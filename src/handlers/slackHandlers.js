// ─── Slack Handlers ────────────────────────────────────────────────────────────
// All app.event(), app.message(), app.command() registrations.
// Uses router from orchestrator instead of calling askGiuno directly.

'use strict';

var logger = require('../utils/logger');
var { formatPerSlack } = require('../utils/slackFormat');
var { app } = require('../services/slackService');
var { getUtenti } = require('../services/slackService');
var { getUserRole, checkPermission, getRoleSystemPrompt, getAccessDeniedMessage, setUserRole, getAllRoles } = require('../../rbac');
var { getUserTokens, generaLinkOAuth, rimuoviTokenUtente } = require('../services/googleAuthService');
var db = require('../../supabase');
var { route } = require('../orchestrator/router');
var { catalogaConfirm } = require('../tools/registry');
var { detectAndSaveDeadlines } = require('../agents/deadlineDetector');
var { autoSummarizeDriveLinks } = require('../agents/driveLinkSummarizer');
var { processMessageFiles } = require('../agents/fileAnalyzer');
var { processSlackMessage: watchMemory } = require('../services/slackMemoryWatcher');
var { createRequestContext, withRequestContext } = require('../utils/requestContext');
var metricsService = require('../services/metricsService');
var { toUserErrorMessage } = require('../utils/errorResponse');
var feedbackCorrections = require('../utils/feedbackCorrections');
var { isDegradedReply } = require('../utils/degradedReply');
var appHome = require('./appHomeHandler');
var behaviorTracker = require('../services/behaviorTracker');
var sentimentClassifier = require('../services/sentimentClassifier');
var { withTimeout, withRetry } = require('../utils/retryPolicy');

// Register App Home tab
appHome.register();

// ─── In-memory state ───────────────────────────────────────────────────────────

var processedEvents = new Set();
var botMessages = new Map(); // ts -> { userId, text, channel, timestamp }
var lastBotMessageByChannel = new Map(); // channelId -> { ts, userId, timestamp }
var stats = { startedAt: new Date().toISOString(), messagesHandled: 0, toolCallsTotal: 0 };
var standupInAttesa = new Set();

// Called from app.js after db.initAll() has populated the standup cache.
function rehydrateStandupInAttesa() {
  try {
    var sd = db.getStandupCache();
    var today = require('./dailyStandupV2').oggi();
    standupInAttesa.clear();
    if (sd.oggi === today && Array.isArray(sd.inattesa)) {
      sd.inattesa.forEach(function(uid) { standupInAttesa.add(uid); });
    }
    logger.info('[STARTUP] Standup state rehydrated for', today, '— inattesa:', standupInAttesa.size);
  } catch(e) {
    logger.warn('[STARTUP] rehydrateStandupInAttesa:', e.message);
  }
}

// Periodic cleanup
setInterval(function() {
  var cutoff = Date.now() - 30 * 60 * 1000;
  botMessages.forEach(function(v, k) { if (v.timestamp && v.timestamp < cutoff) botMessages.delete(k); });
  lastBotMessageByChannel.forEach(function(v, k) { if (v.timestamp < cutoff) lastBotMessageByChannel.delete(k); });
}, 10 * 60 * 1000);

// ─── Helpers ───────────────────────────────────────────────────────────────────

function dedup(ts) {
  if (processedEvents.has(ts)) return false;
  processedEvents.add(ts);
  if (processedEvents.size > 200) {
    var arr = Array.from(processedEvents);
    for (var i = 0; i < arr.length - 100; i++) processedEvents.delete(arr[i]);
  }
  return true;
}

async function saveCorrectionFeedback(userId, text) {
  try {
    var content = 'CORREZIONE_BRIEFING: ' + (text || '').substring(0, 500);
    await db.addMemory(userId, content, ['feedback', 'correzione', 'briefing'], {
      memoryType: 'feedback',
      confidenceScore: 0.9,
      source: 'dm_correction',
      entityRefs: [],
    });
    logger.info('[FEEDBACK-CORRECTION] salvata per user:', userId);
    return true;
  } catch (e) {
    logger.error('[FEEDBACK-CORRECTION] errore salvataggio:', e.message);
    return false;
  }
}

// ─── app_mention ───────────────────────────────────────────────────────────────

app.event('app_mention', async function(args) {
  var event = args.event;
  if (!dedup(event.ts)) return;
  var threadTs = event.thread_ts || event.ts;
  stats.messagesHandled++;
  metricsService.increment('request_total');
  metricsService.increment('request_app_mention_total');

  return withRequestContext(createRequestContext({
    userId: event.user,
    channelId: event.channel,
    threadTs: threadTs,
    source: 'app_mention',
  }), async function() {
  try {
    // "Sta scrivendo" — reagisci subito per feedback visivo
    try { await app.client.reactions.add({ channel: event.channel, timestamp: event.ts, name: 'eyes' }); } catch(e) { /* already reacted or missing scope */ }

    var text = event.text.replace(/<@[^>]+>/g, '').trim();

    // Track behavior + classify sentiment for channel mentions
    behaviorTracker.trackInteraction(event.user, text, { channelId: event.channel, isDM: false });
    var mentionSentiment = sentimentClassifier.classify(text);

    // Detect CC/presa visione: if message mentions other users AND Giuno is at the end
    var isCCMention = false;
    var rawText = event.text || '';
    var mentionMatches = rawText.match(/<@[A-Z0-9]+>/g) || [];
    if (mentionMatches.length >= 2) {
      // Giuno's mention is among several — likely CC
      var botUserId = (app.client && app.client.token) ? null : null; // We'll detect by position
      var giunoMentionIdx = rawText.lastIndexOf('<@');
      var textAfterGiuno = rawText.substring(giunoMentionIdx).replace(/<@[^>]+>/, '').trim();
      // If Giuno is the last mention and nothing meaningful follows → CC
      if (textAfterGiuno.length < 10) isCCMention = true;
    }
    // Also detect patterns like "message to someone. @Giuno"
    if (!isCCMention && mentionMatches.length >= 2 && text.length < 15) {
      isCCMention = true; // Very little text directed at Giuno specifically
    }

    // Collect channel context
    var channelContext = '';
    var ch = {};
    try {
      var chInfo = await app.client.conversations.info({ channel: event.channel });
      ch = chInfo.channel || {};
      channelContext += 'CANALE: #' + (ch.name || 'sconosciuto');
      if (ch.topic && ch.topic.value) channelContext += '\nTopic: ' + ch.topic.value;
      if (ch.purpose && ch.purpose.value) channelContext += '\nDescrizione: ' + ch.purpose.value;
      channelContext += '\n';
    } catch(e) {
      logger.debug('[SLACK-HANDLER] conversations.info ignorato:', e.message);
    }

    try {
      var recentMsgs;
      if (event.thread_ts) {
        var threadRes = await app.client.conversations.replies({ channel: event.channel, ts: event.thread_ts, limit: 30 });
        recentMsgs = (threadRes.messages || []).slice(-30);
      } else {
        var histRes = await app.client.conversations.history({ channel: event.channel, limit: 30 });
        recentMsgs = (histRes.messages || []).reverse();
      }
      if (recentMsgs.length > 0) {
        // For substantive chatter (>=10 real messages, excluding bots + current
        // event) ask Haiku for a one-paragraph topic recap BEFORE dumping the
        // raw transcript. Stops Giuno from answering off-topic when dropped
        // into a long conversation mid-thread.
        var realMsgs = recentMsgs.filter(function(m) { return m.ts !== event.ts && !m.bot_id && m.text; });
        if (realMsgs.length >= 10) {
          try {
            var { askGemini: _unused } = require('../services/geminiService'); // lazy check Anthropic availability
            var Anthropic = require('@anthropic-ai/sdk');
            var haiku = new Anthropic();
            var topicTranscript = realMsgs.slice(-20).map(function(m) {
              return (m.user ? '<@' + m.user + '>' : 'bot') + ': ' + (m.text || '').substring(0, 250);
            }).join('\n');
            var topicRes = await haiku.messages.create({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 200,
              system: 'Sei un osservatore silenzioso in un canale Slack. In 2-3 frasi italiane descrivi: (1) di cosa si sta parlando adesso, (2) chi sta facendo cosa, (3) qual è la domanda/decisione aperta se esiste. Niente saluti, niente meta-commenti.',
              messages: [{ role: 'user', content: topicTranscript }],
            });
            var topic = topicRes.content && topicRes.content[0] && topicRes.content[0].text ? topicRes.content[0].text.trim() : '';
            if (topic) channelContext += '\nTOPIC ATTUALE DEL ' + (event.thread_ts ? 'THREAD' : 'CANALE') + ':\n' + topic + '\n';
          } catch(topicErr) {
            logger.debug('[SLACK-HANDLER] topic autosummary skipped:', topicErr.message);
          }
        }
        channelContext += '\nCONVERSAZIONE RECENTE NEL CANALE:\n';
        for (var rm of recentMsgs.slice(-15)) {
          if (rm.ts === event.ts) continue;
          var who = rm.user ? '<@' + rm.user + '>' : 'bot';
          channelContext += who + ': ' + (rm.text || '').substring(0, 300) + '\n';
        }
      }
    } catch(e) {
      logger.debug('[SLACK-HANDLER] fetch messaggi recenti ignorato:', e.message);
    }

    try {
      var membersRes = await app.client.conversations.members({ channel: event.channel, limit: 50 });
      var memberIds = (membersRes.members || []).filter(function(id) { return id !== event.user; });
      if (memberIds.length > 0) {
        channelContext += '\nMEMBRI PRESENTI NEL CANALE: ' + memberIds.map(function(id) { return '<@' + id + '>'; }).join(', ') + '\n';
      }
    } catch(e) {
      logger.debug('[SLACK-HANDLER] fetch membri canale ignorato:', e.message);
    }

    // Inject Giuno's last response in this channel as context
    var lastBotCtx = '';
    var lastBot = lastBotMessageByChannel.get(event.channel);
    if (lastBot && (Date.now() - lastBot.timestamp) < 600000) { // Within 10 min
      var lastBotMsg = botMessages.get(lastBot.ts);
      if (lastBotMsg && lastBotMsg.text) {
        lastBotCtx = '\n[LA MIA ULTIMA RISPOSTA IN QUESTO CANALE (< 10 min fa):\n' + lastBotMsg.text.substring(0, 300) + ']\n';
      }
    }

    var mentionChannelType = ch.is_private ? 'private' : 'public';

    // If CC mention: add instruction to not respond unless necessary
    var ccInstruction = '';
    if (isCCMention) {
      ccInstruction = '\n[SEI IN CC/PRESA VISIONE su questo messaggio. NON rispondere a meno che:\n' +
        '1. Ti venga fatta una domanda diretta\n' +
        '2. Ci sia un errore grave da segnalare\n' +
        '3. Puoi aggiungere info critiche che nessuno ha\n' +
        'Se nessuna di queste condizioni è vera, rispondi con un brevissimo "👀 Visto." o non rispondere.]\n';
    }

    var reply = await route(event.user, text, {
      mentionedBy: event.user,
      threadTs: threadTs,
      channelContext: channelContext,
      channelId: ch.id || null,
      channelType: mentionChannelType,
      sentiment: mentionSentiment,
      preflightInstruction: (lastBotCtx + (ccInstruction || '')).trim() || undefined,
    });

    var degradedMentionReply = isDegradedReply(reply);

    // Gemini quality gate
    var { askGemini } = require('../services/geminiService');
    if (!degradedMentionReply && reply && reply.length > 30) {
      try {
        var qgReview = await askGemini(
          'Rivedi questa risposta di un bot aziendale in un canale Slack pubblico.\n' +
          'Domanda utente: ' + text.substring(0, 300) + '\n' +
          'Risposta bot: ' + reply.substring(0, 1000) + '\n\n' +
          'Controlla: tono professionale ma informale, niente dati sensibili esposti (password, token, IBAN), info coerente, niente hallucination evidenti.\n' +
          'Se tutto ok rispondi SOLO "OK". Se c\'è un problema, suggerisci la correzione in 1 riga.',
          'Revisore qualità comunicazione aziendale. Brevissimo, italiano.'
        );
        if (qgReview && qgReview.response && qgReview.response.trim() !== 'OK') {
          logger.warn('[QUALITY-GATE] Gemini nota:', qgReview.response.substring(0, 100));
          // Non modificare la reply — la nota è solo per i log
        }
      } catch(e) { logger.error('Gemini quality gate error:', e.message); }
    }

    var formatted = formatPerSlack(reply);
    if (!formatted) {
      logger.warn('[MENTION] Reply vuota per', event.user, '- skip postMessage');
      try { await app.client.reactions.remove({ channel: event.channel, timestamp: event.ts, name: 'eyes' }); } catch(e) { /* ignore */ }
      return;
    }
    // Confidence gate: if reply is low-quality filler, don't post in channel
    var isFillerReply = /^(non ho (trovato|informazioni|dati)|non sono sicuro|non saprei|devo verificare|al momento non|purtroppo non)/i.test(reply.trim());
    var isTooGeneric = reply.trim().length < 30 && !/fatto|ok|registrato|salvato/i.test(reply);
    if (isFillerReply && !event.thread_ts) {
      // In main channel: don't post filler. In thread: it's ok to say "non so"
      logger.info('[MENTION] Confidence gate: reply troppo generica, skip');
      try { await app.client.reactions.remove({ channel: event.channel, timestamp: event.ts, name: 'eyes' }); } catch(e) { /* ignore */ }
      return;
    }
    // Rimuovi reaction "sta scrivendo" prima di rispondere
    try { await app.client.reactions.remove({ channel: event.channel, timestamp: event.ts, name: 'eyes' }); } catch(e) { /* ignore */ }

    var posted = await app.client.chat.postMessage({ channel: event.channel, text: formatted, thread_ts: threadTs });
    if (posted && posted.ts) {
      botMessages.set(posted.ts, { userId: event.user, text: formatted, channel: event.channel, timestamp: Date.now() });
      lastBotMessageByChannel.set(event.channel, { ts: posted.ts, userId: event.user, timestamp: Date.now() });
    }

    // Background: detect deadlines and auto-summarize Drive links
    if (!degradedMentionReply) {
      detectAndSaveDeadlines(event.user, text, event.channel).catch(function(e) {});
      autoSummarizeDriveLinks(event.user, event.text, event.channel, threadTs).catch(function(e) {});
    }
  } catch(err) {
    metricsService.increment('request_failed_total');
    metricsService.increment('request_app_mention_failed_total');
    await app.client.chat.postMessage({ channel: event.channel, text: toUserErrorMessage(err), thread_ts: threadTs });
  }
  });
});

// ─── app.message ──────────────────────────────────────────────────────────────

app.message(async function(args) {
  var message = args.message;
  if (message.bot_id) return;

  metricsService.increment('request_total');
  metricsService.increment('request_app_message_total');

  return withRequestContext(createRequestContext({
    userId: message.user,
    channelId: message.channel,
    threadTs: message.thread_ts || message.ts,
    source: 'app_message',
  }), async function() {

  // Passive memory watcher (fire-and-forget) — now also in DMs
  if (message.text) {
    watchMemory(message, message.channel).catch(function() {});
    // Auto-read Drive links shared in channels (not just mentions)
    if (message.text && /docs\.google\.com|drive\.google\.com/i.test(message.text)) {
      autoSummarizeDriveLinks(message.user, message.text, message.channel, message.thread_ts || message.ts).catch(function() {});
    }
  }
  // Auto-analyze uploaded files (channel and DM)
  if (message.files && message.files.length > 0) {
    processMessageFiles(message, message.channel).catch(function() {});
  }

  // Implicit channel replies
  if (message.channel_type !== 'im') {
    var isImplicitReply = false;
    var implicitThreadTs = null;

    if (message.thread_ts && botMessages.has(message.thread_ts)) {
      isImplicitReply = true;
      implicitThreadTs = message.thread_ts;
    }
    if (!isImplicitReply) {
      var lastBot = lastBotMessageByChannel.get(message.channel);
      if (lastBot && (Date.now() - lastBot.timestamp) < 120000 && lastBot.userId === message.user) {
        isImplicitReply = true;
        implicitThreadTs = lastBot.ts;
      }
    }
    if (!isImplicitReply) return;
    if (!dedup(message.ts)) return;

    stats.messagesHandled++;
    try {
      // Read thread context for implicit replies
      var implicitRouteOpts = { threadTs: implicitThreadTs, channelId: message.channel, channelType: 'public' };
      if (implicitThreadTs) {
        try {
          var implicitThreadHistory = await app.client.conversations.replies({
            channel: message.channel, ts: implicitThreadTs, limit: 10,
          });
          if (implicitThreadHistory.messages && implicitThreadHistory.messages.length > 1) {
            var prevImplicit = implicitThreadHistory.messages.slice(0, -1);
            var implicitCtx = prevImplicit.map(function(m) {
              var who = m.bot_id ? 'Giuno' : (m.user ? '<@' + m.user + '>' : '???');
              return who + ': ' + (m.text || '').substring(0, 300);
            }).join('\n');
            implicitRouteOpts.preflightInstruction = '[MESSAGGI PRECEDENTI NEL THREAD:\n' + implicitCtx + ']\n' +
              'IMPORTANTE: usa questi messaggi per capire il SOGGETTO della conversazione. Non perderlo.';
          }
        } catch(implErr) { /* non bloccante */ }
      }
      // Don't respond if message is clearly directed at another person, not Giuno
      var msgText = message.text || '';
      var mentionsOther = /<@[A-Z0-9]+>/.test(msgText); // mentions someone
      var mentionsGiuno = false;
      try {
        var authTest = await app.client.auth.test();
        mentionsGiuno = msgText.includes('<@' + authTest.user_id + '>');
      } catch(e) { /* ignore */ }
      if (mentionsOther && !mentionsGiuno) {
        // Message tags someone else in the thread — they're talking to each other, not to Giuno
        return;
      }

      var reply = await route(message.user, message.text, implicitRouteOpts);
      var degradedImplicitReply = isDegradedReply(reply);
      var formatted = formatPerSlack(reply);
      if (!formatted) return;
      var posted = await app.client.chat.postMessage({ channel: message.channel, text: formatted, thread_ts: implicitThreadTs });
      if (posted && posted.ts) {
        botMessages.set(posted.ts, { userId: message.user, text: formatted, channel: message.channel, timestamp: Date.now() });
        lastBotMessageByChannel.set(message.channel, { ts: posted.ts, userId: message.user, timestamp: Date.now() });
      }
      // Background: detect deadlines
      if (!degradedImplicitReply) detectAndSaveDeadlines(message.user, message.text, message.channel).catch(function(e) {});
    } catch(err) { metricsService.increment('request_failed_total'); metricsService.increment('request_app_message_failed_total'); logger.error('[IMPLICIT-REPLY] Errore:', err.message); }
    return;
  }

  // ── DM ─────────────────────────────────────────────────────────────────────

  // Standup replies (V2 — routes through dailyStandupV2)
  // Strict detection: only accept messages that CLEARLY look like a daily report.
  // Plain length > 30 is not enough (it catches complaints/questions to the bot).
  if (standupInAttesa.has(message.user)) {
    var dailyV2Oggi = require('./dailyStandupV2').oggi();
    var dailyV2Sd = db.getStandupCache();
    if (dailyV2Sd.oggi === dailyV2Oggi) {
      var txt = (message.text || '').trim();
      var txtLow = txt.toLowerCase();

      // Positive detection: structured header or multiple standup keywords
      var looksStructured = /^\s*\*?(ieri|oggi|blocchi)\*?\s*:/im.test(txt);
      var keywordHits = (txtLow.match(/\b(ieri|oggi|fatto|far[oò]|bloccat|blocco|blocchi|task|consegn|finito|iniziato|call|meeting|ore\b|min\b|h\b|\d+\s*h\b|\d+\s*min\b)/g) || []).length;
      var looksLikeDaily = looksStructured || keywordHits >= 2;

      // Hard rejection: message opens with a request/complaint addressed to the bot.
      // Soft rejection: a question mark alone rejects ONLY when there's no strong daily
      // signal ("Ieri? design. Oggi? mockup. Blocchi? niente." is a valid daily).
      var startsLikeRequest = /^(per favore|ciao giuno|ehi giuno|hey giuno|giuno[,:\s!]|assicurati|puoi |potresti |scusa|aiuto|non (hai|ho|funziona|va))/i.test(txt);
      var hasQuestionMark = /[?¿]/.test(txt);
      var looksLikeRequest = startsLikeRequest || (hasQuestionMark && !looksLikeDaily);

      if (!looksLikeRequest && looksLikeDaily) {
        var dailyStandupV2 = require('./dailyStandupV2');
        var saved = false;
        try {
          saved = await dailyStandupV2.handleDailyResponse(message.user, message.text);
        } catch(e) {
          logger.error('[STANDUP-V2] handleDailyResponse ha throwato:', e.message);
        }
        if (saved) {
          await app.client.chat.postMessage({ channel: message.channel, text: 'Registrato, mbare! Il riepilogo uscirà alle 11:30 in #daily.' });
          logger.info('[STANDUP-V2] Risposta testuale ricevuta da:', message.user);
        } else {
          await app.client.chat.postMessage({ channel: message.channel, text: 'Non sono riuscito a registrare il daily — riprova con il bottone *✏️ Compila daily* o avvisa Antonio.' });
          logger.error('[STANDUP-V2] Save testuale fallito per:', message.user);
        }
        return;
      }
    }
  }

  // Feedback response handler — check if user has pending feedback question
  try {
    var fbSupabase = db.getClient ? db.getClient() : null;
    if (fbSupabase && message.text && message.text.length > 0) {
      var currentMonth = new Date().toISOString().slice(0, 7);
      var { data: pendingFb } = await fbSupabase.from('team_feedback')
        .select('id, question_index, question')
        .eq('slack_user_id', message.user)
        .eq('month', currentMonth)
        .is('answer', null)
        .order('question_index')
        .limit(1);
      if (pendingFb && pendingFb.length > 0) {
        var fb = pendingFb[0];
        var fbText = (message.text || '').trim();

        // If user is asking a clarification question, don't save — respond instead
        var isAskingClarification = /\?$/.test(fbText) && fbText.length < 80;
        // Only complaining about Giuno specifically, not using these words in answers
        var isComplaining = /^(ma ti ho fatto|non mi rispondi|fermati|stop|basta domande)$/i.test(fbText);
        // "Ok", "continua", "vai" = user wants to proceed, re-show the question
        var isJustConfirming = /^(ok|sì|si|vai|continua|avanti|prosegui)$/i.test(fbText);

        if (isJustConfirming) {
          // Re-show the current question
          var { data: totalFbConf } = await fbSupabase.from('team_feedback')
            .select('id').eq('slack_user_id', message.user).eq('month', currentMonth);
          await app.client.chat.postMessage({
            channel: message.channel,
            text: '*' + (fb.question_index + 1) + '/' + (totalFbConf || []).length + ':* ' + fb.question,
          });
          return;
        }

        if (isAskingClarification || isComplaining) {
          var clarificationReply = '';
          if (isComplaining) {
            clarificationReply = 'Scusa! Aspetto la tua risposta alla domanda. Prenditi il tempo che vuoi.\n\n*Domanda:* ' + fb.question;
          } else {
            // Generate a brief clarification using the question context
            clarificationReply = 'Buona domanda! Per chiarire: ' + fb.question + '\n\nRispondi liberamente con la tua esperienza. Non c\'è una risposta giusta o sbagliata.';
          }
          await app.client.chat.postMessage({ channel: message.channel, text: clarificationReply });
          return;
        }

        // Save answer
        await fbSupabase.from('team_feedback').update({ answer: fbText, answered_at: new Date().toISOString() }).eq('id', fb.id);

        // Small acknowledgment before next question
        var acks = ['Capito, grazie.', 'Registrato.', 'Ok, nota presa.', 'Interessante, grazie.'];
        var ack = acks[Math.floor(Math.random() * acks.length)];

        // Check for next question
        var { data: nextFb } = await fbSupabase.from('team_feedback')
          .select('question_index, question')
          .eq('slack_user_id', message.user)
          .eq('month', currentMonth)
          .is('answer', null)
          .order('question_index')
          .limit(1);
        if (nextFb && nextFb.length > 0) {
          var { data: totalFb } = await fbSupabase.from('team_feedback')
            .select('id').eq('slack_user_id', message.user).eq('month', currentMonth);
          var totalCount = (totalFb || []).length;
          // Wait a moment before next question so it feels like a conversation
          await app.client.chat.postMessage({
            channel: message.channel,
            text: ack + '\n\n*' + (nextFb[0].question_index + 1) + '/' + totalCount + ':* ' + nextFb[0].question,
          });
        } else {
          await app.client.chat.postMessage({
            channel: message.channel,
            text: ack + '\n\nGrazie per il feedback! Tutte le risposte sono state salvate. Le leggerò con attenzione. 🙏',
          });
        }
        return; // Don't process further — this was a feedback response
      }
    }
  } catch(e) { logger.debug('[FEEDBACK-DM] Error:', e.message); }

  // import-leads confirm
  var importKey = 'import_leads_' + message.user;
  if (catalogaConfirm.has(importKey)) {
    var impTesto = (message.text || '').toLowerCase().trim();
    if (impTesto === 'sì' || impTesto === 'si' || impTesto === 'ok' || impTesto === 'yes') {
      var impPending = catalogaConfirm.get(importKey);
      catalogaConfirm.delete(importKey);
      await app.client.chat.postMessage({ channel: message.channel, text: 'Importo ' + impPending.leads.length + ' lead...' });
      try {
        var leadsTools = require('../tools/leadsTools');
        var impResult = await leadsTools.importLeadsToSupabase(impPending.leads);
        await app.client.chat.postMessage({
          channel: message.channel,
          text: '*Import completato!*\n• Importati: ' + impResult.imported + '\n• Saltati (duplicati): ' + impResult.skipped + '\n• Errori: ' + impResult.errors,
        });
      } catch(e) {
        await app.client.chat.postMessage({ channel: message.channel, text: toUserErrorMessage(e) });
      }
      return;
    } else if (impTesto === 'no' || impTesto === 'annulla') {
      catalogaConfirm.delete(importKey);
      await app.client.chat.postMessage({ channel: message.channel, text: 'Import annullato.' });
      return;
    }
  }

  // cataloga confirm
  var catConfirmKey = 'cataloga_confirm_' + message.user;
  if (catalogaConfirm.has(catConfirmKey)) {
    var catTesto = (message.text || '').toLowerCase().trim();
    if (catTesto === 'sì' || catTesto === 'si' || catTesto === 'ok' || catTesto === 'yes' || catTesto === 'procedi') {
      var catPending = catalogaConfirm.get(catConfirmKey);
      catalogaConfirm.delete(catConfirmKey);
      var { elaboraPreventivi } = require('./cronHandlers');
      elaboraPreventivi(catPending.userId, catPending.channelId, catPending.files, catPending.rateCard)
        .catch(function(e) { logger.error('[CATALOGA] Errore elaborazione:', e.message); });
      await app.client.chat.postMessage({
        channel: message.channel,
        text: 'Perfetto! Elaboro ' + catPending.files.length + ' file in background. Ti avviso quando ho finito.',
      });
      return;
    } else if (catTesto === 'no' || catTesto === 'annulla' || catTesto === 'stop') {
      catalogaConfirm.delete(catConfirmKey);
      await app.client.chat.postMessage({ channel: message.channel, text: 'Catalogazione annullata.' });
      return;
    }
  }

  stats.messagesHandled++;
  var threadTs = message.thread_ts || null;
  try {
    var originalText = message.text || '';
    var textForRoute = originalText;

    // "Sta scrivendo" — reagisci subito per feedback visivo in DM
    try { await app.client.reactions.add({ channel: message.channel, timestamp: message.ts, name: 'eyes' }); } catch(e) { /* ignore */ }

    // Track behavior + classify sentiment
    behaviorTracker.trackInteraction(message.user, originalText, { channelId: message.channel, isDM: true });
    var msgSentiment = sentimentClassifier.classify(originalText);

    var isCorrection = !!(
      feedbackCorrections &&
      typeof feedbackCorrections.isCorrectionFeedback === 'function' &&
      feedbackCorrections.isCorrectionFeedback(originalText)
    );
    if (isCorrection) {
      metricsService.increment('feedback_correction_total');
      await saveCorrectionFeedback(message.user, originalText);
      if (typeof feedbackCorrections.buildCorrectionPrompt === 'function') {
        textForRoute = feedbackCorrections.buildCorrectionPrompt(originalText);
      }
    }

    // If in a DM thread, read previous messages for context (fix #12)
    var dmThreadContext = '';
    if (threadTs) {
      try {
        var threadHistory = await app.client.conversations.replies({
          channel: message.channel,
          ts: threadTs,
          limit: 10,
        });
        if (threadHistory.messages && threadHistory.messages.length > 1) {
          var previousMessages = threadHistory.messages.slice(0, -1);
          dmThreadContext = previousMessages.map(function(m) {
            var author = m.user ? '<@' + m.user + '>' : 'bot';
            return author + ': ' + (m.text || '').substring(0, 300);
          }).join('\n');
        }
      } catch(threadErr) {
        logger.debug('[DM-THREAD] Lettura thread fallita:', threadErr.message);
      }
    }

    var dmRouteOptions = { threadTs: threadTs, channelType: 'dm', channelId: message.channel, isDM: true, sentiment: msgSentiment };
    // Inject sentiment instruction
    var sentimentInstruction = '';
    if (msgSentiment.urgency !== 'normal' || msgSentiment.sentiment !== 'neutral') {
      sentimentInstruction = '\n[TONO MESSAGGIO: urgenza=' + msgSentiment.urgency + ', sentiment=' + msgSentiment.sentiment + '. Stile risposta: ' + msgSentiment.responseStyle + ']\n';
    }
    if (dmThreadContext) {
      dmRouteOptions.preflightInstruction = sentimentInstruction + '[MESSAGGI PRECEDENTI IN QUESTO THREAD:\n' + dmThreadContext + '\n]\n' +
        'USA QUESTI MESSAGGI per capire il contesto. Se l\'utente si riferisce a qualcosa detto "sopra", le info sono QUI.\n' +
        'Il SOGGETTO della conversazione è determinato da questi messaggi precedenti. Non perderlo.';
    } else if (sentimentInstruction) {
      dmRouteOptions.preflightInstruction = sentimentInstruction;
    }
    var reply = await route(message.user, textForRoute, dmRouteOptions);

    // Rimuovi reaction "sta scrivendo"
    try { await app.client.reactions.remove({ channel: message.channel, timestamp: message.ts, name: 'eyes' }); } catch(e) { /* ignore */ }

    var formatted = formatPerSlack(reply);
    var posted = await app.client.chat.postMessage({ channel: message.channel, text: formatted, thread_ts: threadTs || undefined });
    if (posted && posted.ts) botMessages.set(posted.ts, { userId: message.user, text: formatted, channel: message.channel, timestamp: Date.now() });
  } catch(err) { metricsService.increment('request_failed_total'); metricsService.increment('request_app_message_failed_total'); await app.client.chat.postMessage({ channel: message.channel, text: toUserErrorMessage(err) }); }
  });
});

// ─── /giuno command ────────────────────────────────────────────────────────────

app.command('/giuno', async function(args) {
  var command = args.command, ack = args.ack, respond = args.respond;
  await ack();
  var text = command.text.trim();

  metricsService.increment('request_total');
  metricsService.increment('request_slash_giuno_total');

  return withRequestContext(createRequestContext({
    userId: command.user_id,
    channelId: command.channel_id,
    source: 'slash_giuno',
  }), async function() {

  if (text.startsWith('admin')) {
    await handleAdmin(command, respond);
    return;
  }

  if (text === 'test-daily' || text === 'testdaily') {
    var dailyStandupTest = require('./dailyStandupV2');
    var { getUtenti: getUtentiTest } = require('../services/slackService');
    var utentiTest = await getUtentiTest();
    var meTest = utentiTest.find(function(u) { return u.id === command.user_id; });
    var nomeTest = meTest ? meTest.name.split(' ')[0] : 'Test';
    try {
      standupInAttesa.add(command.user_id);
      var testSd = db.getStandupCache();
      var testOggi = dailyStandupTest.oggi();
      if (testSd.oggi !== testOggi) {
        testSd.oggi = testOggi;
        testSd.risposte = {};
      }
      testSd.risposte = testSd.risposte || {};
      testSd.inattesa = Array.from(standupInAttesa);
      await db.saveStandup(testSd);
      await app.client.chat.postMessage({
        channel: command.user_id,
        text: 'Ciao ' + nomeTest + ', è il momento del daily!',
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: 'Ciao *' + nomeTest + '*, è il momento del daily!' } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: 'Compila il form o rispondi con un messaggio. Il recap esce alle 11:30.' }] },
          { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '✏️ Compila daily', emoji: true }, style: 'primary', action_id: 'open_daily_modal' }] },
        ],
      });
      await respond({ text: 'DM daily inviato!', response_type: 'ephemeral' });
    } catch(e) { await respond({ text: 'Errore: ' + e.message, response_type: 'ephemeral' }); }
    return;
  }

  if (text === 'chi sono' || text === 'chisono') {
    try {
      var myRole = await getUserRole(command.user_id);
      var roleDesc = getRoleSystemPrompt(myRole).split('\n').slice(0, 3).join('\n');
      var utenti = await getUtenti();
      var me = utenti.find(function(u) { return u.id === command.user_id; });
      var myName = me ? me.name : 'Utente';

      var sections = [
        'Ciao ' + myName + '!',
        '• Slack ID: `' + command.user_id + '`',
        '• Livello di accesso: *' + myRole.toUpperCase() + '*',
        '• ' + roleDesc,
      ];

      // What Giuno remembers about this person — transparency panel.
      try {
        var facts = await db.getUserFacts(command.user_id, 20);
        if (facts && facts.length > 0) {
          var byCat = {};
          facts.forEach(function(f) {
            if (!byCat[f.category]) byCat[f.category] = [];
            byCat[f.category].push(f.fact);
          });
          var factLines = Object.keys(byCat).map(function(cat) {
            return '_' + cat + ':_ ' + byCat[cat].join('; ');
          });
          sections.push('\n*Cosa ricordo di te:*\n' + factLines.join('\n'));
        }
      } catch(e) { /* user_facts table may not exist */ }

      try {
        var supabaseForMe = db.getClient && db.getClient();
        if (supabaseForMe) {
          var summaryRes = await supabaseForMe.from('conversation_summaries')
            .select('summary, updated_at, messages_count, proposed_actions')
            .eq('conv_key', command.user_id)
            .limit(1);
          if (summaryRes.data && summaryRes.data.length > 0) {
            var row = summaryRes.data[0];
            var ageH = row.updated_at ? Math.round((Date.now() - new Date(row.updated_at).getTime()) / 3600000) : null;
            if (row.summary) {
              sections.push('\n*Memoria della nostra chat* (aggiornata ' + (ageH != null ? ageH + 'h fa' : 'di recente') + ', ' + (row.messages_count || 0) + ' messaggi totali):\n' + row.summary);
            }
            var openItems = (row.proposed_actions || []).filter(function(a) { return a && a.type === 'open_item' && a.description; });
            if (openItems.length > 0) {
              sections.push('\n*Cose aperte tra noi:*\n' + openItems.slice(0, 5).map(function(a) { return '• ' + a.description; }).join('\n'));
            }
          }
        }
      } catch(e) { /* non-blocking */ }

      sections.push('\n_Se qualcosa non è corretto, dimmelo in DM e lo aggiorno._');

      await respond({ text: sections.join('\n'), response_type: 'ephemeral' });
    } catch(err) { await respond({ text: toUserErrorMessage(err), response_type: 'ephemeral' }); }
    return;
  }

  if (text === 'recap' || text.startsWith('recap ')) {
    try {
      var { getSlackBriefingData, buildBriefingUtente } = require('./cronHandlers');
      var canaliBriefing = await getSlackBriefingData();
      var parti = await buildBriefingUtente(command.user_id, canaliBriefing);
      await respond({ text: formatPerSlack(parti.join('\n\n')) || 'Niente di nuovo, mbare.', response_type: 'ephemeral' });
    } catch(err) { await respond({ text: toUserErrorMessage(err), response_type: 'ephemeral' }); }
    return;
  }

  if (text === 'leads' || text === 'pipeline') {
    var leadsRole = await getUserRole(command.user_id);
    if (leadsRole !== 'admin' && leadsRole !== 'manager' && leadsRole !== 'finance') {
      await respond({ text: 'Non hai accesso alla pipeline lead.', response_type: 'ephemeral' });
      return;
    }
    try {
      var leadsTools = require('../tools/leadsTools');
      var pipeline = await leadsTools.getLeadsPipeline();
      var pMsg = '*Pipeline Lead — ' + (pipeline.total || 0) + ' totali*\n\n';
      var statusLabels = { 'new': 'Nuovi', 'contacted': 'Contattati', 'proposal_sent': 'Proposta inviata', 'negotiating': 'In trattativa', 'won': 'Vinti', 'lost': 'Persi', 'dormant': 'Dormienti' };
      for (var s in statusLabels) {
        if (pipeline.byStatus[s]) pMsg += '• *' + statusLabels[s] + ':* ' + pipeline.byStatus[s] + '\n';
      }
      if (pipeline.upcoming && pipeline.upcoming.length > 0) {
        pMsg += '\n*Followup oggi/domani:*\n';
        pipeline.upcoming.forEach(function(l) {
          pMsg += '• ' + l.company_name + (l.contact_name ? ' (' + l.contact_name + ')' : '') + ' — ' + l.next_followup + '\n';
        });
      } else {
        pMsg += '\n_Nessun followup in scadenza oggi/domani._';
      }
      await respond({ text: pMsg, response_type: 'ephemeral' });
    } catch(e) { await respond({ text: toUserErrorMessage(e), response_type: 'ephemeral' }); }
    return;
  }

  if (text === 'studia' || text.startsWith('studia ')) {
    var studiaRole = await getUserRole(command.user_id);
    if (studiaRole !== 'admin') {
      await respond({ text: 'Solo Antonio e Corrado possono avviare lo studio.', response_type: 'ephemeral' });
      return;
    }
    var { runKnowledgeEngine } = require('../agents/knowledgeEngine');
    runKnowledgeEngine(command.user_id).catch(function(e) { logger.error('[KB-ENGINE]', e.message); });
    await respond({ text: 'Studio avviato — ricevi il report quando finisco.', response_type: 'ephemeral' });
    return;
  }

  if (text === 'export' || text === 'esporta' || text === 'export memory' || text === 'export memoria') {
    try {
      await respond({ text: 'Sto preparando l\'export nel tuo Drive...', response_type: 'ephemeral' });
      var { exportForUser } = require('../jobs/memoryBackupJob');
      var result = await exportForUser(command.user_id);
      var msg = 'Export caricato nel tuo Drive.\n' +
        '• Memorie: ' + result.rows.memories + '\n' +
        '• Fatti stabili: ' + result.rows.facts + '\n' +
        '• Riassunti conversazione: ' + result.rows.summaries + '\n' +
        (result.link ? '<' + result.link + '|Apri il file>' : '');
      await respond({ text: msg, response_type: 'ephemeral' });
    } catch(err) { await respond({ text: toUserErrorMessage(err), response_type: 'ephemeral' }); }
    return;
  }

  if (text === 'preventivo' || text.startsWith('preventivo ')) {
    try {
      var prevText = text.replace(/^preventivo\s*/, '').trim();
      if (!prevText) {
        await respond({ text: 'Specifica cosa quotare: /giuno preventivo branding per ClienteX', response_type: 'ephemeral' });
        return;
      }
      var reply = await route(command.user_id, 'Fammi un preventivo per: ' + prevText);
      await respond({ text: formatPerSlack(reply), response_type: 'ephemeral' });
    } catch(err) { await respond({ text: toUserErrorMessage(err), response_type: 'ephemeral' }); }
    return;
  }

  if (text === 'glossario' || text.startsWith('glossario ')) {
    var searchTerm = text.replace(/^glossario\s*/, '').trim();
    var glossary = db.getGlossaryCache();

    if (searchTerm) {
      var found = db.searchGlossary(searchTerm);
      if (found.length === 0) {
        await respond({ text: 'Termine "' + searchTerm + '" non trovato nel glossario.', response_type: 'ephemeral' });
      } else {
        var gMsg = found.map(function(g) {
          var t = '*' + g.term + '*: ' + g.definition;
          if (g.synonyms && g.synonyms.length > 0) t += '\n_Sinonimi: ' + g.synonyms.join(', ') + '_';
          return t;
        }).join('\n\n');
        await respond({ text: gMsg, response_type: 'ephemeral' });
      }
    } else {
      var byCategory = {};
      glossary.forEach(function(g) {
        var cat = g.category || 'altro';
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(g.term);
      });
      var gMsg = '*Glossario Katania Studio:*\n\n';
      Object.keys(byCategory).forEach(function(cat) {
        gMsg += '*' + cat.replace(/_/g, ' ') + ':*\n';
        gMsg += byCategory[cat].join(', ') + '\n\n';
      });
      gMsg += '_Cerca un termine specifico con /giuno glossario [termine]_';
      await respond({ text: gMsg, response_type: 'ephemeral' });
    }
    return;
  }

  if (text === 'libero' || text.startsWith('libero ')) {
    try {
      var datePart = text.replace(/^libero\s*/, '').trim();
      var prompt = 'Mostrami gli slot liberi nel mio calendario' + (datePart ? ' per il giorno ' + datePart : ' oggi');
      var reply = await route(command.user_id, prompt);
      await respond({ text: formatPerSlack(reply), response_type: 'ephemeral' });
    } catch(err) { await respond({ text: toUserErrorMessage(err), response_type: 'ephemeral' }); }
    return;
  }

  if (text === 'email' || text.startsWith('email ')) {
    try {
      var query = text.replace(/^email\s*/, '').trim() || 'is:unread is:important';
      var reply = await route(command.user_id, 'Mostrami le email: ' + query);
      await respond({ text: formatPerSlack(reply), response_type: 'ephemeral' });
    } catch(err) { await respond({ text: toUserErrorMessage(err), response_type: 'ephemeral' }); }
    return;
  }

  if (text === 'cataloga' || text.startsWith('cataloga ')) {
    var catRole = await getUserRole(command.user_id);
    if (!checkPermission(catRole, 'view_financials')) {
      await respond({ text: getAccessDeniedMessage(catRole), response_type: 'ephemeral' });
      return;
    }
    try {
      await respond({ text: 'Avvio scansione preventivi su Drive... dammi un momento.', response_type: 'ephemeral' });
      var { catalogaPreventivi } = require('./cronHandlers');
      await catalogaPreventivi(command.user_id, command.channel_id);
    } catch(err) { await respond({ text: toUserErrorMessage(err), response_type: 'ephemeral' }); }
    return;
  }

  try {
    var reply = await route(command.user_id, text);
    var degradedSlashReply = isDegradedReply(reply);
    await respond({ text: formatPerSlack(reply), response_type: degradedSlashReply ? 'ephemeral' : 'in_channel' });
  } catch(err) { metricsService.increment('request_failed_total'); metricsService.increment('request_slash_giuno_failed_total'); await respond(toUserErrorMessage(err)); }
  });
});

// ─── team_join ────────────────────────────────────────────────────────────────

var MANSIONI_TEAM = {
  'antonio':    'CEO e capo dell\'agenzia. Visione strategica, decisioni finali, gestione complessiva.',
  'corrado':    'GM e capo. General Management, supervisione operativa, coordinamento tra reparti.',
  'gianna':     'COO e PM. Project management, controllo finanza e economics.',
  'alessandra': 'CCO. Contatto diretto con i clienti, relazioni commerciali.',
  'nicol\u00f2': 'Direttore Creativo e Digital Strategist.',
  'nicolo':     'Direttore Creativo e Digital Strategist.',
  'giusy':      'Social Media Manager, Digital Strategist, Junior Copy.',
  'paolo':      'Graphic Designer.',
  'claudia':    'Graphic Designer.',
  'gloria':     'Marketing e Strategist Manager.',
  'peppe':      'Logistica e referente del progetto OffKatania.',
};

app.event('team_join', async function(args) {
  var user = args.event.user;
  if (!user || user.is_bot) return;
  var name = (user.real_name || user.name || '').split(' ')[0] || 'nuovo membro';
  var mansione = MANSIONI_TEAM[name.toLowerCase()] || null;
  try {
    var oauthUrl = generaLinkOAuth(user.id);
    var link = '<' + oauthUrl + '|Collega il tuo Google>';
    var intro = 'Benvenuto in Katania Studio, *' + name + '*! Sono Giuno, il tuo assistente interno.\n\n';
    if (mansione) intro += 'So già che sei ' + mansione.split('.')[0] + '.\n\n';
    intro += 'Per attivarmi completamente collega il tuo Google: ' + link + '\n' +
      '_Ti servirà per calendario, email e Drive direttamente da Slack._\n\n' +
      'Puoi già scrivermi in DM o taggarmi con *@Giuno* in qualsiasi canale.';
    await app.client.chat.postMessage({ channel: user.id, text: intro });
    logger.info('[ONBOARDING] Benvenuto inviato a', user.id, name);
  } catch(e) { logger.error('[ONBOARDING]', e.message); }
});

// ─── reaction_added (feedback) ────────────────────────────────────────────────

// ─── Daily Standup Modal ─────────────────────────────────────────────────────

var DURATA_OPTIONS = [
  { text: { type: 'plain_text', text: '15min' }, value: '0.25' },
  { text: { type: 'plain_text', text: '30min' }, value: '0.5' },
  { text: { type: 'plain_text', text: '45min' }, value: '0.75' },
  { text: { type: 'plain_text', text: '1h' }, value: '1' },
  { text: { type: 'plain_text', text: '1h 30min' }, value: '1.5' },
  { text: { type: 'plain_text', text: '2h' }, value: '2' },
  { text: { type: 'plain_text', text: '2h 30min' }, value: '2.5' },
  { text: { type: 'plain_text', text: '3h' }, value: '3' },
  { text: { type: 'plain_text', text: '3h 30min' }, value: '3.5' },
  { text: { type: 'plain_text', text: '4h' }, value: '4' },
  { text: { type: 'plain_text', text: '5h' }, value: '5' },
  { text: { type: 'plain_text', text: '6h' }, value: '6' },
  { text: { type: 'plain_text', text: '7h' }, value: '7' },
  { text: { type: 'plain_text', text: '8h' }, value: '8' },
];

function buildDailyModalBlocks(ieriCount, oggiCount) {
  var blocks = [];

  // ─── IERI ─────────────────────────────────────────────────────────────
  blocks.push({ type: 'header', text: { type: 'plain_text', text: '📋  Ieri' } });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Cosa hai fatto ieri? Aggiungi task e tempo dedicato.' }] });

  for (var i = 1; i <= ieriCount; i++) {
    blocks.push({
      type: 'input', block_id: 'ieri_task_' + i, optional: i > 1,
      label: { type: 'plain_text', text: 'Task ' + i },
      element: { type: 'plain_text_input', action_id: 'task_input',
        placeholder: { type: 'plain_text', text: i === 1 ? 'Es. Design logo Aitho' : 'Altra attività...' } },
    });
    blocks.push({
      type: 'input', block_id: 'ieri_durata_' + i, optional: true,
      label: { type: 'plain_text', text: '⏱ Durata' },
      element: { type: 'static_select', action_id: 'durata_select',
        placeholder: { type: 'plain_text', text: 'Tempo' },
        options: DURATA_OPTIONS },
    });
  }

  // Add task button for ieri
  if (ieriCount < 6) {
    blocks.push({
      type: 'actions', block_id: 'ieri_add_action',
      elements: [{ type: 'button', text: { type: 'plain_text', text: '+ Aggiungi task ieri' },
        action_id: 'add_task_ieri', value: String(ieriCount) }],
    });
  }

  blocks.push({ type: 'divider' });

  // ─── OGGI ─────────────────────────────────────────────────────────────
  blocks.push({ type: 'header', text: { type: 'plain_text', text: '🎯  Oggi' } });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Cosa farai oggi? Aggiungi task e tempo stimato.' }] });

  for (var j = 1; j <= oggiCount; j++) {
    blocks.push({
      type: 'input', block_id: 'oggi_task_' + j, optional: j > 1,
      label: { type: 'plain_text', text: 'Task ' + j },
      element: { type: 'plain_text_input', action_id: 'task_input',
        placeholder: { type: 'plain_text', text: j === 1 ? 'Es. Mockup sito cliente' : 'Altra attività...' } },
    });
    blocks.push({
      type: 'input', block_id: 'oggi_durata_' + j, optional: true,
      label: { type: 'plain_text', text: '⏱ Durata' },
      element: { type: 'static_select', action_id: 'durata_select',
        placeholder: { type: 'plain_text', text: 'Tempo' },
        options: DURATA_OPTIONS },
    });
  }

  // Add task button for oggi
  if (oggiCount < 6) {
    blocks.push({
      type: 'actions', block_id: 'oggi_add_action',
      elements: [{ type: 'button', text: { type: 'plain_text', text: '+ Aggiungi task oggi' },
        action_id: 'add_task_oggi', value: String(oggiCount) }],
    });
  }

  blocks.push({ type: 'divider' });

  // ─── BLOCCHI ──────────────────────────────────────────────────────────
  blocks.push({
    type: 'input', block_id: 'blocchi', optional: true,
    label: { type: 'plain_text', text: '🚧  Blocchi o problemi' },
    element: { type: 'plain_text_input', action_id: 'blocchi_input', multiline: true,
      placeholder: { type: 'plain_text', text: 'Qualcosa ti rallenta o ti blocca?' } },
  });

  return blocks;
}

app.action('open_dm_from_home', async function(args) {
  await args.ack();
  try {
    await app.client.chat.postMessage({
      channel: args.body.user.id,
      text: 'Eccomi! Che ti serve?',
    });
  } catch(e) { logger.debug('[APP-HOME] DM error:', e.message); }
});

app.action('open_daily_modal', async function(args) {
  var ackStart = Date.now();
  await args.ack();
  var triggerId = args.body.trigger_id;
  // Slack trigger_id is valid for ~3s after the click. Retry on transient
  // network errors but bail out immediately if Slack says the trigger expired.
  try {
    await withTimeout(function() {
      return withRetry(function() {
        return app.client.views.open({
          trigger_id: triggerId,
          view: {
            type: 'modal', callback_id: 'daily_standup_submit',
            private_metadata: JSON.stringify({ ieri: 2, oggi: 2 }),
            title: { type: 'plain_text', text: 'Daily Standup' },
            submit: { type: 'plain_text', text: '✅ Invia' },
            close: { type: 'plain_text', text: 'Chiudi' },
            blocks: buildDailyModalBlocks(2, 2),
          },
        });
      }, {
        retries: 1,
        baseDelayMs: 100,
        shouldRetry: function(err) {
          var code = err && ((err.data && err.data.error) || err.code || '');
          if (/expired_trigger_id|invalid_trigger_id|invalid_blocks/i.test(String(code))) return false;
          return true;
        },
      });
    }, 2500, 'views.open daily modal');
  } catch(e) {
    var slackCode = e && ((e.data && e.data.error) || e.code || e.name || '');
    logger.error('[DAILY-MODAL] views.open fallita', {
      code: String(slackCode),
      message: e && e.message,
      triggerIdPresent: !!triggerId,
      elapsedMs: Date.now() - ackStart,
    });
  }
});

// "Aggiungi task" buttons — update the modal with more rows
app.action('add_task_ieri', async function(args) {
  await args.ack();
  var meta = JSON.parse(args.body.view.private_metadata || '{}');
  meta.ieri = Math.min((meta.ieri || 2) + 1, 6);
  try {
    await app.client.views.update({
      view_id: args.body.view.id,
      view: {
        type: 'modal', callback_id: 'daily_standup_submit',
        private_metadata: JSON.stringify(meta),
        title: { type: 'plain_text', text: 'Daily Standup' },
        submit: { type: 'plain_text', text: '✅ Invia' },
        close: { type: 'plain_text', text: 'Chiudi' },
        blocks: buildDailyModalBlocks(meta.ieri, meta.oggi || 2),
      },
    });
  } catch(e) { logger.error('[DAILY-MODAL] Errore aggiungi ieri:', e.message); }
});

app.action('add_task_oggi', async function(args) {
  await args.ack();
  var meta = JSON.parse(args.body.view.private_metadata || '{}');
  meta.oggi = Math.min((meta.oggi || 2) + 1, 6);
  try {
    await app.client.views.update({
      view_id: args.body.view.id,
      view: {
        type: 'modal', callback_id: 'daily_standup_submit',
        private_metadata: JSON.stringify(meta),
        title: { type: 'plain_text', text: 'Daily Standup' },
        submit: { type: 'plain_text', text: '✅ Invia' },
        close: { type: 'plain_text', text: 'Chiudi' },
        blocks: buildDailyModalBlocks(meta.ieri || 2, meta.oggi),
      },
    });
  } catch(e) { logger.error('[DAILY-MODAL] Errore aggiungi oggi:', e.message); }
});

app.view('daily_standup_submit', async function(args) {
  var view = args.view;
  await args.ack();
  var userId = args.body.user.id;
  var values = view.state.values;

  function extractTasks(section) {
    var tasks = [];
    for (var i = 1; i <= 6; i++) {
      var taskKey = section + '_task_' + i;
      var durKey = section + '_durata_' + i;
      var taskVal = values[taskKey] && values[taskKey].task_input ? values[taskKey].task_input.value : null;
      if (!taskVal) continue;
      var durVal = values[durKey] && values[durKey].durata_select && values[durKey].durata_select.selected_option ? values[durKey].durata_select.selected_option : null;
      var hours = durVal ? parseFloat(durVal.value) : 0;
      var durLabel = durVal ? durVal.text.text : '';
      tasks.push({ task: taskVal, hours: hours, label: durLabel });
    }
    return tasks;
  }

  var ieriTasks = extractTasks('ieri');
  var oggiTasks = extractTasks('oggi');
  var blocchi = values.blocchi && values.blocchi.blocchi_input ? values.blocchi.blocchi_input.value : null;

  var totalIeri = 0; ieriTasks.forEach(function(t) { totalIeri += t.hours; });
  var totalOggi = 0; oggiTasks.forEach(function(t) { totalOggi += t.hours; });

  // Format text for recap
  var formattedText = '';
  if (ieriTasks.length > 0) {
    formattedText += '*Ieri:* ' + ieriTasks.map(function(t) { return t.task + (t.label ? ' ' + t.label : ''); }).join(', ') + '\n';
  }
  if (oggiTasks.length > 0) {
    formattedText += '*Oggi:* ' + oggiTasks.map(function(t) { return t.task + (t.label ? ' ' + t.label : ''); }).join(', ') + '\n';
  }
  if (blocchi) formattedText += '*Blocchi:* ' + blocchi;
  formattedText = formattedText.trim();

  if (formattedText) {
    var structured = {
      ieri: ieriTasks.map(function(t) { return { task: t.task, hours: Math.floor(t.hours), minutes: Math.round((t.hours % 1) * 60) }; }),
      oggi: oggiTasks.map(function(t) { return { task: t.task, hours: Math.floor(t.hours), minutes: Math.round((t.hours % 1) * 60) }; }),
      blocchi: blocchi || null,
      totalIeri: totalIeri,
      totalOggi: totalOggi,
    };

    var dailyStandup = require('./dailyStandupV2');
    var saved = false;
    try {
      saved = await dailyStandup.handleDailyResponse(userId, formattedText, structured);
    } catch(e) {
      logger.error('[DAILY-MODAL] handleDailyResponse ha throwato:', e.message);
    }

    if (saved) {
      var confirmMsg = 'Daily registrato! ✅';
      if (totalIeri > 0 || totalOggi > 0) {
        confirmMsg += '\n_Ieri: ' + totalIeri + 'h | Oggi: ' + totalOggi + 'h stimate_';
      }
      await app.client.chat.postMessage({ channel: userId, text: confirmMsg });
      logger.info('[DAILY-MODAL] Risposta da', userId, '| Ieri:', totalIeri + 'h | Oggi:', totalOggi + 'h');
    } else {
      await app.client.chat.postMessage({
        channel: userId,
        text: 'Non sono riuscito a registrare il daily — riprova tra un attimo. Se il problema persiste avvisa Antonio.',
      });
      logger.error('[DAILY-MODAL] Save fallito per', userId);
    }
  }
});

// ─── reaction_added (feedback) ────────────────────────────────────────────────

app.event('reaction_added', async function(args) {
  var event = args.event;
  if (!event.item || event.item.type !== 'message') return;

  // Classify reaction as positive, negative, or neutral
  var positiveReactions = ['+1', 'white_check_mark', 'heavy_check_mark', 'ok', 'thumbsup', 'clap', 'raised_hands', 'fire', '100', 'star', 'heart'];
  var negativeReactions = ['-1', 'thumbsdown', 'x', 'no_entry', 'disappointed', 'angry', 'rage', 'face_with_rolling_eyes', 'confused'];
  var isPositive = positiveReactions.indexOf(event.reaction) !== -1;
  var isNegative = negativeReactions.indexOf(event.reaction) !== -1;
  if (!isPositive && !isNegative) return;

  var botMsg = botMessages.get(event.item.ts);
  if (!botMsg) return;

  var feedback = isPositive ? 'positivo' : 'negativo';
  logger.info('[FEEDBACK]', feedback, '(' + event.reaction + ') | user:', event.user, '| text:', (botMsg.text || '').substring(0, 80));

  try {
    // Save to feedback table
    db.saveFeedback(event.item.ts, event.user, feedback, (botMsg.text || '').substring(0, 200));

    // Adjust memory confidence based on feedback
    var supabase = db.getClient ? db.getClient() : null;
    if (supabase) {
      // Find memories created around the same time as this bot message (±2 minutes)
      var msgTime = new Date(parseFloat(event.item.ts) * 1000);
      var timeStart = new Date(msgTime.getTime() - 2 * 60 * 1000).toISOString();
      var timeEnd = new Date(msgTime.getTime() + 2 * 60 * 1000).toISOString();
      var relatedMems = await supabase.from('memories')
        .select('id, confidence_score')
        .eq('slack_user_id', botMsg.userId)
        .gte('created_at', timeStart)
        .lte('created_at', timeEnd)
        .limit(5);

      if (relatedMems.data && relatedMems.data.length > 0) {
        var adjustment = isPositive ? 0.1 : -0.15; // Negative feedback weighs more
        for (var ri = 0; ri < relatedMems.data.length; ri++) {
          var mem = relatedMems.data[ri];
          var newScore = Math.max(0.1, Math.min(1.0, (parseFloat(mem.confidence_score) || 0.5) + adjustment));
          await supabase.from('memories').update({ confidence_score: newScore }).eq('id', mem.id);
        }
        logger.info('[FEEDBACK] Adjusted', relatedMems.data.length, 'memories by', adjustment, 'for', feedback);
      }
    }

    // If negative, save as correction memory
    if (isNegative) {
      // Track error pattern for repeated mistakes
      try {
        var errorTracker = require('../services/errorTracker');
        errorTracker.recordError(botMsg.text, 'negative_feedback', event.user);
      } catch(e3) { /* ignore */ }

      db.addMemory(event.user, 'FEEDBACK_NEGATIVO su risposta Giuno: "' + (botMsg.text || '').substring(0, 150) + '"', ['feedback', 'negativo'], {
        memory_type: 'episodic', confidence_score: 0.8,
      });
    }
  } catch(e) { logger.error('[FEEDBACK]', e.message); }
});

// ─── Admin command handler ─────────────────────────────────────────────────────

async function handleAdmin(command, respond) {
  var callerRole = await getUserRole(command.user_id);
  var args = command.text.replace(/^admin\s*/, '').trim().split(/\s+/);
  var sub  = args[0];

  if (sub === 'list') {
    if (callerRole !== 'admin') { await respond({ text: 'Solo Antonio e Corrado possono usare questo comando.', response_type: 'ephemeral' }); return; }
    var utenti = await getUtenti();
    var msg = '*Utenti e token Google:*\n';
    utenti.forEach(function(u) { msg += (getUserTokens()[u.id] ? '✅' : '❌') + ' ' + u.name + ' (<@' + u.id + '>)\n'; });
    await respond({ text: msg, response_type: 'ephemeral' });
    return;
  }

  if (sub === 'revoke' && args[1]) {
    if (callerRole !== 'admin') { await respond({ text: 'Solo Antonio e Corrado possono usare questo comando.', response_type: 'ephemeral' }); return; }
    var targetId = args[1].replace(/<@|>/g, '').split('|')[0];
    if (!getUserTokens()[targetId]) { await respond({ text: 'Nessun token trovato per quell\'utente.', response_type: 'ephemeral' }); return; }
    rimuoviTokenUtente(targetId);
    await respond({ text: 'Token revocato per <@' + targetId + '>.', response_type: 'ephemeral' });
    return;
  }

  if (sub === 'ruolo' && args[1]) {
    if (callerRole !== 'admin') { await respond({ text: 'Solo Antonio e Corrado possono modificare i ruoli.', response_type: 'ephemeral' }); return; }
    var targetId = args[1].replace(/<@|>/g, '').split('|')[0];
    var newRole = (args[2] || '').toLowerCase();
    var validRoles = ['admin', 'finance', 'manager', 'member', 'restricted'];
    if (!validRoles.includes(newRole)) { await respond({ text: 'Ruolo non valido. Usa: ' + validRoles.join(', '), response_type: 'ephemeral' }); return; }
    var utenti = await getUtenti();
    var targetUser = utenti.find(function(u) { return u.id === targetId; });
    var displayName = targetUser ? targetUser.name : null;
    var success = await setUserRole(targetId, newRole, displayName, command.user_id);
    if (success) {
      await respond({ text: '<@' + targetId + '> ora ha accesso livello *' + newRole + '*\nModificato da <@' + command.user_id + '>', response_type: 'ephemeral' });
    } else {
      await respond({ text: 'Errore nel salvataggio del ruolo. Riprova.', response_type: 'ephemeral' });
    }
    return;
  }

  if (sub === 'roles') {
    if (callerRole !== 'admin') { await respond({ text: 'Solo Antonio e Corrado possono vedere i ruoli.', response_type: 'ephemeral' }); return; }
    var roles = await getAllRoles();
    if (roles.length === 0) { await respond({ text: 'Nessun ruolo configurato.', response_type: 'ephemeral' }); return; }
    var msg = '*Ruoli team:*\n';
    var order = { admin: 1, finance: 2, manager: 3, member: 4, restricted: 5 };
    roles.sort(function(a, b) { return (order[a.role] || 9) - (order[b.role] || 9); });
    roles.forEach(function(r) { msg += '*' + r.role.toUpperCase() + '* — ' + (r.display_name || r.slack_user_id) + ' (<@' + r.slack_user_id + '>)\n'; });
    await respond({ text: msg, response_type: 'ephemeral' });
    return;
  }

  if (sub === 'push-google') {
    if (callerRole !== 'admin') { await respond({ text: 'Solo Antonio e Corrado possono usare questo comando.', response_type: 'ephemeral' }); return; }
    await respond({ text: 'Sto inviando gli inviti...', response_type: 'ephemeral' });
    var { invitaNonConnessi } = require('./cronHandlers');
    var inviati = await invitaNonConnessi();
    await respond({ text: 'Inviti inviati a *' + inviati + '* utenti senza Google collegato.', response_type: 'ephemeral' });
    return;
  }

  if (sub === 'import-leads') {
    if (callerRole !== 'admin') { await respond({ text: 'Solo Antonio e Corrado possono importare lead.', response_type: 'ephemeral' }); return; }
    await respond({ text: 'Leggo il CRM Sheet...', response_type: 'ephemeral' });
    try {
      var leadsTools = require('../tools/leadsTools');
      var result = await leadsTools.importCRMSheet(leadsTools.CORRADO_SLACK_ID, leadsTools.CRM_SHEET_ID);
      if (result.error) { await respond({ text: 'Errore: ' + result.error, response_type: 'ephemeral' }); return; }

      var previewMsg = '*CRM Sheet: ' + result.sheetName + '*\n' +
        'Trovati *' + result.leads.length + '* lead su ' + result.totalRows + ' righe.\n\n' +
        '*Mapping colonne:*\n';
      for (var col in result.mapping) {
        previewMsg += '• ' + col + ' → `' + result.mapping[col] + '`\n';
      }
      previewMsg += '\n*Anteprima:* ' + result.preview.join(', ') + '\n\n' +
        'Rispondi "sì" per importare o "annulla" per fermarti.';

      var importKey = 'import_leads_' + command.user_id;
      catalogaConfirm.set(importKey, { leads: result.leads, userId: command.user_id, channelId: command.channel_id });
      await respond({ text: previewMsg, response_type: 'ephemeral' });

      // Auto-expire after 2 minutes
      setTimeout(function() { catalogaConfirm.delete(importKey); }, 120000);
    } catch(e) {
      await respond({ text: toUserErrorMessage(e), response_type: 'ephemeral' });
    }
    return;
  }

  if (sub === 'team') {
    if (callerRole !== 'admin') { await respond({ text: 'Solo admin possono gestire il team roster.', response_type: 'ephemeral' }); return; }
    var teamSub = (args[1] || 'list').toLowerCase();
    var roster = db.getTeamRoster ? db.getTeamRoster() : [];

    if (teamSub === 'list') {
      if (!roster || roster.length === 0) {
        await respond({ text: 'Roster vuoto. Lancia `node scripts/seed-team-roster.js` per popolarlo.', response_type: 'ephemeral' });
        return;
      }
      var listMsg = '*Roster team (' + roster.length + '):*\n' + roster.map(function(m) {
        var alias = (m.aliases && m.aliases.length > 0) ? ' _(alias: ' + m.aliases.join(', ') + ')_' : '';
        var role = m.role ? ' — ' + m.role : '';
        var proj = (m.primary_projects && m.primary_projects.length > 0) ? ' | progetti: ' + m.primary_projects.join(', ') : '';
        return '• <@' + m.slack_user_id + '> *' + m.canonical_name + '*' + alias + role + proj;
      }).join('\n');
      await respond({ text: listMsg, response_type: 'ephemeral' });
      return;
    }

    if (teamSub === 'refresh') {
      try {
        await db.loadTeamRoster();
        var fresh = db.getTeamRoster() || [];
        await respond({ text: 'Roster ricaricato da DB: ' + fresh.length + ' membri.', response_type: 'ephemeral' });
      } catch(e) { await respond({ text: 'Errore refresh: ' + e.message, response_type: 'ephemeral' }); }
      return;
    }

    if (teamSub === 'set' && args[2]) {
      var targetId = args[2].replace(/<@|>/g, '').split('|')[0];
      // Parse key="value" or key=value[,value] pairs
      var raw = command.text.substring(command.text.indexOf('set') + 3).trim();
      raw = raw.replace(/^\s*<@[^>]+>\s*/, '');
      var parsed = {};
      var kvRe = /(\w+)\s*=\s*(?:"([^"]*)"|([^\s]+))/g;
      var match;
      while ((match = kvRe.exec(raw)) !== null) { parsed[match[1].toLowerCase()] = match[2] != null ? match[2] : match[3]; }

      var existing = roster.find(function(m) { return m.slack_user_id === targetId; }) || {};
      var aliases = parsed.aliases != null ? parsed.aliases.split(',').map(function(s) { return s.trim(); }).filter(Boolean) : (existing.aliases || []);
      var projects = parsed.progetti != null ? parsed.progetti.split(',').map(function(s) { return s.trim(); }).filter(Boolean) : (existing.primary_projects || []);
      var clients = parsed.clienti != null ? parsed.clienti.split(',').map(function(s) { return s.trim(); }).filter(Boolean) : (existing.primary_clients || []);
      var canonical = parsed.nome || existing.canonical_name || null;
      if (!canonical) { await respond({ text: 'Manca `nome="..."` (serve alla prima volta).', response_type: 'ephemeral' }); return; }
      var role = parsed.role != null ? parsed.role : (existing.role || null);

      var saved = await db.upsertTeamMember({
        slack_user_id: targetId,
        canonical_name: canonical,
        aliases: aliases,
        role: role,
        primary_projects: projects,
        primary_clients: clients,
        active: parsed.active === 'false' ? false : true,
      });
      if (saved) await respond({ text: 'Aggiornato <@' + targetId + '> → *' + canonical + '* (' + aliases.length + ' alias, ' + projects.length + ' progetti).', response_type: 'ephemeral' });
      else await respond({ text: 'Salvataggio fallito.', response_type: 'ephemeral' });
      return;
    }

    if (teamSub === 'remove' && args[2]) {
      var rmId = args[2].replace(/<@|>/g, '').split('|')[0];
      var ok = await db.deactivateTeamMember(rmId);
      await respond({ text: ok ? 'Disattivato <@' + rmId + '>.' : 'Non trovato.', response_type: 'ephemeral' });
      return;
    }

    await respond({
      text: '*Comandi team:*\n' +
        '• `admin team list` — mostra roster\n' +
        '• `admin team refresh` — ricarica da DB\n' +
        '• `admin team set @utente nome="Peppe" aliases="giuseppe,peppino" role="Logistica" progetti="OffKatania" clienti=""`\n' +
        '• `admin team remove @utente` — disattiva',
      response_type: 'ephemeral',
    });
    return;
  }

  await respond({ text: 'Comandi admin:\n• `admin list` — utenti e token Google\n• `admin roles` — mostra ruoli team\n• `admin ruolo @nome livello` — cambia ruolo\n• `admin revoke @utente` — revoca token Google\n• `admin push-google` — invita chi non ha ancora collegato Google\n• `admin import-leads` — importa lead dal CRM Sheet\n• `admin team [list|refresh|set|remove]` — gestisci il roster del team (disambiguazione nomi)\n\nLivelli: admin, finance, manager, member, restricted', response_type: 'ephemeral' });
}

module.exports = {
  botMessages: botMessages,
  lastBotMessageByChannel: lastBotMessageByChannel,
  standupInAttesa: standupInAttesa,
  rehydrateStandupInAttesa: rehydrateStandupInAttesa,
  stats: stats,
  MANSIONI_TEAM: MANSIONI_TEAM,
};
