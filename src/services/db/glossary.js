// ─── Glossary ────────────────────────────────────────────────────────────────
'use strict';

var c = require('./client');

var _glossaryCache = null;

async function loadGlossary() {
  if (!c.useSupabase) { _glossaryCache = []; return []; }
  try {
    var res = await c.getClient().from('glossary').select('*');
    _glossaryCache = res.data || [];
    return _glossaryCache;
  } catch(e) { c.logErr('loadGlossary', e); _glossaryCache = []; return []; }
}

async function addGlossaryTerm(term, definition, synonyms, category, addedBy) {
  if (!c.useSupabase) return null;
  try {
    var res = await c.getClient().from('glossary').insert({ term: term, definition: definition, synonyms: synonyms || [], category: category || 'altro', added_by: addedBy, source: 'auto-learn' });
    if (_glossaryCache) {
      _glossaryCache.push({ term: term, definition: definition, synonyms: synonyms || [], category: category || 'altro' });
    }
    return res.data;
  } catch(e) { c.logErr('addGlossaryTerm', e); return null; }
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

module.exports = { loadGlossary: loadGlossary, addGlossaryTerm: addGlossaryTerm, searchGlossary: searchGlossary, getGlossaryCache: getGlossaryCache };
