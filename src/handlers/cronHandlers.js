// ─── Cron Handlers ─────────────────────────────────────────────────────────────
// All cron.schedule() calls, routine functions, Drive indexing, channel digest,
// catalogazione preventivi, onboarding helpers.

'use strict';

require('dotenv').config();

var cron   = require('node-cron');
var logger = require('../utils/logger');
var { formatPerSlack, SLACK_FORMAT_RULES } = require('../utils/slackFormat');
var { withTimeout } = require('../utils/timeout');
var db = require('../../supabase');
var { acquireCronLock, releaseCronLock } = require('../../supabase');
var rbac = require('../../rbac');
var {
  getCalendarPerUtente, getGmailPerUtente, getDrivePerUtente,
  getDocsPerUtente, getSheetPerUtente, getUserTokens,
  generaLinkOAuth, handleTokenScaduto,
} = require('../services/googleAuthService');
var { app, getUtenti } = require('../services/slackService');
var { askGemini } = require('../services/geminiService');
var { fetchNewsMarketing } = require('../services/geminiService');
var { catalogaConfirm } = require('../tools/registry');
var { safeParse } = require('../utils/safeCall');

var getUserRole = rbac.getUserRole;
var getRoleSystemPrompt = rbac.getRoleSystemPrompt;

// ─── Prefs helper ──────────────────────────────────────────────────────────────

function getPrefs(userId) {
  return Object.assign({ routine_enabled: true, notifiche_enabled: true, standup_enabled: true }, db.getPrefsCache()[userId] || {});
}

// ─── Standup state ─────────────────────────────────────────────────────────────

var STANDUP_CHANNEL = process.env.STANDUP_CHANNEL || 'daily';

// standupInAttesa is owned by slackHandlers.js to avoid circular dep;
// we import it lazily where needed
function getStandupInAttesa() {
  return require('./slackHandlers').standupInAttesa;
}

// ─── Titles to filter from recurring events ───────────────────────────────────

var TITOLI_RIPETITIVI = ['stand-up', 'standup', 'daily', 'sync', 'check-in', 'weekly', 'scrum'];

// ─── Briefing ─────────────────────────────────────────────────────────────────

async function getSlackBriefingData() {
  var ieri = String(Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000));
  var channelsRes = await app.client.conversations.list({ limit: 100, types: 'public_channel,private_channel' });
  var channels = (channelsRes.channels || []).filter(function(c) { return !c.is_archived; });
  var risultati = [];
  for (var ch of channels) {
    try {
      var hist = await app.client.conversations.history({ channel: ch.id, oldest: ieri, limit: 30 });
      var msgs = (hist.messages || []).filter(function(m) { return !m.bot_id && m.type === 'message'; });
      if (msgs.length > 0) risultati.push({ id: ch.id, name: ch.name, messages: msgs, count: msgs.length });
    } catch(e) {
      logger.warn('[CRON] operazione fallita:', e.message);
    }
  }
  return risultati;
}

async function buildBriefingUtente(slackUserId, canaliBriefing, newsMarketing) {
  var parti = [];
  var oggi = new Date();
  var fineGiorno = new Date();
  fineGiorno.setHours(23, 59, 59, 999);

  // 1. Agenda
  var cal = getCalendarPerUtente(slackUserId);
  if (cal) {
    try {
      var res = await withTimeout(
        cal.events.list({ calendarId: 'primary', timeMin: oggi.toISOString(), timeMax: fineGiorno.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 20 }),
        8000, 'briefing_calendar'
      );
      var eventi = (res.data.items || []).filter(function(e) {
        if (!e.recurringEventId) return true;
        var t = (e.summary || '').toLowerCase();
        return !TITOLI_RIPETITIVI.some(function(p) { return t.includes(p); });
      });
      if (eventi.length > 0) {
        var s = '*Agenda di oggi:*\n';
        eventi.forEach(function(e) {
          var ora = e.start.dateTime
            ? new Date(e.start.dateTime).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
            : 'tutto il giorno';
          s += '• ' + ora + ' — ' + (e.summary || 'Senza titolo') + '\n';
        });
        parti.push(s.trim());
      } else {
        parti.push('*Agenda di oggi:* giornata libera.');
      }
    } catch(e) { logger.error('[BRIEFING] Calendar error:', e.message); }
  }

  // 2. Mail
  var gm = getGmailPerUtente(slackUserId);
  if (gm) {
    try {
      var resUnread = await withTimeout(
        gm.users.messages.list({ userId: 'me', maxResults: 5, q: 'is:unread is:important -from:me' }),
        8000, 'briefing_gmail_unread'
      );
      if (resUnread.data.messages && resUnread.data.messages.length > 0) {
        var emails = await Promise.all(resUnread.data.messages.map(async function(m) {
          var msg = await withTimeout(
            gm.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'Subject'] }),
            8000, 'briefing_gmail_get'
          );
          var h = msg.data.payload.headers;
          function getHdr(hs, n) { return (hs.find(function(x) { return x.name === n; }) || {}).value || ''; }
          return { subject: getHdr(h, 'Subject'), from: getHdr(h, 'From') };
        }));
        var s = '*Mail importanti non lette:*\n';
        emails.forEach(function(e) { s += '• "' + e.subject + '" da ' + e.from.split('<')[0].trim() + '\n'; });
        parti.push(s.trim());
      }

      var resWaiting = await withTimeout(
        gm.users.messages.list({ userId: 'me', maxResults: 5, q: 'is:inbox -from:me newer_than:3d is:read' }),
        8000, 'briefing_gmail_waiting'
      );
      if (resWaiting.data.messages && resWaiting.data.messages.length > 0) {
        var waiting = await Promise.all(resWaiting.data.messages.map(async function(m) {
          var msg = await withTimeout(
            gm.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'Subject'] }),
            8000, 'briefing_gmail_waiting_get'
          );
          var h = msg.data.payload.headers;
          function getHdr(hs, n) { return (hs.find(function(x) { return x.name === n; }) || {}).value || ''; }
          return { subject: getHdr(h, 'Subject'), from: getHdr(h, 'From').split('<')[0].trim() };
        }));
        var s = '*Attendono risposta da te:*\n';
        waiting.forEach(function(e) { s += '• "' + e.subject + '" — ' + e.from + '\n'; });
        parti.push(s.trim());
      }
    } catch(e) { logger.error('[BRIEFING] Gmail error:', e.message); }
  }

  // 3. Slack mentions senza risposta
  var senzaRisposta = [];
  for (var canale of (canaliBriefing || [])) {
    if (senzaRisposta.length >= 5) break;
    for (var msg of canale.messages) {
      if (!msg.text || !msg.text.includes('<@' + slackUserId + '>')) continue;
      var threadTs = msg.thread_ts || msg.ts;
      try {
        var thread = await app.client.conversations.replies({ channel: canale.id, ts: threadTs, limit: 50 });
        var haiRisposto = (thread.messages || []).some(function(m) { return m.user === slackUserId; });
        if (!haiRisposto) {
          senzaRisposta.push({ channel: canale.name, channelId: canale.id, ts: threadTs, testo: msg.text.replace(/<[^>]+>/g, '').trim().substring(0, 80) });
        }
      } catch(e) {
        logger.warn('[CRON] operazione fallita:', e.message);
      }
    }
  }
  if (senzaRisposta.length > 0) {
    var s = '*Ti aspettano su Slack:*\n';
    senzaRisposta.slice(0, 4).forEach(function(t) {
      var link = '<https://slack.com/app_redirect?channel=' + t.channelId + '&message_ts=' + t.ts + '|#' + t.channel + '>';
      s += '• ' + link + ': ' + t.testo + '…\n';
    });
    parti.push(s.trim());
  }

  // 4. Task dalla memoria
  try {
    var taskMemories = db.searchMemories(slackUserId, 'task da fare todo in sospeso');
    if (taskMemories.length > 0) {
      var s = '*Task in sospeso:*\n';
      taskMemories.slice(0, 4).forEach(function(m) { s += '• ' + m.content + '\n'; });
      parti.push(s.trim());
    }
  } catch(e) {
    logger.warn('[CRON] operazione fallita:', e.message);
  }

  // 5. News
  if (newsMarketing) {
    parti.push('*News di oggi — Marketing & Comunicazione:*\n' + newsMarketing);
  }

  return parti;
}

async function inviaRoutineGiornaliera() {
  var locked = await acquireCronLock('briefing_giornaliero', 15);
  if (!locked) return;
  logger.info('[ROUTINE] Avvio briefing giornaliero...');
  try {
    var canaliBriefing, newsMarketing;
    var results = await Promise.all([getSlackBriefingData(), fetchNewsMarketing()]);
    canaliBriefing = results[0];
    newsMarketing  = results[1];

    var utenti = await getUtenti();
    for (var utente of utenti) {
      if (!getPrefs(utente.id).routine_enabled) continue;
      try {
        var parti = await buildBriefingUtente(utente.id, canaliBriefing, newsMarketing);
        var msg = 'Buongiorno *' + utente.name.split(' ')[0] + '*, mbare! Ecco cosa hai oggi:\n\n' + parti.join('\n\n');
        if (!getCalendarPerUtente(utente.id)) {
          var oauthUrl = generaLinkOAuth(utente.id);
          msg += '\n\n_<' + oauthUrl + '|Collega il tuo Google> per vedere agenda e mail._';
        }
        await app.client.chat.postMessage({ channel: utente.id, text: formatPerSlack(msg), unfurl_links: false, unfurl_media: false });
      } catch(e) { logger.error('[ROUTINE] Errore per', utente.id + ':', e.message); }
    }
    logger.info('[ROUTINE] Briefing inviato a', utenti.length, 'utenti.');
  } catch(e) { logger.error('[ROUTINE] Errore generale:', e.message); }
  finally { await releaseCronLock('briefing_giornaliero'); }
}

// ─── Standup ───────────────────────────────────────────────────────────────────

async function inviaStandupDomande() {
  var locked = await acquireCronLock('standup_domande', 10);
  if (!locked) return;
  try {
    var oggi = new Date().toISOString().slice(0, 10);
    logger.info('[STANDUP] Invio domande standup per', oggi);
    var sd = db.getStandupCache();
    sd.oggi = oggi;
    sd.risposte = {};
    db.saveStandup(sd);

    var utenti = await getUtenti();
    var inviati = 0;
    var standupInAttesa = getStandupInAttesa();
    for (var utente of utenti) {
      if (!getPrefs(utente.id).standup_enabled) continue;
      try {
        standupInAttesa.add(utente.id);
        await app.client.chat.postMessage({
          channel: utente.id,
          text: 'Buongiorno ' + utente.name.split(' ')[0] + '! Standup time.\n\n' +
            'Rispondi a questo messaggio con:\n' +
            '1. Su cosa lavori oggi?\n' +
            '2. Hai blocchi o serve aiuto?\n\n' +
            '_Scrivi tutto in un unico messaggio, il recap uscirà alle 10:00._',
        });
        inviati++;
      } catch(e) { logger.error('[STANDUP] Errore invio a', utente.id + ':', e.message); }
    }
    logger.info('[STANDUP] Domande inviate a', inviati, 'utenti.');
  } finally { await releaseCronLock('standup_domande'); }
}

async function pubblicaRecapStandup() {
  var locked = await acquireCronLock('standup_recap', 10);
  if (!locked) return;
  try {
    var oggi = new Date().toISOString().slice(0, 10);
    var sd = db.getStandupCache();
    if (sd.oggi !== oggi) { logger.info('[STANDUP] Nessun dato standup per oggi, skip recap.'); return; }
    var risposte = sd.risposte;
    var userIds = Object.keys(risposte);
    if (userIds.length === 0) { logger.info('[STANDUP] Nessuna risposta standup ricevuta, skip recap.'); return; }
    getStandupInAttesa().clear();

    var msg = '*Standup ' + oggi + '*\n\n';
    for (var userId of userIds) {
      var r = risposte[userId];
      msg += '<@' + userId + '>:\n' + (r.testo || '') + '\n\n';
    }
    try {
      var channelsRes = await app.client.conversations.list({ limit: 200, types: 'public_channel,private_channel' });
      var target = (channelsRes.channels || []).find(function(c) { return c.name === STANDUP_CHANNEL || c.id === STANDUP_CHANNEL; });
      if (!target) { logger.error('[STANDUP] Canale "' + STANDUP_CHANNEL + '" non trovato.'); return; }
      try { await app.client.conversations.join({ channel: target.id }); } catch(e) {
        logger.debug('[CRON] join canale ignorato:', e.message);
      }
      await app.client.chat.postMessage({ channel: target.id, text: formatPerSlack(msg), unfurl_links: false, unfurl_media: false });
      logger.info('[STANDUP] Recap pubblicato in #' + target.name + ' con', userIds.length, 'risposte.');
    } catch(e) { logger.error('[STANDUP] Errore pubblicazione recap:', e.message); }
  } finally { await releaseCronLock('standup_recap'); }
}

// ─── Recap settimanale ─────────────────────────────────────────────────────────

async function getSlackWeekData() {
  var unaSettimanaFa = String(Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000));
  var channelsRes = await app.client.conversations.list({ limit: 100, types: 'public_channel,private_channel' });
  var channels = (channelsRes.channels || []).filter(function(c) { return !c.is_archived; });
  var risultati = [];
  for (var ch of channels) {
    try {
      var hist = await app.client.conversations.history({ channel: ch.id, oldest: unaSettimanaFa, limit: 200 });
      var msgs = (hist.messages || []).filter(function(m) { return !m.bot_id && m.type === 'message'; });
      if (msgs.length > 0) risultati.push({ id: ch.id, name: ch.name, count: msgs.length });
    } catch(e) {
      logger.warn('[CRON] operazione fallita:', e.message);
    }
  }
  return risultati;
}

async function buildRecapSettimanale(slackUserId, canaliSettimana) {
  var parti = [];
  var oggi = new Date();
  var unaSettimanaFa = new Date(oggi.getTime() - 7 * 24 * 60 * 60 * 1000);
  var cal = getCalendarPerUtente(slackUserId);

  if (cal) {
    try {
      var res = await cal.events.list({ calendarId: 'primary', timeMin: unaSettimanaFa.toISOString(), timeMax: oggi.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 30 });
      var eventi = (res.data.items || []).filter(function(e) {
        if (!e.recurringEventId) return true;
        var t = (e.summary || '').toLowerCase();
        return !TITOLI_RIPETITIVI.some(function(p) { return t.includes(p); });
      });
      if (eventi.length > 0) {
        var s = '*Riunioni della settimana:* ' + eventi.length + ' eventi\n';
        eventi.slice(0, 8).forEach(function(e) {
          var giorno = e.start.dateTime
            ? new Date(e.start.dateTime).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' })
            : new Date(e.start.date).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
          s += giorno + ' — ' + (e.summary || 'Senza titolo') + '\n';
        });
        if (eventi.length > 8) s += '...e altri ' + (eventi.length - 8) + ' eventi\n';
        parti.push(s.trim());
      } else {
        parti.push('*Riunioni della settimana:* nessuna, settimana tranquilla.');
      }
    } catch(e) { logger.error('Recap calendar error:', e.message); }
  }

  var gm = getGmailPerUtente(slackUserId);
  if (gm) {
    try {
      var afterTs = Math.floor(unaSettimanaFa.getTime() / 1000);
      var res = await gm.users.messages.list({ userId: 'me', maxResults: 1, q: 'after:' + afterTs });
      var totale = res.data.resultSizeEstimate || 0;
      var unreadRes = await gm.users.messages.list({ userId: 'me', maxResults: 1, q: 'is:unread after:' + afterTs });
      var nonLette = unreadRes.data.resultSizeEstimate || 0;
      var s = '*Email della settimana:* ~' + totale + ' ricevute';
      if (nonLette > 0) s += ', ' + nonLette + ' ancora non lette';
      parti.push(s);
    } catch(e) { logger.error('Recap gmail error:', e.message); }
  }

  var top = canaliSettimana.slice().sort(function(a, b) { return b.count - a.count; }).slice(0, 5);
  if (top.length > 0) {
    var s = '*Canali più attivi della settimana:*\n';
    top.forEach(function(c) { s += '#' + c.name + ' (' + c.count + ' messaggi)\n'; });
    parti.push(s.trim());
  }

  if (cal) {
    try {
      var lunProssimo = new Date(oggi);
      lunProssimo.setDate(lunProssimo.getDate() + (8 - lunProssimo.getDay()) % 7);
      lunProssimo.setHours(0, 0, 0, 0);
      var venProssimo = new Date(lunProssimo);
      venProssimo.setDate(venProssimo.getDate() + 5);
      var res = await cal.events.list({ calendarId: 'primary', timeMin: lunProssimo.toISOString(), timeMax: venProssimo.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 15 });
      var prossimi = (res.data.items || []).filter(function(e) {
        if (!e.recurringEventId) return true;
        var t = (e.summary || '').toLowerCase();
        return !TITOLI_RIPETITIVI.some(function(p) { return t.includes(p); });
      });
      if (prossimi.length > 0) {
        var s = '*Anteprima settimana prossima:* ' + prossimi.length + ' eventi\n';
        prossimi.slice(0, 5).forEach(function(e) {
          var giorno = e.start.dateTime
            ? new Date(e.start.dateTime).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' })
            : new Date(e.start.date).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
          s += giorno + ' — ' + (e.summary || 'Senza titolo') + '\n';
        });
        parti.push(s.trim());
      }
    } catch(e) { logger.error('Recap next week error:', e.message); }
  }

  return parti;
}

async function inviaRecapSettimanale() {
  var locked = await acquireCronLock('recap_settimanale', 15);
  if (!locked) return;
  logger.info('[RECAP] Avvio recap settimanale...');
  try {
    var canaliSettimana = await getSlackWeekData();
    var utenti = await getUtenti();
    for (var utente of utenti) {
      if (!getPrefs(utente.id).routine_enabled) continue;
      try {
        var parti = await buildRecapSettimanale(utente.id, canaliSettimana);
        var msg = 'Buon fine settimana ' + utente.name.split(' ')[0] + ', mbare! Ecco il recap della settimana:\n\n' + parti.join('\n\n');
        if (!getCalendarPerUtente(utente.id)) {
          msg += '\n\n_Collega il tuo Google per avere il recap completo con agenda e mail._';
        }
        await app.client.chat.postMessage({ channel: utente.id, text: formatPerSlack(msg), unfurl_links: false, unfurl_media: false });
      } catch(e) { logger.error('[RECAP] Errore per', utente.id + ':', e.message); }
    }
    logger.info('[RECAP] Recap inviato a', utenti.length, 'utenti.');
  } catch(e) { logger.error('[RECAP] Errore generale:', e.message); }
  finally { await releaseCronLock('recap_settimanale'); }
}

// ─── Drive indexing ────────────────────────────────────────────────────────────

async function indicizzaDriveUtente(slackUserId) {
  var drv = getDrivePerUtente(slackUserId);
  if (!drv) return 0;
  var dueOreFa = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  try {
    var res = await drv.files.list({
      q: "modifiedTime > '" + dueOreFa + "' and trashed = false",
      fields: 'files(id, name, mimeType, webViewLink, modifiedTime, owners, description)',
      pageSize: 20,
      orderBy: 'modifiedTime desc',
    });
    var files = res.data.files || [];
    if (files.length === 0) return 0;
    db.saveDriveFiles(slackUserId, files);
    return files.length;
  } catch(e) {
    await handleTokenScaduto(slackUserId, e);
    return 0;
  }
}

async function indicizzaDriveTutti() {
  logger.info('[DRIVE-INDEX] Avvio indicizzazione...');
  var totale = 0;
  for (var uid of Object.keys(getUserTokens())) {
    var n = await indicizzaDriveUtente(uid);
    totale += n;
  }
  logger.info('[DRIVE-INDEX] Indicizzati', totale, 'file.');
}

// ─── Channel auto-map + digest ─────────────────────────────────────────────────

async function autoMapChannel(channelId) {
  try {
    var info = await app.client.conversations.info({ channel: channelId });
    var ch = info.channel || {};
    if (!ch.name) return null;
    var existing = db.getChannelMapCache()[channelId];
    if (existing && existing.cliente) return existing;

    var chContext = 'Nome canale: #' + ch.name;
    if (ch.topic && ch.topic.value) chContext += '\nTopic: ' + ch.topic.value;
    if (ch.purpose && ch.purpose.value) chContext += '\nDescrizione: ' + ch.purpose.value;

    var Anthropic = require('@anthropic-ai/sdk');
    var client = new Anthropic();
    var res = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      system: 'Analizzi nomi e descrizioni di canali Slack aziendali.\n' +
        'Rispondi SOLO in JSON: {"cliente": "nome o null", "progetto": "nome o null", "tags": ["tag1"]}\n' +
        'Se il canale è generico (es. #general, #random, #dev) rispondi: {"cliente": null, "progetto": null, "tags": ["interno"]}\n' +
        'I tag devono essere nel formato: tipo:valore (es. "cliente:elfo", "area:sviluppo", "tipo:marketing")',
      messages: [{ role: 'user', content: chContext }],
    });
    var text = res.content[0].text.trim();
    var jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    var parsed = safeParse('CRON.459', jsonMatch[0], null);
    var mapping = { channel_name: ch.name, cliente: parsed.cliente || null, progetto: parsed.progetto || null, tags: parsed.tags || [], note: ch.topic ? ch.topic.value : null };
    db.saveChannelMapping(channelId, mapping);
    logger.info('[CHANNEL-MAP] #' + ch.name + ' → cliente:', mapping.cliente, '| progetto:', mapping.progetto);
    return mapping;
  } catch(e) { logger.error('[CHANNEL-MAP] Errore:', e.message); return null; }
}

async function digerisciCanali() {
  var locked = await acquireCronLock('channel_digest', 30);
  if (!locked) return;
  logger.info('[CHANNEL-DIGEST] Avvio digestione canali...');
  try {
    var Anthropic = require('@anthropic-ai/sdk');
    var client = new Anthropic();
    var channelsRes = await app.client.conversations.list({ limit: 100, types: 'public_channel,private_channel' });
    var channels = (channelsRes.channels || []).filter(function(c) { return !c.is_archived; });
    var digested = 0;

    for (var ch of channels) {
      try {
        await autoMapChannel(ch.id);
        var digests = db.getChannelDigestCache();
        var lastTs = (digests[ch.id] && digests[ch.id].last_ts) || String(Math.floor((Date.now() - 4 * 60 * 60 * 1000) / 1000));
        var hist = await app.client.conversations.history({ channel: ch.id, oldest: lastTs, limit: 50 });
        var msgs = (hist.messages || []).filter(function(m) { return !m.bot_id && m.type === 'message' && m.text; });
        if (msgs.length < 3) continue;

        var newestTs = msgs[0].ts;
        var msgText = msgs.reverse().map(function(m) {
          return (m.user ? '<@' + m.user + '>' : 'unknown') + ': ' + (m.text || '').substring(0, 200);
        }).join('\n');

        var channelMapping = db.getChannelMapCache()[ch.id] || {};
        var analysisRes = await client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 500,
          system: 'Analizzi conversazioni di canali Slack di un\'agenzia digitale.\n' +
            'Canale: #' + ch.name + (channelMapping.cliente ? ' (cliente: ' + channelMapping.cliente + ')' : '') +
            (channelMapping.progetto ? ' (progetto: ' + channelMapping.progetto + ')' : '') + '\n' +
            'Rispondi SOLO in JSON:\n' +
            '{"skip": true} se non c\'è nulla di utile.\n' +
            'Altrimenti:\n' +
            '{\n' +
            '  "digest": "riassunto breve di cosa si è discusso (max 3 righe)",\n' +
            '  "kb": [{"content": "info aziendale importante", "tags": ["tipo:valore"]}],\n' +
            '  "channel_update": {"cliente": "nome o null", "progetto": "nome o null"}\n' +
            '}\n' +
            'Regole:\n' +
            '- kb: solo decisioni, scadenze, info clienti, procedure — NON chiacchiere\n' +
            '- Tags strutturati: cliente:nome, progetto:nome, area:dev/design/marketing, tipo:decisione/scadenza/procedura\n' +
            '- channel_update: aggiorna solo se hai info più precise sul cliente/progetto del canale',
          messages: [{ role: 'user', content: msgText }],
        });

        var analysisText = analysisRes.content[0].text.trim();
        var jsonMatch = analysisText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) continue;
        var analysis = safeParse('CRON.517', jsonMatch[0], null);
        if (analysis.skip) { db.saveChannelDigest(ch.id, 'nessuna novita', newestTs); continue; }

        if (analysis.digest) db.saveChannelDigest(ch.id, analysis.digest, newestTs);

        if (analysis.kb && analysis.kb.length > 0) {
          analysis.kb.forEach(function(entry) {
            if (entry.content && entry.content.length > 5) {
              var cLow = (entry.content || '').toLowerCase();
              var isAboutRoles = cLow.includes('ceo') ||
                cLow.includes('coo') || cLow.includes('gm') ||
                cLow.includes('cco') || cLow.includes('organigramma') ||
                cLow.includes('rate card') || cLow.includes('€/h') ||
                cLow.includes('ruolo');
              if (isAboutRoles) {
                logger.info('[CHANNEL-DIGEST] Skip KB su ruoli/rate card — protetta:', entry.content.substring(0, 60));
                return;
              }
              var tags = (entry.tags || []);
              if (channelMapping.cliente) tags.push('cliente:' + channelMapping.cliente.toLowerCase());
              if (channelMapping.progetto) tags.push('progetto:' + channelMapping.progetto.toLowerCase());
              tags.push('canale:' + ch.name);
              db.addKBEntry(entry.content, tags, 'channel-digest', {
                confidenceTier: ch.is_private ? 'slack_private' : 'slack_public',
                sourceType: 'slack',
                sourceChannelId: ch.id,
                sourceChannelType: ch.is_private ? 'private' : 'public',
              });
              logger.info('[CHANNEL-DIGEST] KB da #' + ch.name + ':', entry.content.substring(0, 60));
            }
          });
        }

        if (analysis.channel_update) {
          var cu = analysis.channel_update;
          if (cu.cliente || cu.progetto) {
            var current = db.getChannelMapCache()[ch.id] || { channel_name: ch.name, tags: [] };
            if (cu.cliente) current.cliente = cu.cliente;
            if (cu.progetto) current.progetto = cu.progetto;
            db.saveChannelMapping(ch.id, current);
          }
        }
        digested++;
      } catch(e) {
        if (e.status !== 429) logger.error('[CHANNEL-DIGEST] Errore #' + ch.name + ':', e.message);
      }
    }
    logger.info('[CHANNEL-DIGEST] Digeriti', digested, 'canali.');
  } catch(e) { logger.error('[CHANNEL-DIGEST] Errore generale:', e.message); }
  finally { await releaseCronLock('channel_digest'); }
}

// ─── Onboarding ────────────────────────────────────────────────────────────────

var MANSIONI_TEAM = {
  'antonio':    'CEO e capo dell\'agenzia. Visione strategica, decisioni finali, gestione complessiva. Vuole avere controllo su tutto: finanza, team, clienti, produzione.',
  'corrado':    'GM e capo. General Management, supervisione operativa, coordinamento tra reparti, decisioni strategiche insieme ad Antonio.',
  'gianna':     'COO e PM. Project management, controllo finanza e economics: fatturato, cassa, margini, costi interni, rate card. Segue la macchina operativa dell\'agenzia.',
  'alessandra': 'CCO. Contatto diretto con i clienti, relazioni commerciali, coordinamento brief e deliverables.',
  'nicol\u00f2': 'Direttore Creativo e Digital Strategist. Direzione artistica, identità di brand, strategie digitali.',
  'nicolo':     'Direttore Creativo e Digital Strategist. Direzione artistica, identità di brand, strategie digitali.',
  'giusy':      'Social Media Manager, Digital Strategist, Junior Copy. Gestione canali social, produzione contenuti.',
  'paolo':      'Graphic Designer. Progettazione grafica, visual identity, materiali creativi.',
  'claudia':    'Graphic Designer. Progettazione grafica, visual identity, materiali creativi.',
  'gloria':     'Marketing e Strategist Manager. Pianificazione campagne marketing, analisi dati.',
  'peppe':      'Logistica e referente del progetto OffKatania.',
};

async function inviaOnboardingPersonalizzato(slackUserId) {
  try {
    var role = await getUserRole(slackUserId);
    var profiles = db.getProfileCache();
    var profile = profiles[slackUserId] || {};
    var userCtx = 'Ruolo accesso: ' + role + '\n';
    var nome = '';
    try {
      var uInfo = await app.client.users.info({ user: slackUserId });
      nome = (uInfo.user.real_name || uInfo.user.name || '').split(' ')[0];
      if (nome) userCtx += 'Nome: ' + nome + '\n';
    } catch(e) {
      logger.warn('[CRON] operazione fallita:', e.message);
    }

    var mansioneLookup = MANSIONI_TEAM[nome.toLowerCase()] || null;
    if (mansioneLookup) {
      userCtx += 'Mansione e responsabilità: ' + mansioneLookup + '\n';
    } else if (profile.ruolo) {
      userCtx += 'Mansione: ' + profile.ruolo + '\n';
    }
    if (profile.competenze && profile.competenze.length > 0) userCtx += 'Competenze: ' + profile.competenze.join(', ') + '\n';
    if (profile.progetti && profile.progetti.length > 0) userCtx += 'Progetti attivi: ' + profile.progetti.join(', ') + '\n';
    if (profile.clienti && profile.clienti.length > 0) userCtx += 'Clienti seguiti: ' + profile.clienti.join(', ') + '\n';

    var roleCtx = getRoleSystemPrompt(role);

    var Anthropic = require('@anthropic-ai/sdk');
    var client = new Anthropic();
    var response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 450,
      system:
        'Sei Giuno, assistente interno di Katania Studio, agenzia digitale di Catania.\n' +
        'Scrivi un messaggio di benvenuto in DM Slack per un membro del team che ha appena collegato il suo Google.\n' +
        'TONO: diretto, caldo, siciliano nell\'anima. Zero aziendalese. Usa "mbare" con parsimonia.\n' +
        'FORMATO Slack: *grassetto* con un asterisco. Liste con •. MAI ** o ##. Max 18 righe.\n' +
        'STRUTTURA:\n' +
        '1. Conferma Google collegato (1 riga)\n' +
        '2. 3-4 cose che posso fare per questa persona SPECIFICHE per la sua mansione e competenze\n' +
        '3. 3 esempi concreti di richieste che farà spesso nel suo lavoro quotidiano\n' +
        '4. Call to action in 1 riga\n' +
        'Se la mansione non è nota, basati sul ruolo di accesso e sul contesto aziendale.',
      messages: [{ role: 'user', content: 'Dati utente:\n' + userCtx + '\nContesto ruolo:\n' + roleCtx }],
    });
    var msg = response.content[0].text;
    await app.client.chat.postMessage({ channel: slackUserId, text: msg });
    logger.info('[ONBOARDING] Messaggio generato e inviato a', slackUserId, '| ruolo:', role);
  } catch(e) {
    logger.error('[ONBOARDING] Errore:', e.message);
    try {
      await app.client.chat.postMessage({
        channel: slackUserId,
        text: '*Google collegato, mbare!* Da ora vedo il tuo calendario, le email e i file Drive.\nScrivimi in DM o taggami con *@Giuno* in qualsiasi canale.',
      });
    } catch(e2) {}
  }
}

async function invitaNonConnessi() {
  try {
    var utenti = await getUtenti();
    var connessi = getUserTokens();
    var nonConnessi = utenti.filter(function(u) { return !connessi[u.id]; });
    logger.info('[PUSH-GOOGLE] Utenti senza token:', nonConnessi.length);
    var inviati = 0;
    for (var u of nonConnessi) {
      try {
        var oauthUrl = generaLinkOAuth(u.id);
        var link = '<' + oauthUrl + '|Collega il tuo Google>';
        await app.client.chat.postMessage({
          channel: u.id,
          text: 'Ciao ' + u.name.split(' ')[0] + '! Non hai ancora collegato il tuo account Google a Giuno.\n\n' +
            'Collegandolo posso aiutarti con calendario, email e Drive direttamente da Slack.\n\n' + link,
        });
        inviati++;
        logger.info('[PUSH-GOOGLE] Invito inviato a', u.id, u.name);
      } catch(e) { logger.error('[PUSH-GOOGLE] Errore per', u.id + ':', e.message); }
    }
    return inviati;
  } catch(e) { logger.error('[PUSH-GOOGLE] Errore generale:', e.message); return 0; }
}

// ─── Catalogazione preventivi ──────────────────────────────────────────────────

async function catalogaPreventivi(userId, channelId, maxFiles, skipConfirm) {
  maxFiles = maxFiles || 50;
  skipConfirm = skipConfirm || false;
  var drv = getDrivePerUtente(userId);
  var sheets = getSheetPerUtente(userId);
  if (!drv || !sheets) {
    await app.client.chat.postMessage({ channel: channelId, text: 'Google non collegato. Scrivi "collega il mio Google" prima.' });
    return;
  }

  // STEP A: Find rate card
  var rateCard = null;
  try {
    var rcRes = await drv.files.list({
      q: "fullText contains 'rate card' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
      fields: 'files(id, name)', pageSize: 5, orderBy: 'modifiedTime desc',
    });
    if (rcRes.data.files && rcRes.data.files.length > 0) {
      var rcFile = rcRes.data.files[0];
      var rcData = await sheets.spreadsheets.values.get({ spreadsheetId: rcFile.id, range: 'A1:Z50' });
      var Anthropic = require('@anthropic-ai/sdk');
      var client = new Anthropic();
      var rcExtract = await client.messages.create({
        model: 'claude-sonnet-4-20250514', max_tokens: 1000,
        system: 'Estrai la rate card da questo foglio. Rispondi SOLO in JSON valido:\n{"version":"current","effective_from":null,"resources":[{"person":null,"role":"nome ruolo","day_rate":null,"hour_rate":null,"notes":null}]}\nSe non riesci rispondi: {"skip":true}',
        messages: [{ role: 'user', content: 'Rate card dal file "' + rcFile.name + '":\n' + JSON.stringify(rcData.data.values || []).substring(0, 3000) }],
      });
      var rcText = rcExtract.content[0].text.trim();
      var rcJson = rcText.match(/\{[\s\S]*\}/);
      if (rcJson) {
        var parsed = safeParse('CRON.698', rcJson[0], null);
        if (!parsed.skip) {
          rateCard = parsed;
          rateCard.source_doc_id = rcFile.id;
          await db.saveRateCard({ version: 'current', effective_from: null, resources: rateCard.resources, source_doc_id: rcFile.id, notes: 'Estratto automaticamente da /giuno cataloga' });
          logger.info('[CATALOGA] Rate card trovata e salvata:', rcFile.name);
        }
      }
    }
  } catch(e) { logger.error('[CATALOGA] Errore rate card:', e.message); }

  // STEP B: Discovery
  var targetFolderIds = [];
  var folderKeywords = ['preventivi', 'deck commerciali', 'economics'];
  for (var fi = 0; fi < folderKeywords.length; fi++) {
    try {
      var folderRes = await drv.files.list({ q: "name contains '" + folderKeywords[fi] + "' and mimeType = 'application/vnd.google-apps.folder' and trashed = false", fields: 'files(id, name)', pageSize: 10 });
      (folderRes.data.files || []).forEach(function(f) { targetFolderIds.push(f.id); });
    } catch(e) {
      logger.warn('[CRON] operazione fallita:', e.message);
    }
  }

  var searchTerms = ['economics', 'preventivo', 'proposta', 'quotation', 'offerta', 'katania studio'];
  var searchMimes = ['application/vnd.google-apps.spreadsheet', 'application/vnd.google-apps.document'];
  var foundFiles = new Map();
  var excludeNames = ['business plan', 'recruitment', 'piano industriale', 'template', 'copia di template'];

  if (targetFolderIds.length > 0) {
    for (var fIdx = 0; fIdx < targetFolderIds.length; fIdx++) {
      for (var mi = 0; mi < searchMimes.length; mi++) {
        try {
          var fRes = await drv.files.list({ q: "'" + targetFolderIds[fIdx] + "' in parents and mimeType = '" + searchMimes[mi] + "' and trashed = false", fields: 'files(id, name, modifiedTime, mimeType)', pageSize: 50 });
          (fRes.data.files || []).forEach(function(f) { if (!foundFiles.has(f.id)) foundFiles.set(f.id, f); });
        } catch(e) {
          logger.warn('[CRON] operazione fallita:', e.message);
        }
      }
    }
  }

  for (var si = 0; si < searchTerms.length; si++) {
    for (var mi = 0; mi < searchMimes.length; mi++) {
      try {
        var sRes = await drv.files.list({ q: "fullText contains '" + searchTerms[si] + "' and mimeType = '" + searchMimes[mi] + "' and trashed = false", fields: 'files(id, name, modifiedTime, mimeType)', pageSize: 20, orderBy: 'modifiedTime desc' });
        (sRes.data.files || []).forEach(function(f) { if (!foundFiles.has(f.id)) foundFiles.set(f.id, f); });
      } catch(e) {
        logger.warn('[CRON] operazione fallita:', e.message);
      }
    }
  }

  var files = Array.from(foundFiles.values()).filter(function(f) {
    var nameLow = (f.name || '').toLowerCase();
    for (var ei = 0; ei < excludeNames.length; ei++) { if (nameLow.includes(excludeNames[ei])) return false; }
    return true;
  }).slice(0, maxFiles);

  if (files.length === 0) {
    await app.client.chat.postMessage({ channel: channelId, text: 'Nessun file preventivo trovato su Drive.' });
    return;
  }

  if (skipConfirm) {
    elaboraPreventivi(userId, channelId, files, rateCard).catch(function(e) { logger.error('[CATALOGA] Errore:', e.message); });
    return;
  }

  await app.client.chat.postMessage({
    channel: channelId,
    text: formatPerSlack('*Trovati ' + files.length + ' file* da analizzare:\n' +
      files.slice(0, 8).map(function(f) { return '• ' + f.name; }).join('\n') +
      (files.length > 8 ? '\n...e altri ' + (files.length - 8) : '') +
      (rateCard ? '\n\n_Rate card trovata_' : '') +
      '\n\nRispondi *si* per procedere o *no* per annullare.'),
  });

  var confirmKey = 'cataloga_confirm_' + userId;
  catalogaConfirm.set(confirmKey, { files: files, userId: userId, channelId: channelId, rateCard: rateCard, created: Date.now() });
  setTimeout(function() { catalogaConfirm.delete(confirmKey); }, 15 * 60 * 1000);
}

async function elaboraPreventivi(userId, channelId, files, rateCard) {
  var sheets = getSheetPerUtente(userId);
  var results = { catalogati: 0, saltati: 0, da_rivedere: [], per_era: { 'pre-ratecard': 0, 'ratecard-v1': 0, 'ratecard-v2': 0, 'unknown': 0 }, per_categoria: {}, per_stato: { accepted: 0, rejected: 0, draft: 0, unknown: 0 }, valori: [] };
  var Anthropic = require('@anthropic-ai/sdk');
  var client = new Anthropic();
  var toProcess = files.slice(0, 50);

  for (var i = 0; i < toProcess.length; i++) {
    var file = toProcess[i];
    try {
      var exists = await db.quoteExistsByDocId(file.id);
      if (exists) { results.saltati++; continue; }

      var fileContent = '';
      var isSheet = (file.mimeType || '').includes('spreadsheet');
      if (isSheet) {
        var sheetData = await sheets.spreadsheets.values.get({ spreadsheetId: file.id, range: 'A1:Z100' });
        var rows = sheetData.data.values || [];
        if (rows.length === 0) { results.saltati++; continue; }
        fileContent = JSON.stringify(rows).substring(0, 4000);
      } else {
        var docs = getDocsPerUtente(userId);
        if (!docs) { results.saltati++; continue; }
        var doc = await docs.documents.get({ documentId: file.id });
        var { extractDocText } = require('../tools/driveTools');
        var text = extractDocText(doc.data.body.content);
        if (text.trim().length < 20) { results.saltati++; continue; }
        fileContent = text.substring(0, 4000);
      }

      var extraction = await client.messages.create({
        model: 'claude-sonnet-4-20250514', max_tokens: 1500,
        system: 'Estrai dati da un preventivo/economics di agenzia digitale.\nRispondi SOLO in JSON valido, nessun testo prima o dopo:\n{"client_name":"string o null","project_name":"string o null","service_category":"branding|content|performance|video|web|event|altro","service_tags":["array"],"deliverables":["array"],"resources":[{"person":"string","days":0,"hours":0,"day_rate":0,"hour_rate":0,"subtotal":0}],"total_days":0,"total_cost_interno":0,"price_quoted":0,"markup_pct":0,"status":"accepted|rejected|draft|unknown","date":"YYYY-MM-DD o null","confidence":"high|medium|low","notes":"string o null"}',
        messages: [{ role: 'user', content: 'File: "' + file.name + '" (' + (isSheet ? 'Sheet' : 'Doc') + ')\n\nContenuto:\n' + fileContent + (rateCard ? '\n\nRate card corrente:\n' + JSON.stringify(rateCard.resources).substring(0, 1000) : '') }],
      });

      var extText = extraction.content[0].text.trim();
      var extJson = extText.match(/\{[\s\S]*\}/);
      if (!extJson) { results.da_rivedere.push(file.name + ' (parsing fallito)'); continue; }
      var data = safeParse('CRON.813', extJson[0], null);

      var pricing_era = 'unknown';
      if (data.date) {
        var d = new Date(data.date);
        if (d < new Date('2024-01-01')) pricing_era = 'pre-ratecard';
        else if (d < new Date('2025-06-01')) pricing_era = 'ratecard-v1';
        else pricing_era = 'ratecard-v2';
      }
      if (!data.markup_pct && data.price_quoted && data.total_cost_interno) {
        data.markup_pct = Math.round((data.price_quoted - data.total_cost_interno) / data.total_cost_interno * 100);
      }

      var needs_review = data.confidence === 'low' || !data.client_name || !data.price_quoted;
      if (data.price_quoted) {
        try {
          var crossCheck = await askGemini(
            'Controlla questa estrazione dati da un preventivo di agenzia digitale:\nCliente: ' + (data.client_name || 'N/D') + '\nPrezzo quotato: ' + data.price_quoted + '\nMarkup: ' + (data.markup_pct || 'N/D') + '%\nFile: "' + file.name + '"\n\nSegnala SOLO se qualcosa è palesemente sbagliato (markup >500%, prezzo negativo). Se tutto plausibile rispondi "OK".',
            'Revisore dati finanziari. Rispondi brevissimo in italiano.'
          );
          if (crossCheck && crossCheck.response && crossCheck.response.trim() !== 'OK') {
            needs_review = true;
            data.notes = (data.notes || '') + ' [Gemini: ' + crossCheck.response.substring(0, 100) + ']';
          }
        } catch(e) {
          logger.warn('[CRON] operazione fallita:', e.message);
        }
      }

      await db.saveQuote({
        client_name: data.client_name, project_name: data.project_name, service_category: data.service_category,
        service_tags: data.service_tags || [], deliverables: data.deliverables || [], resources: data.resources || [],
        total_days: data.total_days, total_cost_interno: data.total_cost_interno, price_quoted: data.price_quoted,
        markup_pct: data.markup_pct, status: data.status || 'unknown', date: data.date || null,
        quote_year: data.date ? new Date(data.date).getFullYear() : null,
        quote_quarter: data.date ? 'Q' + Math.ceil((new Date(data.date).getMonth() + 1) / 3) + ' ' + new Date(data.date).getFullYear() : null,
        pricing_era: pricing_era, source_doc_id: file.id, source_doc_name: file.name,
        needs_review: needs_review, confidence: data.confidence, notes: data.notes, cataloged_at: new Date().toISOString(),
      });

      results.catalogati++;
      results.per_era[pricing_era] = (results.per_era[pricing_era] || 0) + 1;
      if (data.service_category) results.per_categoria[data.service_category] = (results.per_categoria[data.service_category] || 0) + 1;
      results.per_stato[data.status || 'unknown']++;
      if (data.price_quoted && data.status === 'accepted') results.valori.push(data.price_quoted);
      if (needs_review) results.da_rivedere.push(file.name);

      await new Promise(function(r) { setTimeout(r, 500); });
    } catch(e) {
      logger.error('[CATALOGA] Errore file ' + file.name + ':', e.message);
      results.da_rivedere.push(file.name + ' (errore: ' + e.message.substring(0, 50) + ')');
    }
  }

  var totaleValore = results.valori.reduce(function(a, b) { return a + b; }, 0);
  var report = '*Scansione preventivi completata*\n\n';
  report += '*Trovati:* ' + files.length + ' file analizzati\n';
  report += '*Catalogati:* ' + results.catalogati + ' nuovi';
  if (results.saltati > 0) report += ' | *Già presenti:* ' + results.saltati;
  report += '\n\n*Per era:*\n• Pre-ratecard (< 2024): ' + results.per_era['pre-ratecard'] + '\n• Ratecard v1 (2024-mid2025): ' + results.per_era['ratecard-v1'] + '\n• Ratecard v2 (2025-oggi): ' + results.per_era['ratecard-v2'] + '\n\n';
  if (Object.keys(results.per_categoria).length > 0) {
    report += '*Per categoria:*\n';
    Object.keys(results.per_categoria).forEach(function(k) { report += '• ' + k + ': ' + results.per_categoria[k] + '\n'; });
    report += '\n';
  }
  report += '*Per stato:*\n• Accettati: ' + results.per_stato.accepted;
  if (totaleValore > 0) report += ' (tot. ' + totaleValore.toLocaleString('it-IT') + ')';
  report += '\n• Rifiutati: ' + results.per_stato.rejected + '\n• Bozze/sconosciuto: ' + (results.per_stato.draft + results.per_stato.unknown) + '\n';
  if (results.da_rivedere.length > 0) {
    report += '\n*Da revisionare manualmente:* ' + results.da_rivedere.length + ' file\n';
    results.da_rivedere.slice(0, 5).forEach(function(n) { report += '• ' + n + '\n'; });
    if (results.da_rivedere.length > 5) report += '...e altri ' + (results.da_rivedere.length - 5) + '\n';
  }
  if (rateCard) report += '\n_Rate card trovata e salvata_';
  await app.client.chat.postMessage({ channel: channelId, text: formatPerSlack(report) });
}

// ─── Schedule cron jobs ────────────────────────────────────────────────────────

// ─── Unanswered Questions Monitor ─────────────────────────────────────────────

async function monitoraDomandeInSospeso() {
  logger.info('[MONITOR] Controllo domande in sospeso...');

  try {
    var channelsRes = await app.client.conversations.list({
      limit: 50,
      types: 'public_channel,private_channel',
    });
    var channels = (channelsRes.channels || [])
      .filter(function(c) { return !c.is_archived; });

    var dueOreFa = String(Math.floor(
      (Date.now() - 2 * 60 * 60 * 1000) / 1000
    ));

    for (var ci = 0; ci < channels.length; ci++) {
      var ch = channels[ci];
      try {
        var hist = await app.client.conversations.history({
          channel: ch.id,
          oldest: dueOreFa,
          limit: 20,
        });
        var msgs = (hist.messages || []).filter(function(m) {
          return !m.bot_id && m.type === 'message' && m.text &&
            (m.text.includes('?') ||
             m.text.toLowerCase().includes('qualcuno sa') ||
             m.text.toLowerCase().includes('come si fa') ||
             m.text.toLowerCase().includes('qualcuno può'));
        });

        for (var mi = 0; mi < msgs.length; mi++) {
          var msg = msgs[mi];
          if (msg.reply_count && msg.reply_count > 0) continue;

          var kbResults = db.searchKB(msg.text.substring(0, 100));
          if (kbResults.length === 0) continue;

          try {
            var Anthropic = require('@anthropic-ai/sdk');
            var client = new Anthropic();
            var res = await client.messages.create({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 200,
              system: 'Hai trovato info rilevanti nella KB aziendale. ' +
                'Rispondi in 2-3 righe massimo alla domanda. ' +
                'Formato Slack: *grassetto* per punti chiave. MAI ** o ##. ' +
                'Se le info non sono pertinenti alla domanda, rispondi solo "SKIP".',
              messages: [{
                role: 'user',
                content: 'Domanda: ' + msg.text.substring(0, 200) +
                  '\n\nKB:\n' + kbResults.slice(0, 2)
                    .map(function(k) { return k.content; }).join('\n'),
              }],
            });

            var reply = res.content[0].text.trim();
            if (reply !== 'SKIP' && reply.length > 10) {
              await app.client.chat.postMessage({
                channel: ch.id,
                thread_ts: msg.ts,
                text: reply,
              });
              logger.info('[MONITOR] Risposta postata in #' + ch.name);
            }
          } catch(e) {
            logger.warn('[CRON] operazione fallita:', e.message);
          }
        }
      } catch(e) {
        logger.warn('[CRON] operazione fallita:', e.message);
      }
    }
  } catch(e) {
    logger.error('[MONITOR] Errore:', e.message);
  }
}

// ─── Memory Consolidation ─────────────────────────────────────────────────────

async function consolidaMemorie() {
  var Anthropic = require('@anthropic-ai/sdk');
  var client = new Anthropic();
  var memCache = db.getMemCache();
  var userIds = Object.keys(memCache);
  var totalConsolidated = 0;

  for (var u = 0; u < userIds.length; u++) {
    var userId = userIds[u];
    var memories = memCache[userId];
    if (!memories || memories.length < 5) continue;

    // Group by ENTITY (not just tags) — more effective consolidation
    var entityGroups = {};
    memories.forEach(function(m) {
      // Extract entity from content or tags
      var entityKey = '_general';
      var tags = m.tags || [];
      for (var ti = 0; ti < tags.length; ti++) {
        if (tags[ti].startsWith('cliente:') || tags[ti].startsWith('progetto:') || tags[ti].startsWith('persona:')) {
          entityKey = tags[ti];
          break;
        }
      }
      // Also group by entity_refs if available
      if (m.entity_refs && m.entity_refs.length > 0) {
        entityKey = 'entity:' + m.entity_refs[0];
      }
      if (!entityGroups[entityKey]) entityGroups[entityKey] = [];
      entityGroups[entityKey].push(m);
    });

    var keys = Object.keys(entityGroups);
    for (var k = 0; k < keys.length; k++) {
      var group = entityGroups[keys[k]];
      if (group.length < 3) continue;

      // Sort by date, newest first
      group.sort(function(a, b) { return new Date(b.created || 0) - new Date(a.created || 0); });

      try {
        var res = await client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 800,
          system: 'Consolida queste memorie di un\'agenzia di marketing. Per ogni gruppo:\n' +
            '1. ELIMINA duplicati e info superate (tieni la più recente)\n' +
            '2. FONDI memorie episodiche simili in UNA memoria semantica completa\n' +
            '3. Esempio: 5 frammenti su "Aitho" → 1 memoria: "Aitho: cliente dal 2025, branding+social, budget €15k, contatto Marco, canale #aitho, ultimo progetto logo Q1 2026"\n' +
            '4. Per tool_result e search_pattern: elimina se >7 giorni e non utili\n\n' +
            'JSON: {"delete_ids": ["id1"], "new_memories": [{"content": "testo consolidato", "tags": ["tipo:valore"], "memory_type": "semantic"}]}\n' +
            'Se non serve: {"delete_ids": [], "new_memories": []}',
          messages: [{
            role: 'user',
            content: 'Entità/gruppo: ' + keys[k] + ' (' + group.length + ' memorie)\n\n' +
              group.slice(0, 20).map(function(m) {
                return '- [ID:' + m.id + '] [' + (m.memory_type || '?') + '] [' + (m.created || '?').substring(0, 10) + '] ' + (m.content || '').substring(0, 200);
              }).join('\n'),
          }],
        });

        var text = res.content[0].text.trim();
        var jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) continue;

        var result = safeParse('CRON.consolidate', jsonMatch[0], null);
        if (result.delete_ids && result.delete_ids.length > 0) {
          for (var d = 0; d < result.delete_ids.length; d++) {
            await db.deleteMemory(userId, result.delete_ids[d]);
            totalConsolidated++;
          }
        }
        if (result.new_memories && result.new_memories.length > 0) {
          for (var n = 0; n < result.new_memories.length; n++) {
            var nm = result.new_memories[n];
            await db.addMemory(userId, nm.content, nm.tags || [], {
              memory_type: nm.memory_type || 'semantic',
              confidence_score: 0.85,
            });
          }
        }
      } catch(e) {
        logger.error('[CONSOLIDATE] Errore per user ' + userId + ':', e.message);
      }
    }
  }

  logger.info('[CONSOLIDATE] Completato. Memorie consolidate/rimosse:', totalConsolidated);
}

function scheduleCrons() {
  cron.schedule('45 8 * * 1-5', inviaRoutineGiornaliera, { timezone: 'Europe/Rome' });
  // Daily Standup V2 — replaces old inviaStandupDomande/pubblicaRecapStandup
  var dailyStandup = require('./dailyStandupV2');
  dailyStandup.scheduleDailyJobs(cron);
  // Weekly report V2 — venerdì 17:00
  cron.schedule('0 17 * * 5', function() {
    var { sendWeeklyReports } = require('../agents/weeklyReport');
    sendWeeklyReports().catch(function(e) { logger.error('[WEEKLY-CRON] Errore:', e.message); });
  }, { timezone: 'Europe/Rome' });
  // Follow-up agent — ogni 4 ore lun-ven durante orario lavorativo
  cron.schedule('0 9,13,17 * * 1-5', function() {
    var { runFollowups } = require('../agents/followUpAgent');
    runFollowups().catch(function(e) { logger.error('[FOLLOWUP-CRON] Errore:', e.message); });
  }, { timezone: 'Europe/Rome' });
  // Pre-call briefing — ogni 30 min durante orario lavorativo
  cron.schedule('*/30 8-18 * * 1-5', function() {
    var { checkUpcomingCalls } = require('../agents/preCallBriefing');
    checkUpcomingCalls().catch(function(e) { logger.error('[PRECALL-CRON] Errore:', e.message); });
  }, { timezone: 'Europe/Rome' });
  // Legacy weekly recap (kept as fallback)
  cron.schedule('0 17 * * 5', inviaRecapSettimanale, { timezone: 'Europe/Rome' });
  cron.schedule('0 */2 * * *', indicizzaDriveTutti, { timezone: 'Europe/Rome' });
  cron.schedule('0 */4 * * *', digerisciCanali, { timezone: 'Europe/Rome' });
  cron.schedule('0 10 * * 1-5', invitaNonConnessi, { timezone: 'Europe/Rome' });
  cron.schedule('30 */2 * * 1-5', monitoraDomandeInSospeso, { timezone: 'Europe/Rome' }); // ogni 2 ore lun-ven
  // Proactive monitor — ogni 3 ore durante orario lavorativo
  cron.schedule('0 10,13,16 * * 1-5', function() {
    var { runProactiveScan } = require('../agents/proactiveMonitor');
    runProactiveScan().catch(function(e) { logger.error('[PROACTIVE-CRON] Errore:', e.message); });
  }, { timezone: 'Europe/Rome' });
  // Behavior tracker flush — ogni 5 minuti
  cron.schedule('*/5 * * * *', function() {
    var behaviorTracker = require('../services/behaviorTracker');
    behaviorTracker.flushToDb().catch(function(e) { logger.warn('[BEHAVIOR-CRON] Flush error:', e.message); });
  });
  cron.schedule('0 3 * * 0,3', consolidaMemorie, { timezone: 'Europe/Rome' }); // domenica e mercoledì alle 3:00
  cron.schedule('30 3 * * 0', async function() {
    try {
      var expired = await db.cleanupExpiredKB();
      var reviewed = await db.reviewPendingKB();
      logger.info('[KB-CLEANUP] Scadute rimosse:', expired, '| Promosse:', reviewed.promoted, '| Rifiutate:', reviewed.rejected);
    } catch(e) { logger.error('[KB-CLEANUP] Errore:', e.message); }
  }, { timezone: 'Europe/Rome' }); // domenica alle 3:30
  cron.schedule('0 2 * * *', function() {
    var { runKnowledgeEngine } = require('../agents/knowledgeEngine');
    runKnowledgeEngine('system').catch(function(e) { logger.error('[KB-ENGINE] Errore cron:', e.message); });
  }, { timezone: 'Europe/Rome' }); // ogni notte alle 2:00
  // Historical scanner — gira ogni notte alle 1:00, processa 5 canali per run
  // Continua automaticamente ogni notte finché tutti i canali non sono 'done'
  cron.schedule('0 1 * * *', async function() {
    var locked = await acquireCronLock('historical_scan', 120);
    if (!locked) return;
    try {
      var { runHistoricalScan } = require('../jobs/historicalScanner');
      var result = await runHistoricalScan({ batchSize: 5 });
      logger.info('[HISTORICAL-SCAN] Nightly run:', JSON.stringify(result));
    } catch(e) { logger.error('[HISTORICAL-SCAN] Errore:', e.message); }
    finally { await releaseCronLock('historical_scan'); }
  }, { timezone: 'Europe/Rome' });
  // PM Signals — ogni mattina alle 6:30
  cron.schedule('30 6 * * 1-5', async function() {
    var locked = await acquireCronLock('pm_signals', 30);
    if (!locked) return;
    try {
      var { runPMSignals } = require('../jobs/pmSignalsJob');
      await runPMSignals();
    } catch(e) { logger.error('[PM-SIGNALS] Errore:', e.message); }
    finally { await releaseCronLock('pm_signals'); }
  }, { timezone: 'Europe/Rome' });
  // Sheet Scanner — ogni giorno alle 7:00
  cron.schedule('0 7 * * *', async function() {
    var locked = await acquireCronLock('sheet_scanner', 30);
    if (!locked) return;
    try {
      var { runSheetScanner } = require('../jobs/sheetScannerJob');
      await runSheetScanner();
    } catch(e) { logger.error('[SHEET-SCAN] Errore:', e.message); }
    finally { await releaseCronLock('sheet_scanner'); }
  }, { timezone: 'Europe/Rome' });
  logger.info('Routine schedulata: lun-ven alle 8:45 Europe/Rome');
  logger.info('Historical scan: ogni notte alle 1:00 (5 canali/run)');
  logger.info('PM Signals: lun-ven alle 6:30');
  logger.info('Sheet Scanner: ogni giorno alle 7:00');
  // Drive Watcher — ogni 30 min durante orario lavorativo
  cron.schedule('*/30 8-20 * * *', async function() {
    var locked = await acquireCronLock('drive_watcher', 15);
    if (!locked) return;
    try {
      var { runDriveWatcher } = require('../jobs/driveWatcherJob');
      await runDriveWatcher();
    } catch(e) { logger.error('[DRIVE-WATCH] Errore:', e.message); }
    finally { await releaseCronLock('drive_watcher'); }
  }, { timezone: 'Europe/Rome' });
  logger.info('Drive Watcher: ogni 30 min 8-20');
  // Memory maintenance — domenica notte
  cron.schedule('0 2 * * 0', async function() {
    var locked = await acquireCronLock('memory_consolidation', 60);
    if (!locked) return;
    try { var { runConsolidation } = require('../jobs/memoryConsolidationJob'); await runConsolidation(); }
    catch(e) { logger.error('[MEM-CONSOLIDATE]', e.message); }
    finally { await releaseCronLock('memory_consolidation'); }
  }, { timezone: 'Europe/Rome' });
  cron.schedule('0 3 * * 0', async function() {
    var locked = await acquireCronLock('graph_enricher', 60);
    if (!locked) return;
    try { var { runGraphEnricher } = require('../jobs/graphEnricherJob'); await runGraphEnricher(); }
    catch(e) { logger.error('[GRAPH-ENRICH]', e.message); }
    finally { await releaseCronLock('graph_enricher'); }
  }, { timezone: 'Europe/Rome' });
  cron.schedule('0 4 * * 0', async function() {
    var locked = await acquireCronLock('entity_backfill', 60);
    if (!locked) return;
    try { var { runEntityBackfill } = require('../jobs/entityBackfillJob'); await runEntityBackfill(); }
    catch(e) { logger.error('[ENTITY-BACKFILL]', e.message); }
    finally { await releaseCronLock('entity_backfill'); }
  }, { timezone: 'Europe/Rome' });
  cron.schedule('0 5 1-7 * 1', async function() {
    var locked = await acquireCronLock('kb_quality_sweep', 60);
    if (!locked) return;
    try { var { runQualitySweep } = require('../jobs/kbQualitySweepJob'); await runQualitySweep(); }
    catch(e) { logger.error('[KB-SWEEP]', e.message); }
    finally { await releaseCronLock('kb_quality_sweep'); }
  }, { timezone: 'Europe/Rome' });
  logger.info('Memory maintenance: dom 2:00-4:00, KB sweep 1° lun mese');
  logger.info('Standup asincrono: domande 9:05, recap 10:00 lun-ven in #' + STANDUP_CHANNEL);
  logger.info('Recap settimanale: venerdì alle 17:00 Europe/Rome');
  logger.info('Drive auto-index: ogni 2 ore');
  logger.info('Channel digest: ogni 4 ore');
  logger.info('Memory consolidation: domenica alle 3:00');
}

module.exports = {
  scheduleCrons: scheduleCrons,
  inviaRoutineGiornaliera: inviaRoutineGiornaliera,
  inviaStandupDomande: inviaStandupDomande,
  pubblicaRecapStandup: pubblicaRecapStandup,
  inviaRecapSettimanale: inviaRecapSettimanale,
  indicizzaDriveTutti: indicizzaDriveTutti,
  indicizzaDriveUtente: indicizzaDriveUtente,
  digerisciCanali: digerisciCanali,
  catalogaPreventivi: catalogaPreventivi,
  elaboraPreventivi: elaboraPreventivi,
  inviaOnboardingPersonalizzato: inviaOnboardingPersonalizzato,
  invitaNonConnessi: invitaNonConnessi,
  consolidaMemorie: consolidaMemorie,
  monitoraDomandeInSospeso: monitoraDomandeInSospeso,
  getSlackBriefingData: getSlackBriefingData,
  buildBriefingUtente: buildBriefingUtente,
  MANSIONI_TEAM: MANSIONI_TEAM,
};
