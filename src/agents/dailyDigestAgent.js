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
  'Massimo 20 righe totali.';

var TOOLS = registry.getToolsForAgent('dailyDigest');

async function run(message, ctx) {
  var Anthropic = require('@anthropic-ai/sdk');
  var client = new Anthropic();

  var messages = [{ role: 'user', content: message }];
  var finalReply = '';

  while (true) {
    var response;
    try {
      response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        system: SYSTEM_PROMPT,
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

  return finalReply;
}

module.exports = { run: run };
