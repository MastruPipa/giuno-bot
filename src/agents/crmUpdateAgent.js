// ─── CRM Update Agent ──────────────────────────────────────────────────────────
// Dedicated agent for CRM updates: status, services, notes, followup.
// Principle: DO the action, confirm concisely. Never dump the whole CRM.

'use strict';

var { MODELS } = require('../config/models');

var logger = require('../utils/logger');
var registry = require('../tools/registry');

var SYSTEM_PROMPT =
  'Sei Giuno, collega digitale di Katania Studio. In questo turno l\'utente ti sta dando un aggiornamento CRM: ' +
  'un cambio di stato, un valore, un servizio, una nota o un follow-up su un lead o cliente.\n\n' +
  'DUE CRM, UNA VERITÀ\n' +
  'Attio è la fonte di verità (tool attio_*). La tabella leads interna (search_leads, update_lead, create_lead) è una copia di lavoro che deve restare allineata. ' +
  'Quando aggiorni: se hai i tool Attio e il record esiste lì, aggiorna Attio; poi allinea il lead interno se esiste. ' +
  'Se nel contesto vedi un CONFRONTO CRM con discrepanze sull\'azienda in questione, dillo in una riga e allinea l\'interno ad Attio nello stesso passaggio.\n\n' +
  'COME PROCEDI\n' +
  'Cerca prima il record (search_leads / attio_search) e aggiorna solo i campi che l\'utente ha detto: non inventare valori, date o servizi. ' +
  'Se il lead non esiste da nessuna parte, crealo con i dati che hai. ' +
  'Per una modifica semplice non chiedere conferma: agisci e conferma in due o tre righe cosa hai cambiato e dove. ' +
  'Non elencare altri lead e non riportare l\'intero CRM.\n\n' +
  'STATI (linguaggio naturale → status interno)\n' +
  'hot/caldo/warm/tiepido → contacted · cold/freddo → dormant · chiuso/firmato/won → won · rifiutato/perso/lost → lost · ' +
  'in trattativa → negotiating · proposta inviata → proposal_sent.\n\n' +
  'FORMATO\n' +
  '*Azienda* aggiornata (Attio / CRM interno): una riga per campo cambiato. *grassetto* con un solo asterisco, mai ** o #.';

var TOOLS = registry.getToolsForAgent('crmUpdate');

async function run(message, ctx) {
  var Anthropic = require('@anthropic-ai/sdk');
  var client = new Anthropic();

  var now = new Date();
  var dynamicContext = '\nDATA: ' + now.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' }) + '\n';
  if (ctx.profile && ctx.profile.ruolo) {
    dynamicContext += 'Utente: ' + (ctx.profile.ruolo || 'team') + '\n';
  }

  var attioBlock = require('../orchestrator/attioContext').formatAttioForPrompt(ctx.attioContext);
  if (attioBlock) dynamicContext += '\n' + attioBlock + '\n';

  var fullSystemPrompt = SYSTEM_PROMPT + '\n\n---\nCONTESTO:\n' + dynamicContext;

  // Storia della conversazione Slack (dal router) + messaggio corrente.
  var messages = (Array.isArray(ctx.conversationHistory) ? ctx.conversationHistory : []).concat([{ role: 'user', content: message }]);
  var finalReply = '';
  var iterations = 0;

  while (iterations < 5) {
    iterations++;
    var response;
    try {
      response = await client.messages.create({
        model: MODELS.PRIMARY,
        max_tokens: 1024,
        system: fullSystemPrompt,
        messages: messages,
        tools: TOOLS,
      });
    } catch(e) {
      logger.error('[CRM-UPDATE-AGENT] LLM error:', e.message);
      throw e;
    }

    if (response.stop_reason !== 'tool_use') {
      finalReply = response.content
        .filter(function(b) { return b.type === 'text'; })
        .map(function(b) { return b.text; })
        .join('\n');
      break;
    }

    messages.push({ role: 'assistant', content: response.content });

    var toolResults = await Promise.all(
      response.content
        .filter(function(b) { return b.type === 'tool_use'; })
        .map(async function(tu) {
          var result = await registry.executeToolCall(tu.name, tu.input, ctx.userId, ctx.userRole);
          logger.info('[CRM-UPDATE] Tool:', tu.name, '| Result:', JSON.stringify(result).substring(0, 120));
          return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) };
        })
    );
    messages.push({ role: 'user', content: toolResults });
  }

  // Auto-learn from CRM interactions
  var { autoLearn } = require('../services/anthropicService');
  if (finalReply && finalReply.length > 20) {
    autoLearn(ctx.userId, message, finalReply, { channelId: ctx.channelId, channelType: ctx.channelType, isDM: ctx.isDM }).catch(function(e) {});
  }

  return finalReply;
}

module.exports = { run: run };
