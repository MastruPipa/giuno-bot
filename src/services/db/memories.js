// ─── Memories ────────────────────────────────────────────────────────────────
'use strict';

var c = require('./client');
var search = require('./search');

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
    var entRes = await c.getClient().from('kb_entities').select('canonical_name').limit(100);
    if (entRes.data) {
      var contentLow = content.toLowerCase();
      entityRefs = entRes.data.filter(function(e) {
        return e.canonical_name.length > 3 && contentLow.includes(e.canonical_name.toLowerCase());
      }).map(function(e) { return e.canonical_name; });
    }
  } catch(e) {}

  try {
    await c.getClient().from('memories').insert({
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
    });

    if (entityRefs.length > 0) {
      var graphRows = entityRefs.map(function(name) {
        return { from_type: 'memory', from_id: entry.id, relationship: 'mentions', to_type: 'entity', to_id: name, weight: 0.8, created_by: 'auto' };
      });
      c.getClient().from('memory_graph').insert(graphRows).catch(function() {});
    }

    process.stdout.write('[storeMemory] ' + classification.type + ' | shared:' + classification.shared + ' | entities:' + (entityRefs.join(',') || 'none') + '\n');
  } catch(e) { c.logErr('addMemory', e); }
  return entry;
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

function searchMemories(userId, query) {
  var temporal = detectTemporalRef(query);
  var now = Date.now();

  if (c.useSupabase && !temporal) {
    c.getClient().rpc('recall_by_entity', { p_entity_name: query || '', p_limit: 5 })
      .then(function(res) {
        if (res.data && res.data.length > 0) {
          var ids = res.data.map(function(m) { return m.id; }).filter(Boolean);
          c.getClient().rpc('increment_memory_usage', { memory_ids: ids }).catch(function() {});
        }
      }).catch(function() {});
    c.getClient().rpc('recall_memories_weighted', { p_query: query || '', p_user_id: userId || null, p_limit: 10, p_include_expired: false })
      .then(function(res) {
        if (res.data && res.data.length > 0) {
          var ids = res.data.map(function(m) { return m.id; }).filter(Boolean);
          c.getClient().rpc('increment_memory_usage', { memory_ids: ids }).catch(function() {});
        }
      }).catch(function(e) { process.stdout.write('[MEM-RPC] ' + e.message + '\n'); });
  }

  if (!_memCache || !_memCache[userId]) return [];

  if (temporal) {
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

  var tokens = search.expandQueryTokens(query);
  var scored = _memCache[userId].map(function(m) {
    return { memory: m, score: search.scoreMemory(m, tokens, now) };
  }).filter(function(item) {
    return item.score > 0 && !search.isBlacklisted(item.memory.content || '');
  });
  scored.sort(function(a, b) { return b.score - a.score; });
  return scored.slice(0, 20).map(function(item) { return item.memory; });
}

function getMemCache() { return _memCache || {}; }

module.exports = {
  loadMemories: loadMemories,
  addMemory: addMemory,
  deleteMemory: deleteMemory,
  searchMemories: searchMemories,
  getMemCache: getMemCache,
};
