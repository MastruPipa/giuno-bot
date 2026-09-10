// ─── Follow-up sulla pipeline commerciale (Attio) ────────────────────────────
// Deal aperti fermi da N giorni, proposte senza valore, deal vinti senza
// progetto: un promemoria agli admin il lunedì e il giovedì, una volta per
// deal ogni 7 giorni. Prima il follow-up agent era spento perché rumoroso:
// qui la fonte è il CRM e il throttle è per singolo deal.

'use strict';

var logger = require('../utils/logger');

var STALE_DAYS = Number(process.env.PIPELINE_STALE_DAYS) || 14;
var CLOSED_RE = /won|lost|vint|pers|chius|archiv|in progress|contratto|completat|declin/i;
var LATE_STAGE_RE = /propos|preventiv|negoz|negotiat|contract|offert/i;

function firstOf(v) { return Array.isArray(v) ? v[0] : v; }
function stageOf(deal) { var st = firstOf(deal.values && deal.values.stage); return st == null ? '' : String(st); }
function isOpen(deal) { var st = stageOf(deal); return !!st && !CLOSED_RE.test(st); }
function daysSince(iso, now) { if (!iso) return null; return Math.floor(((now || Date.now()) - new Date(iso).getTime()) / 86400000); }
function valueOf(deal) { var v = firstOf(deal.values && deal.values.value); var n = Number(v); return isNaN(n) ? null : n; }
function nameOf(deal) { return String(firstOf(deal.values && deal.values.name) || 'Deal senza nome'); }

async function fetchOpenDeals(deps) {
  var attio = (deps && deps.attio) || require('../services/attioService');
  if (attio.isConfigured && !attio.isConfigured()) return [];
  var out = [];
  for (var page = 0; page < 10; page++) {
    var batch;
    try { batch = await attio.queryRecords('deals', null, 50, null, page * 50); }
    catch(e) { logger.warn('[PIPELINE] query deals fallita a pagina', page, '-', e.message); break; }
    if (!batch || !batch.length) break;
    batch.forEach(function(d) { if (isOpen(d)) out.push(d); });
    if (batch.length < 50) break;
  }
  return out;
}

// Deal aperti da segnalare. Ritorna { stale:[...], no_value:[...] }.
function findIssues(deals, opts) {
  opts = opts || {};
  var now = opts.now || Date.now();
  var staleDays = opts.staleDays || STALE_DAYS;
  var stale = [], noValue = [];
  (deals || []).forEach(function(d) {
    var last = d.last_activity_at || d.created_at;
    var days = daysSince(last, now);
    var item = { record_id: d.record_id, name: nameOf(d), stage: stageOf(d), value: valueOf(d), days: days, last: last ? String(last).slice(0, 10) : null };
    if (days != null && days >= staleDays) stale.push(item);
    if (LATE_STAGE_RE.test(item.stage) && !item.value) noValue.push(item);
  });
  stale.sort(function(a, b) { return (b.value || 0) - (a.value || 0) || b.days - a.days; });
  return { stale: stale, no_value: noValue };
}

function suggestionFor(item) {
  if (item.days >= 45) return 'fermo da più di 6 settimane: chiudilo come Lost o riaprilo con una call';
  if (LATE_STAGE_RE.test(item.stage)) return 'proposta in sospeso: manda un follow-up al cliente o chiedi una call di chiusura';
  return 'nessun movimento: aggiorna lo stage o scrivi due righe di nota su cosa aspettiamo';
}

function formatReport(issues, opts) {
  opts = opts || {};
  var lines = [];
  if (!issues.stale.length && !issues.no_value.length) return opts.empty === false ? null : '*Pipeline:* nessun deal fermo da ' + (opts.staleDays || STALE_DAYS) + '+ giorni e nessuna proposta senza valore. 👌';
  if (issues.stale.length) {
    lines.push('*Pipeline — ' + issues.stale.length + ' deal fermi da ' + (opts.staleDays || STALE_DAYS) + '+ giorni:*');
    issues.stale.slice(0, 12).forEach(function(it) {
      lines.push('• *' + it.name + '* — ' + (it.stage || 'stage?') + (it.value ? ', €' + Math.round(it.value).toLocaleString('it-IT') : '') + ', ultimo movimento ' + it.days + ' gg fa' + (it.last ? ' (' + it.last + ')' : '') + '\n   → ' + suggestionFor(it));
    });
    if (issues.stale.length > 12) lines.push('  …e altri ' + (issues.stale.length - 12));
  }
  if (issues.no_value.length) {
    lines.push('*Proposte senza valore su Attio:* ' + issues.no_value.map(function(it) { return it.name + ' (' + it.stage + ')'; }).join(', ') + ' — senza valore la pipeline non si somma.');
  }
  return lines.join('\n');
}

async function runPipelineReview(opts) {
  opts = opts || {};
  var deps = opts.deps || {};
  var deals = opts.deals || await fetchOpenDeals(deps);
  var issues = findIssues(deals, { now: deps.now && deps.now(), staleDays: opts.staleDays });
  var report = { open: deals.length, issues: issues, notified: 0 };
  if (!opts.notify) return report;
  var gate = deps.gate || require('../utils/proactiveGate');
  var supabase = deps.supabase !== undefined ? deps.supabase : require('../services/db/client').getClient();
  var app = deps.app || require('../services/slackService').app;
  var roles = deps.roles || await require('../../rbac').getAllRoles();
  var admins = roles.filter(function(r) { return r.role === 'admin'; });
  for (var i = 0; i < admins.length; i++) {
    var uid = admins[i].slack_user_id;
    if (!gate.notificheEnabled(uid)) continue;
    // Throttle per deal: ogni deal fermo torna nel promemoria al massimo ogni 7 giorni, 3 volte.
    var fresh = { stale: [], no_value: issues.no_value };
    var toRecord = [];
    for (var j = 0; j < issues.stale.length; j++) {
      var it = issues.stale[j];
      var hash = gate.itemHash('pipeline:' + it.record_id);
      var ok = supabase ? await gate.followupAllowed(supabase, uid, hash, { cooldownDays: 7, maxAttempts: 3 }) : { allowed: true, attempts: 0 };
      if (ok.allowed) { fresh.stale.push(it); toRecord.push({ hash: hash, attempts: ok.attempts, desc: it.name }); }
    }
    var text = formatReport(fresh, { empty: false, staleDays: opts.staleDays });
    if (!text) continue;
    try {
      await app.client.chat.postMessage({ channel: uid, text: '📈 ' + text + '\n_Dati Attio. "pipeline" in DM per rivederla quando vuoi._' });
      report.notified++;
      for (var k = 0; k < toRecord.length; k++) if (supabase) await gate.recordFollowup(supabase, uid, toRecord[k].hash, 'pipeline: ' + toRecord[k].desc, toRecord[k].attempts);
    } catch(e) { logger.warn('[PIPELINE] avviso a ' + uid + ' fallito:', e.message); }
  }
  logger.info('[PIPELINE] ' + deals.length + ' deal aperti, ' + issues.stale.length + ' fermi, ' + issues.no_value.length + ' senza valore, ' + report.notified + ' avvisi');
  return report;
}

module.exports = { STALE_DAYS: STALE_DAYS, isOpen: isOpen, stageOf: stageOf, fetchOpenDeals: fetchOpenDeals, findIssues: findIssues, formatReport: formatReport, runPipelineReview: runPipelineReview };
