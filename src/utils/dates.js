// ─── Date helpers ──────────────────────────────────────────────────────────────
// Tutte le date "umane" del bot sono in Europe/Rome: il team è italiano e i
// cron girano in ora di Roma. Usare SEMPRE todayISO() (o daysFromTodayISO)
// invece di new Date().toISOString().slice(0,10): quella è la data UTC e tra
// le 23:00/01:00 ora italiana sbaglia giorno.

'use strict';

var TZ = 'Europe/Rome';

/**
 * Returns today's date as YYYY-MM-DD string (Europe/Rome).
 */
function todayISO() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date());
}

/**
 * YYYY-MM-DD a N giorni da oggi (Roma). n può essere negativo.
 * Aritmetica a mezzogiorno UTC: immune da DST.
 */
function daysFromTodayISO(n) {
  var d = new Date(todayISO() + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + (n || 0));
  return d.toISOString().slice(0, 10);
}

/**
 * YYYY-MM-DD del lunedì della settimana corrente (Roma).
 */
function mondayISO() {
  var dow = new Date(todayISO() + 'T12:00:00Z').getUTCDay(); // 0=dom
  return daysFromTodayISO(-((dow + 6) % 7));
}

/**
 * Returns Unix timestamp (seconds) for N hours ago.
 */
function hoursAgoTimestamp(hours) {
  return String(Math.floor((Date.now() - hours * 60 * 60 * 1000) / 1000));
}

/**
 * Returns Unix timestamp (seconds) for N days ago.
 */
function daysAgoTimestamp(days) {
  return String(Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000));
}

/**
 * Riga di contesto temporale da iniettare nei prompt LLM: giorno della
 * settimana + data ISO + anno esplicito. Senza l'anno esplicito il modello
 * ancora le date relative ("entro il 15") all'anno sbagliato, specialmente
 * a cavallo di dicembre/gennaio.
 */
function dateContextIt() {
  var now = new Date();
  var weekday = new Intl.DateTimeFormat('it-IT', { timeZone: TZ, weekday: 'long' }).format(now);
  var time = new Intl.DateTimeFormat('it-IT', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);
  var iso = todayISO();
  return 'Oggi è ' + weekday + ' ' + iso + ', ore ' + time + ' (Europe/Rome). Anno corrente: ' + iso.slice(0, 4) + '.';
}

/**
 * Età in formato umano ("oggi", "ieri", "12 giorni fa", "~3 mesi fa",
 * "~2 anni fa") per etichettare memorie/KB nei prompt: senza l'età il
 * modello tratta un fatto del 2025 come verità attuale.
 * Ritorna null se la data non è interpretabile.
 */
function ageLabelIt(createdAt) {
  if (!createdAt) return null;
  var t = new Date(createdAt).getTime();
  if (isNaN(t)) return null;
  var days = Math.floor((Date.now() - t) / 86400000);
  if (days <= 0) return 'oggi';
  if (days === 1) return 'ieri';
  if (days < 30) return days + ' giorni fa';
  if (days < 365) {
    var months = Math.max(1, Math.round(days / 30));
    return '~' + months + (months === 1 ? ' mese fa' : ' mesi fa');
  }
  var years = Math.max(1, Math.round(days / 365));
  return '~' + years + (years === 1 ? ' anno fa' : ' anni fa');
}

/**
 * Valida una data ISO (YYYY-MM-DD) estratta da un LLM: formato corretto E
 * data reale (respinge 2026-99-99, 2026-02-31, ecc.).
 */
function isValidISODate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  var d = new Date(s + 'T12:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

module.exports = {
  todayISO: todayISO,
  daysFromTodayISO: daysFromTodayISO,
  mondayISO: mondayISO,
  hoursAgoTimestamp: hoursAgoTimestamp,
  daysAgoTimestamp: daysAgoTimestamp,
  dateContextIt: dateContextIt,
  ageLabelIt: ageLabelIt,
  isValidISODate: isValidISODate,
};
