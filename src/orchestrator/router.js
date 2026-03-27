// ─── Orchestrator Router ───────────────────────────────────────────────────────
// Main orchestration function: route(userId, message, options) →
//   classifies intent → selects agent → calls agent → returns reply string

'use strict';

var logger = require('../utils/logger');
var { INTENTS, classifyIntent } = require('./intentClassifier');
var { buildContext } = require('./contextBuilder');

// Agents (lazy-loaded to avoid circular deps)
function getThreadSummaryAgent()   { return require('../agents/threadSummaryAgent'); }
function getDailyDigestAgent()     { return require('../agents/dailyDigestAgent'); }
function getClientRetrievalAgent() { return require('../agents/clientRetrievalAgent'); }
function getGeneralAssistantAgent(){ return require('../agents/generalAssistantAgent'); }
function getQuoteSupportAgent()   { return require('../agents/quoteSupportAgent'); }
function getCRMUpdateAgent()      { return require('../agents/crmUpdateAgent'); }

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
    // 1. Build context
    var ctx = await buildContext({ userId: userId, message: message, options: options });

    // 2. Classify intent
    var intent = await classifyIntent(message);
    logger.info('[ROUTER] User:', userId, '| Intent:', intent);

    // 3. Select and call agent
    var reply;
    switch (intent) {
      case INTENTS.THREAD_SUMMARY:
        reply = await getThreadSummaryAgent().run(message, ctx);
        break;
      case INTENTS.DAILY_DIGEST:
        reply = await getDailyDigestAgent().run(message, ctx);
        break;
      case INTENTS.CLIENT_RETRIEVAL:
        reply = await getClientRetrievalAgent().run(message, ctx);
        break;
      case INTENTS.QUOTE_SUPPORT:
        reply = await getQuoteSupportAgent().run(message, ctx);
        break;
      case INTENTS.CRM_UPDATE:
        reply = await getCRMUpdateAgent().run(message, ctx);
        break;
      case INTENTS.GENERAL:
      default:
        reply = await getGeneralAssistantAgent().run(message, ctx);
        break;
    }

    return reply;
  } catch(e) {
    logger.error('[ROUTER] Errore:', e.message);
    throw e;
  }
}

module.exports = { route: route };
