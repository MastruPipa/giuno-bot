// ─── CRM Update Agent ──────────────────────────────────────────────────────────
// Dedicated agent for CRM updates: status, services, notes, followup.
// Principle: DO the action, confirm concisely. Never dump the whole CRM.

'use strict';

var logger = require('../utils/logger');
var registry = require('../tools/registry');

var SYSTEM_PROMPT =
  'Sei Giuno, assistente di Katania Studio.\n' +
  'Il tuo compito SPECIFICO adesso è aggiornare il CRM.\n\n' +
  'REGOLE ASSOLUTE:\n' +
  '1. Cerca SEMPRE il lead con search_leads prima di aggiornare.\n' +
  '2. Se il lead esiste → usa update_lead con solo i campi da cambiare.\n' +
  '3. Se il lead non esiste → usa create_lead con tutti i dati disponibili.\n' +
  '4. Dopo l\'aggiornamento → conferma in MAX 3 righe cosa hai fatto.\n' +
  '5. NON listare tutto il CRM. NON mostrare altri lead. Solo quello richiesto.\n' +
  '6. NON chiedere conferma per aggiornamenti semplici — agisci subito.\n\n' +
  'STATUS MAPPING (accetta linguaggio naturale):\n' +
  '• "hot", "caldo", "molto interessato" → contacted\n' +
  '• "warm", "tiepido" → contacted\n' +
  '• "cold", "freddo" → dormant\n' +
  '• "abbiamo chiuso", "hanno firmato", "won" → won\n' +
  '• "hanno rifiutato", "lost", "perso" → lost\n' +
  '• "in trattativa", "negotiating" → negotiating\n' +
  '• "proposta inviata", "proposal sent" → proposal_sent\n\n' +
  'FORMATO RISPOSTA dopo update:\n' +
  '*[Azienda]* aggiornato:\n' +
  '• Status: [nuovo status]\n' +
  '• [altri campi modificati]\n\n' +
  'Usa *grassetto* con UN asterisco. MAI ** o ##. MAI elenchi lunghi.';

var TOOLS = registry.getToolsForAgent('crmUpdate');

async function run(message, ctx) {
  var Anthropic = require('@anthropic-ai/sdk');
  var client = new Anthropic();

  var now = new Date();
  var dynamicContext = '\nDATA: ' + now.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' }) + '\n';
  if (ctx.profile && ctx.profile.ruolo) {
    dynamicContext += 'Utente: ' + (ctx.profile.ruolo || 'team') + '\n';
  }

  var fullSystemPrompt = SYSTEM_PROMPT + '\n\n---\nCONTESTO:\n' + dynamicContext;

  var messages = [{ role: 'user', content: message }];
  var finalReply = '';
  var iterations = 0;

  while (iterations < 5) {
    iterations++;
    var response;
    try {
      response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 400,
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
