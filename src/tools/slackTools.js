// ─── Slack Tools ───────────────────────────────────────────────────────────────
// get_slack_users, send_dm, set_user_prefs, search_slack_messages,
// summarize_channel, summarize_thread, get_channel_map, create_poll

'use strict';

require('dotenv').config();

var db = require('../../supabase');
var logger = require('../utils/logger');
var { SLACK_FORMAT_RULES } = require('../utils/slackFormat');
// Search token — use SLACK_USER_TOKEN for search APIs
function getSearchToken() {
  return process.env.SLACK_USER_TOKEN || process.env.SLACK_BOT_TOKEN;
}

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
    description: 'Invia un messaggio diretto (DM) a un collega su Slack. ' +
      'Usa SEMPRE questo tool quando l\'utente dice "mandalo", "invialo", "scrivi a [persona]", "di\' a [persona]". ' +
      'Se nella conversazione precedente hai già preparato un messaggio, usa quello — non inventarne uno nuovo. ' +
      'NON usare per postare in canali pubblici. Puoi passare slack_user_id o il nome della persona.',
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
  // ─── New tools: pins, files, reminders, profiles, usergroups, channels mgmt ──
  {
    name: 'get_pinned_messages',
    description: 'Ottieni i messaggi fissati (pin) in un canale. Utile per trovare info importanti e risorse fissate.',
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Nome o ID del canale' },
      },
      required: ['channel'],
    },
  },
  {
    name: 'pin_message',
    description: 'Fissa un messaggio in un canale. Usalo per evidenziare decisioni importanti o risorse.',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'ID del canale' },
        message_ts: { type: 'string', description: 'Timestamp del messaggio da fissare' },
      },
      required: ['channel_id', 'message_ts'],
    },
  },
  {
    name: 'unpin_message',
    description: 'Rimuovi un messaggio dai pin di un canale.',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'ID del canale' },
        message_ts: { type: 'string', description: 'Timestamp del messaggio da sbloccare' },
      },
      required: ['channel_id', 'message_ts'],
    },
  },
  {
    name: 'search_files',
    description: 'Cerca file condivisi su Slack (PDF, immagini, documenti). Utile per trovare allegati e risorse.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Testo da cercare nei nomi/contenuti dei file' },
        channel: { type: 'string', description: 'ID canale per filtrare (opzionale)' },
        max: { type: 'number', description: 'Numero massimo risultati (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'upload_file',
    description: 'Carica un file di testo/snippet in un canale Slack.',
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Nome o ID del canale' },
        content: { type: 'string', description: 'Contenuto del file' },
        filename: { type: 'string', description: 'Nome del file (es. report.txt)' },
        title: { type: 'string', description: 'Titolo del file (opzionale)' },
        comment: { type: 'string', description: 'Commento da aggiungere al file (opzionale)' },
      },
      required: ['channel', 'content', 'filename'],
    },
  },
  {
    name: 'set_reminder',
    description: 'Crea un promemoria Slack per un utente. Usalo quando qualcuno dice "ricordami di...", "reminder per...", ecc.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Testo del promemoria' },
        time: { type: 'string', description: 'Quando ricordare (es. "in 30 minutes", "tomorrow at 9am", "next Monday", timestamp Unix)' },
        user: { type: 'string', description: 'Slack user ID (default: utente corrente)' },
      },
      required: ['text', 'time'],
    },
  },
  {
    name: 'get_slack_profile',
    description: 'Ottieni il profilo Slack dettagliato di un utente: ruolo, telefono, fuso orario, stato, titolo.',
    input_schema: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'Slack user ID' },
        user_name: { type: 'string', description: 'Nome utente (cerca l\'ID se user_id non fornito)' },
      },
    },
  },
  {
    name: 'list_usergroups',
    description: 'Elenca i gruppi utente (@team-design, @sviluppatori, ecc.) del workspace.',
    input_schema: {
      type: 'object',
      properties: {
        include_users: { type: 'boolean', description: 'Includi la lista dei membri (default false)' },
      },
    },
  },
  {
    name: 'set_channel_topic',
    description: 'Imposta o aggiorna il topic/descrizione di un canale.',
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Nome o ID del canale' },
        topic: { type: 'string', description: 'Nuovo topic del canale' },
      },
      required: ['channel', 'topic'],
    },
  },
  {
    name: 'invite_to_channel',
    description: 'Invita uno o più utenti in un canale Slack.',
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Nome o ID del canale' },
        users: { type: 'array', items: { type: 'string' }, description: 'Lista di Slack user ID da invitare' },
      },
      required: ['channel', 'users'],
    },
  },
  {
    name: 'get_reactions',
    description: 'Ottieni le reazioni su un messaggio specifico. Utile per contare voti, feedback, conferme.',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'ID del canale' },
        message_ts: { type: 'string', description: 'Timestamp del messaggio' },
      },
      required: ['channel_id', 'message_ts'],
    },
  },
  {
    name: 'list_emoji',
    description: 'Elenca gli emoji personalizzati del workspace.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'read_channel',
    description: 'Legge i messaggi di un canale Slack in ordine cronologico. ' +
      'Usa SEMPRE questo tool quando vuoi leggere la storia di un canale specifico, ' +
      'analizzare l\'attività recente, o fare un riepilogo. ' +
      'Restituisce ANCHE messaggi di bot — fondamentale per canali con daily automatici (#daily). ' +
      'NON usare search_slack_messages per leggere un canale — search non mostra messaggi bot.',
    input_schema: {
      type: 'object',
      properties: {
        channel_id:   { type: 'string', description: 'ID del canale (es. C05846AEV6D per #daily)' },
        channel_name: { type: 'string', description: 'Nome del canale (alternativo a channel_id, senza #)' },
        limit:        { type: 'number', description: 'Numero massimo messaggi (default 50, max 200)' },
        oldest:       { type: 'string', description: 'Timestamp Unix (secondi) del messaggio più vecchio. Es. per "da lunedì" calcola il timestamp.' },
        latest:       { type: 'string', description: 'Timestamp Unix (secondi) del messaggio più recente.' },
        include_bots: { type: 'boolean', description: 'Includi messaggi bot (default true — IMPORTANTE per #daily)' },
      },
    },
  },
  {
    name: 'list_channels',
    description: 'Elenca tutti i canali Slack del workspace (pubblici e privati a cui il bot ha accesso). Utile per fare una panoramica, trovare canali per nome, o sapere dove cercare.',
    input_schema: {
      type: 'object',
      properties: {
        include_archived: { type: 'boolean', description: 'Includi canali archiviati (default false)' },
      },
    },
  },
  {
    name: 'get_team_presence',
    description: 'Controlla chi è online/offline/away su Slack in questo momento. Mostra lo stato di presenza di tutto il team o di utenti specifici.',
    input_schema: {
      type: 'object',
      properties: {
        user_ids: { type: 'array', items: { type: 'string' }, description: 'Lista di Slack user ID da controllare (opzionale — default: tutto il team)' },
      },
    },
  },
  {
    name: 'analyze_team_activity',
    description: 'Analizza l\'attività del team su Slack nelle ultime 24-48h. Conta messaggi per utente, canali più attivi, orari di attività. Usalo per capire chi è più carico, chi è silenzioso, chi sta interagendo di più. NON basarti solo sui daily — analizza i messaggi reali.',
    input_schema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: 'Quante ore indietro analizzare (default 24, max 72)' },
        user_filter: { type: 'string', description: 'Filtra per un utente specifico (Slack ID, opzionale)' },
      },
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
    // Check: messaggio lungo con dati sensibili → richiede conferma
    var sensitivePattern = /€[\d\.]+|pipeline|contratto firmato|preventivo|\d+\.000|CRM completo/i;
    if (sensitivePattern.test(input.message || '') && (input.message || '').length > 200) {
      return {
        requires_confirmation: true,
        action_id: Date.now().toString(36),
        preview: 'INVIO DM A ' + (input.target_user_name || input.target_user_id || '?') +
          ':\n\n' + (input.message || '').substring(0, 300) + '...',
        message: 'Il messaggio contiene dati sensibili. Confermi l\'invio?',
      };
    }
    if (!input.target_user_id) {
      if (input.target_user_name) {
        try {
          var allUsers = await getUtenti();
          var nameL = input.target_user_name.toLowerCase();
          var match = allUsers.find(function(u) { return u.name.toLowerCase().includes(nameL); });
          if (match) input.target_user_id = match.id;
        } catch(e) {
          logger.warn('[SLACK-TOOLS] operazione fallita:', e.message);
        }
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

      var allMatches = [];
      var page = 1;
      var totalFetched = 0;
      while (totalFetched < max) {
        var pageCount = Math.min(max - totalFetched, 100);
        var res = await app.client.search.messages({
          token: getSearchToken(),
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
      logger.error('[SEARCH-SLACK] Errore reale:', e.message, e.data || '');
      // Fallback: try with conversations.history if search completely fails
      return { error: 'Ricerca fallita (' + e.message + '). Usa summarize_channel per leggere i canali.' };
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
      try { await app.client.conversations.join({ channel: target.id }); } catch(e) {
        logger.debug('[SLACK-TOOLS] join canale ignorato:', e.message);
      }

      // Paginated history
      var allMsgs = await getChannelHistory(app, target.id, oldest, 300);
      var includeBots = input.include_bots !== false; // default true
      var msgs = allMsgs.filter(function(m) {
        if (!includeBots && m.bot_id) return false;
        return m.type === 'message' && m.text;
      });
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
        } catch(e) {
          logger.warn('[SLACK-TOOLS] operazione fallita:', e.message);
        }
      }
      var posted = await app.client.chat.postMessage({ channel: channelId, text: text });
      for (var pi = 0; pi < options.length; pi++) {
        try { await app.client.reactions.add({ channel: channelId, timestamp: posted.ts, name: EMOJI_NAMES[pi] }); } catch(e) {
          logger.warn('[SLACK-TOOLS] operazione fallita:', e.message);
        }
      }
      return { success: true, ts: posted.ts };
    } catch(e) { return { error: e.message }; }
  }

  // ─── Resolve channel name → ID helper ─────────────────────────────────────────
  async function resolveChannelId(channelInput) {
    if (channelInput.match(/^[CG]/)) return channelInput;
    var name = channelInput.replace(/^#/, '');
    var channels = await getAllChannels(app);
    var ch = channels.find(function(c) { return c.name === name; });
    return ch ? ch.id : null;
  }

  // ─── Pins ───────────────────────────────────────────────────────────────────
  if (toolName === 'get_pinned_messages') {
    try {
      var pinChId = await resolveChannelId(input.channel);
      if (!pinChId) return { error: 'Canale non trovato: ' + input.channel };
      var pinsRes = await app.client.pins.list({ channel: pinChId });
      var pins = (pinsRes.items || []).map(function(item) {
        var msg = item.message || {};
        return {
          text: (msg.text || '').substring(0, 600),
          user: msg.user,
          timestamp: msg.ts,
          permalink: msg.permalink || null,
        };
      });
      return { channel: input.channel, pins: pins, count: pins.length };
    } catch(e) { return { error: 'Errore pins: ' + e.message }; }
  }

  if (toolName === 'pin_message') {
    try {
      await app.client.pins.add({ channel: input.channel_id, timestamp: input.message_ts });
      return { success: true, message: 'Messaggio fissato.' };
    } catch(e) { return { error: 'Errore pin: ' + e.message }; }
  }

  if (toolName === 'unpin_message') {
    try {
      await app.client.pins.remove({ channel: input.channel_id, timestamp: input.message_ts });
      return { success: true, message: 'Pin rimosso.' };
    } catch(e) { return { error: 'Errore unpin: ' + e.message }; }
  }

  // ─── Files ──────────────────────────────────────────────────────────────────
  if (toolName === 'search_files') {
    try {
      var fileMax = input.max || 10;
      var fileRes = await app.client.search.files({
        token: getSearchToken(),
        query: input.query,
        count: fileMax,
        sort: 'timestamp',
        sort_dir: 'desc',
      });
      var files = (fileRes.files && fileRes.files.matches) || [];
      return {
        results: files.map(function(f) {
          return {
            name: f.name,
            title: f.title,
            filetype: f.filetype,
            size: f.size,
            user: f.user,
            url: f.url_private || f.permalink,
            channels: f.channels || [],
            created: f.created,
            preview: (f.preview || '').substring(0, 300),
          };
        }),
        total: (fileRes.files && fileRes.files.total) || 0,
      };
    } catch(e) { return { error: 'Errore ricerca file: ' + e.message }; }
  }

  if (toolName === 'upload_file') {
    try {
      var upChId = await resolveChannelId(input.channel);
      if (!upChId) return { error: 'Canale non trovato: ' + input.channel };
      var upRes = await app.client.files.uploadV2({
        channel_id: upChId,
        content: input.content,
        filename: input.filename,
        title: input.title || input.filename,
        initial_comment: input.comment || '',
      });
      return { success: true, file_id: upRes.file ? upRes.file.id : null };
    } catch(e) { return { error: 'Errore upload: ' + e.message }; }
  }

  // ─── Reminders ──────────────────────────────────────────────────────────────
  if (toolName === 'set_reminder') {
    try {
      var reminderUser = input.user || userId;
      var remRes = await app.client.reminders.add({
        text: input.text,
        time: input.time,
        user: reminderUser,
      });
      return {
        success: true,
        reminder_id: remRes.reminder ? remRes.reminder.id : null,
        text: input.text,
        time: input.time,
        user: reminderUser,
      };
    } catch(e) { return { error: 'Errore reminder: ' + e.message }; }
  }

  // ─── User Profile ──────────────────────────────────────────────────────────
  if (toolName === 'get_slack_profile') {
    try {
      var profileUserId = input.user_id;
      if (!profileUserId && input.user_name) {
        var allU = await getUtenti();
        var nameMatch = allU.find(function(u) { return u.name.toLowerCase().includes(input.user_name.toLowerCase()); });
        if (nameMatch) profileUserId = nameMatch.id;
      }
      if (!profileUserId) return { error: 'Utente non trovato.' };
      var profRes = await app.client.users.profile.get({ user: profileUserId });
      var prof = profRes.profile || {};
      return {
        user_id: profileUserId,
        display_name: prof.display_name || prof.real_name,
        real_name: prof.real_name,
        title: prof.title || null,
        phone: prof.phone || null,
        email: prof.email || null,
        status_text: prof.status_text || null,
        status_emoji: prof.status_emoji || null,
        image: prof.image_192 || null,
        tz: prof.tz || null,
      };
    } catch(e) { return { error: 'Errore profilo: ' + e.message }; }
  }

  // ─── User Groups ───────────────────────────────────────────────────────────
  if (toolName === 'list_usergroups') {
    try {
      var ugRes = await app.client.usergroups.list({
        include_users: input.include_users || false,
        include_disabled: false,
      });
      var groups = (ugRes.usergroups || []).map(function(g) {
        var result = {
          id: g.id,
          handle: g.handle,
          name: g.name,
          description: g.description || '',
          user_count: g.user_count || (g.users ? g.users.length : 0),
        };
        if (g.users) result.users = g.users;
        return result;
      });
      return { usergroups: groups, count: groups.length };
    } catch(e) { return { error: 'Errore usergroups: ' + e.message }; }
  }

  // ─── Channel Topic ─────────────────────────────────────────────────────────
  if (toolName === 'set_channel_topic') {
    try {
      var topicChId = await resolveChannelId(input.channel);
      if (!topicChId) return { error: 'Canale non trovato: ' + input.channel };
      await app.client.conversations.setTopic({ channel: topicChId, topic: input.topic });
      return { success: true, channel: input.channel, topic: input.topic };
    } catch(e) { return { error: 'Errore topic: ' + e.message }; }
  }

  // ─── Invite to Channel ─────────────────────────────────────────────────────
  if (toolName === 'invite_to_channel') {
    try {
      var invChId = await resolveChannelId(input.channel);
      if (!invChId) return { error: 'Canale non trovato: ' + input.channel };
      var invUsers = input.users || [];
      var invited = [];
      var invErrors = [];
      for (var iu = 0; iu < invUsers.length; iu++) {
        try {
          await app.client.conversations.invite({ channel: invChId, users: invUsers[iu] });
          invited.push(invUsers[iu]);
        } catch(e) {
          invErrors.push({ user: invUsers[iu], error: e.message });
        }
      }
      return { success: true, invited: invited, errors: invErrors };
    } catch(e) { return { error: 'Errore invito: ' + e.message }; }
  }

  // ─── Reactions ──────────────────────────────────────────────────────────────
  if (toolName === 'get_reactions') {
    try {
      var reactRes = await app.client.reactions.get({
        channel: input.channel_id,
        timestamp: input.message_ts,
        full: true,
      });
      var msg = reactRes.message || {};
      var reactions = (msg.reactions || []).map(function(r) {
        return { name: r.name, count: r.count, users: r.users || [] };
      });
      return { reactions: reactions, total: reactions.length };
    } catch(e) { return { error: 'Errore reazioni: ' + e.message }; }
  }

  // ─── Read Channel ──────────────────────────────────────────────────────────
  if (toolName === 'read_channel') {
    try {
      var targetChId = input.channel_id;
      if (!targetChId && input.channel_name) {
        var allChs = await getAllChannels(app);
        var found = allChs.find(function(c) { return c.name === input.channel_name; });
        if (found) targetChId = found.id;
      }
      if (!targetChId) return { error: 'Specifica channel_id o channel_name.' };

      try { await app.client.conversations.join({ channel: targetChId }); } catch(e) {
        logger.debug('[SLACK-TOOLS] join canale ignorato:', e.message);
      }

      var readParams = { channel: targetChId, limit: Math.min(input.limit || 50, 200) };
      if (input.oldest) readParams.oldest = String(input.oldest);
      if (input.latest) readParams.latest = String(input.latest);

      var hist = await app.client.conversations.history(readParams);
      var allMsgs = (hist.messages || []).filter(function(m) {
        if (!m.text && !m.attachments) return false;
        if (input.include_bots === false && m.bot_id) return false;
        return true;
      });

      var userCache = {};
      var formatted = [];
      for (var ri = allMsgs.length - 1; ri >= 0; ri--) {
        var rm = allMsgs[ri];
        var author = rm.username || rm.bot_profile && rm.bot_profile.name || null;
        if (!author && rm.user) {
          author = await resolveUserName(app, rm.user, userCache);
        }
        formatted.push({
          author: author || 'unknown',
          text: (rm.text || '').substring(0, 500),
          ts: rm.ts,
          is_bot: !!rm.bot_id,
          thread_reply_count: rm.reply_count || 0,
        });
      }

      return {
        channel_id: targetChId,
        messages: formatted,
        count: formatted.length,
        has_more: hist.has_more || false,
      };
    } catch(e) { return { error: 'Errore lettura canale: ' + e.message }; }
  }

  // ─── List Channels ──────────────────────────────────────────────────────────
  if (toolName === 'list_channels') {
    try {
      var allCh = await getAllChannels(app);
      var filtered = allCh;
      if (!input.include_archived) {
        filtered = allCh.filter(function(c) { return !c.is_archived; });
      }
      return {
        channels: filtered.map(function(c) {
          return {
            id: c.id,
            name: c.name,
            topic: (c.topic && c.topic.value) || '',
            purpose: (c.purpose && c.purpose.value) || '',
            num_members: c.num_members || 0,
            is_private: c.is_private || false,
            is_archived: c.is_archived || false,
          };
        }),
        total: filtered.length,
      };
    } catch(e) { return { error: 'Errore lista canali: ' + e.message }; }
  }

  // ─── Emoji ──────────────────────────────────────────────────────────────────
  if (toolName === 'list_emoji') {
    try {
      var emojiRes = await app.client.emoji.list();
      var emojiMap = emojiRes.emoji || {};
      var emojiList = Object.keys(emojiMap).map(function(name) {
        return { name: name, url: emojiMap[name] };
      });
      return { emoji: emojiList.slice(0, 100), total: emojiList.length };
    } catch(e) { return { error: 'Errore emoji: ' + e.message }; }
  }

  // ─── Team presence ─────────────────────────────────────────────────────────
  if (toolName === 'get_team_presence') {
    try {
      var userIds = input.user_ids;
      if (!userIds || userIds.length === 0) {
        // Get all team members
        var teamRes = await app.client.users.list();
        userIds = (teamRes.members || [])
          .filter(function(u) { return !u.is_bot && !u.deleted && u.id !== 'USLACKBOT'; })
          .map(function(u) { return u.id; });
      }
      var presenceResults = [];
      for (var pi = 0; pi < Math.min(userIds.length, 20); pi++) {
        try {
          var presRes = await app.client.users.getPresence({ user: userIds[pi] });
          var profileRes = await app.client.users.info({ user: userIds[pi] });
          var userName = profileRes.user ? (profileRes.user.real_name || profileRes.user.name) : userIds[pi];
          var statusText = (profileRes.user && profileRes.user.profile) ? profileRes.user.profile.status_text : '';
          var statusEmoji = (profileRes.user && profileRes.user.profile) ? profileRes.user.profile.status_emoji : '';
          presenceResults.push({
            user_id: userIds[pi],
            name: userName,
            presence: presRes.presence, // 'active' or 'away'
            online: presRes.online || false,
            status: statusText ? (statusEmoji + ' ' + statusText) : null,
          });
        } catch(e) {
          presenceResults.push({ user_id: userIds[pi], presence: 'unknown', error: e.message });
        }
      }
      var online = presenceResults.filter(function(p) { return p.presence === 'active'; });
      var away = presenceResults.filter(function(p) { return p.presence === 'away'; });
      return {
        online: online,
        away: away,
        online_count: online.length,
        away_count: away.length,
        total: presenceResults.length,
      };
    } catch(e) { return { error: 'Errore controllo presenza: ' + e.message }; }
  }

  // ─── Team activity analysis ───────────────────────────────────────────────
  if (toolName === 'analyze_team_activity') {
    try {
      var hoursBack = Math.min(input.hours || 24, 72);
      var oldest = String(Math.floor((Date.now() - hoursBack * 60 * 60 * 1000) / 1000));
      var channelsRes = await app.client.conversations.list({ limit: 100, types: 'public_channel,private_channel' });
      var channels = (channelsRes.channels || []).filter(function(c) { return !c.is_archived; });

      var userActivity = {}; // userId -> { messages: 0, channels: Set, lastActive: ts }
      var channelActivity = {}; // channelName -> msgCount
      var totalMessages = 0;

      for (var ci = 0; ci < channels.length; ci++) {
        try {
          var hist = await app.client.conversations.history({ channel: channels[ci].id, oldest: oldest, limit: 100 });
          var msgs = (hist.messages || []).filter(function(m) { return !m.bot_id && m.type === 'message' && m.user; });
          if (msgs.length > 0) {
            channelActivity[channels[ci].name] = msgs.length;
            totalMessages += msgs.length;
          }
          for (var mi = 0; mi < msgs.length; mi++) {
            var msg = msgs[mi];
            if (input.user_filter && msg.user !== input.user_filter) continue;
            if (!userActivity[msg.user]) {
              userActivity[msg.user] = { messages: 0, channels: {}, lastActive: null, threads: 0 };
            }
            userActivity[msg.user].messages++;
            userActivity[msg.user].channels[channels[ci].name] = (userActivity[msg.user].channels[channels[ci].name] || 0) + 1;
            if (!userActivity[msg.user].lastActive || msg.ts > userActivity[msg.user].lastActive) {
              userActivity[msg.user].lastActive = msg.ts;
            }
            if (msg.thread_ts && msg.thread_ts !== msg.ts) userActivity[msg.user].threads++;
          }
        } catch(e) { /* skip inaccessible channels */ }
      }

      // Resolve user names
      var activityList = [];
      for (var uid in userActivity) {
        var ua = userActivity[uid];
        var uName = uid;
        try {
          var uInfo = await app.client.users.info({ user: uid });
          uName = uInfo.user ? (uInfo.user.real_name || uInfo.user.name) : uid;
        } catch(e) { /* ignore */ }
        activityList.push({
          user_id: uid,
          name: uName,
          messages: ua.messages,
          threads: ua.threads,
          channels_active: Object.keys(ua.channels).length,
          top_channels: Object.entries(ua.channels).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 3).map(function(e) { return e[0] + ' (' + e[1] + ')'; }),
          last_active: ua.lastActive ? new Date(parseFloat(ua.lastActive) * 1000).toISOString() : null,
        });
      }
      activityList.sort(function(a, b) { return b.messages - a.messages; });

      var topChannels = Object.entries(channelActivity).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 5);

      return {
        period: 'ultime ' + hoursBack + 'h',
        total_messages: totalMessages,
        team_activity: activityList.slice(0, 15),
        top_channels: topChannels.map(function(c) { return { name: c[0], messages: c[1] }; }),
        most_active: activityList.length > 0 ? activityList[0].name + ' (' + activityList[0].messages + ' msg)' : 'nessuno',
        least_active: activityList.length > 1 ? activityList[activityList.length - 1].name + ' (' + activityList[activityList.length - 1].messages + ' msg)' : null,
      };
    } catch(e) { return { error: 'Errore analisi attività: ' + e.message }; }
  }

  return { error: 'Tool sconosciuto nel modulo slackTools: ' + toolName };
}

module.exports = { definitions: definitions, execute: execute };
