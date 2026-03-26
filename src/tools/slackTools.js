// ─── Slack Tools ───────────────────────────────────────────────────────────────
// get_slack_users, send_dm, set_user_prefs, search_slack_messages,
// summarize_channel, summarize_thread, get_channel_map, create_poll

'use strict';

require('dotenv').config();

var db = require('../../supabase');
var logger = require('../utils/logger');
var { SLACK_FORMAT_RULES } = require('../utils/slackFormat');

// Lazy-loaded to avoid circular deps at module load time
function getApp() { return require('../services/slackService').app; }
function getAnthropic() { return require('../services/anthropicService').client; }
function getUtenti() { return require('../services/slackService').getUtenti(); }

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Paginated conversations.list — fetches ALL channels
async function getAllChannels(app) {
  var all = [];
  var cursor = undefined;
  do {
    var res = await app.client.conversations.list({
      limit: 200,
      types: 'public_channel,private_channel',
      cursor: cursor,
    });
    all = all.concat(res.channels || []);
    cursor = res.response_metadata && res.response_metadata.next_cursor;
  } while (cursor);
  return all;
}

// Paginated conversations.history — fetches up to maxMessages
async function getChannelHistory(app, channelId, oldest, maxMessages) {
  maxMessages = maxMessages || 300;
  var all = [];
  var cursor = undefined;
  do {
    var opts = { channel: channelId, limit: 200 };
    if (oldest) opts.oldest = oldest;
    if (cursor) opts.cursor = cursor;
    var res = await app.client.conversations.history(opts);
    all = all.concat(res.messages || []);
    cursor = res.response_metadata && res.response_metadata.next_cursor;
  } while (cursor && all.length < maxMessages);
  return all.slice(0, maxMessages);
}

// Resolve user ID to display name (with cache)
async function resolveUserName(app, userId, cache) {
  if (cache[userId]) return cache[userId];
  try {
    var uRes = await app.client.users.info({ user: userId });
    cache[userId] = uRes.user.real_name || uRes.user.name;
  } catch(e) {
    cache[userId] = userId;
  }
  return cache[userId];
}

// ─── Preferences helpers ───────────────────────────────────────────────────────

function getPrefs(userId) {
  return Object.assign(
    { routine_enabled: true, notifiche_enabled: true, standup_enabled: true },
    db.getPrefsCache()[userId] || {}
  );
}

function setPrefs(userId, prefs) {
  var merged = Object.assign(getPrefs(userId), prefs);
  db.savePrefs(userId, merged);
}

// ─── Tool definitions ──────────────────────────────────────────────────────────

var definitions = [
  {
    name: 'get_slack_users',
    description: 'Ottieni utenti Slack con nome, ID e email. Usalo per trovare email di colleghi o ID per taggarli.',
    input_schema: {
      type: 'object',
      properties: {
        name_filter: { type: 'string', description: 'Filtra per nome (opzionale)' },
      },
    },
  },
  {
    name: 'send_dm',
    description: 'Invia un messaggio diretto (DM) a un collega su Slack. Usalo quando l\'utente chiede di scrivere, mandare un messaggio, avvisare o comunicare qualcosa a qualcuno. ' +
      'Esegui SUBITO senza chiedere conferma. ' +
      'Puoi passare lo slack_user_id se lo conosci, oppure il nome della persona (Giuno cercherà l\'ID).',
    input_schema: {
      type: 'object',
      properties: {
        target_user_id:   { type: 'string', description: 'Slack user ID del destinatario (se noto)' },
        target_user_name: { type: 'string', description: 'Nome del destinatario (usato per cercare l\'ID se target_user_id non fornito)' },
        message:          { type: 'string', description: 'Testo del messaggio da inviare' },
      },
      required: ['message'],
    },
  },
  {
    name: 'set_user_prefs',
    description: 'Aggiorna le preferenze dell\'utente per Giuno (routine mattutina, notifiche proattive, standup).',
    input_schema: {
      type: 'object',
      properties: {
        routine_enabled:   { type: 'boolean', description: 'Abilita/disabilita la routine del mattino' },
        notifiche_enabled: { type: 'boolean', description: 'Abilita/disabilita le notifiche proattive' },
        standup_enabled:   { type: 'boolean', description: 'Abilita/disabilita la domanda standup giornaliera' },
      },
    },
  },
  {
    name: 'search_slack_messages',
    description: 'Cerca messaggi nei canali Slack. Utile per ritrovare decisioni, link, o conversazioni passate.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Testo da cercare (supporta operatori Slack: in:#canale, from:@utente, before:, after:, has:link)' },
        max:   { type: 'number', description: 'Numero massimo risultati (default 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'summarize_channel',
    description: 'Riassume cosa è successo in un canale Slack nelle ultime ore/giorni. Perfetto per "cosa mi sono perso in #canale?".',
    input_schema: {
      type: 'object',
      properties: {
        channel_name: { type: 'string', description: 'Nome del canale (senza #)' },
        hours:        { type: 'number', description: 'Quante ore indietro guardare (default 24)' },
      },
      required: ['channel_name'],
    },
  },
  {
    name: 'summarize_thread',
    description: 'Riassume un thread Slack lungo. Serve il channel ID e il timestamp del thread.',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'ID del canale' },
        thread_ts:  { type: 'string', description: 'Timestamp del messaggio parent del thread' },
      },
      required: ['channel_id', 'thread_ts'],
    },
  },
  {
    name: 'get_channel_map',
    description: 'Restituisce la mappa canale → cliente/progetto per un canale specifico.',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'ID del canale Slack' },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'create_poll',
    description: 'Posta un sondaggio in un canale Slack con emoji come opzioni di voto.',
    input_schema: {
      type: 'object',
      properties: {
        channel:  { type: 'string', description: 'Nome o ID del canale (es. "generale" o "C012AB3CD")' },
        question: { type: 'string', description: 'Domanda del sondaggio' },
        options:  { type: 'array', items: { type: 'string' }, description: 'Lista di opzioni (max 10)' },
      },
      required: ['channel', 'question', 'options'],
    },
  },
];

// ─── Tool execution ────────────────────────────────────────────────────────────

async function execute(toolName, input, userId) {
  var app = getApp();

  if (toolName === 'get_slack_users') {
    try {
      var utenti = await getUtenti();
      var filtered = utenti;
      if (input.name_filter) {
        var f = input.name_filter.toLowerCase();
        filtered = utenti.filter(function(u) { return u.name.toLowerCase().includes(f); });
      }
      return { users: filtered };
    } catch(e) { return { error: e.message }; }
  }

  if (toolName === 'send_dm') {
    if (!input.target_user_id) {
      if (input.target_user_name) {
        try {
          var allUsers = await getUtenti();
          var nameL = input.target_user_name.toLowerCase();
          var match = allUsers.find(function(u) { return u.name.toLowerCase().includes(nameL); });
          if (match) input.target_user_id = match.id;
        } catch(e) {}
      }
      if (!input.target_user_id) return { error: 'Destinatario non trovato. Specifica il nome esatto o lo Slack ID.' };
    }
    try {
      var convOpen = await app.client.conversations.open({ users: input.target_user_id });
      var dmChannelId = convOpen.channel.id;
      var dmResult = await app.client.chat.postMessage({ channel: dmChannelId, text: input.message });
      logger.info('[DM] Messaggio inviato a', input.target_user_id, 'da', userId);
      return { success: true, message: 'Messaggio inviato in DM.', target: input.target_user_id, ts: dmResult.ts };
    } catch(e) {
      logger.error('[DM] Errore invio:', e.message);
      return { error: 'Errore invio DM: ' + e.message };
    }
  }

  if (toolName === 'set_user_prefs') {
    setPrefs(userId, input);
    var prefs = getPrefs(userId);
    return {
      success: true,
      routine_enabled:   prefs.routine_enabled,
      notifiche_enabled: prefs.notifiche_enabled,
      standup_enabled:   prefs.standup_enabled,
    };
  }

  if (toolName === 'search_slack_messages') {
    try {
      var max = input.max || 20;
      var searchToken = process.env.SLACK_USER_TOKEN || process.env.SLACK_BOT_TOKEN;

      // Paginated search — fetch up to max results across pages
      var allMatches = [];
      var page = 1;
      var totalFetched = 0;
      while (totalFetched < max) {
        var pageCount = Math.min(max - totalFetched, 100);
        var res = await app.client.search.messages({
          token: searchToken,
          query: input.query,
          count: pageCount,
          page: page,
          sort: 'timestamp',
          sort_dir: 'desc',
        });
        var matches = (res.messages && res.messages.matches) || [];
        if (matches.length === 0) break;
        allMatches = allMatches.concat(matches);
        totalFetched += matches.length;
        page++;
        // Stop if we got all available results
        var total = (res.messages && res.messages.total) || 0;
        if (totalFetched >= total) break;
      }

      return {
        results: allMatches.slice(0, max).map(function(m) {
          return {
            text: (m.text || '').substring(0, 800),
            user: m.user || m.username,
            channel: m.channel ? m.channel.name : null,
            timestamp: m.ts,
            permalink: m.permalink,
          };
        }),
        total: (res && res.messages && res.messages.total) || allMatches.length,
      };
    } catch(e) {
      logger.error('[SEARCH-SLACK] Errore:', e.message);
      return { error: 'Errore ricerca Slack: ' + e.message + '. Nota: potrebbe servire un SLACK_USER_TOKEN con scope search:read.' };
    }
  }

  if (toolName === 'summarize_channel') {
    try {
      var hours = input.hours || 24;
      var oldest = String(Math.floor((Date.now() - hours * 60 * 60 * 1000) / 1000));

      // Paginated channel list
      var allChannels = await getAllChannels(app);
      var target = allChannels.find(function(c) { return c.name === input.channel_name; });
      if (!target) return { error: 'Canale #' + input.channel_name + ' non trovato.' };

      // Auto-join channel
      try { await app.client.conversations.join({ channel: target.id }); } catch(e) {}

      // Paginated history
      var allMsgs = await getChannelHistory(app, target.id, oldest, 300);
      var msgs = allMsgs.filter(function(m) { return !m.bot_id && m.type === 'message' && m.text; });
      if (msgs.length === 0) return { summary: 'Nessun messaggio nelle ultime ' + hours + ' ore in #' + input.channel_name + '.' };

      var userCache = {};
      var messagesText = '';
      for (var i = msgs.length - 1; i >= 0; i--) {
        var m = msgs[i];
        var userName = await resolveUserName(app, m.user, userCache);
        messagesText += userName + ': ' + m.text + '\n';
      }

      var summaryRes = await getAnthropic().messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        system: 'Sei un assistente che riassume conversazioni Slack in italiano. Fai un riassunto breve e strutturato: argomenti principali, decisioni prese, azioni da fare. Max 10 righe. ' + SLACK_FORMAT_RULES,
        messages: [{ role: 'user', content: 'Riassumi questa conversazione dal canale #' + input.channel_name + ' (ultime ' + hours + ' ore, ' + msgs.length + ' messaggi):\n\n' + messagesText.substring(0, 12000) }],
      });
      var summary = summaryRes.content[0].text;
      return { channel: input.channel_name, hours: hours, messages_count: msgs.length, summary: summary };
    } catch(e) { return { error: 'Errore: ' + e.message }; }
  }

  if (toolName === 'summarize_thread') {
    try {
      // Paginated thread replies
      var allReplies = [];
      var threadCursor = undefined;
      do {
        var opts = { channel: input.channel_id, ts: input.thread_ts, limit: 200 };
        if (threadCursor) opts.cursor = threadCursor;
        var threadRes = await app.client.conversations.replies(opts);
        allReplies = allReplies.concat(threadRes.messages || []);
        threadCursor = threadRes.response_metadata && threadRes.response_metadata.next_cursor;
      } while (threadCursor && allReplies.length < 500);

      var threadMsgs = allReplies.filter(function(m) { return m.text; });
      if (threadMsgs.length === 0) return { summary: 'Thread vuoto.' };

      var threadUserCache = {};
      var threadText = '';
      for (var j = 0; j < threadMsgs.length; j++) {
        var tm = threadMsgs[j];
        var tmName = await resolveUserName(app, tm.user, threadUserCache);
        threadText += tmName + ': ' + tm.text + '\n';
      }

      var threadSummaryRes = await getAnthropic().messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 400,
        system: 'Sei un assistente che riassume thread Slack in italiano. Riassunto breve: contesto, punti chiave, conclusione/decisione. Max 8 righe. ' + SLACK_FORMAT_RULES,
        messages: [{ role: 'user', content: 'Riassumi questo thread Slack (' + threadMsgs.length + ' messaggi):\n\n' + threadText.substring(0, 12000) }],
      });
      return { messages_count: threadMsgs.length, summary: threadSummaryRes.content[0].text };
    } catch(e) { return { error: 'Errore: ' + e.message }; }
  }

  if (toolName === 'get_channel_map') {
    var entry = db.getChannelMapCache()[input.channel_id];
    return entry ? { channel_id: input.channel_id, mapping: entry } : { channel_id: input.channel_id, mapping: null };
  }

  if (toolName === 'create_poll') {
    try {
      var POLL_EMOJIS = [':one:', ':two:', ':three:', ':four:', ':five:', ':six:', ':seven:', ':eight:', ':nine:', ':keycap_ten:'];
      var EMOJI_NAMES = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'keycap_ten'];
      var options = (input.options || []).slice(0, 10);
      var text = '*' + input.question + '*\n\n';
      options.forEach(function(opt, i) { text += POLL_EMOJIS[i] + ' ' + opt + '\n'; });
      var channelId = input.channel;
      if (!input.channel.match(/^[CG]/)) {
        var chanName = input.channel.replace(/^#/, '');
        try {
          var chanList = await getAllChannels(app);
          var found = chanList.find(function(c) { return c.name === chanName; });
          if (found) channelId = found.id;
        } catch(e) {}
      }
      var posted = await app.client.chat.postMessage({ channel: channelId, text: text });
      for (var pi = 0; pi < options.length; pi++) {
        try { await app.client.reactions.add({ channel: channelId, timestamp: posted.ts, name: EMOJI_NAMES[pi] }); } catch(e) {}
      }
      return { success: true, ts: posted.ts };
    } catch(e) { return { error: e.message }; }
  }

  return { error: 'Tool sconosciuto nel modulo slackTools: ' + toolName };
}

module.exports = { definitions: definitions, execute: execute };
