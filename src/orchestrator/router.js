// ─── Orchestrator Router ───────────────────────────────────────────────────────
// route(userId, message, options) →
//   1. classify intent (fast, keyword-first)
//   2. build context lazily based on intent
//   3. call specialised agent with timeout + fallback to general

'use strict';

var logger = require('../utils/logger');
var { INTENTS, classifyIntent } = require('./intentClassifier');
var { buildContext } = require('./contextBuilder');
var { preflight } = require('./preflight');
var { withTimeout } = require('../utils/timeout');
var { matchSkill, executeSkill } = require('../skills/skillRegistry');

var AGENT_TIMEOUT_MS = 55000; // 55s — below Railway/Slack 60s hard limit

// Agents (lazy-loaded to avoid circular deps)
function getThreadSummaryAgent()    { return require('../agents/threadSummaryAgent'); }
function getDailyDigestAgent()      { return require('../agents/dailyDigestAgent'); }
function getClientRetrievalAgent()  { return require('../agents/clientRetrievalAgent'); }
function getGeneralAssistantAgent() { return require('../agents/generalAssistantAgent'); }
function getQuoteSupportAgent()     { return require('../agents/quoteSupportAgent'); }
function getCRMUpdateAgent()        { return require('../agents/crmUpdateAgent'); }
function getScanCommand()           { return require('../commands/scanCommand'); }
function getProspectingAgent()      { return require('../agents/prospectingAgent'); }

/**
 * runAgent — calls an agent with timeout and falls back to general on error.
 */
async function runAgent(agentFn, message, ctx, agentName) {
  try {
    return await withTimeout(agentFn().run(message, ctx), AGENT_TIMEOUT_MS, agentName);
  } catch(e) {
    if (e.message === 'API_UNAVAILABLE') throw e;
    logger.warn('[ROUTER] ' + agentName + ' fallback → general. Motivo: ' + e.message);
    return await getGeneralAssistantAgent().run(message, ctx);
  }
}

/**
 * route — main entry point for all user messages.
 *
 * @param {string} userId
 * @param {string} message
 * @param {object} [options]  — threadTs, channelId, mentionedBy, channelContext
 * @returns {Promise<string>}  reply text
 */
async function route(userId, message, options) {
  options = options || {};

  try {
    // 0-bis. Comandi admin di test (trigger daily/planner/check-in): dritti
    // all'assistente generale, che ha il toolset COMPLETO (workflowTools
    // inclusi). Senza questo bypass l'intent classifier li smistava agli
    // agenti specializzati: il dailyDigestAgent generava un finto "daily di
    // test" discorsivo e il CRM agent rispondeva "non ho lo strumento" (7/7).
    var ADMIN_TRIGGER_RE = /trigger_(daily|checkin|planner)_request|\b(daily|planner|weekly|check.?in)\b[^\n]{0,40}\bdi test\b/i;
    if (ADMIN_TRIGGER_RE.test(message || '')) {
      logger.info('[ROUTER] Comando di test admin → general assistant (toolset completo)');
      var testCtx = await buildContext({ userId: userId, message: message, options: options, intent: 'GENERAL' });
      testCtx = preflight(message, testCtx);
      return await getGeneralAssistantAgent().run(message, testCtx);
    }

    // 0. Try skill matching FIRST (before intent classification)
    var channelName = '';
    if (options.channelId) {
      var db = require('../../supabase');
      var chMap = db.getChannelMapCache()[options.channelId];
      if (chMap) channelName = chMap.channel_name || '';
    }
    var skillMatch = matchSkill(message, options.channelId, channelName);
    if (skillMatch && !skillMatch.skill.delegateTo) {
      // Build minimal context for skill
      var skillCtx = await buildContext({ userId: userId, message: message, options: options, intent: 'GENERAL' });
      skillCtx = preflight(message, skillCtx);
      var skillReply = await executeSkill(skillMatch.skill, message, skillCtx);
      if (skillReply) {
        logger.info('[ROUTER] Skill handled:', skillMatch.skill.id);
        // Learn from skill interaction
        try {
          var { autoLearn } = require('../services/anthropicService');
          autoLearn(userId, message, skillReply, {
            channelId: options.channelId || null,
            channelType: options.channelType || 'dm',
            isDM: options.isDM || !options.channelId,
          }).catch(function() {});
        } catch(e) { /* ignore */ }
        return skillReply;
      }
      // If skill returned null, fall through to normal routing
    }

    // 1. Classify intent — pass last messages for disambiguation
    var db2 = require('../../supabase');
    var convKey = options.threadTs ? userId + ':' + options.threadTs : userId;
    var convCache = db2.getConvCache();
    var recentConv = (convCache[convKey] || []).slice(-6); // last 3 exchanges

    // Resolve ordinal/numbered references to the previous bot reply.
    // "1. persa" after a numbered lead list → "Unimed è persa" so the
    // classifier and downstream agents don't think the user wants to
    // search the keyword "persa" in isolation.
    try {
      var refResolver = require('../utils/referenceResolver');
      var resolved = refResolver.resolveOrdinalReference(message, recentConv);
      if (resolved) {
        logger.info('[ROUTER] Ordinal ref resolved: "' + message.substring(0, 40) +
          '" → "' + resolved.rewritten.substring(0, 80) + '"');
        message = resolved.rewritten;
      }
    } catch(e) { logger.warn('[ROUTER] referenceResolver error:', e.message); }

    // If we have conversation history, give classifier the subject context
    var classifierMessage = message;
    if (recentConv.length > 0) {
      var lastSubjects = recentConv
        .filter(function(m) { return m.role === 'user' && typeof m.content === 'string'; })
        .slice(-2)
        .map(function(m) { return m.content.substring(0, 150); });
      if (lastSubjects.length > 0) {
        classifierMessage = '[CONTESTO: ' + lastSubjects.join(' | ') + '] ' + message;
      }
    }

    var intent = await classifyIntent(classifierMessage);
    logger.info('[ROUTER] User:', userId, '| Intent:', intent);

    // 2. Build context with intent hint for lazy loading
    var ctx = await buildContext({ userId: userId, message: message, options: options, intent: intent });
    ctx = preflight(message, ctx);

    // Inject conversation history into context for agents
    if (recentConv.length > 0) {
      ctx.conversationHistory = recentConv;
    }

    // 3. Select and call agent
    var reply;
    switch (intent) {
      case INTENTS.THREAD_SUMMARY:
        reply = await runAgent(getThreadSummaryAgent, message, ctx, 'threadSummary');
        break;
      case INTENTS.DAILY_DIGEST:
        reply = await runAgent(getDailyDigestAgent, message, ctx, 'dailyDigest');
        break;
      case INTENTS.CLIENT_RETRIEVAL:
        reply = await runAgent(getClientRetrievalAgent, message, ctx, 'clientRetrieval');
        break;
      case INTENTS.QUOTE_SUPPORT:
        reply = await runAgent(getQuoteSupportAgent, message, ctx, 'quoteSupport');
        break;
      case INTENTS.CRM_UPDATE:
        reply = await runAgent(getCRMUpdateAgent, message, ctx, 'crmUpdate');
        break;
      case INTENTS.HISTORICAL_SCAN:
        reply = await getScanCommand().run(message, ctx);
        if (!reply) reply = await withTimeout(getGeneralAssistantAgent().run(message, ctx), AGENT_TIMEOUT_MS, 'general');
        break;
      case INTENTS.PROSPECTING:
        reply = await getProspectingAgent().run(message, ctx);
        break;
      case INTENTS.GENERAL:
      default:
        reply = await withTimeout(getGeneralAssistantAgent().run(message, ctx), AGENT_TIMEOUT_MS, 'general');
        break;
    }

    // Persisti il turno nella conversazione così il messaggio successivo (es.
    // un "sì" di conferma) ha il contesto a prescindere dall'agente che ha
    // risposto. Il path GENERAL/historical passa da askGiuno che già salva,
    // quindi qui copriamo solo gli agenti specializzati (che non tengono storia).
    if (intent !== INTENTS.GENERAL && intent !== INTENTS.HISTORICAL_SCAN &&
        reply && typeof reply === 'string') {
      try {
        var cc = db2.getConvCache();
        if (!cc[convKey]) cc[convKey] = [];
        cc[convKey].push({ role: 'user', content: message });
        cc[convKey].push({ role: 'assistant', content: reply });
        if (cc[convKey].length > 20) cc[convKey] = cc[convKey].slice(-20);
        db2.saveConversation(convKey, cc[convKey]);
      } catch(e) { logger.warn('[ROUTER] persist conversazione fallita:', e.message); }
    }

    return reply;
  } catch(e) {
    if (e.message === 'API_UNAVAILABLE') {
      return 'Claude è momentaneamente sovraccarico. Riprova tra qualche minuto.';
    }
    if (e.message && e.message.includes('timeout')) {
      return 'Ci sto mettendo troppo. Riprova con una richiesta più specifica.';
    }
    logger.error('[ROUTER] Errore:', e.message);
    throw e;
  }
}

module.exports = { route: route };
