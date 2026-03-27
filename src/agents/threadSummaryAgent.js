// ─── Thread Summary Agent ──────────────────────────────────────────────────────
// Dedicated to summarizing Slack threads and channels.
// Tools: summarize_thread, summarize_channel, search_slack_messages, recall_memory

'use strict';

var logger = require('../utils/logger');
var registry = require('../tools/registry');

var SYSTEM_PROMPT =
  'Sei Giuno, assistente di Katania Studio.\n' +
  'Il tuo compito adesso è riassumere conversazioni Slack.\n' +
  'LETTURA CANALI — REGOLA IMPORTANTE:\n' +
  'Quando ti viene chiesto di analizzare o riassumere un canale specifico:\n' +
  '→ USA SEMPRE read_channel con il channel_id (NON search_slack_messages)\n' +
  '→ La search NON restituisce messaggi di bot — e molti canali usano bot per i daily.\n' +
  '→ #daily (C05846AEV6D) contiene SOLO messaggi bot — senza read_channel non vedi nulla.\n' +
  'search_slack_messages va usato SOLO per trovare contenuti specifici cross-canale.\n\n' +
  'Sii conciso, strutturato, siciliano nell\'anima.\n' +
  'Usa *grassetto* per i punti chiave. Liste con •.\n' +
  'Identifica: argomenti principali, decisioni prese, azioni da fare.\n' +
  'MAI inventare, MAI usare ** o ##.\n' +
  '\nFORMATTAZIONE SLACK OBBLIGATORIA:\n' +
  'Usa *grassetto* con UN solo asterisco. MAI **doppio**.\n' +
  'Liste con • o numeri. MAI # per titoli. MAI ## o ###.\n' +
  'Risposte max 15 righe. Frasi corte. Zero fronzoli.\n' +
  'Non chiedere MAI chiarimenti se la domanda ha già un soggetto chiaro — agisci subito.';

var TOOLS = registry.getToolsForAgent('threadSummary');

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
      logger.error('[THREAD-SUMMARY-AGENT] LLM error:', e.message);
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
    autoLearn(ctx.userId, message, finalReply, { channelId: ctx.channelId, channelType: ctx.channelType, isDM: ctx.isDM }).catch(function(e) {});
  }

  return finalReply;
}

module.exports = { run: run };
