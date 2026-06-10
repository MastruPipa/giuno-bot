// ─── Time Logs DB Module ─────────────────────────────────────────────────────
// Granular source of truth for workload tracking: one row per
// user/project/date/type. 'weekly' = ore pianificate (log_date = lunedì della
// settimana pianificata), 'daily' = consuntivo del giorno lavorato.
// Gli aggregati in resource_allocations.hours_logged sono DERIVATI da qui.
'use strict';

var c = require('./client');
var dates = require('../../utils/trackingDates');

// Batch upsert: la correzione mattutina di un log già inviato è un upsert
// sulla stessa chiave (slack_user_id, project_id, log_date, log_type).
async function saveTimeLogs(rows) {
  if (!c.useSupabase) return null;
  if (!rows || rows.length === 0) return [];
  try {
    var payload = rows.map(function(r) {
      return {
        slack_user_id: r.slack_user_id,
        project_id: r.project_id,
        log_date: r.log_date,
        log_type: r.log_type,
        hours: r.hours,
        notes: r.notes || null,
        validation: r.validation || null,
        updated_at: new Date().toISOString(),
      };
    });
    var res = await c.getClient().from('time_logs')
      .upsert(payload, { onConflict: 'slack_user_id,project_id,log_date,log_type' })
      .select();
    if (res.error) throw res.error;
    return res.data || [];
  } catch(e) { c.logErr('saveTimeLogs', e); return null; }
}

async function getLogsForUserDate(slackUserId, logDate, logType) {
  if (!c.useSupabase) return [];
  try {
    var q = c.getClient().from('time_logs').select('*')
      .eq('slack_user_id', slackUserId)
      .eq('log_date', logDate);
    if (logType) q = q.eq('log_type', logType);
    var res = await q;
    return res.data || [];
  } catch(e) { c.logErr('getLogsForUserDate', e); return []; }
}

// Utenti che hanno almeno un log daily per la data — usato per i reminder
// (chi manca) e per l'escalation dei 2 giorni consecutivi.
async function getUsersWithDailyLog(logDate) {
  if (!c.useSupabase) return [];
  try {
    var res = await c.getClient().from('time_logs')
      .select('slack_user_id')
      .eq('log_date', logDate)
      .eq('log_type', 'daily');
    var seen = {};
    (res.data || []).forEach(function(r) { seen[r.slack_user_id] = true; });
    return Object.keys(seen);
  } catch(e) { c.logErr('getUsersWithDailyLog', e); return []; }
}

// Somma ore per progetto in una settimana. Ritorna { project_id: hours }.
async function sumWeekByProject(slackUserId, weekStart, logType) {
  if (!c.useSupabase) return {};
  try {
    var weekEnd = dates.addDays(weekStart, 6);
    var res = await c.getClient().from('time_logs')
      .select('project_id, hours')
      .eq('slack_user_id', slackUserId)
      .eq('log_type', logType)
      .gte('log_date', weekStart)
      .lte('log_date', weekEnd);
    var byProject = {};
    (res.data || []).forEach(function(r) {
      byProject[r.project_id] = (byProject[r.project_id] || 0) + (parseFloat(r.hours) || 0);
    });
    return byProject;
  } catch(e) { c.logErr('sumWeekByProject', e); return {}; }
}

function getWeekActuals(slackUserId, weekStart) {
  return sumWeekByProject(slackUserId, weekStart, 'daily');
}

function getWeekPlanned(slackUserId, weekStart) {
  return sumWeekByProject(slackUserId, weekStart, 'weekly');
}

// Trova l'allocation della settimana (period_start = lunedì) per user+project.
// Select-then-update/insert: non dipende da unique constraint live.
async function findWeekAllocation(slackUserId, projectId, weekStart) {
  var res = await c.getClient().from('resource_allocations')
    .select('id, hours_allocated, hours_logged')
    .eq('slack_user_id', slackUserId)
    .eq('project_id', projectId)
    .eq('period_start', weekStart)
    .limit(1);
  if (res.error) throw res.error;
  return (res.data && res.data[0]) || null;
}

// Ricalcola resource_allocations.hours_logged dalla somma dei daily logs.
// Se il lavoro non era pianificato, crea l'allocation con hours_allocated=0.
async function syncAllocationHoursLogged(slackUserId, projectId, logDate) {
  if (!c.useSupabase) return null;
  try {
    var weekStart = dates.weekStartOf(logDate);
    var actuals = await getWeekActuals(slackUserId, weekStart);
    var logged = actuals[projectId] || 0;
    var existing = await findWeekAllocation(slackUserId, projectId, weekStart);
    if (existing) {
      var upd = await c.getClient().from('resource_allocations')
        .update({ hours_logged: logged, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
      if (upd.error) throw upd.error;
      return existing.id;
    }
    var ins = await c.getClient().from('resource_allocations').insert({
      slack_user_id: slackUserId,
      project_id: projectId,
      hours_allocated: 0,
      hours_logged: logged,
      period_start: weekStart,
      period_end: dates.addDays(weekStart, 6),
      notes: 'auto: tracking giornaliero (non pianificato)',
    }).select('id').single();
    if (ins.error) throw ins.error;
    return ins.data ? ins.data.id : null;
  } catch(e) { c.logErr('syncAllocationHoursLogged', e); return null; }
}

// Pianificazione settimanale: aggiorna hours_allocated della settimana target.
async function upsertWeeklyAllocation(slackUserId, projectId, weekStart, hours) {
  if (!c.useSupabase) return null;
  try {
    var existing = await findWeekAllocation(slackUserId, projectId, weekStart);
    if (existing) {
      var upd = await c.getClient().from('resource_allocations')
        .update({ hours_allocated: hours, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
      if (upd.error) throw upd.error;
      return existing.id;
    }
    var ins = await c.getClient().from('resource_allocations').insert({
      slack_user_id: slackUserId,
      project_id: projectId,
      hours_allocated: hours,
      hours_logged: 0,
      period_start: weekStart,
      period_end: dates.addDays(weekStart, 6),
      notes: 'weekly planner',
    }).select('id').single();
    if (ins.error) throw ins.error;
    return ins.data ? ins.data.id : null;
  } catch(e) { c.logErr('upsertWeeklyAllocation', e); return null; }
}

module.exports = {
  saveTimeLogs: saveTimeLogs,
  getLogsForUserDate: getLogsForUserDate,
  getUsersWithDailyLog: getUsersWithDailyLog,
  getWeekActuals: getWeekActuals,
  getWeekPlanned: getWeekPlanned,
  syncAllocationHoursLogged: syncAllocationHoursLogged,
  upsertWeeklyAllocation: upsertWeeklyAllocation,
};
