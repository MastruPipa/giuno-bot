// ─── Thread Summary Agent ──────────────────────────────────────────────────────
// Dedicated to summarizing Slack threads and channels.
// Tools: summarize_thread, summarize_channel, search_slack_messages, recall_memory

'use strict';

var logger = require('../utils/logger');
var registry = require('../tools/registry');

var SYSTEM_PROMPT =
  'Sei Giuno, assistente di Katania Studio.\n' +
  'Il tuo compito adesso è riassumere conversazioni Slack.\n' +
  'Sii conciso, strutturato, siciliano nell\'anima.\n' +
  'Usa *grassetto* per i punti chiave. Liste con •.\n' +
  'Identifica: argomenti principali, decisioni prese, azioni da fare.\n' +
  'MAI inventare, MAI usare ** o ##.';

var TOOLS = registry.getToolsForAgent('threadSummary');

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

  return finalReply;
}

module.exports = { run: run };
