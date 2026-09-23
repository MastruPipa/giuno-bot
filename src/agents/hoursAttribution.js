// ─── Attribuzione delle ore orfane ai progetti ───────────────────────────────
// Un task del daily senza project_id non entra nel consuntivo per progetto
// (né nella dashboard). Ogni notte si riprovano i task orfani degli ultimi
// giorni con il catalogo aggiornato (alias dei duplicati uniti, progetti
// nuovi); quelli risolti aggiornano il daily e il consuntivo. Le ore che
// restano orfane compaiono nel report di copertura.

'use strict';

var logger = require('../utils/logger');

function _c() { return require('../services/db/client'); }

function taskHours(t) { return (Number(t && t.hours) || 0) + (Number(t && t.minutes) || 0) / 60; }

function findOrphanTasks(entries) {
  var out = [];
  (entries || []).forEach(function(e) {
    (e.oggi_tasks || []).forEach(function(t, i) {
      if (!t || t.project_id || taskHours(t) <= 0) return;
      out.push({ entry_id: e.id, user_id: e.slack_user_id, date: e.date, index: i, task: t.task, hours: Math.round(taskHours(t) * 100) / 100, source: e.source || null });
    });
  });
  return out;
}

async function attributeOrphans(opts) {
  opts = opts || {};
  var deps = opts.deps || {};
  var supabase = deps.supabase !== undefined ? deps.supabase : _c().getClient();
  var matcher = deps.matcher || require('../services/projectMatcher');
  var sync = deps.syncTimeLogs || require('../handlers/dailyStandupV2').syncTimeLogsFromDaily;
  var days = opts.days || 14;
  var report = { entries: 0, orphans: 0, resolved: 0, still: [], byUser: {} };
  if (!supabase) return report;
  var since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  var entries = opts.entries || (await supabase.from('standup_entries').select('id, slack_user_id, date, source, oggi_tasks, domani_tasks, blocchi, total_hours_oggi').gte('date', since).limit(500)).data || [];
  report.entries = entries.length;
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var orphans = findOrphanTasks([e]);
    if (!orphans.length) continue;
    report.orphans += orphans.length;
    var tasks = orphans.map(function(o) { return e.oggi_tasks[o.index]; });
    try { await matcher.enrichTasksWithProjects(tasks, { llmFallback: opts.llm !== false, date: e.date, userId: e.slack_user_id }); } catch(err) { logger.debug('[ATTRIB] match fallito:', err.message); }
    var resolvedNow = tasks.filter(function(t) { return t && t.project_id; }).length;
    if (resolvedNow && opts.apply !== false) {
      try {
        var up = await supabase.from('standup_entries').update({ oggi_tasks: e.oggi_tasks }).eq('id', e.id);
        if (up.error) throw up.error;
        await sync(e.slack_user_id, e.date, { oggi: e.oggi_tasks, domani: e.domani_tasks || [], blocchi: e.blocchi || null }, { estimate: e.source === 'estimate' });
        report.resolved += resolvedNow;
      } catch(err) { logger.warn('[ATTRIB] aggiornamento ' + e.id + ' fallito:', err.message); }
    } else if (resolvedNow) report.resolved += resolvedNow;
    findOrphanTasks([e]).forEach(function(o) {
      report.still.push(o);
      report.byUser[o.user_id] = (report.byUser[o.user_id] || 0) + o.hours;
    });
  }
  logger.info('[ATTRIB] ' + report.entries + ' daily, ' + report.orphans + ' task orfani, ' + report.resolved + ' attribuiti, ' + report.still.length + ' ancora senza progetto');
  return report;
}

// ─── Riallineamento del registro ─────────────────────────────────────────────
// Il consuntivo (time_logs) deve valere quanto i task del daily agganciati a
// un progetto. Non era così: all'invio con un task senza progetto si scriveva
// in modalità "conserva", e il job notturno, dopo aver agganciato i task al
// progetto, falliva la sincronizzazione ("sync is not a function": la
// funzione non era esportata). Risultato al 22/9: registro al 40% delle ore
// dichiarate. Qui ogni daily della finestra viene confrontato con le sue
// righe di registro e, se differiscono, risincronizzato.
function expectedRows(entry) {
  var derive = require('../services/workloadService').deriveTimeLogRows;
  return derive(entry.oggi_tasks || [], entry.slack_user_id, entry.date);
}
function sameLedger(expected, existing, estimate) {
  var exp = {}, got = {};
  expected.forEach(function(r) { exp[r.project_id] = Math.round(Number(r.hours) * 100) / 100; });
  (existing || []).forEach(function(r) {
    var isEst = !!(r.validation && r.validation.status === 'estimate');
    if (isEst !== estimate) return; // righe dell'altro tipo non sono di questa entry
    got[r.project_id] = Math.round(Number(r.hours) * 100) / 100;
  });
  var keys = Object.keys(exp).concat(Object.keys(got).filter(function(k) { return !(k in exp); }));
  return keys.every(function(k) { return exp[k] !== undefined && got[k] !== undefined && Math.abs(exp[k] - got[k]) < 0.01; });
}
async function reconcileLedger(opts) {
  opts = opts || {};
  var deps = opts.deps || {};
  var supabase = deps.supabase !== undefined ? deps.supabase : _c().getClient();
  var db = deps.db || require('../../supabase');
  var sync = deps.syncTimeLogs || require('../handlers/dailyStandupV2').syncTimeLogsFromDaily;
  var days = opts.days || 30;
  var report = { entries: 0, checked: 0, realigned: 0, realignedHours: 0, failed: 0, rows: [] };
  if (!supabase) return report;
  var since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  var entries = opts.entries || (await supabase.from('standup_entries').select('id, slack_user_id, date, source, oggi_tasks, domani_tasks, blocchi').gte('date', since).limit(500)).data || [];
  report.entries = entries.length;
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var expected = expectedRows(e);
    if (!expected.length) continue;
    report.checked++;
    var estimate = e.source === 'estimate';
    var existing = await db.getLogsForUserDate(e.slack_user_id, e.date, 'daily');
    if (sameLedger(expected, existing, estimate)) continue;
    var before = (existing || []).reduce(function(a, r) { return a + (Number(r.hours) || 0); }, 0);
    var after = expected.reduce(function(a, r) { return a + r.hours; }, 0);
    report.rows.push({ user_id: e.slack_user_id, date: e.date, before: Math.round(before * 100) / 100, after: Math.round(after * 100) / 100 });
    if (opts.apply === false) { report.realigned++; report.realignedHours += after - before; continue; }
    try {
      await sync(e.slack_user_id, e.date, { oggi: e.oggi_tasks || [], domani: e.domani_tasks || [], blocchi: e.blocchi || null }, { estimate: estimate });
      report.realigned++; report.realignedHours += after - before;
    } catch(err) { report.failed++; logger.warn('[LEDGER] riallineamento ' + e.slack_user_id + ' ' + e.date + ' fallito:', err.message); }
  }
  report.realignedHours = Math.round(report.realignedHours * 100) / 100;
  logger.info('[LEDGER] ' + report.checked + ' daily confrontati, ' + report.realigned + ' registri riallineati (' + (report.realignedHours >= 0 ? '+' : '') + report.realignedHours + 'h), ' + report.failed + ' falliti');
  return report;
}

function formatReport(r) {
  var lines = ['*Attribuzione ore ai progetti:* ' + r.entries + ' daily letti, ' + r.orphans + ' task senza progetto, ' + r.resolved + ' attribuiti ora, ' + r.still.length + ' ancora orfani'];
  Object.keys(r.byUser).sort(function(a, b) { return r.byUser[b] - r.byUser[a]; }).slice(0, 10).forEach(function(u) {
    var ex = r.still.filter(function(o) { return o.user_id === u; }).slice(0, 3).map(function(o) { return '"' + String(o.task).substring(0, 40) + '"'; }).join(', ');
    lines.push('• <@' + u + '>: ' + Math.round(r.byUser[u] * 10) / 10 + 'h senza progetto — ' + ex);
  });
  if (r.still.length) lines.push('_Aggiungi alias ai progetti (`/giuno admin progetti`) o crea il progetto mancante: alla prossima corsa notturna le ore si agganciano da sole._');
  return lines.join('\n');
}

module.exports = { findOrphanTasks: findOrphanTasks, attributeOrphans: attributeOrphans, reconcileLedger: reconcileLedger, sameLedger: sameLedger, formatReport: formatReport };
