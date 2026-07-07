// ─── Tracking config ──────────────────────────────────────────────────────────
// Configurazione condivisa tra Daily Standup V2 e Daily Check-in: prima le
// esclusioni erano due liste hardcoded duplicate (dailyStandupV2.js e
// timeTracking.js) che potevano divergere. Override senza deploy via env:
//   TRACKING_EXCLUDED_NAMES="antonio,gloria,corrado,cellulare,telefono"
'use strict';

var DEFAULT_EXCLUDED = ['antonio', 'gloria', 'corrado', 'cellulare', 'telefono'];

function excludedNamePatterns() {
  var raw = process.env.TRACKING_EXCLUDED_NAMES;
  if (!raw || !raw.trim()) return DEFAULT_EXCLUDED;
  return raw.split(',')
    .map(function(s) { return s.trim().toLowerCase(); })
    .filter(Boolean);
}

// Match case-insensitive su substring del nome (stessa semantica storica).
function isExcludedName(name) {
  var n = (name || '').toLowerCase();
  if (!n) return false;
  return excludedNamePatterns().some(function(p) { return n.indexOf(p) !== -1; });
}

module.exports = {
  excludedNamePatterns: excludedNamePatterns,
  isExcludedName: isExcludedName,
};
