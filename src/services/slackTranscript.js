// ─── Slack Transcript ────────────────────────────────────────────────────────
// La "memoria di lavoro" di Giuno è la conversazione Slack stessa, non una
// copia interna. Prima il bot teneva una storia per (utente, thread): in un
// thread con tre persone vedeva tre conversazioni separate e perdeva tutto
// quello che gli altri si dicevano tra loro; in DM la storia era un blob con
// dentro anche il contesto iniettato ad ogni turno. Qui:
//
//   1. conversationKey  — una chiave per conversazione Slack, condivisa tra
//                         tutti i partecipanti di un thread.
//   2. messagesToTurns  — converte i messaggi Slack (conversations.replies /
//                         conversations.history) nei turni user/assistant che
//                         il modello vede come storia. Funzione pura, testata.
//   3. fetchTranscript  — chiede a Slack il thread/DM corrente e restituisce
//                         i turni (esclude il messaggio in elaborazione).
//   4. getBotUserId     — id utente del bot, risolto una volta via auth.test.
//
// Slack è la fonte di verità: dopo un riavvio o un deploy Giuno ritrova il
// filo esattamente dove lo vedono le persone.

'use strict';

var logger = require('../utils/logger');

var DEFAULT_THREAD_LIMIT = 60;
var DEFAULT_DM_LIMIT = 30;
var DEFAULT_MAX_CHARS = 14000;
var PER_MESSAGE_MAX_CHARS = 1500;

// ─── Bot user id ─────────────────────────────────────────────────────────────

var _botUserId = process.env.GIUNO_BOT_USER_ID || null;
var _botUserIdPromise = null;

async function getBotUserId(app) {
  if (_botUserId) return _botUserId;
  if (!app || !app.client) return null;
  if (!_botUserIdPromise) {
    _botUserIdPromise = app.client.auth.test()
      .then(function(res) {
        _botUserId = (res && res.user_id) || null;
        if (_botUserId) logger.info('[TRANSCRIPT] bot user id:', _botUserId);
        return _botUserId;
      })
      .catch(function(e) {
        logger.warn('[TRANSCRIPT] auth.test fallita:', e.message);
        _botUserIdPromise = null;
        return null;
      });
  }
  return _botUserIdPromise;
}

function setBotUserIdForTests(id) { _botUserId = id; _botUserIdPromise = null; }

// ─── Conversation key ────────────────────────────────────────────────────────
// DM senza thread      → userId                (compatibile con lo storico)
// DM con thread        → userId:threadTs       (compatibile)
// thread in canale     → thread:channelId:ts   (CONDIVISA tra i partecipanti)
// canale senza thread  → userId                (slash command, fallback)

function conversationKey(opts) {
  opts = opts || {};
  var userId = opts.userId || 'unknown';
  var channelId = opts.channelId || null;
  var threadTs = opts.threadTs || null;
  var isDM = opts.isDM != null ? !!opts.isDM : (!channelId || String(channelId).charAt(0) === 'D');
  if (!threadTs) return userId;
  if (isDM) return userId + ':' + threadTs;
  return 'thread:' + channelId + ':' + threadTs;
}

// Chiave legacy (per utente) dello stesso thread, usata come fallback in
// lettura finché le conversazioni vecchie non vengono naturalmente superate.
function legacyConversationKey(opts) {
  opts = opts || {};
  return opts.threadTs ? (opts.userId || 'unknown') + ':' + opts.threadTs : (opts.userId || 'unknown');
}

// ─── Slack messages → model turns ────────────────────────────────────────────

function _truncate(text, max) {
  text = String(text || '');
  if (text.length <= max) return text;
  return text.substring(0, max) + ' […]';
}

function _describeFiles(files) {
  if (!Array.isArray(files) || files.length === 0) return '';
  return files.map(function(f) {
    return '[file: ' + ((f && (f.title || f.name)) || 'allegato') + ']';
  }).join(' ');
}

/**
 * messagesToTurns(slackMessages, opts)
 * @param {Array}  slackMessages — messaggi Slack in ordine cronologico
 * @param {Object} opts
 *   - botUserId   : id del bot (i suoi messaggi diventano turni assistant)
 *   - excludeTs   : ts del messaggio corrente (già passato come ultimo turno)
 *   - labelAuthors: true nei thread di canale (prefisso "<@U> (Nome): ")
 *   - resolveName : fn(userId) → nome o null
 *   - maxChars    : budget totale caratteri (si tiene la coda più recente)
 * @returns {Array<{role, content}>} turni alternati, primo turno sempre user
 */
function messagesToTurns(slackMessages, opts) {
  opts = opts || {};
  var botUserId = opts.botUserId || null;
  var maxChars = opts.maxChars || DEFAULT_MAX_CHARS;
  var resolveName = typeof opts.resolveName === 'function' ? opts.resolveName : function() { return null; };
  var turns = [];

  (slackMessages || []).forEach(function(m) {
    if (!m) return;
    if (opts.excludeTs && m.ts === opts.excludeTs) return;
    // Sottotipi di sistema (join, leave, pin, …) non sono conversazione.
    if (m.subtype && m.subtype !== 'thread_broadcast' && m.subtype !== 'file_share' && m.subtype !== 'bot_message') return;

    var isBot = !!(m.bot_id || (botUserId && m.user === botUserId));
    // Messaggi di ALTRI bot (integrazioni, reminder) restano come turni user
    // etichettati: non sono parole di Giuno. Se non conosciamo l'id del bot,
    // ogni messaggio bot viene trattato come nostro (comportamento precedente).
    var isGiuno = botUserId ? (m.user === botUserId) : isBot;
    var text = String(m.text || '').trim();
    var files = _describeFiles(m.files);
    if (files) text = (text ? text + ' ' : '') + files;
    if (!text) return;
    text = _truncate(text, PER_MESSAGE_MAX_CHARS);

    if (isGiuno) {
      turns.push({ role: 'assistant', content: text });
      return;
    }

    var label = '';
    if (isBot) {
      label = '[bot ' + (m.username || m.bot_profile && m.bot_profile.name || 'integrazione') + ']: ';
    } else if (opts.labelAuthors && m.user) {
      var name = resolveName(m.user);
      label = '<@' + m.user + '>' + (name ? ' (' + name + ')' : '') + ': ';
    }
    turns.push({ role: 'user', content: label + text });
  });

  // Unisci turni consecutivi dello stesso ruolo (più messaggi di fila).
  var merged = [];
  turns.forEach(function(t) {
    var last = merged[merged.length - 1];
    if (last && last.role === t.role) last.content += '\n' + t.content;
    else merged.push({ role: t.role, content: t.content });
  });

  // Budget caratteri: si tiene la coda (il recente conta di più).
  var total = 0;
  var kept = [];
  for (var i = merged.length - 1; i >= 0; i--) {
    total += merged[i].content.length;
    if (total > maxChars && kept.length > 0) break;
    kept.unshift(merged[i]);
  }

  // La API vuole che il primo turno sia user.
  if (kept.length > 0 && kept[0].role === 'assistant') {
    kept.unshift({ role: 'user', content: '[inizio della conversazione — il primo messaggio è tuo]' });
  }
  return kept;
}

// ─── Fetch from Slack ────────────────────────────────────────────────────────

function _rosterResolver() {
  try {
    var db = require('../../supabase');
    var roster = db.getTeamRoster ? db.getTeamRoster() : [];
    var byId = {};
    (roster || []).forEach(function(r) { if (r && r.slack_user_id) byId[r.slack_user_id] = r.canonical_name; });
    return function(uid) { return byId[uid] || null; };
  } catch(_) {
    return function() { return null; };
  }
}

/**
 * fetchTranscript(app, opts)
 *   - channelId, threadTs, isDM, excludeTs, limit
 * Ritorna { turns, source } — turns vuoto se non c'è storia (mention top-level
 * in canale) o se Slack non risponde (source: 'unavailable').
 */
async function fetchTranscript(app, opts) {
  opts = opts || {};
  if (!app || !app.client || !opts.channelId) return { turns: [], source: 'none' };
  var isDM = opts.isDM != null ? !!opts.isDM : String(opts.channelId).charAt(0) === 'D';
  var botUserId = await getBotUserId(app);
  var resolveName = _rosterResolver();

  try {
    var messages;
    if (opts.threadTs) {
      var rep = await app.client.conversations.replies({
        channel: opts.channelId, ts: opts.threadTs, limit: opts.limit || DEFAULT_THREAD_LIMIT,
      });
      messages = rep.messages || [];
    } else if (isDM) {
      var hist = await app.client.conversations.history({
        channel: opts.channelId, limit: opts.limit || DEFAULT_DM_LIMIT,
      });
      // history è dal più recente; teniamo solo i messaggi top-level del DM
      messages = (hist.messages || []).slice().reverse().filter(function(m) {
        return !m.thread_ts || m.thread_ts === m.ts;
      });
    } else {
      return { turns: [], source: 'none' };
    }
    var turns = messagesToTurns(messages, {
      botUserId: botUserId,
      excludeTs: opts.excludeTs,
      labelAuthors: !isDM,
      resolveName: resolveName,
      maxChars: opts.maxChars,
    });
    return { turns: turns, source: opts.threadTs ? 'thread' : 'dm' };
  } catch(e) {
    logger.warn('[TRANSCRIPT] lettura Slack fallita (' + opts.channelId + '):', e.message);
    return { turns: [], source: 'unavailable' };
  }
}

module.exports = {
  conversationKey: conversationKey,
  legacyConversationKey: legacyConversationKey,
  messagesToTurns: messagesToTurns,
  fetchTranscript: fetchTranscript,
  getBotUserId: getBotUserId,
  setBotUserIdForTests: setBotUserIdForTests,
};
