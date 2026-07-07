// ─── Workload Service ─────────────────────────────────────────────────────────
// L'unica fonte di verità sul carico del team. Fonde le DUE serie che prima
// vivevano separate producendo risposte incoerenti ("chi è sovraccarico?"
// dava un risultato in chat e un altro in dashboard):
//   • STIMATO   — daily del mattino (standup_entries, task "oggi", ore da
//                 tendina o dal parser AI)
//   • EFFETTIVO — check-in serale (time_logs log_type='daily', per progetto)
//   • PIANIFICATO — weekly planner (time_logs log_type='weekly')
// Tutti i consumatori (dashboard workload, weekly report, skill capacity)
// devono passare da qui.
'use strict';

var logger = require('../utils/logger');
var db = require('../../supabase');
var dbClient = require('./db/client');
var trackingDates = require('../utils/trackingDates');
var { workdaysBetween } = require('../utils/dates');
var { aggregateStandupRows } = require('../tools/standupTools');

// Merge puro (testabile senza DB) delle tre serie per una settimana.
// standupAgg: output di aggregateStandupRows; pva: output di getPlannedVsActual;
// weekLogs: righe raw time_logs della settimana (per contare i giorni con check-in).
function buildOverview(standupAgg, pva, weekLogs, weekStart, weekEnd) {
  var workdays = workdaysBetween(weekStart, weekEnd);
  var byUser = {};

  function ensure(uid) {
    if (!byUser[uid]) {
      byUser[uid] = {
        estimated_hours: 0, days_with_daily: 0, missing_dailies: workdays,
        carico: null, pct_of_tracked_days: null,
        actual_hours: 0, planned_hours: 0,
        days_with_checkin: 0, missing_checkins: workdays,
      };
    }
    return byUser[uid];
  }

  // Serie stimata (daily del mattino)
  ((standupAgg && standupAgg.by_user) || []).forEach(function(su) {
    var u = ensure(su.slack_user_id);
    u.estimated_hours = Math.round((su.minutes / 60) * 10) / 10;
    u.days_with_daily = su.days_with_daily || 0;
    u.missing_dailies = Math.max(0, workdays - u.days_with_daily);
    u.carico = su.carico || null;
    u.pct_of_tracked_days = su.pct_of_tracked_days != null ? su.pct_of_tracked_days : null;
  });

  // Serie effettiva + pianificata (time_logs)
  var pvaByUser = (pva && pva.byUser) || {};
  Object.keys(pvaByUser).forEach(function(uid) {
    var u = ensure(uid);
    u.actual_hours = Math.round(pvaByUser[uid].actual * 10) / 10;
    u.planned_hours = Math.round(pvaByUser[uid].planned * 10) / 10;
  });

  // Giorni con check-in (distinct log_date daily per utente)
  var checkinDays = {};
  (weekLogs || []).forEach(function(r) {
    if (r.log_type !== 'daily') return;
    if (!checkinDays[r.slack_user_id]) checkinDays[r.slack_user_id] = {};
    checkinDays[r.slack_user_id][r.log_date] = true;
  });
  Object.keys(checkinDays).forEach(function(uid) {
    var u = ensure(uid);
    u.days_with_checkin = Object.keys(checkinDays[uid]).length;
  });
  Object.keys(byUser).forEach(function(uid) {
    byUser[uid].missing_checkins = Math.max(0, workdays - byUser[uid].days_with_checkin);
  });

  return {
    week_start: weekStart,
    week_end: weekEnd,
    periodo: 'dal ' + weekStart + ' al ' + weekEnd + ' (' + workdays + ' giorni lavorativi)',
    workdays: workdays,
    byUser: byUser,
    // Il dettaglio per progetto dei consuntivi resta quello di getPlannedVsActual
    pva: pva || { byUser: {}, byProject: {} },
    legenda: 'dichiarato (estimated_hours) = ore reali dichiarate nel daily delle 16:00 (tutti i task); ' +
      'effettivo (actual_hours) = time_logs per progetto, auto-derivati dai task del daily agganciati a un progetto; ' +
      'pianificato = weekly planner. carico (ok/pieno/sovraccarico) è calcolato sul dichiarato dei giorni con daily compilato.',
  };
}

// Panoramica completa della settimana che inizia a weekStart (lunedì).
async function getWeekOverview(weekStart) {
  var weekEnd = trackingDates.addDays(weekStart, 6);

  var standupAgg = null;
  try {
    var supabase = dbClient.getClient();
    if (supabase) {
      var res = await supabase.from('standup_entries')
        .select('slack_user_id, date, ieri_tasks, oggi_tasks, total_hours_ieri, total_hours_oggi')
        .gte('date', weekStart).lte('date', weekEnd);
      if (!res.error) standupAgg = aggregateStandupRows(res.data || [], {}, weekStart, weekEnd);
    }
  } catch(e) { logger.warn('[WORKLOAD-SVC] standup_entries non disponibili:', e.message); }

  var pva = { byUser: {}, byProject: {} };
  var weekLogs = [];
  try {
    pva = await db.getPlannedVsActual(weekStart);
    weekLogs = await db.getWeekLogs(weekStart);
  } catch(e) { logger.warn('[WORKLOAD-SVC] time_logs non disponibili:', e.message); }

  return buildOverview(standupAgg, pva, weekLogs, weekStart, weekEnd);
}

// Righe time_logs derivate dai task "oggi" (fatto) del daily unico delle
// 16:00: solo i task agganciati a un progetto contribuiscono al consuntivo
// per progetto. Pura e testabile; la scrittura la fa dailyStandupV2.
function deriveTimeLogRows(oggiTasks, userId, dateStr) {
  var byProject = {};
  (oggiTasks || []).forEach(function(t) {
    if (!t || !t.project_id) return;
    var h = (parseInt(t.hours, 10) || 0) + (parseInt(t.minutes, 10) || 0) / 60;
    if (h <= 0) return;
    byProject[t.project_id] = (byProject[t.project_id] || 0) + h;
  });
  return Object.keys(byProject).map(function(pid) {
    return {
      slack_user_id: userId,
      project_id: pid,
      log_date: dateStr,
      log_type: 'daily',
      hours: Math.round(byProject[pid] * 100) / 100,
      notes: 'auto: dal daily',
      validation: null,
    };
  });
}

module.exports = {
  getWeekOverview: getWeekOverview,
  buildOverview: buildOverview,
  deriveTimeLogRows: deriveTimeLogRows,
};
