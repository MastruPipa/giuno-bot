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
    try { await matcher.enrichTasksWithProjects(tasks, { llmFallback: opts.llm !== false, date: e.date }); } catch(err) { logger.debug('[ATTRIB] match fallito:', err.message); }
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

function formatReport(r) {
  var lines = ['*Attribuzione ore ai progetti:* ' + r.entries + ' daily letti, ' + r.orphans + ' task senza progetto, ' + r.resolved + ' attribuiti ora, ' + r.still.length + ' ancora orfani'];
  Object.keys(r.byUser).sort(function(a, b) { return r.byUser[b] - r.byUser[a]; }).slice(0, 10).forEach(function(u) {
    var ex = r.still.filter(function(o) { return o.user_id === u; }).slice(0, 3).map(function(o) { return '"' + String(o.task).substring(0, 40) + '"'; }).join(', ');
    lines.push('• <@' + u + '>: ' + Math.round(r.byUser[u] * 10) / 10 + 'h senza progetto — ' + ex);
  });
  if (r.still.length) lines.push('_Aggiungi alias ai progetti (`/giuno admin progetti`) o crea il progetto mancante: alla prossima corsa notturna le ore si agganciano da sole._');
  return lines.join('\n');
}

module.exports = { findOrphanTasks: findOrphanTasks, attributeOrphans: attributeOrphans, formatReport: formatReport };
