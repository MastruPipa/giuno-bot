// ─── Client Retrieval Agent ────────────────────────────────────────────────────
// Retrieves info about clients/projects.
// Tools: recall_memory, search_kb, search_drive, search_slack_messages, search_everywhere

'use strict';

var logger = require('../utils/logger');
var registry = require('../tools/registry');

var SYSTEM_PROMPT =
  'Sei Giuno, assistente di Katania Studio.\n' +
  'Il tuo compito adesso è recuperare informazioni su un cliente o progetto specifico.\n' +
  'Cerca in ordine:\n' +
  '1. recall_memory — memoria personale dell\'utente\n' +
  '2. search_kb — knowledge base aziendale\n' +
  '3. search_drive — documenti Drive\n' +
  '4. search_slack_messages — conversazioni Slack\n' +
  '5. search_everywhere — se le ricerche precedenti non bastano\n\n' +
  'Presenta le info trovate in modo strutturato.\n' +
  'Sii conciso. Usa *grassetto* per i punti chiave. MAI ** o ##.\n' +
  'Se non trovi nulla, dillo chiaramente.';

var TOOLS = registry.getToolsForAgent('clientRetrieval');

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

  return finalReply;
}

module.exports = { run: run };
