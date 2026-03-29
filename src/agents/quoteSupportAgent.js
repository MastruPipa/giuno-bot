// ─── Quote Support Agent V2 ──────────────────────────────────────────────────
// Fix: status accepted, fuzzy category, unified search, min effort enforcement
'use strict';

var logger = require('../utils/logger');
var db = require('../../supabase');
var { checkPermission, getAccessDeniedMessage } = require('../../rbac');
var { safeParse } = require('../utils/safeCall');

function roundTo50(n) { return Math.ceil(n / 50) * 50; }
function formatEuro(n) { return n.toLocaleString('it-IT') + ' €'; }

var RELATED_CATEGORIES = {
  'branding': ['design', 'content'], 'video': ['content', 'social', 'evento'],
  'social': ['content', 'campagna', 'video'], 'web': ['design', 'branding'],
  'foto': ['video', 'content', 'evento'], 'design': ['branding', 'web'],
  'campagna': ['social', 'performance', 'content'], 'evento': ['video', 'foto'],
  'copy': ['content', 'social'], 'content': ['social', 'copy', 'video'],
};

async function findSimilarQuotes(serviceCategory) {
  var quotes = [];
  try {
    quotes = await db.searchQuotes({ service_category: serviceCategory, status: 'accepted', limit: 10 });
    if (quotes.length < 3) {
      var more = await db.searchQuotes({ service_category: serviceCategory, limit: 10 });
      var ids = {}; quotes.forEach(function(q) { ids[q.id] = true; });
      more.forEach(function(q) { if (!ids[q.id]) quotes.push(q); });
    }
    if (quotes.length < 2) {
      var related = RELATED_CATEGORIES[serviceCategory] || ['content', 'branding'];
      for (var i = 0; i < related.length && quotes.length < 5; i++) {
        var rel = await db.searchQuotes({ service_category: related[i], limit: 5 });
        var ids2 = {}; quotes.forEach(function(q) { ids2[q.id] = true; });
        rel.forEach(function(q) { if (!ids2[q.id]) quotes.push(q); });
      }
    }
  } catch(e) { logger.warn('[QUOTE-V2] searchQuotes error:', e.message); }
  quotes.sort(function(a, b) {
    if (a.status === 'accepted' && b.status !== 'accepted') return -1;
    if (b.status === 'accepted' && a.status !== 'accepted') return 1;
    return new Date(b.date || 0) - new Date(a.date || 0);
  });
  return quotes.slice(0, 8);
}

async function estimateEffort(message, rateCardData, similarQuotes) {
  var Anthropic = require('@anthropic-ai/sdk');
  var client = new Anthropic();
  var rateInfo = '';
  if (rateCardData && rateCardData.resources) {
    rateInfo = 'RATE CARD:\n';
    var resources = typeof rateCardData.resources === 'string' ? safeParse('QUOTE.resources', rateCardData.resources, []) : rateCardData.resources;
    if (Array.isArray(resources)) resources.forEach(function(r) {
      rateInfo += '- ' + (r.role || r.person || 'N/A') + ': ' + (r.hour_rate || r.day_rate || '?') + '€/h\n';
    });
  }
  var quotesInfo = '';
  if (similarQuotes.length > 0) {
    quotesInfo = '\nPREVENTIVI STORICI:\n';
    similarQuotes.forEach(function(q) {
      quotesInfo += '- ' + (q.project_name || q.client_name || 'N/A') + ': ' + (q.price_quoted || q.total_price || '?') + '€ [' + (q.service_category || '') + ', ' + (q.status || '') + ']\n';
    });
  }
  var res = await client.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 800,
    system: 'Pricing expert per Katania Studio (agenzia creativa Catania, 9 persone).\n' +
      'Rispondi SOLO JSON:\n{"projectType":"string","scope":"1-2 frasi","effort":[{"role":"string","hours":number,"rateInterno":number}],"confidence":"alta|media|bassa","warnings":["string"]}\n' +
      'REGOLE: ore minime 2h/deliverable, includi PM (min 10%), rate default se mancanti: 35€/h junior, 50€/h senior, 65€/h director\n\n' + rateInfo + quotesInfo,
    messages: [{ role: 'user', content: message }],
  });
  var match = res.content[0].text.trim().match(/\{[\s\S]*\}/);
  return match ? safeParse('QUOTE.parse', match[0], null) : null;
}

function extractServiceType(msg) {
  var m = (msg || '').toLowerCase();
  var types = {
    'branding': /brand|logo|identit|marchio|naming/, 'video': /video|film|reel|montaggio|spot/,
    'social': /social|instagram|tiktok|linkedin|piano\s*editoriale/, 'web': /sito|web|landing|app|e-?commerce/,
    'foto': /foto|shooting|still\s*life/, 'design': /design|grafica|packaging|ui|ux/,
    'campagna': /campagna|adv|advertising|lead\s*gen/, 'evento': /evento|fiera|stand/,
    'copy': /copy|testi|seo|blog/, 'content': /content|contenut|strategi/,
  };
  for (var t in types) { if (types[t].test(m)) return t; }
  return 'altro';
}

async function run(message, ctx) {
  if (!checkPermission(ctx.userRole, 'view_quote_price')) return getAccessDeniedMessage(ctx.userRole);
  logger.info('[QUOTE-V2] Request from', ctx.userId);
  try {
    var serviceType = extractServiceType(message);
    var rateCard = await db.getRateCard();
    var similarQuotes = await findSimilarQuotes(serviceType);
    var estimate = await estimateEffort(message, rateCard, similarQuotes);
    if (!estimate) return 'Non riesco a stimare. Specifica: tipo progetto, deliverable, timeline.';

    var internalCost = 0;
    var effort = estimate.effort || [];
    for (var i = 0; i < effort.length; i++) {
      if (!effort[i].rateInterno) effort[i].rateInterno = 45;
      if (!effort[i].hours || effort[i].hours < 2) effort[i].hours = 4;
      effort[i].subtotal = effort[i].hours * effort[i].rateInterno;
      internalCost += effort[i].subtotal;
    }

    var markup = 130, warnings = estimate.warnings || [];
    var accepted = similarQuotes.filter(function(q) { return q.status === 'accepted' && q.markup_pct; });
    if (accepted.length >= 3) {
      var sum = 0; accepted.forEach(function(q) { sum += parseFloat(q.markup_pct) || 0; });
      markup = sum / accepted.length;
    } else if (accepted.length >= 1) {
      var avg = 0; accepted.forEach(function(q) { avg += parseFloat(q.markup_pct) || 0; });
      markup = Math.max(avg / accepted.length, 100);
    } else { warnings.push('Nessun preventivo accettato trovato — markup default 2.3x'); }

    var midPrice = roundTo50(internalCost * (1 + markup / 100));
    var lowPrice = roundTo50(midPrice * 0.85);
    var highPrice = roundTo50(midPrice * 1.20);
    if (midPrice < 200) warnings.push('Prezzo molto basso — verifica effort');

    var confidence = accepted.length >= 3 ? 'alta' : (accepted.length >= 1 || similarQuotes.length >= 3 ? 'media' : 'bassa');
    var cEmoji = { 'alta': '🟢', 'media': '🟡', 'bassa': '🔴' }[confidence] || '🔴';
    var totalHours = 0; effort.forEach(function(e) { totalHours += e.hours; });

    var msg = '*💰 Quote — ' + (estimate.projectType || serviceType) + '*\n';
    if (estimate.scope) msg += '_' + estimate.scope + '_\n';
    msg += '\n*LOW:* ' + formatEuro(lowPrice) + '\n*MID:* ' + formatEuro(midPrice) + ' ← consigliato\n*HIGH:* ' + formatEuro(highPrice) + '\n\n';
    msg += '*Breakdown:*\n';
    effort.forEach(function(r) { msg += '• ' + r.role + ': ' + r.hours + 'h × ' + r.rateInterno + '€ = ' + formatEuro(r.subtotal) + '\n'; });
    msg += '_Totale: ' + totalHours + 'h | Interno: ' + formatEuro(internalCost) + ' | Markup: ' + Math.round(markup) + '%_\n';
    if (similarQuotes.length > 0) {
      msg += '\n*Riferimenti:*\n';
      similarQuotes.slice(0, 3).forEach(function(q) {
        msg += '• ' + (q.status === 'accepted' ? '✅' : '📝') + ' ' + (q.project_name || q.client_name || '?') + ': ' + formatEuro(q.price_quoted || q.total_price || 0) + '\n';
      });
    }
    msg += '\n*Confidence:* ' + cEmoji + ' ' + confidence + '\n';
    warnings.forEach(function(w) { msg += '⚠️ ' + w + '\n'; });
    msg += '\n_Richiede approvazione prima dell\'invio al cliente._';
    return msg;
  } catch(e) {
    logger.error('[QUOTE-V2]', e.message);
    return 'Errore: ' + e.message + '\nSpecifica: tipo progetto, deliverable, timeline.';
  }
}

module.exports = { run: run };
