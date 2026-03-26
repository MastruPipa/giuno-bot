// ─── Daily Digest Agent ────────────────────────────────────────────────────────
// Builds the daily briefing.
// Tools: list_events, find_emails, recall_memory, search_kb

'use strict';

var logger = require('../utils/logger');
var registry = require('../tools/registry');

var SYSTEM_PROMPT =
  'Sei Giuno, assistente di Katania Studio.\n' +
  'Il tuo compito adesso è costruire il briefing giornaliero dell\'utente.\n' +
  'Struttura la risposta in sezioni chiare:\n' +
  '• *Agenda di oggi* — eventi del calendario\n' +
  '• *Mail importanti* — email non lette\n' +
  '• *Task in sospeso* — dalla memoria\n' +
  '• *Info aziendali* — dalla knowledge base se rilevante\n' +
  'Sii conciso. Usa *grassetto* per titoli sezioni. MAI ** o ##.\n' +
  'Massimo 20 righe totali.\n' +
  '\nFORMATTAZIONE SLACK OBBLIGATORIA:\n' +
  'Usa *grassetto* con UN solo asterisco. MAI **doppio**.\n' +
  'Liste con • o numeri. MAI # per titoli. MAI ## o ###.\n' +
  'Risposte max 15 righe. Frasi corte. Zero fronzoli.\n' +
  'Non chiedere MAI chiarimenti se la domanda ha già un soggetto chiaro — agisci subito.';

var TOOLS = registry.getToolsForAgent('dailyDigest');

function buildDynamicContext(ctx) {
  var dynamicContext = '';

  if (ctx.currentDate) {
    dynamicContext += '\nDATA ATTUALE: ' + ctx.currentDate +
      ' (' + ctx.currentYear + ' ' + ctx.currentQuarter + ')\n';
    dynamicContext += 'PRIORITÀ TEMPORALE: Informazioni del ' +
      ctx.currentYear + ' hanno priorità su anni precedenti.\n';
  }

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
      logger.error('[DAILY-DIGEST-AGENT] LLM error:', e.message);
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
