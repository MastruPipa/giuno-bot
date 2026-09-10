// ─── Retrospettiva serale di Giuno (auto-sviluppo, livello 1) ────────────────
// Ogni sera Giuno rilegge la propria giornata: risposte finite in fallback,
// tool falliti, cron con errori, feedback negativi, eval, costi. Un modello
// ne ricava al massimo tre proposte concrete (dove intervenire, impatto,
// sforzo) che arrivano in DM agli admin e restano in self_reviews. Il
// livello 2 (scrivere il codice della proposta) si appoggerà a questo storico.

'use strict';

var fs = require('fs');
var path = require('path');
var logger = require('../utils/logger');
var { MODELS } = require('../config/models');
var { safeParse } = require('../utils/safeCall');

var FALLBACK_MARKERS = [
  { key: 'vuota', test: function(t) { return !String(t || '').trim(); } },
  { key: 'incartato', test: function(t) { return /Mi sono incartato e non sono riuscito/.test(t); } },
  { key: 'validator', test: function(t) { return /Non sono riuscito a completare l'azione/.test(t); } },
  { key: 'contesto', test: function(t) { return /^Dimmi pure — a cosa ti riferisci\?/.test(t); } },
  { key: 'sovraccarico', test: function(t) { return /momentaneamente sovraccarico/.test(t); } },
];

function dayBounds(dateStr) {
  // Giornata Europe/Rome espressa in UTC (approssimazione: +2 estate/+1 inverno gestita dal DB con timezone)
  var start = new Date(dateStr + 'T00:00:00+02:00').toISOString();
  var end = new Date(dateStr + 'T23:59:59+02:00').toISOString();
  return { start: start, end: end };
}

// Risposte in fallback nelle conversazioni toccate oggi: per ogni assistant
// marcato, il messaggio utente che lo precede.
function findFallbackReplies(conversations) {
  var out = [];
  (conversations || []).forEach(function(c) {
    var msgs = Array.isArray(c.messages) ? c.messages : [];
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (!m || m.role !== 'assistant') continue;
      var marker = FALLBACK_MARKERS.find(function(f) { return f.test(typeof m.content === 'string' ? m.content : ''); });
      if (!marker) continue;
      var prev = msgs[i - 1] && msgs[i - 1].role === 'user' ? String(msgs[i - 1].content || '') : '';
      out.push({ conv_key: c.conv_key, kind: marker.key, user_message: prev.replace(/^<@[A-Z0-9]+>(\s*\([^)]*\))?:\s*/, '').substring(0, 160) });
    }
  });
  return out;
}

function latestEvalResult(dir) {
  try {
    var files = fs.readdirSync(dir).filter(function(f) { return f.endsWith('.json'); }).sort();
    if (!files.length) return null;
    var data = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));
    return { ran_at: data.ran_at, passed: data.passed, total: data.total, avg_judge: data.avg_judge, failed: (data.results || []).filter(function(r) { return !r.pass; }).map(function(r) { return { id: r.id, failures: r.failures, judge: r.judge && r.judge.reason }; }).slice(0, 8) };
  } catch(_) { return null; }
}

async function collectSignals(dateStr, deps) {
  deps = deps || {};
  var bounds = dayBounds(dateStr);
  var signals = { date: dateStr, fallbacks: [], tool_failures: [], cron_errors: [], error_patterns: [], feedback_negative: [], api: [], actions: 0, conversations: 0, eval: null };
  var supabase = deps.supabase !== undefined ? deps.supabase : (function() { try { return require('../services/db/client').getClient(); } catch(_) { return null; } })();
  if (supabase) {
    try {
      var convs = await supabase.from('conversations').select('conv_key, messages').gte('updated_at', bounds.start).lte('updated_at', bounds.end).limit(200);
      signals.conversations = (convs.data || []).length;
      signals.fallbacks = findFallbackReplies(convs.data || []).slice(0, 20);
    } catch(e) { logger.debug('[SELF-REVIEW] conversations:', e.message); }
    try {
      var errs = await supabase.from('error_patterns').select('pattern_key, error_count, last_error, last_seen').gte('last_seen', bounds.start).order('last_seen', { ascending: false }).limit(15);
      signals.error_patterns = (errs.data || []).map(function(e) { return { key: e.pattern_key, count: e.error_count, error: String(e.last_error || '').substring(0, 160) }; });
    } catch(e) { /* ok */ }
    try {
      var fb = await supabase.from('feedback').select('feedback, message_text, created_at').gte('created_at', bounds.start).limit(30);
      signals.feedback_negative = (fb.data || []).filter(function(f) { return /neg|👎|-1|thumbsdown/i.test(String(f.feedback)); }).map(function(f) { return String(f.message_text || '').substring(0, 160); });
    } catch(e) { /* ok */ }
    try {
      var api = await supabase.from('api_usage').select('model, calls, input_tokens, output_tokens, estimated_cost_usd').eq('date', dateStr);
      signals.api = (api.data || []).map(function(a) { return { model: a.model, calls: a.calls, input: a.input_tokens, output: a.output_tokens, usd: Number(a.estimated_cost_usd) }; });
    } catch(e) { /* ok */ }
    try {
      var acts = await supabase.from('conversation_actions').select('id', { count: 'exact', head: true }).gte('at', bounds.start).lte('at', bounds.end);
      signals.actions = acts.count || 0;
    } catch(e) { /* ok */ }
  }
  try {
    var svc = deps.anthropicService || require('../services/anthropicService');
    signals.tool_failures = (svc.getToolFailures ? svc.getToolFailures(bounds.start) : []).slice(-30);
  } catch(e) { /* ok */ }
  try {
    var jobs = deps.jobs || require('../jobs/scheduler').listJobs();
    signals.cron_errors = jobs.filter(function(j) { return j.lastError; }).map(function(j) { return { name: j.name, error: String(j.lastError).substring(0, 160), at: j.lastFinishedAt }; });
  } catch(e) { /* ok */ }
  signals.eval = deps.evalDir === null ? null : latestEvalResult(deps.evalDir || path.join(__dirname, '..', '..', 'eval', 'results'));
  return signals;
}

function hasSomethingToSay(s) {
  return !!(s.fallbacks.length || s.tool_failures.length || s.cron_errors.length || s.error_patterns.length || s.feedback_negative.length || (s.eval && s.eval.failed && s.eval.failed.length));
}

var SYSTEM =
  'Sei Giuno, assistente Slack interno di Katania Studio, e stai facendo la retrospettiva della TUA giornata con i dati di sistema qui sotto. ' +
  'Obiettivo: capire dove hai fatto perdere tempo alle persone e proporre al massimo TRE interventi concreti e piccoli, in ordine di impatto. ' +
  'Non inventare cause: se i dati non bastano, dillo nell\'evidenza. Le proposte devono indicare DOVE si interviene (prompt, tool, codice, dati, processo del team). ' +
  'Rispondi con un unico JSON:\n' +
  '{"sintesi":"2-3 righe sulla giornata","cosa_ha_funzionato":["max 3"],' +
  '"problemi":[{"titolo":"...","evidenza":"cosa dicono i dati (numeri, esempi)","causa_probabile":"...","proposta":"intervento concreto","dove":"prompt|tool|codice|dati|processo","impatto":"alto|medio|basso","sforzo":"piccolo|medio|grande"}],' +
  '"non_toccare":["cose che vanno bene e non vanno cambiate, max 2"]}';

function buildPrompt(s) {
  var lines = ['GIORNATA: ' + s.date, 'Conversazioni toccate: ' + s.conversations + ' · azioni eseguite: ' + s.actions];
  if (s.api.length) lines.push('Costi API: ' + s.api.map(function(a) { return a.model + ' ' + a.calls + ' chiamate, ' + Math.round((a.input || 0) / 1000) + 'k token in, $' + (a.usd || 0).toFixed(2); }).join('; '));
  if (s.fallbacks.length) lines.push('RISPOSTE IN FALLBACK (' + s.fallbacks.length + '):\n' + s.fallbacks.map(function(f) { return '• [' + f.kind + '] dopo: "' + f.user_message + '"'; }).join('\n'));
  if (s.tool_failures.length) lines.push('TOOL FALLITI (' + s.tool_failures.length + '):\n' + s.tool_failures.map(function(f) { return '• ' + f.tool + ': ' + f.error + ' | input ' + f.input; }).join('\n'));
  if (s.cron_errors.length) lines.push('CRON CON ERRORI:\n' + s.cron_errors.map(function(c) { return '• ' + c.name + ': ' + c.error; }).join('\n'));
  if (s.error_patterns.length) lines.push('PATTERN DI ERRORE:\n' + s.error_patterns.map(function(e) { return '• ' + e.key + ' ×' + e.count + ': ' + e.error; }).join('\n'));
  if (s.feedback_negative.length) lines.push('FEEDBACK NEGATIVI:\n' + s.feedback_negative.map(function(f) { return '• ' + f; }).join('\n'));
  if (s.eval) lines.push('ULTIMA EVAL (' + String(s.eval.ran_at || '').slice(0, 10) + '): ' + s.eval.passed + '/' + s.eval.total + (s.eval.avg_judge != null ? ', giudice ' + Number(s.eval.avg_judge).toFixed(2) : '') + (s.eval.failed.length ? '\n' + s.eval.failed.map(function(f) { return '• ' + f.id + ': ' + (f.failures || []).join('; ') + (f.judge ? ' — ' + f.judge : ''); }).join('\n') : ''));
  return lines.join('\n\n');
}

function parseReview(text) {
  var m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  var r = safeParse('self-review', m[0], null);
  if (!r || typeof r !== 'object') return null;
  r.problemi = Array.isArray(r.problemi) ? r.problemi.slice(0, 3) : [];
  r.cosa_ha_funzionato = Array.isArray(r.cosa_ha_funzionato) ? r.cosa_ha_funzionato : [];
  r.non_toccare = Array.isArray(r.non_toccare) ? r.non_toccare : [];
  return r;
}

function formatReview(s, r) {
  var head = '🪞 *Retrospettiva di Giuno — ' + s.date + '*\n' + s.conversations + ' conversazioni · ' + s.actions + ' azioni · ' + s.fallbacks.length + ' risposte in fallback · ' + s.tool_failures.length + ' tool falliti · ' + s.cron_errors.length + ' cron con errori' +
    (s.api.length ? ' · $' + s.api.reduce(function(a, x) { return a + (x.usd || 0); }, 0).toFixed(2) : '');
  var lines = [head];
  if (r.sintesi) lines.push(r.sintesi);
  if (r.cosa_ha_funzionato.length) lines.push('*Ha funzionato:* ' + r.cosa_ha_funzionato.join(' · '));
  r.problemi.forEach(function(p, i) {
    lines.push('*' + (i + 1) + '. ' + p.titolo + '* _(' + (p.dove || '?') + ', impatto ' + (p.impatto || '?') + ', sforzo ' + (p.sforzo || '?') + ')_\n' +
      (p.evidenza ? '   Evidenza: ' + p.evidenza + '\n' : '') + (p.causa_probabile ? '   Causa probabile: ' + p.causa_probabile + '\n' : '') + '   → ' + (p.proposta || ''));
  });
  if (r.non_toccare.length) lines.push('*Non toccare:* ' + r.non_toccare.join(' · '));
  lines.push('_Per farne una modifica: dimmi "sviluppa il punto N" (arriva col livello 2)._');
  return lines.join('\n\n');
}

async function saveReview(dateStr, signals, review, deps) {
  var supabase = deps.supabase !== undefined ? deps.supabase : (function() { try { return require('../services/db/client').getClient(); } catch(_) { return null; } })();
  if (!supabase) return;
  try {
    var res = await supabase.from('self_reviews').upsert({ date: dateStr, signals: signals, review: review, created_at: new Date().toISOString() }, { onConflict: 'date' });
    if (res.error) throw res.error;
  } catch(e) { logger.warn('[SELF-REVIEW] salvataggio fallito:', e.message); }
}

async function runSelfReview(opts) {
  opts = opts || {};
  var deps = opts.deps || {};
  var dateStr = opts.date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
  var signals = opts.signals || await collectSignals(dateStr, deps);
  if (!hasSomethingToSay(signals) && !opts.force) {
    logger.info('[SELF-REVIEW] ' + dateStr + ': giornata pulita, niente da proporre');
    return { date: dateStr, signals: signals, review: null, text: null, notified: 0 };
  }
  var client = deps.client || require('../services/anthropicService').client;
  var res = await client.messages.create({ model: opts.model || MODELS.UTILITY, max_tokens: 1800, system: SYSTEM, messages: [{ role: 'user', content: buildPrompt(signals) }] });
  var text = (res.content || []).filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('\n');
  var review = parseReview(text);
  if (!review) throw new Error('retrospettiva non parsabile');
  await saveReview(dateStr, signals, review, deps);
  var formatted = formatReview(signals, review);
  var notified = 0;
  if (opts.notify) {
    var app = deps.app || require('../services/slackService').app;
    var roles = deps.roles || await require('../../rbac').getAllRoles();
    var admins = roles.filter(function(r) { return r.role === 'admin'; });
    for (var i = 0; i < admins.length; i++) {
      try { await app.client.chat.postMessage({ channel: admins[i].slack_user_id, text: formatted }); notified++; }
      catch(e) { logger.warn('[SELF-REVIEW] DM a ' + admins[i].slack_user_id + ' fallita:', e.message); }
    }
  }
  return { date: dateStr, signals: signals, review: review, text: formatted, notified: notified };
}

module.exports = { FALLBACK_MARKERS: FALLBACK_MARKERS, findFallbackReplies: findFallbackReplies, collectSignals: collectSignals, hasSomethingToSay: hasSomethingToSay, buildPrompt: buildPrompt, parseReview: parseReview, formatReview: formatReview, runSelfReview: runSelfReview };
