// ─── Quote Support Agent ───────────────────────────────────────────────────────
// Generates pricing proposals based on rate card, historical quotes, and KB data.
// Triggered by QUOTE_SUPPORT intent or /giuno preventivo.

'use strict';

var logger = require('../utils/logger');
var db = require('../../supabase');
var { checkPermission, getAccessDeniedMessage } = require('../../rbac');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function roundTo50(n) {
  return Math.ceil(n / 50) * 50;
}

function formatEuro(n) {
  return n.toLocaleString('it-IT') + ' €';
}

// ─── Load pricing data ───────────────────────────────────────────────────────

async function loadRateCard() {
  var rc = await db.getRateCard();
  if (!rc) return null;
  // Also search KB for rate card entries
  var kbRates = db.searchKB('rate card');
  return { rateCard: rc, kbRates: kbRates };
}

async function findSimilarQuotes(serviceCategory) {
  var quotes = [];
  try {
    quotes = await db.searchQuotes({
      service_category: serviceCategory,
      status: 'approved',
      limit: 10,
    });
  } catch(e) {
    logger.warn('[QUOTE-SUPPORT] Errore searchQuotes:', e.message);
  }
  // Sort by date descending, take top 5
  quotes.sort(function(a, b) {
    return new Date(b.date || 0) - new Date(a.date || 0);
  });
  return quotes.slice(0, 5);
}

// ─── Estimate effort with LLM ────────────────────────────────────────────────

async function estimateEffort(message, rateCardData, similarQuotes) {
  var Anthropic = require('@anthropic-ai/sdk');
  var client = new Anthropic();

  var rateInfo = '';
  if (rateCardData && rateCardData.rateCard && rateCardData.rateCard.resources) {
    rateInfo = 'RATE CARD ATTUALE:\n';
    var resources = rateCardData.rateCard.resources;
    if (typeof resources === 'string') {
      try { resources = JSON.parse(resources); } catch(e) { resources = []; }
    }
    if (Array.isArray(resources)) {
      resources.forEach(function(r) {
        rateInfo += '- ' + (r.role || r.person || 'N/A') + ': ' +
          (r.hour_rate || r.day_rate || '?') + '€/h\n';
      });
    }
  }

  var quotesInfo = '';
  if (similarQuotes.length > 0) {
    quotesInfo = '\nPREVENTIVI SIMILI ACCETTATI:\n';
    similarQuotes.forEach(function(q) {
      quotesInfo += '- ' + (q.project_name || q.client_name || 'N/A') +
        ': ' + (q.total_price || '?') + '€' +
        ' (' + (q.service_category || '') + ')' +
        (q.markup_pct ? ' markup: ' + q.markup_pct + '%' : '') + '\n';
    });
  }

  var res = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 800,
    system: 'Sei un esperto di pricing per un\'agenzia creativa (Katania Studio).\n' +
      'Stima l\'effort per il progetto richiesto.\n' +
      'Rispondi SOLO in JSON valido:\n' +
      '{"projectType":"string","scope":"string","client":null,' +
      '"effort":[{"role":"string","hours":number,"rateInterno":number}],' +
      '"confidence":"alta|media|bassa",' +
      '"warnings":["string"]}\n\n' +
      rateInfo + quotesInfo,
    messages: [{ role: 'user', content: message }],
  });

  var text = res.content[0].text.trim();
  var jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  return JSON.parse(jsonMatch[0]);
}

// ─── Main agent ──────────────────────────────────────────────────────────────

async function run(message, ctx) {
  // RBAC check
  if (!checkPermission(ctx.userRole, 'view_quote_price')) {
    return getAccessDeniedMessage(ctx.userRole);
  }

  logger.info('[QUOTE-SUPPORT] Richiesta da', ctx.userId, '- ruolo:', ctx.userRole);

  try {
    // 1. Load rate card and similar quotes
    var rateCardData = await loadRateCard();
    var serviceType = extractServiceType(message);
    var similarQuotes = await findSimilarQuotes(serviceType);

    // 2. Estimate effort via LLM
    var estimate = await estimateEffort(message, rateCardData, similarQuotes);
    if (!estimate) {
      return 'Non sono riuscito a stimare l\'effort per questo progetto. Puoi darmi più dettagli su tipo di progetto, deliverable e tempistica?';
    }

    // 3. Calculate pricing
    var internalCost = 0;
    var effort = estimate.effort || [];
    for (var i = 0; i < effort.length; i++) {
      var e = effort[i];
      e.subtotal = (e.hours || 0) * (e.rateInterno || 0);
      internalCost += e.subtotal;
    }

    // 4. Determine markup
    var markup = 130; // default 2.3x = 130% markup
    var warnings = estimate.warnings || [];
    var acceptedQuotes = similarQuotes.filter(function(q) {
      return q.status === 'approved' && q.markup_pct;
    });

    if (acceptedQuotes.length >= 3) {
      var totalMarkup = 0;
      for (var qi = 0; qi < acceptedQuotes.length; qi++) {
        totalMarkup += parseFloat(acceptedQuotes[qi].markup_pct) || 0;
      }
      markup = totalMarkup / acceptedQuotes.length;
    } else if (acceptedQuotes.length >= 1) {
      var avgMarkup = 0;
      for (var qi2 = 0; qi2 < acceptedQuotes.length; qi2++) {
        avgMarkup += parseFloat(acceptedQuotes[qi2].markup_pct) || 0;
      }
      avgMarkup = avgMarkup / acceptedQuotes.length;
      markup = Math.max(avgMarkup, 100); // min 2.0x
    } else {
      warnings.push('Nessun precedente simile trovato — markup default 2.3x applicato');
    }

    // 5. Calculate scenarios
    var midPrice = roundTo50(internalCost * (1 + markup / 100));
    var lowPrice = roundTo50(midPrice * 0.85);
    var highPrice = roundTo50(midPrice * 1.20);

    // 6. Confidence
    var confidence = 'bassa';
    var confidenceEmoji = '🔴';
    if (acceptedQuotes.length >= 3) {
      confidence = 'alta';
      confidenceEmoji = '🟢';
    } else if (acceptedQuotes.length >= 1 || effort.length > 0) {
      confidence = 'media';
      confidenceEmoji = '🟡';
    }

    // 7. Build references
    var references = similarQuotes.slice(0, 3).map(function(q) {
      return {
        name: q.project_name || q.client_name || 'N/A',
        price: q.total_price || 0,
        status: q.status || 'unknown',
      };
    });

    // 8. Format output
    var totalHours = 0;
    effort.forEach(function(e) { totalHours += (e.hours || 0); });

    var msg = '*Quote Support — ' + (estimate.projectType || 'Progetto') + '*\n';
    if (estimate.scope) msg += estimate.scope + '\n';
    msg += '\n';
    msg += '*Scenario LOW:* ' + formatEuro(lowPrice) + '\n';
    msg += '*Scenario MID:* ' + formatEuro(midPrice) + ' ← consigliato\n';
    msg += '*Scenario HIGH:* ' + formatEuro(highPrice) + '\n';
    msg += '\n*Basato su:*\n';
    msg += '• ' + acceptedQuotes.length + ' preventivi simili';
    if (acceptedQuotes.length > 0) {
      var years = acceptedQuotes.map(function(q) {
        return new Date(q.date || Date.now()).getFullYear();
      });
      msg += ' (periodo: ' + Math.min.apply(null, years) + '-' + Math.max.apply(null, years) + ')';
    }
    msg += '\n';
    msg += '• Effort stimato: ' + totalHours + 'h totali\n';
    msg += '• Markup applicato: ' + Math.round(markup) + '%\n';

    if (effort.length > 0) {
      msg += '\n*Breakdown risorse:*\n';
      for (var ei = 0; ei < effort.length; ei++) {
        var r = effort[ei];
        msg += '• ' + (r.role || 'N/A') + ': ' + (r.hours || 0) + 'h × ' +
          (r.rateInterno || 0) + '€/h interno = ' + formatEuro(r.subtotal || 0) + '\n';
      }
    }

    if (references.length > 0) {
      msg += '\n*Riferimenti:*\n';
      for (var ri = 0; ri < references.length; ri++) {
        var ref = references[ri];
        msg += '• ' + ref.name + ': ' + formatEuro(ref.price) + ' (' + ref.status + ')\n';
      }
    }

    msg += '\n*Confidence:* ' + confidenceEmoji + ' ' + confidence.charAt(0).toUpperCase() + confidence.slice(1) + '\n';

    if (warnings.length > 0) {
      for (var wi = 0; wi < warnings.length; wi++) {
        msg += '\n⚠️ ' + warnings[wi];
      }
      msg += '\n';
    }

    msg += '\n_Richiede approvazione di Gianna o Corrado prima dell\'invio al cliente._';

    return msg;
  } catch(e) {
    logger.error('[QUOTE-SUPPORT] Errore:', e.message);
    return 'Errore nella generazione del preventivo: ' + e.message;
  }
}

// ─── Extract service type from message ───────────────────────────────────────

function extractServiceType(message) {
  var msgLow = (message || '').toLowerCase();
  var types = {
    'branding': /brand|logo|identit|marchio/,
    'video': /video|film|reel|montaggio|riprese|clip/,
    'social': /social|instagram|facebook|tiktok|linkedin|content/,
    'web': /sito|web|landing|portale|app/,
    'foto': /foto|shooting|servizio fotografico/,
    'design': /design|grafica|layout|ui|ux/,
    'campagna': /campagna|adv|advertising|marketing/,
    'evento': /evento|event|fiera|stand/,
    'copy': /copy|testi|copywriting|seo/,
  };
  for (var type in types) {
    if (types[type].test(msgLow)) return type;
  }
  return 'altro';
}

module.exports = { run: run };
