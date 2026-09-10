// ─── Slack Memory Watcher V2 ──────────────────────────────────────────────────
// Passive listener on ALL channel messages. Learns from conversations.
// 1. Detects completion signals → invalidates stale memories
// 2. Tracks behavioral patterns (il salvataggio in KB è del realTimeListener)
// Fire-and-forget — never blocks main message handling.

'use strict';

var db = require('../../supabase');
var logger = require('../utils/logger');

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
  var userId = message.user;

  // Track behavior (fire-and-forget)
  try {
    var behaviorTracker = require('./behaviorTracker');
    behaviorTracker.trackInteraction(userId, text, { channelId: channelId, isDM: false });
  } catch(e) { /* ignore */ }

  // 1. Completion signals — invalidate stale memories
  var isCompletion = COMPLETION_SIGNALS.some(function(p) { return p.test(text); });
  if (isCompletion) {
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
        db.addMemory(userId, 'Segnale completamento: "' + text.substring(0, 100) + '"', ['signal:completion'], {
          memory_type: 'episodic', channelType: 'public', channelId: channelId, confidence_score: 0.4,
          threadTs: message.thread_ts || null,
        });
        logger.debug('[MEM-WATCHER] Completion signal detected');
      }
    } catch(e) { logger.debug('[MEM-WATCHER] Completion check error:', e.message); }
  }

  // 2. (Rimosso, ricalibrazione 2026-09) Il dump regex dei messaggi in KB:
  // qualsiasi messaggio >100 caratteri o contenente "call", "modifica",
  // "cliente"... finiva in knowledge_base come testo grezzo, fino a 15 volte
  // l'ora per canale. Era la prima fonte di rumore nel retrieval. L'estrazione
  // dai canali la fa il realTimeListener (batch + triage AI), che salva solo
  // fatti operativi in una frase.
}

module.exports = { processSlackMessage: processSlackMessage };
