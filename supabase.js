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

async function addMemory(userId, content, tags) {
  var entry = {
    id: Date.now().toString(36),
    content: content,
    tags: tags || [],
    created: new Date().toISOString(),
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
  var contentLow = memory.content.toLowerCase();
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

  // Temporal score: 1.0 for brand new, decays to 0.3 over 180 days
  var temporalScore = 1.0;
  if (memory.created && now) {
    var ageDays = (now - new Date(memory.created).getTime()) / (1000 * 60 * 60 * 24);
    temporalScore = Math.max(0.3, 1 - (ageDays / 180) * 0.7);
  }

  // Weighted final score: 75% relevance + 25% recency
  return baseScore * 0.75 + (baseScore * temporalScore) * 0.25;
}

// Filter out stale/wrong info about technical limitations
var BLACKLIST_PATTERNS = [
  'slack_user_token', 'search:read', 'limitazioni tecniche',
  'problema tecnico con slack', 'token non ha', 'permessi.*slack',
  'non riesco ad accedere ai canali', 'configurare.*permessi',
  'serve che.*configur', 'accesso.*canali.*limitat',
];
var _blacklistRegex = new RegExp(BLACKLIST_PATTERNS.join('|'), 'i');

function isBlacklisted(content) {
  return _blacklistRegex.test(content);
}

function searchMemories(userId, query) {
  if (!_memCache || !_memCache[userId]) return [];
  var tokens = expandQueryTokens(query);
  var now = Date.now();

  var scored = _memCache[userId].map(function(m) {
    return { memory: m, score: scoreMemory(m, tokens, now) };
  }).filter(function(item) {
    return item.score > 0 && !isBlacklisted(item.memory.content);
  });

  scored.sort(function(a, b) { return b.score - a.score; });

  return scored.map(function(item) { return item.memory; });
}

function getMemCache() { return _memCache || {}; }

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
  return text.toLowerCase().split(/\W+/).filter(function(w) {
    return w.length > 5 && !sw[w];
  });
}

function getTagValue(tags, prefix) {
  for (var i = 0; i < tags.length; i++) {
    if (tags[i].toLowerCase().startsWith(prefix)) return tags[i].toLowerCase();
  }
  return null;
}

// Fast dedup: check only last 200 KB entries (most recent) instead of full scan
function isDuplicate(newContent, newTags) {
  if (!_kbCache || _kbCache.length === 0) return false;
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

async function addKBEntry(content, tags, addedBy) {
  // Deduplication check
  if (isDuplicate(content, tags)) {
    return null;
  }

  var entry = {
    id: Date.now().toString(36),
    content: content,
    tags: tags || [],
    added_by: addedBy,
    created: new Date().toISOString(),
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

function searchKB(query) {
  if (!_kbCache) return [];
  var tokens = expandQueryTokens(query);
  var now = Date.now();

  var scored = _kbCache.map(function(entry) {
    return { entry: entry, score: scoreMemory(entry, tokens, now) };
  }).filter(function(item) {
    return item.score > 0 && !isBlacklisted(item.entry.content);
  });

  scored.sort(function(a, b) { return b.score - a.score; });

  return scored.map(function(item) { return item.entry; });
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
  if (!_glossaryCache) return [];
  var q = query.toLowerCase();
  return _glossaryCache.filter(function(g) {
    return g.term.toLowerCase().includes(q) ||
      (g.synonyms || []).some(function(s) { return s.toLowerCase().includes(q); }) ||
      g.definition.toLowerCase().includes(q);
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

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  isSupabase: function() { return useSupabase; },
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
  getLeadsPipeline: getLeadsPipeline,
  // Glossary
  loadGlossary: loadGlossary,
  addGlossaryTerm: addGlossaryTerm,
  searchGlossary: searchGlossary,
  getGlossaryCache: getGlossaryCache,
};
