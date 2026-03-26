// ─── Date helpers ──────────────────────────────────────────────────────────────

'use strict';

/**
 * Returns today's date as YYYY-MM-DD string.
 */
function todayISO() {
  return new Date().toISOString().slice(0, 10);
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

module.exports = {
  todayISO: todayISO,
  hoursAgoTimestamp: hoursAgoTimestamp,
  daysAgoTimestamp: daysAgoTimestamp,
};
