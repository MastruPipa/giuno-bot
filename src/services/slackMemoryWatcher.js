// ─── Slack Memory Watcher ──────────────────────────────────────────────────────
// Passive listener: invalidates stale memories when completion signals detected.
// Fire-and-forget — never blocks main message handling.

'use strict';

var db = require('../../supabase');

var COMPLETION_SIGNALS = [
  /\b(fatto|completato|chiuso|consegnato|risolto|finito)\b/i,
  /\b(confermato|approvato|firmato)\b/i,
  /\b(won|acquired|cliente acquisito)\b/i,
  /\b(mandato|inviato|pubblicato|live|online)\b/i,
  /\b(non più|non serve più|cancellato|annullato)\b/i,
];

async function processSlackMessage(message, channelId) {
  var text = (message.text || '').trim();
  if (text.length < 10) return;

  var isCompletion = COMPLETION_SIGNALS.some(function(p) { return p.test(text); });
  if (!isCompletion) return;

  try {
    var memCache = db.getMemCache();
    var allUsers = Object.keys(memCache);
    var found = false;

    for (var ui = 0; ui < allUsers.length; ui++) {
      var mems = memCache[allUsers[ui]] || [];
      for (var mi = 0; mi < mems.length; mi++) {
        var m = mems[mi];
        if (m.superseded_by) continue;
        if (m.memory_type !== 'episodic' && m.memory_type !== 'intent' && m.memory_type !== undefined) continue;
        if (!/aspetta|in attesa|da fare|bloccato|pending|mancante/i.test(m.content || '')) continue;

        var memWords = (m.content || '').toLowerCase().split(/\W+/).filter(function(w) { return w.length > 4; });
        var msgWords = text.toLowerCase().split(/\W+/).filter(function(w) { return w.length > 4; });
        var shared = memWords.filter(function(w) { return msgWords.indexOf(w) !== -1; });
        if (shared.length >= 2) found = true;
      }
    }

    if (found) {
      // Save a completion signal memory — this triggers the invalidation cascade via addMemory
      db.addMemory(message.user, 'Segnale completamento: "' + text.substring(0, 100) + '"', ['signal:completion'], {
        memory_type: 'episodic',
        channelType: 'public',
        channelId: channelId,
        confidence_score: 0.4,
      });
      process.stdout.write('[slackMemoryWatcher] Completion signal detected\n');
    }
  } catch(e) {
    process.stdout.write('[slackMemoryWatcher] Error: ' + e.message + '\n');
  }
}

module.exports = { processSlackMessage: processSlackMessage };
