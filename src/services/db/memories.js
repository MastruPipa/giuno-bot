// ─── Memories ────────────────────────────────────────────────────────────────
'use strict';

var c = require('./client');
var search = require('./search');
var logger = require('../../utils/logger');

// ─── Memory type classification ───────────────────────────────────────────────

var MEMORY_CLASSIFIERS = [
  { type: 'preference', confidence: 0.8, expiresIn: null, shared: false,
    patterns: [/preferisce/i, /vuole (che|un|una|il|la)\s/i, /tono.*(umoristico|formale|diretto|conversazionale)/i,
      /stile.*(editoriale|grafico|comunicativo)/i, /monitora regolarmente/i, /abitudine di/i,
      /gli piace|non gli piace|vuole sempre/i] },
  { type: 'semantic', confidence: 0.85, expiresIn: null, shared: true,
    patterns: [/è un[ao]?\s+(fornitore|cliente|partner|collaboratore|designer|sviluppatore|grafico|copywriter)/i,
      /si occupa di/i, /lavora (come|in qualità di)/i, /specializzat[ao] in/i, /ha sede (a|in)/i,
      /è (il|la|un|una) (responsabile|direttore|manager|ceo|coo|cco|gm)/i, /fondat/i] },
  { type: 'procedural', confidence: 0.9, expiresIn: null, shared: true,
    patterns: [/template/i, /procedura/i, /processo/i, /per i preventivi/i, /rate card/i,
      /struttura (del|della|dei)/i, /come si fa/i, /bisogna (prima|sempre)/i, /workflow/i] },
  { type: 'intent', confidence: 0.7, expiresIn: 24 * 3600000, shared: false,
    patterns: [/ho proposto di/i, /suggerito di/i, /da fare:/i, /pending:/i, /in attesa di conferma/i,
      /da inviare a|da mandare a|reminder per|da aggiornare/i] },
];

function classifyMemoryType(content) {
  var c2 = (content || '').toLowerCase();
  for (var i = 0; i < MEMORY_CLASSIFIERS.length; i++) {
    var cls = MEMORY_CLASSIFIERS[i];
    if (cls.patterns.some(function(p) { return p.test(c2); })) {
      return { type: cls.type, confidence: cls.confidence, expiresIn: cls.expiresIn, shared: cls.shared };
    }
  }
  return { type: 'episodic', confidence: 0.5, expiresIn: 30 * 86400000, shared: false };
}

// ─── Temporal reference detection ────────────────────────────────────────────

var TEMPORAL_REFS = {
  'stamattina':        { hoursAgo: 12, fromMidnight: true },
  'questa mattina':    { hoursAgo: 12, fromMidnight: true },
  'stamani':           { hoursAgo: 12, fromMidnight: true },
  'oggi':              { hoursAgo: 24, fromMidnight: true },
  'ieri':              { daysAgo: 2, maxDays: 1, fromMidnight: true },
  'questa settimana':  { daysAgo: 7 },
  'settimana scorsa':  { daysAgo: 14, maxDays: 7 },
  'poco fa':           { hoursAgo: 2 },
  'recentemente':      { hoursAgo: 24 },
  'ultimo ora':        { hoursAgo: 1 },
  'ultime ore':        { hoursAgo: 4 },
};

function detectTemporalRef(query) {
  if (!query) return null;
  var q = query.toLowerCase();
  for (var ref in TEMPORAL_REFS) {
    if (q.includes(ref)) return { ref: ref, config: TEMPORAL_REFS[ref] };
  }
  return null;
}

function getTimeRange(config) {
  var now = new Date();
  var oldest;
  if (config.fromMidnight && !config.daysAgo) {
    var midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    oldest = midnight.getTime();
  } else if (config.daysAgo) {
    oldest = now.getTime() - config.daysAgo * 86400000;
  } else if (config.hoursAgo) {
    oldest = now.getTime() - config.hoursAgo * 3600000;
  } else {
    oldest = now.getTime() - 86400000;
  }
  var newest = now.getTime();
  if (config.maxDays) newest = now.getTime() - config.maxDays * 86400000;
  return { oldest: oldest, newest: newest };
}

// ─── Entity cache (TTL 5 min) ────────────────────────────────────────────────

var _entityCache = null;
var _entityCacheExpiry = 0;
var ENTITY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function _getEntityCache() {
  if (_entityCache && Date.now() < _entityCacheExpiry) return _entityCache;
  return null;
}

function _setEntityCache(data) {
  _entityCache = data;
  _entityCacheExpiry = Date.now() + ENTITY_CACHE_TTL;
}

// ─── Cache & persistence ──────────────────────────────────────────────────────

var _memCache = null;

async function loadMemories() {
  if (!c.useSupabase) {
    _memCache = c.readJSON('memories.json', {});
    return _memCache;
  }
  try {
    var res = await c.getClient().from('memories').select('*').order('created_at', { ascending: true });
    var mems = {};
    if (res.data) res.data.forEach(function(r) {
      if (!mems[r.slack_user_id]) mems[r.slack_user_id] = [];
      mems[r.slack_user_id].push({ id: r.id, content: r.content, tags: r.tags || [], created: r.created_at });
    });
    _memCache = mems;
    return mems;
  } catch(e) { c.logErr('loadMemories', e); _memCache = {}; return {}; }
}

async function addMemory(userId, content, tags, options) {
  options = options || {};
  var classification = options.memory_type
    ? { type: options.memory_type, confidence: options.confidence_score || 0.5, expiresIn: options.expiresIn || null, shared: options.shared || false }
    : classifyMemoryType(content);

  var expiresAt = classification.expiresIn ? new Date(Date.now() + classification.expiresIn).toISOString() : null;
  var slackUserId = classification.shared ? null : userId;

  var entry = {
    id: 'mn' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
    content: content,
    tags: tags || [],
    created: new Date().toISOString(),
    memory_type: classification.type,
    expires_at: expiresAt,
  };
  if (!_memCache) _memCache = {};
  if (!_memCache[userId]) _memCache[userId] = [];
  _memCache[userId].push(entry);

  if (!c.useSupabase) {
    c.writeJSON('memories.json', _memCache);
    return entry;
  }

  var entityRefs = [];
  try {
    var entData = _getEntityCache();
    if (!entData) {
      var entRes = await c.getClient().from('kb_entities').select('canonical_name, aliases').limit(500);
      entData = entRes.data || [];
      _setEntityCache(entData);
    }
    if (entData) {
      var contentLow = content.toLowerCase();
      entityRefs = entData.filter(function(e) {
        if (e.canonical_name.length > 3 && contentLow.includes(e.canonical_name.toLowerCase())) return true;
        // Also match aliases
        if (e.aliases && Array.isArray(e.aliases)) {
          return e.aliases.some(function(alias) {
            return alias.length > 3 && contentLow.includes(alias.toLowerCase());
          });
        }
        return false;
      }).map(function(e) { return e.canonical_name; });
    }
  } catch(e) {
    logger.warn('[DB-MEMORIES] operazione fallita:', e.message);
  }

  // Generate embedding for semantic search (fire-and-forget)
  var embedding = null;
  try {
    var embService = require('../../services/embeddingService');
    if (embService.getProvider() && content.length > 20) {
      embedding = await embService.generateEmbedding(content);
    }
  } catch(e) { /* embedding not available */ }

  try {
    var insertData = {
      id: entry.id,
      slack_user_id: slackUserId,
      content: content,
      tags: tags || [],
      created_at: entry.created,
      memory_type: classification.type,
      confidence_score: classification.confidence,
      source_channel_type: options.channelType || 'conversation',
      source_channel_id: options.channelId || null,
      entity_refs: entityRefs.length > 0 ? entityRefs : null,
      expires_at: expiresAt,
    };
    if (embedding) insertData.embedding = embedding;
    await c.getClient().from('memories').insert(insertData);

    if (entityRefs.length > 0) {
      var graphRows = entityRefs.map(function(name) {
        return { from_type: 'memory', from_id: entry.id, relationship: 'mentions', to_type: 'entity', to_id: name, weight: 0.8, created_by: 'auto' };
      });
      c.getClient().from('memory_graph').insert(graphRows).catch(function() {});
    }

    process.stdout.write('[storeMemory] ' + classification.type + ' | shared:' + classification.shared + ' | entities:' + (entityRefs.join(',') || 'none') + '\n');

    // Fire-and-forget: invalidate superseded memories
    invalidateSupersededMemories(entry.id, content, entityRefs, userId)
      .catch(function(e) { process.stdout.write('[storeMemory] invalidation failed: ' + e.message + '\n'); });
  } catch(e) { c.logErr('addMemory', e); }
  return entry;
}

// ─── Memory invalidation ─────────────────────────────────────────────────────

async function invalidateSupersededMemories(newMemoryId, newContent, entityRefs, userId) {
  if (!c.useSupabase) return;
  try {
    var ruleRes = await c.getClient().from('memory_invalidation_rules')
      .select('trigger_pattern, target_pattern, rule_type')
      .eq('active', true);
    var rules = ruleRes.data || [];
    if (rules.length === 0) return;

    var matchingRules = rules.filter(function(rule) {
      if (!rule.trigger_pattern) return false;
      return rule.trigger_pattern.split('|').some(function(p) {
        try { return new RegExp(p.trim(), 'i').test(newContent); } catch(e) { return false; }
      });
    });
    if (matchingRules.length === 0) return;

    var toInvalidate = [];
    for (var ri = 0; ri < matchingRules.length; ri++) {
      var rule = matchingRules[ri];
      var targetPatterns = (rule.target_pattern || '').split('|');
      var candRes = await c.getClient().from('memories').select('id, content, entity_refs')
        .is('superseded_by', null).neq('id', newMemoryId)
        .gte('created_at', new Date(Date.now() - 30 * 86400000).toISOString());
      var candidates = candRes.data || [];

      for (var ci = 0; ci < candidates.length; ci++) {
        var m = candidates[ci];
        var matchesTarget = targetPatterns.some(function(p) {
          try { return p.trim() && new RegExp(p.trim(), 'i').test(m.content); } catch(e) { return false; }
        });
        var sharesEntity = entityRefs && entityRefs.length > 0 && m.entity_refs &&
          entityRefs.some(function(e) { return (m.entity_refs || []).indexOf(e) !== -1; });
        if (matchesTarget && (sharesEntity || rule.rule_type === 'content')) {
          toInvalidate.push(m.id);
        }
      }
    }

    if (toInvalidate.length > 0) {
      var unique = {};
      toInvalidate.forEach(function(id) { unique[id] = true; });
      toInvalidate = Object.keys(unique);
      await c.getClient().rpc('supersede_memories', { p_new_memory_id: newMemoryId, p_old_memory_ids: toInvalidate });
      process.stdout.write('[invalidateMemories] Invalidated ' + toInvalidate.length + ' memories\n');
    }
  } catch(e) {
    process.stdout.write('[invalidateMemories] Error (non-blocking): ' + e.message + '\n');
  }
}

async function deleteMemory(userId, memoryId) {
  if (_memCache && _memCache[userId]) {
    var before = _memCache[userId].length;
    _memCache[userId] = _memCache[userId].filter(function(m) { return m.id !== memoryId; });
    if (_memCache[userId].length >= before) return false;
  }
  if (!c.useSupabase) {
    c.writeJSON('memories.json', _memCache);
    return true;
  }
  try {
    await c.getClient().from('memories').delete().eq('id', memoryId);
  } catch(e) { c.logErr('deleteMemory', e); }
  return true;
}

async function searchMemories(userId, query) {
  var temporal = detectTemporalRef(query);
  var now = Date.now();

  // TEMPORAL SEARCH — sync cache (fast, works well)
  if (temporal) {
    if (!_memCache || !_memCache[userId]) return [];
    var range = getTimeRange(temporal.config);
    var temporalResults = _memCache[userId].filter(function(m) {
      if (search.isBlacklisted(m.content || '')) return false;
      if (!m.created) return false;
      if (m.expires_at && new Date(m.expires_at).getTime() < now) return false;
      var ts = new Date(m.created).getTime();
      return ts >= range.oldest && ts <= range.newest;
    });
    var extraKeywords = (query || '').toLowerCase()
      .replace(/stamattina|stamani|questa mattina|oggi|ieri|questa settimana|settimana scorsa|poco fa|recentemente|ultimo ora|ultime ore/g, '')
      .trim();
    if (extraKeywords.length > 3) {
      var extraTokens = search.expandQueryTokens(extraKeywords);
      if (extraTokens.length > 0) {
        temporalResults = temporalResults.filter(function(m) {
          return extraTokens.some(function(t) { return (m.content || '').toLowerCase().includes(t); });
        });
      }
    }
    temporalResults.sort(function(a, b) { return new Date(b.created).getTime() - new Date(a.created).getTime(); });
    return temporalResults.slice(0, 20);
  }

  // KEYWORD + SEMANTIC SEARCH — try multiple strategies
  if (c.useSupabase) {
    try {
      var rpcResults = [];

      // 1. Entity recall (fast, exact match)
      var entityRes = await c.getClient().rpc('recall_by_entity', { p_entity_name: query || '', p_limit: 5 });
      if (entityRes.data && entityRes.data.length > 0) {
        rpcResults = rpcResults.concat(entityRes.data);
      }

      // 2. Weighted recall (keyword-based)
      var weightedRes = await c.getClient().rpc('recall_memories_weighted', {
        p_query: query || '', p_user_id: userId || null, p_limit: 10, p_include_expired: false,
      });
      if (weightedRes.data && weightedRes.data.length > 0) {
        rpcResults = rpcResults.concat(weightedRes.data);
      }

      // 3. Semantic search via embeddings (finds related memories even without exact keywords)
      if (rpcResults.length < 5 && query.length > 10) {
        try {
          var embeddingService = require('../../services/embeddingService');
          var semanticResults = await embeddingService.semanticSearchMemories(query, userId, { limit: 5, threshold: 0.35 });
          if (semanticResults && semanticResults.length > 0) {
            rpcResults = rpcResults.concat(semanticResults);
          }
        } catch(e) { /* embeddings not available */ }
      }

      // Deduplicate by id
      if (rpcResults.length > 0) {
        var seen = {};
        var deduped = [];
        for (var ri = 0; ri < rpcResults.length; ri++) {
          if (!seen[rpcResults[ri].id]) {
            seen[rpcResults[ri].id] = true;
            deduped.push(rpcResults[ri]);
          }
        }

        // Confidence gate: filter out low-quality results
        deduped = deduped.filter(function(m) {
          return (m.confidence_score || m.final_score || 0.5) >= 0.3;
        });

        // Track usage
        var ids = deduped.map(function(m) { return m.id; }).filter(Boolean);
        if (ids.length > 0) {
          c.getClient().rpc('increment_memory_usage', { memory_ids: ids }).catch(function() {});
        }

        if (deduped.length > 0) return deduped.slice(0, 15);
      }
    } catch(e) {
      process.stdout.write('[MEM-RPC] Fallback to cache: ' + (e.message || '') + '\n');
    }
  }

  // FALLBACK: sync cache search
  if (!_memCache || !_memCache[userId]) return [];
  var tokens = search.expandQueryTokens(query);
  var scored = _memCache[userId].map(function(m) {
    return { memory: m, score: search.scoreMemory(m, tokens, now) };
  }).filter(function(item) {
    return item.score > 0.3 && !search.isBlacklisted(item.memory.content || '');
  });
  scored.sort(function(a, b) { return b.score - a.score; });
  return scored.slice(0, 15).map(function(item) { return item.memory; });
}

function getMemCache() { return _memCache || {}; }

module.exports = {
  loadMemories: loadMemories,
  addMemory: addMemory,
  deleteMemory: deleteMemory,
  searchMemories: searchMemories,
  getMemCache: getMemCache,
};
