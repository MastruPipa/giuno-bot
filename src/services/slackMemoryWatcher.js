// ─── Slack Memory Watcher V2 ──────────────────────────────────────────────────
// Passive listener on ALL channel messages. Learns from conversations.
// 1. Detects completion signals → invalidates stale memories
// 2. Detects important info → saves to KB (decisions, deadlines, client info)
// 3. Tracks behavioral patterns
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

// Patterns that indicate something worth remembering from channels
var IMPORTANT_PATTERNS = [
  { pattern: /entro (il |domani|luned|marted|mercoled|gioved|venerd|\d)/i, type: 'deadline', tag: 'tipo:deadline' },
  { pattern: /deciso|abbiamo deciso|si fa|approvato|confermato che/i, type: 'decision', tag: 'tipo:decisione' },
  { pattern: /bloccat[oi]|bloccato da|serve aiuto|non riesco|problema con/i, type: 'blocker', tag: 'tipo:blocco' },
  { pattern: /cliente (ha detto|vuole|chiede|ha chiesto|preferisce)/i, type: 'client_feedback', tag: 'tipo:feedback_cliente' },
  { pattern: /budget|preventivo|€\s*\d|\d+\s*€/i, type: 'financial', tag: 'tipo:finanziario' },
  { pattern: /meeting|call|riunione|brainstorm/i, type: 'meeting', tag: 'tipo:meeting' },
  { pattern: /nuovo (cliente|progetto|fornitore|collaboratore)/i, type: 'new_entity', tag: 'tipo:nuovo' },
  { pattern: /cambiamento|cambio|modifica|aggiornamento importante/i, type: 'change', tag: 'tipo:cambiamento' },
];

// Rate limiting: don't save more than 3 items per channel per hour
var _rateLimits = {}; // channelId -> { count, resetAt }
var RATE_LIMIT = 3;
var RATE_WINDOW = 60 * 60 * 1000;

function checkRateLimit(channelId) {
  var now = Date.now();
  var entry = _rateLimits[channelId];
  if (!entry || now > entry.resetAt) {
    _rateLimits[channelId] = { count: 1, resetAt: now + RATE_WINDOW };
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

async function processSlackMessage(message, channelId) {
  var text = (message.text || '').trim();
  if (text.length < 15) return;
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
        });
        logger.debug('[MEM-WATCHER] Completion signal detected');
      }
    } catch(e) { logger.debug('[MEM-WATCHER] Completion check error:', e.message); }
  }

  // 2. Important patterns — save to KB
  if (!checkRateLimit(channelId)) return; // Don't flood

  var matchedPatterns = IMPORTANT_PATTERNS.filter(function(p) { return p.pattern.test(text); });
  if (matchedPatterns.length === 0) return;

  // Only save if it has substance (not just a keyword match on a short message)
  if (text.length < 30) return;

  try {
    var channelMap = db.getChannelMapCache();
    var chMapping = channelMap[channelId] || {};
    var channelName = chMapping.channel_name || 'unknown';
    var tags = matchedPatterns.map(function(p) { return p.tag; });
    tags.push('canale:' + channelName);
    if (chMapping.cliente) tags.push('cliente:' + chMapping.cliente.toLowerCase());
    if (chMapping.progetto) tags.push('progetto:' + chMapping.progetto.toLowerCase());

    // Save as KB entry (low confidence, auto_learn tier)
    var content = '[#' + channelName + '] ' + text.substring(0, 300);
    db.addKBEntry(content, tags, userId || 'slack-watcher', {
      confidenceTier: 'auto_learn',
      sourceType: 'slack',
      sourceChannelId: channelId,
      sourceChannelType: 'public',
    });
    logger.debug('[MEM-WATCHER] Saved from #' + channelName + ':', text.substring(0, 50));
  } catch(e) { logger.debug('[MEM-WATCHER] Save error:', e.message); }
}

module.exports = { processSlackMessage: processSlackMessage };
