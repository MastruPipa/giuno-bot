// ─── Historical Scanner ────────────────────────────────────────────────────────
// Deep scan Slack channels + Drive files. Resumable, throttled, intelligent.
// Run via "/giuno avvia scan storico" or weekly cron.

'use strict';

var dbClient = require('../services/db/client');
var logger = require('../utils/logger');

var CONFIG = {
  SLACK_BATCH_SIZE: 100,
  SLACK_DELAY_MS: 600,
  MAX_MESSAGES_PER_CHANNEL: 500,  // Cap per evitare scan infiniti
  MAX_LLM_CALLS_PER_CHANNEL: 20, // Cap chiamate LLM per canale
  MIN_IMPORTANCE: 3,
  SUMMARY_MODEL: 'claude-haiku-4-5-20251001',
  MAX_CONTENT_CHARS: 6000,
  SKIP_CHANNELS: ['general', 'casuale', 'candidature'],
};

var VALUE_SIGNALS = [
  /preventivo|proposta|offerta|contratto|firma/i,
  /€\s*\d+|euro\s*\d+/i,
  /deadline|scadenza|consegna|lancio/i,
  /brief|strategia|posizionamento/i,
  /approvato|confermato|ok procedi|vai avanti/i,
  /problema|critico|urgente|bloccato/i,
  /feedback|revisione|correzione/i,
];

function calculateImportance(messages, channelMeta) {
  var score = 1;
  if (channelMeta && channelMeta.cliente) score += 1;
  if (messages.length >= 5) score += 1;
  if (messages.length >= 15) score += 1;
  var text = messages.map(function(m) { return m.text || ''; }).join(' ');
  var signalCount = VALUE_SIGNALS.filter(function(p) { return p.test(text); }).length;
  score += Math.min(2, signalCount);
  var avgLength = text.length / Math.max(1, messages.length);
  if (avgLength < 20) score -= 1;
  return Math.max(1, Math.min(5, score));
}

async function generateSummary(messages, channelMeta) {
  var text = messages.map(function(m) {
    return '[' + (m.user || 'unknown') + ']: ' + (m.text || '').substring(0, 500);
  }).join('\n').substring(0, CONFIG.MAX_CONTENT_CHARS);

  var clienteInfo = channelMeta && channelMeta.cliente ? 'Cliente: ' + channelMeta.cliente : 'Canale interno';
  var channelName = channelMeta ? channelMeta.channel_name : 'unknown';

  try {
    var Anthropic = require('@anthropic-ai/sdk');
    var client = new Anthropic();
    var res = await client.messages.create({
      model: CONFIG.SUMMARY_MODEL,
      max_tokens: 512,
      messages: [{ role: 'user', content:
        'Analizza messaggi Slack di Katania Studio. ' + clienteInfo + ', canale #' + channelName + '.\n' +
        'MESSAGGI:\n' + text + '\n\n' +
        'Rispondi SOLO in JSON:\n' +
        '{"worth_saving":true,"memory_type":"episodic|semantic|procedural","summary":"1-3 frasi",' +
        '"key_facts":["fatto1"],"importance":3}\n' +
        'Se non c\'è nulla di utile: {"worth_saving":false}'
      }],
    });
    var raw = res.content[0].text.trim().replace(/```json|```/g, '').trim();
    var match = raw.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch(e) {
    logger.warn('[SCANNER] Summary failed:', e.message);
    return null;
  }
}

async function saveToKB(summary, channelMeta) {
  if (!summary || !summary.worth_saving) return null;
  var supabase = dbClient.getClient();
  if (!supabase) return null;

  var content = summary.summary;
  if (summary.key_facts && summary.key_facts.length > 0) {
    content += '\n' + summary.key_facts.map(function(f) { return '• ' + f; }).join('\n');
  }

  var confidence = { 'semantic': 0.75, 'procedural': 0.80, 'episodic': 0.50 }[summary.memory_type] || 0.50;
  if (channelMeta && channelMeta.cliente) confidence += 0.05;

  var expiresAt = summary.memory_type === 'episodic'
    ? new Date(Date.now() + 180 * 86400000).toISOString()
    : null;

  var id = 'kb_scan_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 4);

  try {
    await supabase.from('knowledge_base').insert({
      id: id,
      content: content,
      source_type: 'slack_historical',
      source_channel_id: channelMeta ? channelMeta.channel_id : null,
      source_channel_type: channelMeta && channelMeta.cliente ? 'public' : 'internal',
      confidence_score: confidence,
      confidence_tier: summary.memory_type,
      validation_status: 'approved',
      added_by: 'historical_scanner',
      tags: channelMeta ? [channelMeta.channel_name, channelMeta.cliente].filter(Boolean) : [],
      expires_at: expiresAt,
    });
    return id;
  } catch(e) {
    logger.error('[SCANNER] KB insert error:', e.message);
    return null;
  }
}

async function scanSlackChannel(scanRow, channelMeta) {
  var supabase = dbClient.getClient();
  if (!supabase) return;
  var { app } = require('../services/slackService');
  var channelId = scanRow.source_id;

  logger.info('[SCANNER] Starting:', scanRow.source_name);

  await supabase.from('scan_progress').update({
    status: 'in_progress', started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', scanRow.id);

  var cursor = scanRow.last_cursor || undefined;
  var totalMessages = scanRow.messages_scanned || 0;
  var totalKB = scanRow.kb_entries_created || 0;

  try {
    try { await app.client.conversations.join({ channel: channelId }); } catch(e) {}

    var hasMore = true;
    var llmCalls = 0;
    while (hasMore && totalMessages < CONFIG.MAX_MESSAGES_PER_CHANNEL) {
      var params = { channel: channelId, limit: CONFIG.SLACK_BATCH_SIZE };
      if (cursor) params.cursor = cursor;

      var result = await app.client.conversations.history(params);
      var messages = result.messages || [];
      if (messages.length === 0) break;

      totalMessages += messages.length;

      // Group by thread
      var threads = {};
      for (var i = 0; i < messages.length; i++) {
        var m = messages[i];
        if (!m.text || m.text.length < 10) continue;
        var key = m.thread_ts || m.ts;
        if (!threads[key]) threads[key] = [];
        threads[key].push(m);
      }

      var threadKeys = Object.keys(threads);
      for (var ti = 0; ti < threadKeys.length && llmCalls < CONFIG.MAX_LLM_CALLS_PER_CHANNEL; ti++) {
        var threadMsgs = threads[threadKeys[ti]];
        var importance = calculateImportance(threadMsgs, channelMeta);
        if (importance >= CONFIG.MIN_IMPORTANCE) {
          llmCalls++;
          var summary = await generateSummary(threadMsgs, channelMeta);
          if (summary && summary.worth_saving) {
            var kbId = await saveToKB(summary, channelMeta);
            if (kbId) totalKB++;
          }
        }
        await new Promise(function(r) { setTimeout(r, 100); });
      }

      // Next page
      hasMore = result.has_more && result.response_metadata && result.response_metadata.next_cursor;
      if (hasMore) {
        cursor = result.response_metadata.next_cursor;
        await supabase.from('scan_progress').update({
          last_cursor: cursor, messages_scanned: totalMessages, kb_entries_created: totalKB,
          updated_at: new Date().toISOString(),
        }).eq('id', scanRow.id);
      }

      await new Promise(function(r) { setTimeout(r, CONFIG.SLACK_DELAY_MS); });
    }

    await supabase.from('scan_progress').update({
      status: 'done', last_cursor: cursor || null, messages_scanned: totalMessages,
      kb_entries_created: totalKB, completed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('id', scanRow.id);

    logger.info('[SCANNER] Done:', scanRow.source_name, '| msgs:', totalMessages, '| kb:', totalKB);
  } catch(e) {
    logger.error('[SCANNER] Error:', scanRow.source_name, e.message);
    await supabase.from('scan_progress').update({
      status: 'error', error_message: (e.message || '').substring(0, 200), updated_at: new Date().toISOString(),
    }).eq('id', scanRow.id);
  }
}

async function runHistoricalScan(options) {
  options = options || {};
  var supabase = dbClient.getClient();
  if (!supabase) { logger.error('[SCANNER] No Supabase client'); return; }

  var { data: channelMap } = await supabase.from('channel_map').select('channel_id, channel_name, cliente, progetto');
  var metaMap = {};
  (channelMap || []).forEach(function(c) { metaMap[c.channel_id] = c; });

  // Reset stuck in_progress channels (>30 min)
  var stuckCutoff = new Date(Date.now() - 30 * 60000).toISOString();
  await supabase.from('scan_progress').update({ status: 'pending', updated_at: new Date().toISOString() })
    .eq('status', 'in_progress').lt('updated_at', stuckCutoff);

  var { data: pending } = await supabase.from('scan_progress').select('*')
    .eq('scan_type', 'slack_channel')
    .in('status', ['pending', 'error'])
    .limit(options.batchSize || 3);

  if (!pending || pending.length === 0) {
    logger.info('[SCANNER] All channels done');
  } else {
    for (var i = 0; i < pending.length; i++) {
      var row = pending[i];
      if (CONFIG.SKIP_CHANNELS.indexOf(row.source_name) !== -1) {
        await supabase.from('scan_progress').update({ status: 'done', completed_at: new Date().toISOString() }).eq('id', row.id);
        continue;
      }
      await scanSlackChannel(row, metaMap[row.source_id] || null);
    }
  }

  // Report
  var { data: stats } = await supabase.from('scan_progress').select('status').eq('scan_type', 'slack_channel');
  var counts = { pending: 0, in_progress: 0, done: 0, error: 0 };
  (stats || []).forEach(function(r) { counts[r.status] = (counts[r.status] || 0) + 1; });
  logger.info('[SCANNER] Progress:', JSON.stringify(counts));
  return counts;
}

async function getProgress() {
  var supabase = dbClient.getClient();
  if (!supabase) return [];
  var { data } = await supabase.from('scan_progress')
    .select('scan_type, status, source_name, messages_scanned, kb_entries_created')
    .order('status');
  return data || [];
}

module.exports = { runHistoricalScan: runHistoricalScan, getProgress: getProgress };
