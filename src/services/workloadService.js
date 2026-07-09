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

// Merge puro (testabile senza DB) delle tre serie su un intervallo di date
// arbitrario (storicamente la settimana, da cui i nomi legacy week_start/end).
// standupAgg: output di aggregateStandupRows; pva: output di foldPlannedVsActual;
// rangeLogs: righe raw time_logs del periodo (per contare i giorni con check-in).
function buildOverview(standupAgg, pva, rangeLogs, dateFrom, dateTo) {
  var workdays = workdaysBetween(dateFrom, dateTo);
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
  (rangeLogs || []).forEach(function(r) {
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
    // Chiavi legacy (consumate da weeklyReport e test esistenti) + alias range.
    week_start: dateFrom,
    week_end: dateTo,
    date_from: dateFrom,
    date_to: dateTo,
    periodo: 'dal ' + dateFrom + ' al ' + dateTo + ' (' + workdays + ' giorni lavorativi)',
    workdays: workdays,
    byUser: byUser,
    // Il dettaglio per progetto dei consuntivi resta quello di getPlannedVsActual
    pva: pva || { byUser: {}, byProject: {} },
    legenda: 'dichiarato (estimated_hours) = ore reali dichiarate nel daily delle 16:00 (tutti i task); ' +
      'effettivo (actual_hours) = time_logs per progetto, auto-derivati dai task del daily agganciati a un progetto; ' +
      'pianificato = weekly planner. carico (ok/pieno/sovraccarico) è calcolato sul dichiarato dei giorni con daily compilato.',
  };
}

// Panoramica su un intervallo di date arbitrario, con filtri opzionali:
// opts = { userId, projectId, projectName }. I filtri restringono le serie;
// totals_all resta calcolato sull'intero periodo non filtrato (serve al
// drill-down per la "% del totale").
async function getRangeOverview(dateFrom, dateTo, opts) {
  opts = opts || {};

  var standupAgg = null;
  try {
    var supabase = dbClient.getClient();
    if (supabase) {
      var q = supabase.from('standup_entries')
        .select('slack_user_id, date, ieri_tasks, oggi_tasks, total_hours_ieri, total_hours_oggi')
        .gte('date', dateFrom).lte('date', dateTo);
      if (opts.userId) q = q.eq('slack_user_id', opts.userId);
      var res = await q;
      var aggInput = opts.projectName ? { project: opts.projectName } : {};
      if (!res.error) standupAgg = aggregateStandupRows(res.data || [], aggInput, dateFrom, dateTo);
    }
  } catch(e) { logger.warn('[WORKLOAD-SVC] standup_entries non disponibili:', e.message); }

  var pva = { byUser: {}, byProject: {} };
  var totalsAll = { actual: 0, planned: 0 };
  var rangeLogs = [];
  var truncated = false;
  try {
    var allRows = await db.getRangeLogs(dateFrom, dateTo);
    truncated = allRows.length >= db.RANGE_LOGS_LIMIT;
    var allPva = db.foldPlannedVsActual(allRows);
    Object.keys(allPva.byProject).forEach(function(pid) {
      totalsAll.actual += allPva.byProject[pid].actual;
      totalsAll.planned += allPva.byProject[pid].planned;
    });
    rangeLogs = allRows.filter(function(r) {
      if (opts.userId && r.slack_user_id !== opts.userId) return false;
      if (opts.projectId && r.project_id !== opts.projectId) return false;
      return true;
    });
    pva = db.foldPlannedVsActual(rangeLogs);
  } catch(e) { logger.warn('[WORKLOAD-SVC] time_logs non disponibili:', e.message); }

  var overview = buildOverview(standupAgg, pva, rangeLogs, dateFrom, dateTo);
  // Il pianificato ha granularità settimanale: su range non allineati alla
  // settimana il confronto con l'effettivo è indicativo (vedi dashboard).
  overview.week_aligned = dateFrom === trackingDates.weekStartOf(dateFrom) &&
    dateTo === trackingDates.addDays(trackingDates.weekStartOf(dateTo), 6);
  overview.totals_all = { actual: Math.round(totalsAll.actual * 10) / 10, planned: Math.round(totalsAll.planned * 10) / 10 };
  overview.truncated = truncated;
  return overview;
}

// Panoramica completa della settimana che inizia a weekStart (lunedì).
async function getWeekOverview(weekStart) {
  return getRangeOverview(weekStart, trackingDates.addDays(weekStart, 6), {});
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
  getRangeOverview: getRangeOverview,
  buildOverview: buildOverview,
  deriveTimeLogRows: deriveTimeLogRows,
};
