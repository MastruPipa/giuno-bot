// ─── Safe call utilities ──────────────────────────────────────────────────────
// safeCall: esegue fn async loggando errori invece di silenziarli.
// safeParse: JSON.parse con fallback loggato.
'use strict';

var logger = require('./logger');

/**
 * safeCall(label, fn, fallback)
 * Esegue fn(). Se fallisce, logga warn e ritorna fallback.
 * @param {string}   label    — prefisso nel log, es. 'CTX.searchMemories'
 * @param {Function} fn       — funzione async da eseguire
 * @param {*}        fallback — valore di ritorno in caso di errore (default null)
 */
async function safeCall(label, fn, fallback) {
  try {
    return await fn();
  } catch (e) {
    logger.warn('[' + label + '] fallita:', e.message, e.stack || '');
    return (fallback !== undefined ? fallback : null);
  }
}

/**
 * safeParse(label, str, fallback)
 * JSON.parse con log warn se il JSON è malformato.
 * @param {string} label    — prefisso nel log
 * @param {string} str      — stringa da parsare
 * @param {*}      fallback — valore di ritorno in caso di errore (default null)
 */
function safeParse(label, str, fallback) {
  if (str == null) {
    logger.warn('[' + label + '] input null/undefined');
    return (fallback !== undefined ? fallback : null);
  }
  try {
    return JSON.parse(str);
  } catch (e) {
    logger.warn('[' + label + '] JSON malformato:', e.message, e.stack || '');
    return (fallback !== undefined ? fallback : null);
  }
}

module.exports = { safeCall: safeCall, safeParse: safeParse };
