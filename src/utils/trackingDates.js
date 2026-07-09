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

// Primo giorno del mese della data: '2026-07-15' → '2026-07-01'
function monthStartOf(dateStr) {
  return dateStr.slice(0, 8) + '01';
}

// Ultimo giorno del mese della data: primo del mese successivo − 1 giorno
function monthEndOf(dateStr) {
  var d = toUTCNoon(monthStartOf(dateStr));
  d.setUTCMonth(d.getUTCMonth() + 1);
  return addDays(fmt(d), -1);
}

// Primo giorno del trimestre solare della data: '2026-05-20' → '2026-04-01'
function quarterStartOf(dateStr) {
  var month = parseInt(dateStr.slice(5, 7), 10);
  var qMonth = month - ((month - 1) % 3);
  return dateStr.slice(0, 5) + (qMonth < 10 ? '0' : '') + qMonth + '-01';
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
  monthStartOf: monthStartOf,
  monthEndOf: monthEndOf,
  quarterStartOf: quarterStartOf,
};
