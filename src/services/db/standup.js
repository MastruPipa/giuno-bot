// ─── Standup data ────────────────────────────────────────────────────────────
'use strict';

var c = require('./client');

var _standupCache = null;

function emptyCache() { return { oggi: null, risposte: {}, inattesa: [] }; }

async function loadStandup() {
  if (!c.useSupabase) {
    _standupCache = c.readJSON('standup_data.json', emptyCache());
    _standupCache.inattesa = Array.isArray(_standupCache.inattesa) ? _standupCache.inattesa : [];
    return _standupCache;
  }
  try {
    var res = await c.getClient().from('standup_data').select('*').eq('id', 'current').single();
    // PGRST116 = nessuna riga: stato vergine, ok. Su altri errori (rete, RLS)
    // NON azzerare la cache in memoria: conteneva le risposte del giorno.
    if (res.error && res.error.code !== 'PGRST116') {
      c.logErr('loadStandup', res.error);
      _standupCache = _standupCache || emptyCache();
      return _standupCache;
    }
    _standupCache = res.data
      ? { oggi: res.data.oggi, risposte: res.data.risposte || {}, inattesa: Array.isArray(res.data.inattesa) ? res.data.inattesa : [] }
      : emptyCache();
    return _standupCache;
  } catch(e) {
    c.logErr('loadStandup', e);
    _standupCache = _standupCache || emptyCache();
    return _standupCache;
  }
}

async function saveStandup(data) {
  _standupCache = data;
  if (!c.useSupabase) { c.writeJSON('standup_data.json', data); return; }
  try {
    var row = { id: 'current', oggi: data.oggi, risposte: data.risposte, updated_at: new Date().toISOString() };
    if (Array.isArray(data.inattesa)) row.inattesa = data.inattesa;
    var res = await c.getClient().from('standup_data').upsert(row);
    // supabase-js non lancia sugli errori query: vanno letti da res.error,
    // altrimenti un upsert fallito passa in silenzio e lo stato non viene
    // mai persistito (le risposte spariscono al primo restart).
    if (res && res.error) {
      // Graceful degradation: if the `inattesa` column doesn't exist yet (migration
      // not applied), retry without it so the rest of the standup state still persists.
      if (String(res.error.message || '').match(/inattesa/i)) {
        var retry = await c.getClient().from('standup_data').upsert({ id: 'current', oggi: data.oggi, risposte: data.risposte, updated_at: new Date().toISOString() });
        if (retry && retry.error) c.logErr('saveStandup', retry.error);
      } else {
        c.logErr('saveStandup', res.error);
      }
    }
  } catch(e) {
    c.logErr('saveStandup', e);
  }
}

function getStandupCache() {
  if (!_standupCache) return emptyCache();
  if (!Array.isArray(_standupCache.inattesa)) _standupCache.inattesa = [];
  return _standupCache;
}

module.exports = { loadStandup: loadStandup, saveStandup: saveStandup, getStandupCache: getStandupCache };
