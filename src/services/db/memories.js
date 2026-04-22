// ─── Memories ────────────────────────────────────────────────────────────────
'use strict';

var crypto = require('crypto');
var c = require('./client');
var search = require('./search');
var logger = require('../../utils/logger');
var { scrubPII } = require('../../utils/piiScrub');

// 16-char SHA-1 of a normalized content string — stable across whitespace/case changes
// so that "X ha detto Y." and "x ha detto Y" collide in dedup.
function contentHash(content) {
  var normalized = String(content || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]+/gu, '')
    .trim();
  if (!normalized) return null;
  return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}

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

// Business importance boosters — high-value content gets higher confidence
var IMPORTANCE_BOOSTERS = [
  { pattern: /budget|€\s*\d|\d+\s*€|costo|fattura|pagamento|margine|profitto/i, boost: 0.1 },
  { pattern: /deadline|scadenza|entro il|consegna|urgente/i, boost: 0.1 },
  { pattern: /contratto|firmato|accordo|partnership/i, boost: 0.15 },
  { pattern: /decisione|deciso|approvato|confermato/i, boost: 0.1 },
  { pattern: /problema|blocco|rischio|criticità|escalation/i, boost: 0.1 },
  { pattern: /cliente|lead|prospect|contatto/i, boost: 0.05 },
  { pattern: /CORREZIONE|feedback.*negativo/i, boost: 0.15 },
];

function classifyMemoryType(content) {
  var c2 = (content || '').toLowerCase();
  var result = { type: 'episodic', confidence: 0.5, expiresIn: 30 * 86400000, shared: false };

  for (var i = 0; i < MEMORY_CLASSIFIERS.length; i++) {
    var cls = MEMORY_CLASSIFIERS[i];
    if (cls.patterns.some(function(p) { return p.test(c2); })) {
      result = { type: cls.type, confidence: cls.confidence, expiresIn: cls.expiresIn, shared: cls.shared };
      break;
    }
  }

  // Apply importance boosters
  var totalBoost = 0;
  IMPORTANCE_BOOSTERS.forEach(function(b) {
    if (b.pattern.test(c2)) totalBoost += b.boost;
  });
  if (totalBoost > 0) {
    result.confidence = Math.min(0.95, result.confidence + totalBoost);
    // Business-critical content should live longer
    if (totalBoost >= 0.15 && result.expiresIn) {
      result.expiresIn = Math.max(result.expiresIn, 90 * 86400000); // At least 90 days
    }
  }

  return result;
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
  // Scrub PII before anything else so dedup / classify / embedding all run on
  // the clean string. Keeps personal data out of long-term storage.
  content = scrubPII(content);
  var classification = options.memory_type
    ? { type: options.memory_type, confidence: options.confidence_score || 0.5, expiresIn: options.expiresIn || null, shared: options.shared || false }
    : classifyMemoryType(content);

  var expiresAt = classification.expiresIn ? new Date(Date.now() + classification.expiresIn).toISOString() : null;
  var slackUserId = classification.shared ? null : userId;
  var hash = contentHash(content);
  var threadTs = options.threadTs || null;

  // Content-level dedup: if we've already stored the same normalized content
  // for this user in the last 30 days, skip the write. Prevents the bot from
  // parroting the same memory across threads (fixes "ripetitivo").
  if (hash && c.useSupabase) {
    try {
      var dupQuery = c.getClient().from('memories')
        .select('id')
        .eq('content_hash', hash)
        .is('superseded_by', null)
        .gte('created_at', new Date(Date.now() - 30 * 86400000).toISOString())
        .limit(1);
      if (slackUserId) dupQuery = dupQuery.eq('slack_user_id', slackUserId);
      else dupQuery = dupQuery.is('slack_user_id', null);
      var dupRes = await dupQuery;
      if (dupRes.data && dupRes.data.length > 0) {
        logger.debug('[DB-MEMORIES] Skip duplicate content_hash', hash, 'for user', slackUserId || 'shared');
        return { id: dupRes.data[0].id, duplicate: true };
      }
    } catch(e) {
      // Column may not exist yet (migration pending) — fall through silently
      if (!/content_hash/i.test(String(e && e.message || ''))) {
        logger.debug('[DB-MEMORIES] dedup check skipped:', e.message);
      }
    }
  }

  // Semantic dedup — only for SHARED memories (team-wide knowledge). Stops
  // paraphrased duplicates like "X è nostro partner" vs "X è partner" from
  // piling up in the shared pool. Limited scope keeps embedding cost low.
  if (classification.shared && c.useSupabase && content.length > 30) {
    try {
      var emb = require('../embeddingService');
      if (emb.getProvider()) {
        var semDup = await emb.semanticSearchMemories(content, null, { threshold: 0.95, limit: 1 });
        if (semDup && semDup.length > 0) {
          logger.debug('[DB-MEMORIES] Skip semantic duplicate (similarity >0.95) for shared memory');
          return { id: semDup[0].id, duplicate: true, reason: 'semantic' };
        }
      }
    } catch(e) {
      // Embedding/RPC not available — fall through
    }
  }

  var entry = {
    id: 'mn' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
    content: content,
    tags: tags || [],
    created: new Date().toISOString(),
    memory_type: classification.type,
    expires_at: expiresAt,
    thread_ts: threadTs,
    content_hash: hash,
  };
  if (!_memCache) _memCache = {};
  if (!_memCache[userId]) _memCache[userId] = [];
  _memCache[userId].push(entry);

  if (!c.useSupabase) {
    c.writeJSON('memories.json', _memCache);
    return entry;
  }

  var entityRefs = [];
  var teamRefs = [];
  try {
    var entData = _getEntityCache();
    if (!entData) {
      var entRes = await c.getClient().from('kb_entities').select('canonical_name, aliases, entity_category').limit(500);
      entData = entRes.data || [];
      _setEntityCache(entData);
    }
    if (entData) {
      var contentLow = content.toLowerCase();
      entData.forEach(function(e) {
        var hit = false;
        if (e.canonical_name && e.canonical_name.length > 2 && contentLow.includes(e.canonical_name.toLowerCase())) hit = true;
        if (!hit && e.aliases && Array.isArray(e.aliases)) {
          hit = e.aliases.some(function(alias) {
            return alias && alias.length > 2 && contentLow.includes(alias.toLowerCase());
          });
        }
        if (!hit) return;
        entityRefs.push(e.canonical_name);
        if (e.entity_category === 'team') teamRefs.push(e.canonical_name);
      });
    }
  } catch(e) {
    logger.warn('[DB-MEMORIES] operazione fallita:', e.message);
  }

  // Also resolve against the authoritative team roster so that team members
  // get tagged with their Slack user_id (team:<@U...>) regardless of whether
  // kb_entities has a matching row — this is what stops "Peppe/Giusy/Claudia"
  // from being attributed to a client with the same short name.
  try {
    var teamMod = require('./team');
    var teamHits = teamMod.findTeamMembersInText(content);
    for (var thI = 0; thI < teamHits.length; thI++) {
      var tm = teamHits[thI];
      if (!tm || !tm.slack_user_id) continue;
      var idTag = 'team:' + tm.slack_user_id;
      if (tags.indexOf(idTag) === -1) tags.push(idTag);
      if (entityRefs.indexOf(tm.canonical_name) === -1) entityRefs.push(tm.canonical_name);
      if (teamRefs.indexOf(tm.canonical_name) === -1) teamRefs.push(tm.canonical_name);
    }
  } catch(_) {}

  // Deduplicate entityRefs (team + kb_entities can overlap on the same name)
  if (entityRefs.length > 1) {
    var seenRef = {};
    entityRefs = entityRefs.filter(function(n) { if (seenRef[n]) return false; seenRef[n] = true; return true; });
  }
  entry.tags = tags;

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
      thread_ts: threadTs,
      content_hash: hash,
    };
    if (embedding) insertData.embedding = embedding;
    try {
      await c.getClient().from('memories').insert(insertData);
    } catch(insertErr) {
      // Graceful fallback if thread_ts / content_hash columns are not yet applied
      var msg = String(insertErr && insertErr.message || '');
      if (/thread_ts|content_hash/i.test(msg)) {
        delete insertData.thread_ts;
        delete insertData.content_hash;
        await c.getClient().from('memories').insert(insertData);
      } else {
        throw insertErr;
      }
    }

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

      // 4. Entity refs search — find ALL memories linked to the same entity
      if (rpcResults.length < 8) {
        try {
          var entityRes2 = await c.getClient().from('memories')
            .select('id, content, memory_type, tags, created_at, confidence_score, entity_refs')
            .is('superseded_by', null)
            .contains('entity_refs', [query])
            .order('created_at', { ascending: false })
            .limit(5);
          if (entityRes2.data && entityRes2.data.length > 0) {
            rpcResults = rpcResults.concat(entityRes2.data);
          }
        } catch(e) { /* entity_refs search not available */ }
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

        // RECENCY SCORING — recent memories get massive priority
        var now = Date.now();
        deduped.forEach(function(m) {
          var created = m.created_at || m.created;
          var ageMs = created ? (now - new Date(created).getTime()) : 365 * 86400000;
          var ageDays = ageMs / 86400000;
          // Recency multiplier: last 7 days = 2x, last 30 days = 1.5x, last 90 days = 1x, older = 0.5x
          var recencyBoost = ageDays <= 7 ? 2.0 : (ageDays <= 30 ? 1.5 : (ageDays <= 90 ? 1.0 : 0.5));
          var baseScore = m.final_score || m.confidence_score || 0.5;
          m._sortScore = baseScore * recencyBoost;
        });

        // Sort by recency-weighted score (recent + high confidence first)
        deduped.sort(function(a, b) { return (b._sortScore || 0) - (a._sortScore || 0); });

        // Content dedup: if two memories share >60% of words, keep only the higher scored one
        var finalDeduped = [];
        var seenContent = [];
        for (var di = 0; di < deduped.length; di++) {
          var content = (deduped[di].content || '').toLowerCase();
          var words = content.split(/\s+/).filter(function(w) { return w.length > 3; });
          var isDuplicate = false;
          for (var si = 0; si < seenContent.length; si++) {
            var overlap = words.filter(function(w) { return seenContent[si].indexOf(w) !== -1; });
            if (words.length > 0 && overlap.length / words.length > 0.6) { isDuplicate = true; break; }
          }
          if (!isDuplicate) {
            finalDeduped.push(deduped[di]);
            seenContent.push(words);
          }
        }
        deduped = finalDeduped;

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
  contentHash: contentHash,
};
