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
    _standupCache = res.data
      ? { oggi: res.data.oggi, risposte: res.data.risposte || {}, inattesa: Array.isArray(res.data.inattesa) ? res.data.inattesa : [] }
      : emptyCache();
    return _standupCache;
  } catch(e) { c.logErr('loadStandup', e); _standupCache = emptyCache(); return _standupCache; }
}

async function saveStandup(data) {
  _standupCache = data;
  if (!c.useSupabase) { c.writeJSON('standup_data.json', data); return; }
  try {
    var row = { id: 'current', oggi: data.oggi, risposte: data.risposte, updated_at: new Date().toISOString() };
    if (Array.isArray(data.inattesa)) row.inattesa = data.inattesa;
    await c.getClient().from('standup_data').upsert(row);
  } catch(e) {
    // Graceful degradation: if the `inattesa` column doesn't exist yet (migration
    // not applied), retry without it so the rest of the standup state still persists.
    if (e && String(e.message || '').match(/inattesa/i)) {
      try {
        await c.getClient().from('standup_data').upsert({ id: 'current', oggi: data.oggi, risposte: data.risposte, updated_at: new Date().toISOString() });
      } catch(e2) { c.logErr('saveStandup', e2); }
    } else {
      c.logErr('saveStandup', e);
    }
  }
}

function getStandupCache() {
  if (!_standupCache) return emptyCache();
  if (!Array.isArray(_standupCache.inattesa)) _standupCache.inattesa = [];
  return _standupCache;
}

module.exports = { loadStandup: loadStandup, saveStandup: saveStandup, getStandupCache: getStandupCache };
