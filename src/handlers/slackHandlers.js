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
var { processSlackMessage: watchMemory } = require('../services/slackMemoryWatcher');

// ─── In-memory state ───────────────────────────────────────────────────────────

var processedEvents = new Set();
var botMessages = new Map(); // ts -> { userId, text, channel, timestamp }
var lastBotMessageByChannel = new Map(); // channelId -> { ts, userId, timestamp }
var stats = { startedAt: new Date().toISOString(), messagesHandled: 0, toolCallsTotal: 0 };
var standupInAttesa = new Set();

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

// ─── app_mention ───────────────────────────────────────────────────────────────

app.event('app_mention', async function(args) {
  var event = args.event;
  if (!dedup(event.ts)) return;
  var threadTs = event.thread_ts || event.ts;
  stats.messagesHandled++;

  try {
    var text = event.text.replace(/<@[^>]+>/g, '').trim();

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
        var threadRes = await app.client.conversations.replies({ channel: event.channel, ts: event.thread_ts, limit: 15 });
        recentMsgs = (threadRes.messages || []).slice(-15);
      } else {
        var histRes = await app.client.conversations.history({ channel: event.channel, limit: 10 });
        recentMsgs = (histRes.messages || []).reverse();
      }
      if (recentMsgs.length > 0) {
        channelContext += '\nCONVERSAZIONE RECENTE NEL CANALE:\n';
        for (var rm of recentMsgs) {
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

    var mentionChannelType = ch.is_private ? 'private' : 'public';
    var reply = await route(event.user, text, {
      mentionedBy: event.user,
      threadTs: threadTs,
      channelContext: channelContext,
      channelId: ch.id || null,
      channelType: mentionChannelType,
    });

    // Gemini quality gate
    var { askGemini } = require('../services/geminiService');
    if (reply && reply.length > 30) {
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
      return;
    }
    var posted = await app.client.chat.postMessage({ channel: event.channel, text: formatted, thread_ts: threadTs });
    if (posted && posted.ts) {
      botMessages.set(posted.ts, { userId: event.user, text: formatted, channel: event.channel, timestamp: Date.now() });
      lastBotMessageByChannel.set(event.channel, { ts: posted.ts, userId: event.user, timestamp: Date.now() });
    }

    // Background: detect deadlines and auto-summarize Drive links
    detectAndSaveDeadlines(event.user, text, event.channel).catch(function(e) {});
    autoSummarizeDriveLinks(event.user, event.text, event.channel, threadTs).catch(function(e) {});
  } catch(err) {
    await app.client.chat.postMessage({ channel: event.channel, text: 'Errore: ' + err.message, thread_ts: threadTs });
  }
});

// ─── app.message ──────────────────────────────────────────────────────────────

app.message(async function(args) {
  var message = args.message;
  if (message.bot_id) return;

  // Passive memory watcher (fire-and-forget)
  if (message.text && message.channel_type !== 'im') {
    watchMemory(message, message.channel).catch(function() {});
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
      var reply = await route(message.user, message.text, { threadTs: implicitThreadTs, channelId: message.channel, channelType: 'public' });
      var formatted = formatPerSlack(reply);
      if (!formatted) return;
      var posted = await app.client.chat.postMessage({ channel: message.channel, text: formatted, thread_ts: implicitThreadTs });
      if (posted && posted.ts) {
        botMessages.set(posted.ts, { userId: message.user, text: formatted, channel: message.channel, timestamp: Date.now() });
        lastBotMessageByChannel.set(message.channel, { ts: posted.ts, userId: message.user, timestamp: Date.now() });
      }
      // Background: detect deadlines
      detectAndSaveDeadlines(message.user, message.text, message.channel).catch(function(e) {});
    } catch(err) { logger.error('[IMPLICIT-REPLY] Errore:', err.message); }
    return;
  }

  // ── DM ─────────────────────────────────────────────────────────────────────

  // Standup replies
  if (standupInAttesa.has(message.user)) {
    standupInAttesa.delete(message.user);
    var oggi = new Date().toISOString().slice(0, 10);
    var sd = db.getStandupCache();
    if (sd.oggi === oggi) {
      sd.risposte[message.user] = { testo: message.text, timestamp: Date.now() };
      db.saveStandup(sd);
      await app.client.chat.postMessage({ channel: message.channel, text: 'Registrato, mbare! Il recap uscirà alle 10:00 nel canale.' });
      logger.info('[STANDUP] Risposta ricevuta da:', message.user);
      return;
    }
  }

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
        await app.client.chat.postMessage({ channel: message.channel, text: 'Errore import: ' + e.message });
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
    var reply = await route(message.user, message.text, { threadTs: threadTs, channelType: 'dm', channelId: message.channel });
    var formatted = formatPerSlack(reply);
    var posted = await app.client.chat.postMessage({ channel: message.channel, text: formatted, thread_ts: threadTs || undefined });
    if (posted && posted.ts) botMessages.set(posted.ts, { userId: message.user, text: formatted, channel: message.channel, timestamp: Date.now() });
  } catch(err) { await app.client.chat.postMessage({ channel: message.channel, text: 'Errore: ' + err.message }); }
});

// ─── /giuno command ────────────────────────────────────────────────────────────

app.command('/giuno', async function(args) {
  var command = args.command, ack = args.ack, respond = args.respond;
  await ack();
  var text = command.text.trim();

  if (text.startsWith('admin')) {
    await handleAdmin(command, respond);
    return;
  }

  if (text === 'chi sono' || text === 'chisono') {
    try {
      var myRole = await getUserRole(command.user_id);
      var roleDesc = getRoleSystemPrompt(myRole).split('\n').slice(0, 3).join('\n');
      var utenti = await getUtenti();
      var me = utenti.find(function(u) { return u.id === command.user_id; });
      var myName = me ? me.name : 'Utente';
      await respond({
        text: 'Ciao ' + myName + '!\n• Slack ID: `' + command.user_id + '`\n• Livello di accesso: *' + myRole.toUpperCase() + '*\n• ' + roleDesc,
        response_type: 'ephemeral',
      });
    } catch(err) { await respond({ text: 'Errore: ' + err.message, response_type: 'ephemeral' }); }
    return;
  }

  if (text === 'recap' || text.startsWith('recap ')) {
    try {
      var { getSlackBriefingData, buildBriefingUtente } = require('./cronHandlers');
      var canaliBriefing = await getSlackBriefingData();
      var parti = await buildBriefingUtente(command.user_id, canaliBriefing);
      await respond({ text: formatPerSlack(parti.join('\n\n')) || 'Niente di nuovo, mbare.', response_type: 'ephemeral' });
    } catch(err) { await respond({ text: 'Errore recap: ' + err.message, response_type: 'ephemeral' }); }
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
    } catch(e) { await respond({ text: 'Errore: ' + e.message, response_type: 'ephemeral' }); }
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

  if (text === 'preventivo' || text.startsWith('preventivo ')) {
    try {
      var prevText = text.replace(/^preventivo\s*/, '').trim();
      if (!prevText) {
        await respond({ text: 'Specifica cosa quotare: /giuno preventivo branding per ClienteX', response_type: 'ephemeral' });
        return;
      }
      var reply = await route(command.user_id, 'Fammi un preventivo per: ' + prevText);
      await respond({ text: formatPerSlack(reply), response_type: 'ephemeral' });
    } catch(err) { await respond({ text: 'Errore: ' + err.message, response_type: 'ephemeral' }); }
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
    } catch(err) { await respond({ text: 'Errore: ' + err.message, response_type: 'ephemeral' }); }
    return;
  }

  if (text === 'email' || text.startsWith('email ')) {
    try {
      var query = text.replace(/^email\s*/, '').trim() || 'is:unread is:important';
      var reply = await route(command.user_id, 'Mostrami le email: ' + query);
      await respond({ text: formatPerSlack(reply), response_type: 'ephemeral' });
    } catch(err) { await respond({ text: 'Errore: ' + err.message, response_type: 'ephemeral' }); }
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
    } catch(err) { await respond({ text: 'Errore cataloga: ' + err.message, response_type: 'ephemeral' }); }
    return;
  }

  try {
    var reply = await route(command.user_id, text);
    await respond({ text: formatPerSlack(reply), response_type: 'in_channel' });
  } catch(err) { await respond('Errore: ' + err.message); }
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

app.event('reaction_added', async function(args) {
  var event = args.event;
  if (event.reaction !== '+1' && event.reaction !== '-1') return;
  if (!event.item || event.item.type !== 'message') return;
  var botMsg = botMessages.get(event.item.ts);
  if (!botMsg) return;
  var feedback = event.reaction === '+1' ? 'positivo' : 'negativo';
  logger.info('[FEEDBACK]', feedback, '| user:', event.user, '| text:', (botMsg.text || '').substring(0, 80));
  try {
    db.saveFeedback(event.item.ts, event.user, feedback, (botMsg.text || '').substring(0, 200));
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
      await respond({ text: 'Errore lettura CRM: ' + e.message, response_type: 'ephemeral' });
    }
    return;
  }

  await respond({ text: 'Comandi admin:\n• `admin list` — utenti e token Google\n• `admin roles` — mostra ruoli team\n• `admin ruolo @nome livello` — cambia ruolo\n• `admin revoke @utente` — revoca token Google\n• `admin push-google` — invita chi non ha ancora collegato Google\n• `admin import-leads` — importa lead dal CRM Sheet\n\nLivelli: admin, finance, manager, member, restricted', response_type: 'ephemeral' });
}

module.exports = {
  botMessages: botMessages,
  lastBotMessageByChannel: lastBotMessageByChannel,
  standupInAttesa: standupInAttesa,
  stats: stats,
  MANSIONI_TEAM: MANSIONI_TEAM,
};
