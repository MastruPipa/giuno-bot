// ─── Tracking Dates ──────────────────────────────────────────────────────────
// Pure date helpers for the workload/progress tracking system (time_logs).
// All inputs/outputs are YYYY-MM-DD strings; "today/now" are Europe/Rome,
// matching the cron schedule TZ — same rationale as dailyStandupV2.oggi().
'use strict';

// YYYY-MM-DD di oggi in Europe/Rome
function oggiRome() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date());
}

// 'HH:mm' adesso in Europe/Rome (confronto lessicografico ok: '09:29' < '09:30')
function oraRome() {
  return new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
}

// Mezzogiorno UTC: immune da DST quando si fa aritmetica di giorni
function toUTCNoon(dateStr) {
  return new Date(dateStr + 'T12:00:00Z');
}

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  var d = toUTCNoon(dateStr);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}

// 0=domenica ... 6=sabato
function dayOfWeek(dateStr) {
  return toUTCNoon(dateStr).getUTCDay();
}

function isWorkingDay(dateStr) {
  var dw = dayOfWeek(dateStr);
  return dw >= 1 && dw <= 5;
}

// Lunedì successivo alla data (mai la data stessa: da lunedì → lunedì +7)
function nextMonday(dateStr) {
  var dw = dayOfWeek(dateStr);
  var diff = ((8 - dw) % 7) || 7;
  return addDays(dateStr, diff);
}

// Lunedì della settimana a cui appartiene la data
function weekStartOf(dateStr) {
  var dw = dayOfWeek(dateStr);
  return addDays(dateStr, -((dw + 6) % 7));
}

// Giorno lavorativo precedente (lun-ven): da lunedì → venerdì scorso
function previousWorkingDay(dateStr) {
  var d = addDays(dateStr, -1);
  while (!isWorkingDay(d)) d = addDays(d, -1);
  return d;
}

module.exports = {
  oggiRome: oggiRome,
  oraRome: oraRome,
  addDays: addDays,
  dayOfWeek: dayOfWeek,
  isWorkingDay: isWorkingDay,
  nextMonday: nextMonday,
  weekStartOf: weekStartOf,
  previousWorkingDay: previousWorkingDay,
};
