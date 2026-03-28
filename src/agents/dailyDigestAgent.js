// ─── Daily Digest Agent V2 ───────────────────────────────────────────────────
// Operational briefing with deadlines, channel profiles, team signals.
'use strict';

var logger = require('../utils/logger');
var registry = require('../tools/registry');
var dbClient = require('../services/db/client');

var SYSTEM_PROMPT =
  'Sei Giuno, assistente di Katania Studio (agenzia creativa, 9 persone).\n' +
  'Costruisci il BRIEFING OPERATIVO della giornata.\n\n' +
  'STRUTTURA:\n' +
  '1. *Priorità del giorno* — scadenze e azioni urgenti\n' +
  '2. *Agenda* — eventi calendario\n' +
  '3. *Progetti attivi* — stato veloce per progetto\n' +
  '4. *Mail importanti* — email non lette\n' +
  '5. *Alert* — ritardi, blocchi\n\n' +
  'REGOLE: operativo, nomi+date+azioni concrete. Max 25 righe.\n' +
  'Ometti sezioni senza dati. Usa *grassetto* singolo. MAI ** o ##.\n' +
  'Non chiedere chiarimenti — agisci subito.';

var TOOLS = registry.getToolsForAgent('dailyDigest');

async function buildOperationalContext(ctx) {
  var parts = [];
  var supabase = dbClient.getClient();
  var now = new Date();

  parts.push('DATA: ' + now.toLocaleDateString('it-IT', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Europe/Rome' }) +
    ' ore ' + now.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' }));

  if (ctx.profile && ctx.profile.ruolo) {
    var pStr = 'PROFILO: ' + ctx.profile.ruolo;
    if (ctx.profile.progetti && ctx.profile.progetti.length > 0) pStr += ' | Progetti: ' + ctx.profile.progetti.slice(0, 5).join(', ');
    parts.push(pStr);
  }

  if (!supabase) return parts.join('\n\n');

  // Deadlines from memories
  try {
    var res = await supabase.from('memories')
      .select('content, memory_type, entity_refs')
      .or('memory_type.eq.intent,content.ilike.%scadenza%,content.ilike.%deadline%,content.ilike.%entro%,content.ilike.%consegna%')
      .is('superseded_by', null)
      .or('expires_at.is.null,expires_at.gt.' + now.toISOString())
      .order('created_at', { ascending: false }).limit(15);
    if (res.data && res.data.length > 0) {
      parts.push('SCADENZE:\n' + res.data.map(function(m) { return '• [' + m.memory_type + '] ' + m.content; }).join('\n'));
    }
  } catch(e) {}

  // Active projects from channel_profiles
  try {
    var projRes = await supabase.from('channel_profiles')
      .select('channel_name, cliente, progetto, project_phase, team_members')
      .not('cliente', 'is', null).not('project_phase', 'eq', 'chiuso')
      .order('updated_at', { ascending: false }).limit(12);
    if (projRes.data && projRes.data.length > 0) {
      parts.push('PROGETTI ATTIVI:\n' + projRes.data.map(function(p) {
        var line = '• #' + p.channel_name;
        if (p.cliente) line += ' [' + p.cliente + ']';
        if (p.project_phase) line += ' fase: ' + p.project_phase;
        return line;
      }).join('\n'));
    }
  } catch(e) {}

  // Recent KB entries (24h)
  try {
    var kbRes = await supabase.from('knowledge_base')
      .select('content, confidence_tier')
      .gte('created_at', new Date(now - 86400000).toISOString())
      .eq('validation_status', 'approved')
      .order('confidence_score', { ascending: false }).limit(5);
    if (kbRes.data && kbRes.data.length > 0) {
      parts.push('NUOVE INFO KB:\n' + kbRes.data.map(function(k) { return '• [' + k.confidence_tier + '] ' + (k.content || '').substring(0, 150); }).join('\n'));
    }
  } catch(e) {}

  if (ctx.relevantMemories && ctx.relevantMemories.length > 0) {
    parts.push('MEMORIE:\n' + ctx.relevantMemories.slice(0, 5).map(function(m) { return '• ' + m.content; }).join('\n'));
  }

  return parts.join('\n\n');
}

async function run(message, ctx) {
  var Anthropic = require('@anthropic-ai/sdk');
  var client = new Anthropic();
  var dynamicContext = await buildOperationalContext(ctx);
  var fullSystem = SYSTEM_PROMPT + '\n\n---\nCONTESTO OPERATIVO:\n' + dynamicContext;
  var messages = [{ role: 'user', content: message }];
  var finalReply = '';

  while (true) {
    var response;
    try {
      response = await client.messages.create({
        model: 'claude-sonnet-4-20250514', max_tokens: 1000,
        system: fullSystem, messages: messages, tools: TOOLS,
      });
    } catch(e) { logger.error('[DIGEST-V2]', e.message); throw e; }

    if (response.stop_reason !== 'tool_use') {
      finalReply = response.content.filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('\n');
      break;
    }
    messages.push({ role: 'assistant', content: response.content });
    var toolResults = await Promise.all(response.content.filter(function(b) { return b.type === 'tool_use'; }).map(async function(tu) {
      var result = await registry.executeToolCall(tu.name, tu.input, ctx.userId, ctx.userRole);
      return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) };
    }));
    messages.push({ role: 'user', content: toolResults });
  }

  var { autoLearn } = require('../services/anthropicService');
  if (finalReply && finalReply.length > 20) {
    autoLearn(ctx.userId, message, finalReply, { channelId: ctx.channelId, channelType: ctx.channelType, isDM: ctx.isDM }).catch(function() {});
  }
  return finalReply;
}

module.exports = { run: run };
