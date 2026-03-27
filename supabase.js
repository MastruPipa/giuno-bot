// ─── Supabase persistence layer ────────────────────────────────────────────
// Se SUPABASE_URL e SUPABASE_KEY sono presenti, usa Supabase.
// Altrimenti fallback su file JSON locali (per sviluppo locale).
// ────────────────────────────────────────────────────────────────────────────

var fs = require('fs');
var createClient = null;
try { createClient = require('@supabase/supabase-js').createClient; } catch(e) {}

var supabase = null;
var useSupabase = false;

if (createClient && process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  useSupabase = true;
}

// ─── Helper per file JSON (fallback) ──────────────────────────────────────

function readJSON(file, defaultVal) {
  try { return JSON.parse(fs.readFileSync(file)); } catch(e) { return defaultVal; }
}

function writeJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch(e) {}
}

// ─── Logger minimale ──────────────────────────────────────────────────────

function logErr(ctx, e) {
  process.stdout.write('[' + new Date().toISOString() + '] [ERROR] [Supabase/' + ctx + '] ' + (e.message || e) + '\n');
}

// ============================================================================
// USER TOKENS
// ============================================================================

var _tokenCache = null;

async function loadTokens() {
  if (!useSupabase) {
    _tokenCache = readJSON('user_tokens.json', {});
    return _tokenCache;
  }
  try {
    var res = await supabase.from('user_tokens').select('slack_user_id, refresh_token');
    var tokens = {};
    if (res.data) res.data.forEach(function(r) { tokens[r.slack_user_id] = r.refresh_token; });
    _tokenCache = tokens;
    return tokens;
  } catch(e) { logErr('loadTokens', e); _tokenCache = {}; return {}; }
}

async function saveToken(slackUserId, refreshToken) {
  if (_tokenCache) _tokenCache[slackUserId] = refreshToken;
  if (!useSupabase) {
    var tokens = _tokenCache || readJSON('user_tokens.json', {});
    tokens[slackUserId] = refreshToken;
    writeJSON('user_tokens.json', tokens);
    return;
  }
  try {
    await supabase.from('user_tokens').upsert({
      slack_user_id: slackUserId,
      refresh_token: refreshToken,
      updated_at: new Date().toISOString(),
    });
  } catch(e) { logErr('saveToken', e); }
}

async function removeToken(slackUserId) {
  if (_tokenCache) delete _tokenCache[slackUserId];
  if (!useSupabase) {
    var tokens = _tokenCache || readJSON('user_tokens.json', {});
    delete tokens[slackUserId];
    writeJSON('user_tokens.json', tokens);
    return;
  }
  try {
    await supabase.from('user_tokens').delete().eq('slack_user_id', slackUserId);
  } catch(e) { logErr('removeToken', e); }
}

function getTokenCache() { return _tokenCache || {}; }

// ============================================================================
// USER PREFS
// ============================================================================

var _prefsCache = null;

async function loadPrefs() {
  if (!useSupabase) {
    _prefsCache = readJSON('user_prefs.json', {});
    return _prefsCache;
  }
  try {
    var res = await supabase.from('user_prefs').select('*');
    var prefs = {};
    if (res.data) res.data.forEach(function(r) {
      prefs[r.slack_user_id] = {
        routine_enabled: r.routine_enabled,
        notifiche_enabled: r.notifiche_enabled,
        standup_enabled: r.standup_enabled,
      };
    });
    _prefsCache = prefs;
    return prefs;
  } catch(e) { logErr('loadPrefs', e); _prefsCache = {}; return {}; }
}

async function savePrefs(userId, prefs) {
  if (!_prefsCache) _prefsCache = {};
  _prefsCache[userId] = prefs;
  if (!useSupabase) {
    writeJSON('user_prefs.json', _prefsCache);
    return;
  }
  try {
    await supabase.from('user_prefs').upsert({
      slack_user_id: userId,
      routine_enabled: prefs.routine_enabled,
      notifiche_enabled: prefs.notifiche_enabled,
      standup_enabled: prefs.standup_enabled,
      updated_at: new Date().toISOString(),
    });
  } catch(e) { logErr('savePrefs', e); }
}

function getPrefsCache() { return _prefsCache || {}; }

// ============================================================================
// CONVERSATIONS
// ============================================================================

var _convCache = null;

async function loadConversations() {
  if (!useSupabase) {
    _convCache = readJSON('conversations.json', {});
    return _convCache;
  }
  try {
    var res = await supabase.from('conversations').select('conv_key, messages');
    var convs = {};
    if (res.data) res.data.forEach(function(r) { convs[r.conv_key] = r.messages; });
    _convCache = convs;
    return convs;
  } catch(e) { logErr('loadConversations', e); _convCache = {}; return {}; }
}

async function saveConversation(convKey, messages) {
  if (!_convCache) _convCache = {};
  _convCache[convKey] = messages;
  if (!useSupabase) {
    writeJSON('conversations.json', _convCache);
    return;
  }
  try {
    await supabase.from('conversations').upsert({
      conv_key: convKey,
      messages: messages,
      updated_at: new Date().toISOString(),
    });
  } catch(e) { logErr('saveConversation', e); }
}

function getConvCache() { return _convCache || {}; }

// ============================================================================
// MEMORIES
// ============================================================================

var _memCache = null;

async function loadMemories() {
  if (!useSupabase) {
    _memCache = readJSON('memories.json', {});
    return _memCache;
  }
  try {
    var res = await supabase.from('memories').select('*').order('created_at', { ascending: true });
    var mems = {};
    if (res.data) res.data.forEach(function(r) {
      if (!mems[r.slack_user_id]) mems[r.slack_user_id] = [];
      mems[r.slack_user_id].push({
        id: r.id,
        content: r.content,
        tags: r.tags || [],
        created: r.created_at,
      });
    });
    _memCache = mems;
    return mems;
  } catch(e) { logErr('loadMemories', e); _memCache = {}; return {}; }
}

// ─── Memory type classification ──────────────────────────────────────────────

function classifyMemoryType(content) {
  var c = (content || '').toLowerCase();
  if (/ho proposto|avevo detto di|da inviare a|da mandare a|reminder per|da aggiornare|todo:|action:|da fare/.test(c)) {
    return { type: 'intent', expiresIn: 24 * 60 * 60 * 1000 };
  }
  if (/per i preventivi|il processo è|il workflow|il template|la procedura|si usa|bisogna sempre|regola:/.test(c)) {
    return { type: 'procedural', expiresIn: null };
  }
  if (/preferisce|gli piace|non gli piace|vuole sempre|stile di|tono preferito|preferenza/.test(c)) {
    return { type: 'preference', expiresIn: null };
  }
  if (/è un[ao]?\s|si occupa di|ha sede|contatto:|email:|telefono:|è il cliente|è il fornitore|ruolo:|fondat/.test(c)) {
    return { type: 'semantic', expiresIn: null };
  }
  return { type: 'episodic', expiresIn: 30 * 24 * 60 * 60 * 1000 };
}

async function addMemory(userId, content, tags, options) {
  options = options || {};
  var classification = options.memory_type
    ? { type: options.memory_type, expiresIn: options.expiresIn || null }
    : classifyMemoryType(content);

  var expiresAt = null;
  if (classification.expiresIn) {
    expiresAt = new Date(Date.now() + classification.expiresIn).toISOString();
  }

  var entry = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
    content: content,
    tags: tags || [],
    created: new Date().toISOString(),
    memory_type: classification.type,
    expires_at: expiresAt,
  };
  if (!_memCache) _memCache = {};
  if (!_memCache[userId]) _memCache[userId] = [];
  _memCache[userId].push(entry);

  if (!useSupabase) {
    writeJSON('memories.json', _memCache);
    return entry;
  }
  try {
    await supabase.from('memories').insert({
      id: entry.id,
      slack_user_id: userId,
      content: content,
      tags: tags || [],
      created_at: entry.created,
      memory_type: classification.type,
      confidence_score: options.confidence_score || 0.5,
      source_channel_type: options.channelType || 'conversation',
      source_channel_id: options.channelId || null,
      entity_refs: options.entity_refs || [],
      expires_at: expiresAt,
    });
  } catch(e) { logErr('addMemory', e); }
  return entry;
}

async function deleteMemory(userId, memoryId) {
  if (_memCache && _memCache[userId]) {
    var before = _memCache[userId].length;
    _memCache[userId] = _memCache[userId].filter(function(m) { return m.id !== memoryId; });
    if (_memCache[userId].length >= before) return false;
  }
  if (!useSupabase) {
    writeJSON('memories.json', _memCache);
    return true;
  }
  try {
    await supabase.from('memories').delete().eq('id', memoryId);
  } catch(e) { logErr('deleteMemory', e); }
  return true;
}

// ─── Fuzzy search helpers ─────────────────────────────────────────────────────

var SINONIMI = {
  'foto': ['fotografico', 'fotografia', 'shooting', 'servizio fotografico', 'photo'],
  'fotografico': ['foto', 'fotografia', 'shooting', 'photo'],
  'sito': ['website', 'web', 'sito web', 'portale', 'landing'],
  'website': ['sito', 'web', 'sito web', 'portale', 'landing'],
  'web': ['sito', 'website', 'sito web', 'portale'],
  'branding': ['brand', 'marchio', 'identità visiva', 'logo', 'rebrand', 'rebranding'],
  'brand': ['branding', 'marchio', 'identità visiva', 'logo', 'rebrand'],
  'logo': ['branding', 'brand', 'marchio', 'logotipo'],
  'social': ['social media', 'instagram', 'facebook', 'tiktok', 'linkedin'],
  'marketing': ['promozione', 'campagna', 'adv', 'advertising', 'ads'],
  'campagna': ['marketing', 'promozione', 'adv', 'advertising'],
  'video': ['filmato', 'clip', 'reel', 'montaggio', 'riprese'],
  'design': ['grafica', 'progettazione', 'layout', 'mockup', 'ui', 'ux'],
  'grafica': ['design', 'progettazione', 'layout', 'visual'],
  'progetto': ['progettazione', 'lavoro', 'commessa', 'incarico'],
  'cliente': ['client', 'committente', 'azienda'],
  'preventivo': ['quotazione', 'offerta', 'stima', 'quote', 'budget'],
  'contratto': ['accordo', 'agreement', 'incarico'],
  'fattura': ['invoice', 'pagamento', 'fatturazione'],
  'meeting': ['riunione', 'call', 'incontro', 'appuntamento'],
  'riunione': ['meeting', 'call', 'incontro', 'appuntamento'],
  'task': ['compito', 'attività', 'todo', 'da fare', 'azione'],
  'deadline': ['scadenza', 'consegna', 'termine'],
  'scadenza': ['deadline', 'consegna', 'termine'],
};

function expandQueryTokens(query) {
  if (!query || typeof query !== 'string') return [];
  var tokens = query.toLowerCase().split(/\s+/).filter(function(t) { return t.length > 2; });
  var seen = {};
  var expanded = [];
  tokens.forEach(function(t) { if (!seen[t]) { seen[t] = true; expanded.push(t); } });
  tokens.forEach(function(token) {
    if (SINONIMI[token]) {
      SINONIMI[token].forEach(function(syn) {
        if (!seen[syn]) { seen[syn] = true; expanded.push(syn); }
      });
    }
  });
  // Limit expansion to avoid slow scoring
  return expanded.slice(0, 15);
}

function scoreMemory(memory, tokens, now) {
  var contentLow = (memory.content || '').toLowerCase();
  var tagsLow = (memory.tags || []).map(function(t) { return t.toLowerCase(); });

  // fonte:ufficiale always gets max score
  var isOfficial = tagsLow.some(function(t) { return t === 'fonte:ufficiale'; });

  // Base score: keyword matching
  var baseScore = 0;
  tokens.forEach(function(token) {
    if (contentLow.includes(token)) baseScore += 3;
    tagsLow.forEach(function(t) {
      if (t.includes(token)) baseScore += 2;
    });
  });

  // Bonus for multi-token match (phrase relevance)
  var fullQuery = tokens.slice(0, 3).join(' ');
  if (fullQuery.length > 5 && contentLow.includes(fullQuery)) baseScore += 5;

  if (baseScore === 0) return 0;

  // fonte:ufficiale — always top priority
  if (isOfficial) return baseScore + 100;

  // Memory type weight
  var TYPE_WEIGHT = { 'semantic': 1.0, 'procedural': 1.0, 'preference': 0.95, 'intent': 0.9, 'episodic': 0.7, 'observation': 0.6 };
  var typeWeight = TYPE_WEIGHT[memory.memory_type] || 0.7;

  // Temporal score: 1.0 for brand new, decays to 0.3 over 180 days
  // Semantic/procedural/preference don't decay
  var temporalScore = 1.0;
  if (memory.created && now && (memory.memory_type === 'episodic' || memory.memory_type === 'observation' || memory.memory_type === 'intent')) {
    var ageDays = (now - new Date(memory.created).getTime()) / (1000 * 60 * 60 * 24);
    temporalScore = Math.max(0.3, 1 - (ageDays / 180) * 0.7);
  }

  // Skip expired memories
  if (memory.expires_at && new Date(memory.expires_at).getTime() < now) return 0;

  // Weighted final score: 50% relevance + 25% type + 25% recency
  return (baseScore * 0.5) + (baseScore * typeWeight * 0.25) + (baseScore * temporalScore * 0.25);
}

// Filter out stale/wrong info
var BLACKLIST_PATTERNS = [
  // Tech limitations (stale)
  'slack_user_token', 'search:read', 'limitazioni tecniche',
  'problema tecnico con slack', 'token non ha', 'permessi.*slack',
  'non riesco ad accedere ai canali', 'configurare.*permessi',
  'serve che.*configur', 'accesso.*canali.*limitat',
];
var _blacklistRegex = new RegExp(BLACKLIST_PATTERNS.join('|'), 'i');

// Financial data blacklist — these should come from CRM Sheet, not memory
var _financialBlacklist = /€\s*\d{1,3}([.,]\d{3})*|contratt[oi]\s+attiv|pipeline\s+totale|subtotale|totale\s+confermati|fatturato\s+\d{4}|revenue|ricavi\s+\d/i;

function isBlacklisted(content) {
  return _blacklistRegex.test(content) || _financialBlacklist.test(content);
}

// ─── Temporal reference detection ─────────────────────────────────────────────

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
    if (config.hoursAgo && config.hoursAgo <= 12) {
      oldest = midnight.getTime();
    } else {
      oldest = midnight.getTime();
    }
  } else if (config.daysAgo) {
    oldest = now.getTime() - config.daysAgo * 86400000;
  } else if (config.hoursAgo) {
    oldest = now.getTime() - config.hoursAgo * 3600000;
  } else {
    oldest = now.getTime() - 86400000;
  }

  var newest = now.getTime();
  if (config.maxDays) {
    newest = now.getTime() - config.maxDays * 86400000;
  }

  return { oldest: oldest, newest: newest };
}

function searchMemories(userId, query) {
  var temporal = detectTemporalRef(query);

  // TEMPORAL SEARCH — filter from Supabase directly
  if (temporal && useSupabase) {
    var range = getTimeRange(temporal.config);
    var oldest = new Date(range.oldest).toISOString();
    var newest = new Date(range.newest).toISOString();
    // Async but we need sync return for backwards compat — use cache
  }

  // Try Supabase RPC if available (async via Promise, return cache as sync fallback)
  if (useSupabase && !temporal) {
    // Fire async RPC for weighted recall (results come async, but we return cache sync for now)
    supabase.rpc('recall_memories_weighted', {
      p_query: query || '',
      p_user_id: userId || null,
      p_limit: 10,
      p_include_expired: false,
    }).then(function(res) {
      if (res.data && res.data.length > 0) {
        var ids = res.data.map(function(m) { return m.id; }).filter(Boolean);
        supabase.rpc('increment_memory_usage', { memory_ids: ids }).catch(function() {});
      }
    }).catch(function(e) {
      process.stdout.write('[MEM-RPC] recall_memories_weighted failed: ' + e.message + '\n');
    });
  }

  // SYNC FALLBACK: use in-memory cache (always works)
  if (!_memCache || !_memCache[userId]) return [];
  var now = Date.now();

  if (temporal) {
    var range = getTimeRange(temporal.config);
    var temporalResults = _memCache[userId].filter(function(m) {
      if (isBlacklisted(m.content || '')) return false;
      if (!m.created) return false;
      if (m.expires_at && new Date(m.expires_at).getTime() < now) return false;
      var ts = new Date(m.created).getTime();
      return ts >= range.oldest && ts <= range.newest;
    });

    var extraKeywords = (query || '').toLowerCase()
      .replace(/stamattina|stamani|questa mattina|oggi|ieri|questa settimana|settimana scorsa|poco fa|recentemente|ultimo ora|ultime ore/g, '')
      .trim();

    if (extraKeywords.length > 3) {
      var extraTokens = expandQueryTokens(extraKeywords);
      if (extraTokens.length > 0) {
        temporalResults = temporalResults.filter(function(m) {
          var contentLow = (m.content || '').toLowerCase();
          return extraTokens.some(function(t) { return contentLow.includes(t); });
        });
      }
    }

    temporalResults.sort(function(a, b) {
      return new Date(b.created).getTime() - new Date(a.created).getTime();
    });

    return temporalResults.slice(0, 20);
  }

  // KEYWORD SEARCH with type-based ranking
  var tokens = expandQueryTokens(query);
  var scored = _memCache[userId].map(function(m) {
    return { memory: m, score: scoreMemory(m, tokens, now) };
  }).filter(function(item) {
    return item.score > 0 && !isBlacklisted(item.memory.content || '');
  });

  scored.sort(function(a, b) { return b.score - a.score; });
  return scored.map(function(item) { return item.memory; });
}

function getMemCache() { return _memCache || {}; }

async function saveConversationSummary(convKey, summary, messagesCount, topics, proposedActions) {
  if (!useSupabase) return;
  try {
    await supabase.from('conversation_summaries').upsert({
      conv_key: convKey,
      summary: summary,
      messages_count: messagesCount || 0,
      topics: topics || [],
      proposed_actions: proposedActions || [],
      updated_at: new Date().toISOString(),
    }, { onConflict: 'conv_key' });
  } catch(e) { logErr('saveConversationSummary', e); }
}

// ─── Entity resolution ──────────────────────────────────────────────────────

async function resolveEntity(name) {
  if (!useSupabase || !name) return null;
  try {
    var res = await supabase.rpc('resolve_entity', { p_name: name });
    if (res.data && res.data.length > 0) return res.data[0];
    return null;
  } catch(e) { logErr('resolveEntity', e); return null; }
}

async function getConversationSummary(convKey) {
  if (!useSupabase) return null;
  try {
    var res = await supabase.from('conversation_summaries').select('*').eq('conv_key', convKey).single();
    return res.data || null;
  } catch(e) { return null; }
}

// ============================================================================
// USER PROFILES
// ============================================================================

var _profileCache = null;

async function loadProfiles() {
  if (!useSupabase) {
    _profileCache = readJSON('user_profiles.json', {});
    return _profileCache;
  }
  try {
    var res = await supabase.from('user_profiles').select('*');
    var profiles = {};
    if (res.data) res.data.forEach(function(r) {
      profiles[r.slack_user_id] = {
        ruolo: r.ruolo,
        progetti: r.progetti || [],
        clienti: r.clienti || [],
        competenze: r.competenze || [],
        stile_comunicativo: r.stile_comunicativo,
        note: r.note || [],
        ultimo_aggiornamento: r.ultimo_aggiornamento,
      };
    });
    _profileCache = profiles;
    return profiles;
  } catch(e) { logErr('loadProfiles', e); _profileCache = {}; return {}; }
}

async function saveProfile(userId, profile) {
  if (!_profileCache) _profileCache = {};
  _profileCache[userId] = profile;
  if (!useSupabase) {
    writeJSON('user_profiles.json', _profileCache);
    return;
  }
  try {
    await supabase.from('user_profiles').upsert({
      slack_user_id: userId,
      ruolo: profile.ruolo,
      progetti: profile.progetti || [],
      clienti: profile.clienti || [],
      competenze: profile.competenze || [],
      stile_comunicativo: profile.stile_comunicativo,
      note: profile.note || [],
      ultimo_aggiornamento: profile.ultimo_aggiornamento,
      updated_at: new Date().toISOString(),
    });
  } catch(e) { logErr('saveProfile', e); }
}

function getProfileCache() { return _profileCache || {}; }

// ============================================================================
// KNOWLEDGE BASE
// ============================================================================

var _kbCache = null;

async function loadKB() {
  if (!useSupabase) {
    _kbCache = readJSON('knowledge_base.json', []);
    return _kbCache;
  }
  try {
    var res = await supabase.from('knowledge_base').select('*').order('created_at', { ascending: true });
    _kbCache = (res.data || []).map(function(r) {
      return { id: r.id, content: r.content, tags: r.tags || [], added_by: r.added_by, created: r.created_at };
    });
    return _kbCache;
  } catch(e) { logErr('loadKB', e); _kbCache = []; return []; }
}

var STOPWORDS_IT = ['che', 'per', 'con', 'del', 'della', 'delle', 'dei', 'degli', 'nel', 'nella', 'nelle', 'nei', 'negli', 'una', 'uno', 'sono', 'alla', 'alle', 'allo', 'agli', 'dal', 'dalla', 'dai', 'dagli', 'sul', 'sulla', 'sui', 'sugli', 'tra', 'fra', 'non', 'come', 'anche', 'questo', 'questa', 'questi', 'queste', 'quello', 'quella', 'quelli', 'quelle', 'stato', 'stata', 'stati', 'state', 'essere', 'avere', 'fare', 'dire', 'dove', 'quando', 'cosa', 'ogni', 'tutto', 'tutti', 'dopo', 'prima', 'solo', 'ancora', 'molto', 'più'];

var _stopwordsSet = null;
function getStopwordsSet() {
  if (!_stopwordsSet) {
    _stopwordsSet = {};
    STOPWORDS_IT.forEach(function(w) { _stopwordsSet[w] = true; });
  }
  return _stopwordsSet;
}

function extractKeywords(text) {
  var sw = getStopwordsSet();
  return (text || '').toLowerCase().split(/\W+/).filter(function(w) {
    return w.length > 5 && !sw[w];
  });
}

function getTagValue(tags, prefix) {
  for (var i = 0; i < tags.length; i++) {
    if (tags[i] && tags[i].toLowerCase().startsWith(prefix)) return tags[i].toLowerCase();
  }
  return null;
}

// Fast dedup: check only last 200 KB entries (most recent) instead of full scan
function isDuplicate(newContent, newTags) {
  if (!_kbCache || _kbCache.length === 0) return false;
  if (!newContent || typeof newContent !== 'string') return false;
  if ((newTags || []).some(function(t) { return t === 'fonte:ufficiale'; })) return false;

  var newKeywords = extractKeywords(newContent);
  if (newKeywords.length < 3) return false;

  var newKeywordSet = {};
  newKeywords.forEach(function(kw) { newKeywordSet[kw] = true; });

  var newClient = getTagValue(newTags || [], 'cliente:');
  var newProject = getTagValue(newTags || [], 'progetto:');
  var newTipo = getTagValue(newTags || [], 'tipo:');

  // Only scan last 200 entries (most recent = most likely duplicates)
  var startIdx = Math.max(0, _kbCache.length - 200);
  for (var i = startIdx; i < _kbCache.length; i++) {
    var existing = _kbCache[i];
    if ((existing.tags || []).some(function(t) { return t === 'fonte:ufficiale'; })) continue;

    var existingKeywords = extractKeywords(existing.content);
    var matchCount = 0;
    for (var k = 0; k < existingKeywords.length && matchCount < 3; k++) {
      if (newKeywordSet[existingKeywords[k]]) matchCount++;
    }

    if (matchCount >= 3) {
      var existingClient = getTagValue(existing.tags || [], 'cliente:');
      var existingProject = getTagValue(existing.tags || [], 'progetto:');
      var existingTipo = getTagValue(existing.tags || [], 'tipo:');

      if ((newClient && newClient === existingClient) ||
        (newProject && newProject === existingProject) ||
        (newTipo && newTipo === existingTipo)) return true;
    }
  }
  return false;
}

var TIER_DEFAULTS = {
  official:       { score: 1.0,  expiryDays: null, validation: 'approved' },
  drive_indexed:  { score: 0.8,  expiryDays: null, validation: 'approved' },
  slack_public:   { score: 0.5,  expiryDays: 90,   validation: 'pending' },
  slack_private:  { score: 0.4,  expiryDays: 60,   validation: 'pending' },
  auto_learn:     { score: 0.25, expiryDays: 30,   validation: 'pending' },
};

async function addKBEntry(content, tags, addedBy, options) {
  options = options || {};

  // DM → NEVER in KB
  if (options.sourceChannelType === 'dm') return null;

  // Dedup check (skip for official)
  if (options.confidenceTier !== 'official' && isDuplicate(content, tags)) return null;

  var tier = options.confidenceTier || 'auto_learn';
  var tierDef = TIER_DEFAULTS[tier] || TIER_DEFAULTS.auto_learn;

  var now = new Date();
  var expiryDays = options.expiresInDays != null ? options.expiresInDays : tierDef.expiryDays;
  var expiresAt = expiryDays ? new Date(now.getTime() + expiryDays * 24 * 60 * 60 * 1000).toISOString() : null;

  var entry = {
    id: Date.now().toString(36),
    content: content,
    tags: tags || [],
    added_by: addedBy,
    created: now.toISOString(),
    confidence_score: tierDef.score,
    confidence_tier: tier,
    source_type: options.sourceType || 'auto_learn',
    source_channel_id: options.sourceChannelId || null,
    source_channel_type: options.sourceChannelType || 'conversation',
    validation_status: tierDef.validation,
    expires_at: expiresAt,
    usage_count: 0,
  };

  if (!_kbCache) _kbCache = [];
  _kbCache.push(entry);

  if (!useSupabase) {
    writeJSON('knowledge_base.json', _kbCache);
    return entry;
  }
  try {
    await supabase.from('knowledge_base').insert({
      id: entry.id,
      content: content,
      tags: tags || [],
      added_by: addedBy,
      created_at: entry.created,
      confidence_score: entry.confidence_score,
      confidence_tier: entry.confidence_tier,
      source_type: entry.source_type,
      source_channel_id: entry.source_channel_id,
      source_channel_type: entry.source_channel_type,
      validation_status: entry.validation_status,
      expires_at: entry.expires_at,
      usage_count: 0,
    });
  } catch(e) { logErr('addKBEntry', e); }
  return entry;
}

async function deleteKBEntry(entryId) {
  if (_kbCache) {
    var before = _kbCache.length;
    _kbCache = _kbCache.filter(function(e) { return e.id !== entryId; });
    if (_kbCache.length >= before) return false;
  }
  if (!useSupabase) {
    writeJSON('knowledge_base.json', _kbCache);
    return true;
  }
  try {
    await supabase.from('knowledge_base').delete().eq('id', entryId);
  } catch(e) { logErr('deleteKBEntry', e); }
  return true;
}

function searchKB(query, options) {
  if (!_kbCache) return [];
  options = options || {};
  var minConfidence = options.minConfidence || 0.0;
  var includeExpired = options.includeExpired || false;
  var includePending = options.includePending !== false; // default true for backwards compat
  var limit = options.limit || 20;
  var now = Date.now();
  var nowISO = new Date().toISOString();
  var tokens = expandQueryTokens(query);

  var scored = [];
  for (var i = 0; i < _kbCache.length; i++) {
    var entry = _kbCache[i];

    // Filter rejected
    if (entry.validation_status === 'rejected') continue;
    // Filter pending if not included
    if (!includePending && entry.validation_status === 'pending') continue;
    // Filter expired
    if (!includeExpired && entry.expires_at && entry.expires_at < nowISO) continue;
    // Filter below min confidence
    if (entry.confidence_score && entry.confidence_score < minConfidence) continue;
    // Blacklist
    if (isBlacklisted(entry.content)) continue;

    var keywordScore = scoreMemory(entry, tokens, now);
    if (keywordScore <= 0) continue;

    // Quality-weighted final score
    var confidenceScore = entry.confidence_score || 0.25;
    var recencyScore = 1.0;
    if (entry.created) {
      var ageDays = (now - new Date(entry.created).getTime()) / (1000 * 60 * 60 * 24);
      recencyScore = Math.max(0.3, 1 - (ageDays / 180) * 0.7);
    }

    // Normalize keywordScore to 0-1 range (cap at 20)
    var normalizedKeyword = Math.min(keywordScore / 20, 1.0);

    var finalScore = (normalizedKeyword * 0.5) + (confidenceScore * 0.35) + (recencyScore * 0.15);

    scored.push({ entry: entry, score: finalScore });
  }

  scored.sort(function(a, b) { return b.score - a.score; });

  // Track usage on returned results
  var results = scored.slice(0, limit).map(function(item) { return item.entry; });
  for (var r = 0; r < results.length; r++) {
    results[r].usage_count = (results[r].usage_count || 0) + 1;
    results[r].last_used_at = nowISO;
  }

  // Track usage on Supabase (fire-and-forget)
  if (useSupabase && results.length > 0) {
    var kbIds = results.slice(0, 10).map(function(e) { return e.id; }).filter(Boolean);
    if (kbIds.length > 0) {
      supabase.rpc('increment_kb_usage', { kb_ids: kbIds })
        .then(function() {})
        .catch(function(e) { process.stdout.write('[KB-USAGE] rpc failed: ' + e.message + '\n'); });
    }
  }

  return results;
}

function getKBCache() { return _kbCache || []; }

// ============================================================================
// STANDUP DATA
// ============================================================================

var _standupCache = null;

async function loadStandup() {
  if (!useSupabase) {
    _standupCache = readJSON('standup_data.json', { oggi: null, risposte: {} });
    return _standupCache;
  }
  try {
    var res = await supabase.from('standup_data').select('*').eq('id', 'current').single();
    if (res.data) {
      _standupCache = { oggi: res.data.oggi, risposte: res.data.risposte || {} };
    } else {
      _standupCache = { oggi: null, risposte: {} };
    }
    return _standupCache;
  } catch(e) { logErr('loadStandup', e); _standupCache = { oggi: null, risposte: {} }; return _standupCache; }
}

async function saveStandup(data) {
  _standupCache = data;
  if (!useSupabase) {
    writeJSON('standup_data.json', data);
    return;
  }
  try {
    await supabase.from('standup_data').upsert({
      id: 'current',
      oggi: data.oggi,
      risposte: data.risposte,
      updated_at: new Date().toISOString(),
    });
  } catch(e) { logErr('saveStandup', e); }
}

function getStandupCache() { return _standupCache || { oggi: null, risposte: {} }; }

// ============================================================================
// DRIVE INDEX
// ============================================================================

var _driveCache = null;

async function loadDriveIndex() {
  if (!useSupabase) {
    _driveCache = readJSON('drive_index.json', {});
    return _driveCache;
  }
  try {
    var res = await supabase.from('drive_index').select('*');
    var idx = {};
    if (res.data) res.data.forEach(function(r) {
      if (!idx[r.slack_user_id]) idx[r.slack_user_id] = {};
      idx[r.slack_user_id][r.file_id] = {
        name: r.name,
        type: r.type,
        link: r.link,
        modified: r.modified,
        owner: r.owner,
        description: r.description,
        indexed: r.indexed_at,
      };
    });
    _driveCache = idx;
    return idx;
  } catch(e) { logErr('loadDriveIndex', e); _driveCache = {}; return {}; }
}

async function saveDriveFiles(slackUserId, files) {
  if (!_driveCache) _driveCache = {};
  if (!_driveCache[slackUserId]) _driveCache[slackUserId] = {};

  var rows = [];
  files.forEach(function(f) {
    var entry = {
      name: f.name,
      type: f.mimeType,
      link: f.webViewLink,
      modified: f.modifiedTime,
      owner: (f.owners && f.owners[0]) ? f.owners[0].emailAddress : null,
      description: f.description || null,
      indexed: new Date().toISOString(),
    };
    _driveCache[slackUserId][f.id] = entry;
    rows.push({
      slack_user_id: slackUserId,
      file_id: f.id,
      name: entry.name,
      type: entry.type,
      link: entry.link,
      modified: entry.modified,
      owner: entry.owner,
      description: entry.description,
      indexed_at: entry.indexed,
    });
  });

  if (!useSupabase) {
    writeJSON('drive_index.json', _driveCache);
    return;
  }
  try {
    await supabase.from('drive_index').upsert(rows);
  } catch(e) { logErr('saveDriveFiles', e); }
}

function getDriveCache() { return _driveCache || {}; }

// ============================================================================
// FEEDBACK
// ============================================================================

async function saveFeedback(ts, userId, feedback, text) {
  if (!useSupabase) {
    var log = readJSON('feedback.json', []);
    log.push({ ts: ts, user: userId, feedback: feedback, text: text, date: new Date().toISOString() });
    writeJSON('feedback.json', log);
    return;
  }
  try {
    await supabase.from('feedback').insert({
      ts: ts,
      slack_user_id: userId,
      feedback: feedback,
      message_text: text,
    });
  } catch(e) { logErr('saveFeedback', e); }
}

// ============================================================================
// CHANNEL MAP (canale → progetto/cliente)
// ============================================================================

var _channelMapCache = null;

async function loadChannelMap() {
  if (!useSupabase) {
    _channelMapCache = readJSON('channel_map.json', {});
    return _channelMapCache;
  }
  try {
    var res = await supabase.from('channel_map').select('*');
    var map = {};
    if (res.data) res.data.forEach(function(r) {
      map[r.channel_id] = {
        channel_name: r.channel_name,
        cliente: r.cliente,
        progetto: r.progetto,
        tags: r.tags || [],
        note: r.note,
        updated_at: r.updated_at,
      };
    });
    _channelMapCache = map;
    return map;
  } catch(e) { logErr('loadChannelMap', e); _channelMapCache = {}; return {}; }
}

async function saveChannelMapping(channelId, data) {
  if (!_channelMapCache) _channelMapCache = {};
  _channelMapCache[channelId] = data;
  if (!useSupabase) {
    writeJSON('channel_map.json', _channelMapCache);
    return;
  }
  try {
    await supabase.from('channel_map').upsert({
      channel_id: channelId,
      channel_name: data.channel_name,
      cliente: data.cliente,
      progetto: data.progetto,
      tags: data.tags || [],
      note: data.note || null,
      updated_at: new Date().toISOString(),
    });
  } catch(e) { logErr('saveChannelMapping', e); }
}

function getChannelMapCache() { return _channelMapCache || {}; }

// ============================================================================
// CHANNEL DIGEST (riassunti periodici dei canali)
// ============================================================================

var _channelDigestCache = null;

async function loadChannelDigests() {
  if (!useSupabase) {
    _channelDigestCache = readJSON('channel_digests.json', {});
    return _channelDigestCache;
  }
  try {
    var res = await supabase.from('channel_digests').select('*');
    var digests = {};
    if (res.data) res.data.forEach(function(r) {
      digests[r.channel_id] = {
        last_digest: r.last_digest,
        last_ts: r.last_ts,
        updated_at: r.updated_at,
      };
    });
    _channelDigestCache = digests;
    return digests;
  } catch(e) { logErr('loadChannelDigests', e); _channelDigestCache = {}; return {}; }
}

async function saveChannelDigest(channelId, digest, lastTs) {
  if (!_channelDigestCache) _channelDigestCache = {};
  _channelDigestCache[channelId] = { last_digest: digest, last_ts: lastTs, updated_at: new Date().toISOString() };
  if (!useSupabase) {
    writeJSON('channel_digests.json', _channelDigestCache);
    return;
  }
  try {
    await supabase.from('channel_digests').upsert({
      channel_id: channelId,
      last_digest: digest,
      last_ts: lastTs,
      updated_at: new Date().toISOString(),
    });
  } catch(e) { logErr('saveChannelDigest', e); }
}

function getChannelDigestCache() { return _channelDigestCache || {}; }

// ============================================================================
// GLOSSARY
// ============================================================================

var _glossaryCache = null;

async function loadGlossary() {
  if (!useSupabase) { _glossaryCache = []; return []; }
  try {
    var res = await supabase.from('glossary').select('*');
    _glossaryCache = res.data || [];
    return _glossaryCache;
  } catch(e) { logErr('loadGlossary', e); _glossaryCache = []; return []; }
}

async function addGlossaryTerm(term, definition, synonyms, category, addedBy) {
  if (!useSupabase) return null;
  try {
    var res = await supabase.from('glossary').insert({
      term: term,
      definition: definition,
      synonyms: synonyms || [],
      category: category || 'altro',
      added_by: addedBy,
      source: 'auto-learn',
    });
    if (_glossaryCache) {
      _glossaryCache.push({ term: term, definition: definition, synonyms: synonyms || [], category: category || 'altro' });
    }
    return res.data;
  } catch(e) { logErr('addGlossaryTerm', e); return null; }
}

function searchGlossary(query) {
  if (!_glossaryCache || !query || typeof query !== 'string') return [];
  var q = query.toLowerCase();
  return _glossaryCache.filter(function(g) {
    return (g.term || '').toLowerCase().includes(q) ||
      (g.synonyms || []).some(function(s) { return (s || '').toLowerCase().includes(q); }) ||
      (g.definition || '').toLowerCase().includes(q);
  });
}

function getGlossaryCache() { return _glossaryCache || []; }

// ============================================================================
// INIT: carica tutti i dati all'avvio
// ============================================================================

async function initAll() {
  var results = await Promise.all([
    loadTokens(),
    loadPrefs(),
    loadConversations(),
    loadMemories(),
    loadProfiles(),
    loadKB(),
    loadStandup(),
    loadDriveIndex(),
    loadChannelMap(),
    loadChannelDigests(),
    loadGlossary(),
  ]);
  return {
    tokens: results[0],
    prefs: results[1],
    conversations: results[2],
    memories: results[3],
    profiles: results[4],
    kb: results[5],
    standup: results[6],
    driveIndex: results[7],
  };
}

// ============================================================================
// QUOTES (Preventivi)
// ============================================================================

async function searchQuotes(query) {
  if (!useSupabase) return [];
  try {
    var q = supabase.from('quotes').select('*');
    if (query.client_name) q = q.ilike('client_name', '%' + query.client_name + '%');
    if (query.project_name) q = q.ilike('project_name', '%' + query.project_name + '%');
    if (query.status) q = q.eq('status', query.status);
    if (query.service_category) q = q.ilike('service_category', '%' + query.service_category + '%');
    if (query.year) q = q.eq('quote_year', query.year);
    if (query.quarter) q = q.eq('quote_quarter', query.quarter);
    q = q.order('date', { ascending: false }).limit(query.limit || 20);
    var res = await q;
    return res.data || [];
  } catch(e) { logErr('searchQuotes', e); return []; }
}

async function quoteExistsByDocId(sourceDocId) {
  if (!useSupabase) return false;
  try {
    var res = await supabase.from('quotes').select('id').eq('source_doc_id', sourceDocId).single();
    return !!(res.data);
  } catch(e) { return false; }
}

async function saveQuote(quote) {
  if (!useSupabase) return false;
  try {
    await supabase.from('quotes').upsert(quote);
    return true;
  } catch(e) { logErr('saveQuote', e); return false; }
}

async function getRateCard(version) {
  if (!useSupabase) return null;
  try {
    var q = supabase.from('rate_card_history').select('*');
    if (version) {
      q = q.eq('version', version);
    } else {
      q = q.order('effective_from', { ascending: false }).limit(1);
    }
    var res = await q;
    return res.data && res.data.length > 0 ? res.data[0] : null;
  } catch(e) { logErr('getRateCard', e); return null; }
}

async function listRateCards() {
  if (!useSupabase) return [];
  try {
    var res = await supabase.from('rate_card_history').select('id, version, effective_from, notes, created_at').order('effective_from', { ascending: false });
    return res.data || [];
  } catch(e) { logErr('listRateCards', e); return []; }
}

async function saveRateCard(rateCard) {
  if (!useSupabase) return false;
  try {
    await supabase.from('rate_card_history').upsert(rateCard);
    return true;
  } catch(e) { logErr('saveRateCard', e); return false; }
}

// ============================================================================
// LEADS (CRM)
// ============================================================================

async function leadExists(companyName, contactEmail) {
  if (!useSupabase) return false;
  try {
    var q = supabase.from('leads').select('id').ilike('company_name', companyName);
    if (contactEmail) q = q.eq('contact_email', contactEmail);
    var res = await q.limit(1);
    return !!(res.data && res.data.length > 0);
  } catch(e) { return false; }
}

async function insertLead(lead) {
  if (!useSupabase) return null;
  try {
    var row = {
      company_name: lead.company_name,
      contact_name: lead.contact_name || null,
      contact_email: lead.contact_email || null,
      contact_role: lead.contact_role || null,
      source: lead.source || 'sheet_import',
      service_interest: lead.service_interest || null,
      estimated_value: lead.estimated_value || null,
      status: lead.status || 'new',
      owner_slack_id: lead.owner_slack_id || null,
      first_contact: lead.first_contact || null,
      last_contact: lead.last_contact || null,
      next_followup: lead.next_followup || null,
      notes: lead.notes || null,
      phone: lead.phone || null,
      website: lead.website || null,
    };
    var res = await supabase.from('leads').insert(row);
    if (res.error) throw res.error;
    return res.data;
  } catch(e) { logErr('insertLead', e); throw e; }
}

async function getLeadsPipeline() {
  if (!useSupabase) return { byStatus: {}, upcoming: [] };
  try {
    // Count by status
    var res = await supabase.from('leads').select('status');
    var byStatus = {};
    (res.data || []).forEach(function(r) {
      var s = r.status || 'new';
      byStatus[s] = (byStatus[s] || 0) + 1;
    });

    // Upcoming followups (today + tomorrow)
    var today = new Date().toISOString().slice(0, 10);
    var tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    var upRes = await supabase.from('leads')
      .select('company_name, contact_name, next_followup, status')
      .lte('next_followup', tomorrow)
      .gte('next_followup', today)
      .order('next_followup');
    var upcoming = upRes.data || [];

    return { byStatus: byStatus, upcoming: upcoming, total: (res.data || []).length };
  } catch(e) { logErr('getLeadsPipeline', e); return { byStatus: {}, upcoming: [], total: 0 }; }
}

async function updateLead(identifier, updates) {
  if (!useSupabase) return null;
  try {
    var updateData = Object.assign({}, updates, { updated_at: new Date().toISOString() });
    var res;
    if (identifier.match && identifier.match(/^[0-9a-f-]{36}$/i)) {
      res = await supabase.from('leads').update(updateData).eq('id', identifier).select();
    } else {
      res = await supabase.from('leads').update(updateData).ilike('company_name', identifier).select();
    }
    if (res.error) throw res.error;
    return res.data;
  } catch(e) { logErr('updateLead', e); throw e; }
}

async function searchLeads(params) {
  if (!useSupabase) return [];
  try {
    var q = supabase.from('leads').select('*');
    if (params.company_name) q = q.ilike('company_name', '%' + params.company_name + '%');
    if (params.contact_name) q = q.ilike('contact_name', '%' + params.contact_name + '%');
    if (params.status) q = q.eq('status', params.status);
    if (params.owner_slack_id) q = q.eq('owner_slack_id', params.owner_slack_id);
    q = q.order('updated_at', { ascending: false }).limit(params.limit || 20);
    var res = await q;
    return res.data || [];
  } catch(e) { logErr('searchLeads', e); return []; }
}

// ============================================================================
// KB CLEANUP (cron)
// ============================================================================

async function cleanupExpiredKB() {
  if (!useSupabase) return 0;
  try {
    var res = await supabase.from('knowledge_base').delete()
      .lt('expires_at', new Date().toISOString())
      .neq('confidence_tier', 'official')
      .neq('confidence_tier', 'drive_indexed')
      .select('id');
    var removed = (res.data || []).length;
    // Also remove from cache
    if (_kbCache && removed > 0) {
      var nowISO = new Date().toISOString();
      _kbCache = _kbCache.filter(function(e) {
        return !e.expires_at || e.expires_at >= nowISO || e.confidence_tier === 'official' || e.confidence_tier === 'drive_indexed';
      });
    }
    return removed;
  } catch(e) { logErr('cleanupExpiredKB', e); return 0; }
}

async function reviewPendingKB() {
  if (!useSupabase) return { rejected: 0, promoted: 0 };
  try {
    var sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    var unused = await supabase.from('knowledge_base')
      .update({ validation_status: 'rejected' })
      .eq('validation_status', 'pending')
      .eq('usage_count', 0)
      .lt('created_at', sevenDaysAgo)
      .select('id');
    var promoted = await supabase.from('knowledge_base')
      .update({ validation_status: 'approved', validated_at: new Date().toISOString() })
      .eq('validation_status', 'pending')
      .gte('usage_count', 2)
      .select('id');
    return { rejected: (unused.data || []).length, promoted: (promoted.data || []).length };
  } catch(e) { logErr('reviewPendingKB', e); return { rejected: 0, promoted: 0 }; }
}

// ============================================================================
// CRON LOCKS — mutex distribuito per Railway multi-istanza
// ============================================================================

var INSTANCE_ID = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);

async function acquireCronLock(jobName, ttlMinutes) {
  if (!useSupabase) return true;
  ttlMinutes = ttlMinutes || 10;
  try {
    var expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
    await supabase.from('cron_locks').delete().eq('job_name', jobName).lt('expires_at', new Date().toISOString());
    var res = await supabase.from('cron_locks').insert({
      job_name: jobName,
      locked_at: new Date().toISOString(),
      locked_by: INSTANCE_ID,
      expires_at: expiresAt,
    });
    if (res.error) {
      process.stdout.write('[CRON-LOCK] ' + jobName + ' già in esecuzione, skip.\n');
      return false;
    }
    process.stdout.write('[CRON-LOCK] Lock acquisito: ' + jobName + '\n');
    return true;
  } catch(e) {
    process.stdout.write('[CRON-LOCK] Errore (procedo): ' + e.message + '\n');
    return true;
  }
}

async function releaseCronLock(jobName) {
  if (!useSupabase) return;
  try {
    await supabase.from('cron_locks').delete().eq('job_name', jobName).eq('locked_by', INSTANCE_ID);
  } catch(e) {}
}

// ============================================================================
// LEADS DIRECT QUERY
// ============================================================================

async function queryLeadsDB(input) {
  if (!useSupabase) return { leads: [], count: 0 };
  try {
    var q = supabase.from('leads').select('*');
    if (input.company_name) q = q.ilike('company_name', '%' + input.company_name + '%');
    if (input.contact_name) q = q.ilike('contact_name', '%' + input.contact_name + '%');
    if (input.status) q = q.eq('status', input.status);
    if (input.owner_slack_id) q = q.eq('owner_slack_id', input.owner_slack_id);
    q = q.order('updated_at', { ascending: false }).limit(input.limit || 10);
    var res = await q;
    return { leads: res.data || [], count: (res.data || []).length };
  } catch(e) { logErr('queryLeadsDB', e); return { leads: [], count: 0 }; }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  isSupabase: function() { return useSupabase; },
  getClient: function() { return supabase; },
  initAll: initAll,
  // Tokens
  saveToken: saveToken,
  removeToken: removeToken,
  getTokenCache: getTokenCache,
  // Prefs
  savePrefs: savePrefs,
  getPrefsCache: getPrefsCache,
  // Conversations
  saveConversation: saveConversation,
  getConvCache: getConvCache,
  // Memories
  addMemory: addMemory,
  deleteMemory: deleteMemory,
  searchMemories: searchMemories,
  getMemCache: getMemCache,
  // Profiles
  saveProfile: saveProfile,
  getProfileCache: getProfileCache,
  // Knowledge Base
  addKBEntry: addKBEntry,
  deleteKBEntry: deleteKBEntry,
  searchKB: searchKB,
  getKBCache: getKBCache,
  // Standup
  saveStandup: saveStandup,
  getStandupCache: getStandupCache,
  // Drive Index
  saveDriveFiles: saveDriveFiles,
  getDriveCache: getDriveCache,
  // Feedback
  saveFeedback: saveFeedback,
  // Channel Map
  saveChannelMapping: saveChannelMapping,
  getChannelMapCache: getChannelMapCache,
  // Channel Digests
  saveChannelDigest: saveChannelDigest,
  getChannelDigestCache: getChannelDigestCache,
  // Quotes
  searchQuotes: searchQuotes,
  saveQuote: saveQuote,
  quoteExistsByDocId: quoteExistsByDocId,
  // Rate Card
  getRateCard: getRateCard,
  listRateCards: listRateCards,
  saveRateCard: saveRateCard,
  // Leads
  leadExists: leadExists,
  insertLead: insertLead,
  updateLead: updateLead,
  searchLeads: searchLeads,
  getLeadsPipeline: getLeadsPipeline,
  // Glossary
  loadGlossary: loadGlossary,
  addGlossaryTerm: addGlossaryTerm,
  searchGlossary: searchGlossary,
  getGlossaryCache: getGlossaryCache,
  // Conversation Summaries
  saveConversationSummary: saveConversationSummary,
  getConversationSummary: getConversationSummary,
  // Entity Resolution
  resolveEntity: resolveEntity,
  // Cron Locks
  acquireCronLock: acquireCronLock,
  releaseCronLock: releaseCronLock,
  INSTANCE_ID: INSTANCE_ID,
  // KB Cleanup
  cleanupExpiredKB: cleanupExpiredKB,
  reviewPendingKB: reviewPendingKB,
  // Leads Direct Query
  queryLeadsDB: queryLeadsDB,
};
