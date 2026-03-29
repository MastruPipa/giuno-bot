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
        return skillReply;
      }
      // If skill returned null, fall through to normal routing
    }

    // 1. Classify intent (fast, keyword-based)
    var intent = await classifyIntent(message);
    logger.info('[ROUTER] User:', userId, '| Intent:', intent);

    // 2. Build context with intent hint for lazy loading
    var ctx = await buildContext({ userId: userId, message: message, options: options, intent: intent });
    ctx = preflight(message, ctx);

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
        break;
      case INTENTS.GENERAL:
      default:
        reply = await withTimeout(getGeneralAssistantAgent().run(message, ctx), AGENT_TIMEOUT_MS, 'general');
        break;
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
