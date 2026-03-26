// ─── Client Retrieval Agent ────────────────────────────────────────────────────
// Retrieves info about clients/projects.
// Tools: recall_memory, search_kb, search_drive, search_slack_messages, search_everywhere, ask_gemini

'use strict';

var logger = require('../utils/logger');
var registry = require('../tools/registry');

var SYSTEM_PROMPT =
  'Sei Giuno, assistente di Katania Studio.\n' +
  'Il tuo compito è recuperare informazioni su clienti, progetti o argomenti specifici.\n\n' +
  'REGOLA CRITICA: Non chiedere MAI chiarimenti. Agisci subito con le info che hai.\n' +
  'Se la domanda è vaga, usa le parole chiave più ovvie e cerca in TUTTE le fonti in parallelo.\n\n' +
  'Cerca SEMPRE in questo ordine senza saltare nessun passaggio:\n' +
  '1. recall_memory — memoria personale\n' +
  '2. search_kb — knowledge base aziendale\n' +
  '3. search_drive — documenti Drive\n' +
  '4. search_slack_messages — conversazioni Slack (OBBLIGATORIO, non saltare mai questo step)\n' +
  '5. search_everywhere — se i risultati precedenti sono insufficienti\n\n' +
  'Presenta tutto quello che trovi, anche se parziale.\n' +
  'Se non trovi nulla in nessuna fonte, dillo chiaramente con le fonti consultate.\n' +
  'MAI chiedere "cosa stai cercando?" se la domanda contiene già un soggetto chiaro.\n' +
  'Usa *grassetto* per i punti chiave. MAI ** o ##.\n' +
  'Hai accesso a Gemini tramite il tool ask_gemini.\n' +
  'Usalo per cross-check informazioni importanti o quando serve un secondo parere.\n' +
  '\nCONSAPEVOLEZZA TEMPORALE:\n' +
  'Siamo nel 2026. Quando trovi informazioni:\n' +
  '- Dati 2024-2026: alta priorità, molto rilevanti\n' +
  '- Dati 2022-2023: contesto storico, possono essere obsoleti\n' +
  '- Dati prima del 2022: archivio, menziona sempre che sono vecchi\n' +
  'Quando presenti info, indica sempre la data se disponibile.\n\n' +
  'RICERCA PROATTIVA — REGOLA ASSOLUTA:\n' +
  'Per ogni richiesta su cliente, progetto o argomento aziendale:\n' +
  '1. Cerca SUBITO su recall_memory\n' +
  '2. Cerca SUBITO su search_kb\n' +
  '3. Cerca SUBITO su search_drive con termine principale\n' +
  '4. Cerca SUBITO su search_slack_messages\n' +
  '5. Se i risultati sono parziali, cerca con termini alternativi\n' +
  'NON aspettare, NON chiedere chiarimenti, NON fermarti al primo risultato.\n' +
  'Combina tutto quello che trovi in una risposta strutturata.\n' +
  '\nFORMATTAZIONE SLACK OBBLIGATORIA:\n' +
  'Usa *grassetto* con UN solo asterisco. MAI **doppio**.\n' +
  'Liste con • o numeri. MAI # per titoli. MAI ## o ###.\n' +
  'Risposte max 15 righe. Frasi corte. Zero fronzoli.\n' +
  'Non chiedere MAI chiarimenti se la domanda ha già un soggetto chiaro — agisci subito.';

var TOOLS = registry.getToolsForAgent('clientRetrieval');

function buildDynamicContext(ctx) {
  var dynamicContext = '';

  var now = new Date();
  var dateStr = now.toLocaleDateString('it-IT', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'Europe/Rome',
  });
  var timeStr = now.toLocaleTimeString('it-IT', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome',
  });
  dynamicContext += '\nDATA E ORA: ' + dateStr + ' ore ' + timeStr + '\n';
  dynamicContext += 'Anno corrente: ' + now.getFullYear() +
    '. Priorità: ' + now.getFullYear() + ' > ' + (now.getFullYear() - 1) +
    ' > ' + (now.getFullYear() - 2) + ' > storico.\n';

  if (ctx.profile && ctx.profile.ruolo) {
    dynamicContext += '\nPROFILO UTENTE:\n';
    dynamicContext += 'Ruolo: ' + ctx.profile.ruolo + '\n';
    if (ctx.profile.progetti && ctx.profile.progetti.length > 0)
      dynamicContext += 'Progetti: ' + ctx.profile.progetti.join(', ') + '\n';
    if (ctx.profile.clienti && ctx.profile.clienti.length > 0)
      dynamicContext += 'Clienti: ' + ctx.profile.clienti.join(', ') + '\n';
  }

  if (ctx.relevantMemories && ctx.relevantMemories.length > 0) {
    dynamicContext += '\nMEMORIE RILEVANTI:\n';
    ctx.relevantMemories.forEach(function(m) {
      dynamicContext += '• [' + (m.tags || []).join(', ') + '] ' + m.content + '\n';
    });
  }

  if (ctx.kbResults && ctx.kbResults.length > 0) {
    dynamicContext += '\nKNOWLEDGE BASE AZIENDALE:\n';
    ctx.kbResults.forEach(function(k) {
      dynamicContext += '• ' + k.content + '\n';
    });
  }

  if (ctx.channelContext) {
    dynamicContext += '\nCONTESTO CANALE:\n' + ctx.channelContext + '\n';
  }

  return dynamicContext;
}

async function run(message, ctx) {
  var Anthropic = require('@anthropic-ai/sdk');
  var client = new Anthropic();

  var dynamicContext = buildDynamicContext(ctx);
  var fullSystemPrompt = SYSTEM_PROMPT +
    (dynamicContext ? '\n\n---\nCONTESTO CORRENTE:\n' + dynamicContext : '');

  var messages = [{ role: 'user', content: message }];
  var finalReply = '';

  while (true) {
    var response;
    try {
      response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        system: fullSystemPrompt,
        messages: messages,
        tools: TOOLS,
      });
    } catch(e) {
      logger.error('[CLIENT-RETRIEVAL-AGENT] LLM error:', e.message);
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
          return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) };
        })
    );
    messages.push({ role: 'user', content: toolResults });
  }

  // Auto-learn in background
  var { autoLearn } = require('../services/anthropicService');
  if (finalReply && finalReply.length > 20) {
    autoLearn(ctx.userId, message, finalReply).catch(function(e) {});
  }

  return finalReply;
}

module.exports = { run: run };
