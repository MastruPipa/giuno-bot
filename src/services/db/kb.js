// ─── Knowledge Base ──────────────────────────────────────────────────────────
'use strict';

var c = require('./client');
var search = require('./search');

var _kbCache = null;

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
  return (text || '').toLowerCase().split(/\W+/).filter(function(w) { return w.length > 5 && !sw[w]; });
}

function getTagValue(tags, prefix) {
  for (var i = 0; i < tags.length; i++) {
    if (tags[i] && tags[i].toLowerCase().startsWith(prefix)) return tags[i].toLowerCase();
  }
  return null;
}

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
  var startIdx = _kbCache.length > 1000 ? Math.max(0, _kbCache.length - 500) : 0;
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
  auto_learn:     { score: 0.3,  expiryDays: 30,   validation: 'pending' },
};

// Smart KB entry classification — boosts auto_learn confidence based on content
function classifyKBContent(content, baseTier) {
  if (baseTier === 'official' || baseTier === 'drive_indexed') return null; // already high
  var c2 = (content || '').toLowerCase();
  if (/template|procedura|processo|rate card|workflow|per i preventivi|come si fa|bisogna sempre/i.test(c2)) {
    return { tier: 'auto_learn', score: 0.75, expiryDays: null }; // procedural: permanent, high conf
  }
  if (/è un[ao]?\s+(cliente|fornitore|partner|collaboratore)|si occupa di|specializzat|ha sede|è (il|la) (ceo|coo|cfo|pm|responsabile)/i.test(c2)) {
    return { tier: 'auto_learn', score: 0.65, expiryDays: null }; // semantic: permanent, medium-high conf
  }
  if (/preferisce|vuole (sempre|di solito)|abitudine|tono preferito/i.test(c2)) {
    return { tier: 'auto_learn', score: 0.6, expiryDays: null }; // preference: permanent
  }
  return null; // keep default
}

async function loadKB() {
  if (!c.useSupabase) {
    _kbCache = c.readJSON('knowledge_base.json', []);
    return _kbCache;
  }
  try {
    var res = await c.getClient().from('knowledge_base').select('*').order('created_at', { ascending: true });
    _kbCache = (res.data || []).map(function(r) {
      return { id: r.id, content: r.content, tags: r.tags || [], added_by: r.added_by, created: r.created_at };
    });
    return _kbCache;
  } catch(e) { c.logErr('loadKB', e); _kbCache = []; return []; }
}

async function addKBEntry(content, tags, addedBy, options) {
  options = options || {};
  if (options.sourceChannelType === 'dm') return null;
  if (options.confidenceTier !== 'official' && isDuplicate(content, tags)) return null;

  var tier = options.confidenceTier || 'auto_learn';
  var tierDef = TIER_DEFAULTS[tier] || TIER_DEFAULTS.auto_learn;

  // Smart classification: boost auto_learn confidence based on content type
  var smartClass = classifyKBContent(content, tier);
  var score = smartClass ? smartClass.score : tierDef.score;
  var expiryDays = smartClass ? smartClass.expiryDays : (options.expiresInDays != null ? options.expiresInDays : tierDef.expiryDays);
  var now = new Date();
  var expiresAt = expiryDays ? new Date(now.getTime() + expiryDays * 24 * 60 * 60 * 1000).toISOString() : null;

  var entry = {
    id: Date.now().toString(36),
    content: content,
    tags: tags || [],
    added_by: addedBy,
    created: now.toISOString(),
    confidence_score: score,
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

  if (!c.useSupabase) {
    c.writeJSON('knowledge_base.json', _kbCache);
    return entry;
  }
  try {
    await c.getClient().from('knowledge_base').insert({
      id: entry.id, content: content, tags: tags || [], added_by: addedBy,
      created_at: entry.created, confidence_score: entry.confidence_score,
      confidence_tier: entry.confidence_tier, source_type: entry.source_type,
      source_channel_id: entry.source_channel_id, source_channel_type: entry.source_channel_type,
      validation_status: entry.validation_status, expires_at: entry.expires_at, usage_count: 0,
    });
  } catch(e) { c.logErr('addKBEntry', e); }
  return entry;
}

async function deleteKBEntry(entryId) {
  if (_kbCache) {
    var before = _kbCache.length;
    _kbCache = _kbCache.filter(function(e) { return e.id !== entryId; });
    if (_kbCache.length >= before) return false;
  }
  if (!c.useSupabase) { c.writeJSON('knowledge_base.json', _kbCache); return true; }
  try { await c.getClient().from('knowledge_base').delete().eq('id', entryId); } catch(e) { c.logErr('deleteKBEntry', e); }
  return true;
}

function searchKB(query, options) {
  if (!_kbCache) return [];
  options = options || {};
  var minConfidence = options.minConfidence || 0.0;
  var includeExpired = options.includeExpired || false;
  var includePending = options.includePending !== false;
  var limit = options.limit || 20;
  var now = Date.now();
  var nowISO = new Date().toISOString();
  var tokens = search.expandQueryTokens(query);

  var scored = [];
  for (var i = 0; i < _kbCache.length; i++) {
    var entry = _kbCache[i];
    if (entry.validation_status === 'rejected') continue;
    if (!includePending && entry.validation_status === 'pending') continue;
    if (!includeExpired && entry.expires_at && entry.expires_at < nowISO) continue;
    if (entry.confidence_score && entry.confidence_score < minConfidence) continue;
    if (search.isBlacklisted(entry.content)) continue;

    var keywordScore = search.scoreMemory(entry, tokens, now);
    if (keywordScore <= 0) continue;

    var confidenceScore = entry.confidence_score || 0.25;
    var recencyScore = 1.0;
    if (entry.created) {
      var ageDays = (now - new Date(entry.created).getTime()) / (1000 * 60 * 60 * 24);
      recencyScore = Math.max(0.3, 1 - (ageDays / 180) * 0.7);
    }
    var normalizedKeyword = Math.min(keywordScore / 20, 1.0);
    var finalScore = (normalizedKeyword * 0.5) + (confidenceScore * 0.35) + (recencyScore * 0.15);
    scored.push({ entry: entry, score: finalScore });
  }

  scored.sort(function(a, b) { return b.score - a.score; });
  var results = scored.slice(0, limit).map(function(item) { return item.entry; });
  for (var r = 0; r < results.length; r++) {
    results[r].usage_count = (results[r].usage_count || 0) + 1;
    results[r].last_used_at = nowISO;
  }
  if (c.useSupabase && results.length > 0) {
    var kbIds = results.slice(0, 10).map(function(e) { return e.id; }).filter(Boolean);
    if (kbIds.length > 0) {
      c.getClient().rpc('increment_kb_usage', { kb_ids: kbIds }).then(function() {}).catch(function(e) {
        process.stdout.write('[KB-USAGE] rpc failed: ' + e.message + '\n');
      });
    }
  }
  return results;
}

function getKBCache() { return _kbCache || []; }

async function cleanupExpiredKB() {
  if (!c.useSupabase) return 0;
  try {
    var res = await c.getClient().from('knowledge_base').delete()
      .lt('expires_at', new Date().toISOString())
      .neq('confidence_tier', 'official')
      .neq('confidence_tier', 'drive_indexed')
      .select('id');
    var removed = (res.data || []).length;
    if (_kbCache && removed > 0) {
      var nowISO = new Date().toISOString();
      _kbCache = _kbCache.filter(function(e) {
        return !e.expires_at || e.expires_at >= nowISO || e.confidence_tier === 'official' || e.confidence_tier === 'drive_indexed';
      });
    }
    return removed;
  } catch(e) { c.logErr('cleanupExpiredKB', e); return 0; }
}

async function reviewPendingKB() {
  if (!c.useSupabase) return { rejected: 0, promoted: 0 };
  try {
    var sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    var unused = await c.getClient().from('knowledge_base')
      .update({ validation_status: 'rejected' })
      .eq('validation_status', 'pending').eq('usage_count', 0).lt('created_at', sevenDaysAgo).select('id');
    var promoted = await c.getClient().from('knowledge_base')
      .update({ validation_status: 'approved', validated_at: new Date().toISOString() })
      .eq('validation_status', 'pending').gte('usage_count', 2).select('id');
    return { rejected: (unused.data || []).length, promoted: (promoted.data || []).length };
  } catch(e) { c.logErr('reviewPendingKB', e); return { rejected: 0, promoted: 0 }; }
}

module.exports = {
  loadKB: loadKB,
  addKBEntry: addKBEntry,
  deleteKBEntry: deleteKBEntry,
  searchKB: searchKB,
  getKBCache: getKBCache,
  cleanupExpiredKB: cleanupExpiredKB,
  reviewPendingKB: reviewPendingKB,
};
