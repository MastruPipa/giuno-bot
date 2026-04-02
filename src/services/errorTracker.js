// ─── Error Pattern Tracker ──────────────────────────────────────────────────
// Tracks repeated errors/mistakes. If Giuno makes the same mistake 3+ times,
// injects a warning into the context so it asks for confirmation.
'use strict';

var logger = require('../utils/logger');

// In-memory cache — flushed to DB periodically
var _patterns = {}; // patternKey -> { count, lastError, lastUser }

function extractPatternKey(message, errorType) {
  // Extract a normalized key from the error context
  var words = (message || '').toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(function(w) { return w.length > 4; })
    .slice(0, 5)
    .sort()
    .join('_');
  return (errorType || 'unknown') + ':' + words;
}

function recordError(message, errorType, userId) {
  var key = extractPatternKey(message, errorType);
  if (!_patterns[key]) {
    _patterns[key] = { count: 0, lastError: null, lastUser: null, firstSeen: Date.now() };
  }
  _patterns[key].count++;
  _patterns[key].lastError = (message || '').substring(0, 200);
  _patterns[key].lastUser = userId;
  _patterns[key].lastSeen = Date.now();

  if (_patterns[key].count >= 3) {
    logger.warn('[ERROR-TRACKER] Repeated error (' + _patterns[key].count + 'x):', key);
  }

  // Flush to DB if available
  try {
    var dbClient = require('./db/client');
    var supabase = dbClient.getClient();
    if (supabase) {
      supabase.from('error_patterns').upsert({
        pattern_key: key,
        error_count: _patterns[key].count,
        last_error: _patterns[key].lastError,
        last_user: userId,
        last_seen: new Date().toISOString(),
      }).then(function() {}).catch(function() {});
    }
  } catch(e) { /* ignore */ }
}

function getErrorWarnings(message) {
  // Check if this message topic has known error patterns
  var warnings = [];
  var msgWords = (message || '').toLowerCase().split(/\s+/).filter(function(w) { return w.length > 4; });

  for (var key in _patterns) {
    if (_patterns[key].count < 3) continue;
    var keyWords = key.split(':')[1].split('_');
    var overlap = keyWords.filter(function(kw) {
      return msgWords.some(function(mw) { return mw.includes(kw) || kw.includes(mw); });
    });
    if (overlap.length >= 2) {
      warnings.push({
        pattern: key,
        count: _patterns[key].count,
        lastError: _patterns[key].lastError,
      });
    }
  }
  return warnings;
}

// Load from DB on startup
async function loadPatterns() {
  try {
    var dbClient = require('./db/client');
    var supabase = dbClient.getClient();
    if (!supabase) return;
    var { data } = await supabase.from('error_patterns').select('*').gt('error_count', 1).limit(50);
    if (data) {
      data.forEach(function(row) {
        _patterns[row.pattern_key] = {
          count: row.error_count,
          lastError: row.last_error,
          lastUser: row.last_user,
          firstSeen: new Date(row.first_seen).getTime(),
          lastSeen: new Date(row.last_seen).getTime(),
        };
      });
      logger.info('[ERROR-TRACKER] Loaded', data.length, 'error patterns from DB');
    }
  } catch(e) { /* table may not exist yet */ }
}

module.exports = {
  recordError: recordError,
  getErrorWarnings: getErrorWarnings,
  loadPatterns: loadPatterns,
};
