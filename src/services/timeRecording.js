'use strict';
var timeLogs = require('./db/timeLogs');
var dates = require('../utils/dates');
var context = require('../utils/requestContext');

// Both conversational tools set the same daily total. Additional work must
// first be reconciled with the existing total, never blindly incremented.
async function recordDailyTotal(input) {
  var date = input.date || dates.todayISO();
  var hours = input.hours;
  if (!input.userId || !input.projectId) return { error: 'Persona e progetto sono obbligatori.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date) return { error: 'Data non valida.' };
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0 || hours > 24 ||
      Math.abs(hours * 100 - Math.round(hours * 100)) > 0.000001) {
    return { error: 'Indica un totale giornaliero maggiore di zero e fino a 24 ore, con massimo due decimali.' };
  }
  var request = context.getRequestContext() || {};
  var rows = await timeLogs.saveTimeLogs([{
    slack_user_id: input.userId, project_id: input.projectId,
    log_date: date, log_type: 'daily', hours: hours, notes: input.notes || null,
    validation: { status: 'declared', source: 'slack',
      recorded_by: input.actorId || input.userId,
      request_id: request.requestId || null, channel_id: request.channelId || null,
      thread_ts: request.threadTs || null, billable: input.billable == null ? null : input.billable },
  }]);
  if (!rows || !rows.length) return { error: 'Ore non salvate. Il registro ore non è disponibile; nessun successo confermato.' };
  var allocation = await timeLogs.syncAllocationHoursLogged(input.userId, input.projectId, date);
  return { success: true, entry: rows[0], hours_logged: rows[0].hours,
    user: input.userId, project: input.projectId, date: date,
    mode: 'daily_total', cost: null,
    warning: allocation === null ? 'Ore salvate; riepilogo allocazioni da riallineare.' : undefined };
}
module.exports = { recordDailyTotal: recordDailyTotal };
