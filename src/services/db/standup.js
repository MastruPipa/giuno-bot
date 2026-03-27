// ─── Standup data ────────────────────────────────────────────────────────────
'use strict';

var c = require('./client');

var _standupCache = null;

async function loadStandup() {
  if (!c.useSupabase) {
    _standupCache = c.readJSON('standup_data.json', { oggi: null, risposte: {} });
    return _standupCache;
  }
  try {
    var res = await c.getClient().from('standup_data').select('*').eq('id', 'current').single();
    _standupCache = res.data ? { oggi: res.data.oggi, risposte: res.data.risposte || {} } : { oggi: null, risposte: {} };
    return _standupCache;
  } catch(e) { c.logErr('loadStandup', e); _standupCache = { oggi: null, risposte: {} }; return _standupCache; }
}

async function saveStandup(data) {
  _standupCache = data;
  if (!c.useSupabase) { c.writeJSON('standup_data.json', data); return; }
  try {
    await c.getClient().from('standup_data').upsert({ id: 'current', oggi: data.oggi, risposte: data.risposte, updated_at: new Date().toISOString() });
  } catch(e) { c.logErr('saveStandup', e); }
}

function getStandupCache() { return _standupCache || { oggi: null, risposte: {} }; }

module.exports = { loadStandup: loadStandup, saveStandup: saveStandup, getStandupCache: getStandupCache };
