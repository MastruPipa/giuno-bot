// ─── Real-Time Slack Listener ─────────────────────────────────────────────────
// Listens to ALL Slack messages, batches per channel, AI triage with Haiku.
// Saves only valuable content (decisions, deadlines, prices, tasks, problems).
'use strict';

var logger = require('../utils/logger');
var dbClient = require('../services/db/client');
var { safeParse } = require('../utils/safeCall');

var BOT_USER_ID = process.env.GIUNO_BOT_USER_ID || null;
var FLUSH_INTERVAL_MS = 30000; // 30 seconds
var MIN_MESSAGE_LENGTH = 15;

// Per-channel message buffer
var _buffers = {};  // channelId → [{ text, user, ts }]
var _flushTimers = {};
var _channelMeta = {}; // channelId → { name, cliente, is_private }
var _stats = { buffered: 0, flushed: 0, saved: 0 };

// ─── Value signals for triage ────────────────────────────────────────────────

var VALUE_PATTERNS = [
  /preventivo|proposta|offerta|contratto|€\s*\d/i,
  /deadline|scadenza|consegna|entro (il|le|oggi|domani|luned|marted|mercoled|gioved|venerd)/i,
  /approvato|confermato|ok procedi|firmato|accettat[oa]/i,
  /problema|critico|urgente|bloccat[oi]|bug|errore|non funziona/i,
  /decisione|deciso|si fa così|procediamo con|andiamo con|optiamo per/i,
  /feedback|revisione|va bene|non va bene|da rifare|da correggere/i,
  /task|da fare|todo|azione|action item|responsabile|si occupa/i,
  /budget|costo|prezzo|tariffa|fee|fattur|pagamento|incasso/i,
  // Client & project signals (named entities often appear without other keywords)
  /cliente|progetto|brief|campagna|lancio|rilascio|release/i,
  /meeting|call|riunione|appuntamento|presentazione|demo|brainstorm/i,
  // Question patterns — users often share context while asking
  /\b(chi|cosa|come|dove|quando|perch[eé]|quanto|quanti|quale|quali)\b.{10,}\?/i,
  // Substantive discussions (long-form) in channels are usually worth capturing
  /^.{180,}$/,
];

function hasValueSignal(text) {
  return VALUE_PATTERNS.some(function(p) { return p.test(text); });
}

// ─── Register listener on Bolt app ───────────────────────────────────────────

function register(app) {
  app.event('message', async function(args) {
    var event = args.event || {};

    // Skip bot messages, self, subtypes (joins, leaves, etc.)
    if (event.bot_id) return;
    if (event.subtype) return;
    if (BOT_USER_ID && event.user === BOT_USER_ID) return;
    if (!event.text || event.text.length < MIN_MESSAGE_LENGTH) return;
    if (event.channel_type === 'im') return; // Skip DMs

    var channelId = event.channel;
    var text = event.text;

    // Quick check: does this message have any value signal?
    if (!hasValueSignal(text)) return;

    // Buffer the message (keep thread_ts so we can group a thread into one unit)
    if (!_buffers[channelId]) _buffers[channelId] = [];
    _buffers[channelId].push({ text: text, user: event.user, ts: event.ts, thread_ts: event.thread_ts || null });
    _stats.buffered++;

    // Cache channel metadata (lazy, once)
    if (!_channelMeta[channelId]) {
      try {
        var db = require('../../supabase');
        var chMap = db.getChannelMapCache()[channelId];
        if (chMap) {
          _channelMeta[channelId] = { name: chMap.channel_name, cliente: chMap.cliente, is_private: chMap.is_private };
        } else {
          _channelMeta[channelId] = { name: channelId, cliente: null, is_private: false };
        }
      } catch(e) {
        _channelMeta[channelId] = { name: channelId, cliente: null, is_private: false };
      }
    }

    // Set flush timer (debounced per channel)
    if (_flushTimers[channelId]) clearTimeout(_flushTimers[channelId]);
    _flushTimers[channelId] = setTimeout(function() {
      flushChannel(channelId).catch(function(e) {
        logger.warn('[RT-LISTENER] Flush error:', e.message);
      });
    }, FLUSH_INTERVAL_MS);
  });

  logger.info('[RT-LISTENER] Registered on Slack app');
}

// ─── Flush a channel buffer ──────────────────────────────────────────────────

async function flushChannel(channelId) {
  var messages = _buffers[channelId];
  if (!messages || messages.length === 0) return;

  // Clear buffer
  _buffers[channelId] = [];
  delete _flushTimers[channelId];
  _stats.flushed++;

  var supabase = dbClient.getClient();
  if (!supabase) return;

  var meta = _channelMeta[channelId] || {};
  // If every buffered message belongs to the same thread we tag the whole batch
  // so downstream retrieval can fetch it as a cohesive unit (fixes "non impara dai thread").
  var threadTsSet = messages.reduce(function(acc, m) {
    if (m.thread_ts) acc[m.thread_ts] = true;
    return acc;
  }, {});
  var threadTsKeys = Object.keys(threadTsSet);
  var batchThreadTs = threadTsKeys.length === 1 ? threadTsKeys[0] : null;
  var batchText = messages.map(function(m) {
    return '[' + (m.user || '?') + ']: ' + m.text;
  }).join('\n').substring(0, 4000);

  // AI triage with Haiku
  try {
    var Anthropic = require('@anthropic-ai/sdk');
    var client = new Anthropic();
    var res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content:
        'Canale Slack: #' + (meta.name || '?') + (meta.cliente ? ' (cliente: ' + meta.cliente + ')' : '') + '\n' +
        'Messaggi:\n' + batchText + '\n\n' +
        'Estrai SOLO info operative utili da ricordare. Rispondi JSON:\n' +
        '{"worth_saving":true,"items":[{"type":"decisione|scadenza|task|prezzo|problema|feedback","content":"1 frase","entities":["nome1"]}]}\n' +
        'Se nulla di utile: {"worth_saving":false}'
      }],
    });

    var match = res.content[0].text.trim().replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
    if (!match) return;
    var result = safeParse('RT-LISTENER', match[0], null);
    if (!result.worth_saving || !result.items || result.items.length === 0) return;

    // Save each item to KB
    for (var i = 0; i < result.items.length; i++) {
      var item = result.items[i];
      if (!item.content || item.content.length < 10) continue;

      var kbId = 'kb_rt_' + Date.now().toString(36) + '_' + i;
      var confidence = { 'decisione': 0.7, 'scadenza': 0.75, 'prezzo': 0.7, 'problema': 0.65, 'task': 0.6, 'feedback': 0.55 }[item.type] || 0.5;

      var row = {
        id: kbId,
        content: '#' + (meta.name || '?') + ' — ' + item.content,
        source_type: 'slack_realtime',
        source_channel_id: channelId,
        source_channel_type: meta.is_private ? 'private' : 'public',
        confidence_score: confidence,
        confidence_tier: meta.is_private ? 'slack_private' : 'slack_public',
        validation_status: 'approved',
        added_by: 'realtime_listener',
        tags: [meta.name, item.type, meta.cliente, batchThreadTs ? 'thread:' + batchThreadTs : null].filter(Boolean),
      };
      if (batchThreadTs) row.source_thread_ts = batchThreadTs;
      await supabase.from('knowledge_base').insert(row).catch(function(err) {
        // Retry without source_thread_ts if migration is not yet applied
        if (row.source_thread_ts && /source_thread_ts/i.test(String(err && err.message || ''))) {
          delete row.source_thread_ts;
          return supabase.from('knowledge_base').insert(row).catch(function() {});
        }
      });

      // Entity linking
      if (item.entities && item.entities.length > 0) {
        for (var ei = 0; ei < item.entities.length; ei++) {
          supabase.from('memory_graph').insert({
            from_type: 'knowledge_base', from_id: kbId,
            relationship: 'mentions', to_type: 'entity', to_id: item.entities[ei],
            weight: 0.6, created_by: 'realtime_listener',
          }).catch(function() {});
        }
      }

      _stats.saved++;
    }

    logger.info('[RT-LISTENER] Saved', result.items.length, 'items from #' + (meta.name || channelId));
  } catch(e) {
    logger.warn('[RT-LISTENER] Triage error:', e.message);
  }
}

// ─── Flush all buffers (for graceful shutdown) ───────────────────────────────

async function flushAll() {
  var channels = Object.keys(_buffers);
  for (var i = 0; i < channels.length; i++) {
    await flushChannel(channels[i]).catch(function() {});
  }
}

function getStats() {
  return {
    active_channels: Object.keys(_buffers).filter(function(k) { return _buffers[k].length > 0; }).length,
    buffered_messages: _stats.buffered,
    flushed_batches: _stats.flushed,
    saved_items: _stats.saved,
  };
}

module.exports = { register: register, flushAll: flushAll, getStats: getStats };
