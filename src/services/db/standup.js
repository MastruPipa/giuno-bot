// ─── Standup data ────────────────────────────────────────────────────────────
'use strict';

var c = require('./client');

var _standupCache = null;

// stime: proposte di daily stimato in sospeso (userId → { date, structured }).
// Persistite: un deploy tra le 16:00 e le 18:00 non le deve cancellare.
function emptyCache() { return { oggi: null, risposte: {}, inattesa: [], stime: {} }; }
function stimeOf(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }

async function loadStandup() {
  if (!c.useSupabase) {
    _standupCache = c.readJSON('standup_data.json', emptyCache());
    _standupCache.inattesa = Array.isArray(_standupCache.inattesa) ? _standupCache.inattesa : [];
    _standupCache.stime = stimeOf(_standupCache.stime);
    return _standupCache;
  }
  try {
    var res = await c.getClient().from('standup_data').select('*').eq('id', 'current').single();
    _standupCache = res.data
      ? { oggi: res.data.oggi, risposte: res.data.risposte || {}, inattesa: Array.isArray(res.data.inattesa) ? res.data.inattesa : [], stime: stimeOf(res.data.stime) }
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
    if (data.stime && typeof data.stime === 'object') row.stime = data.stime;
    var res = await c.getClient().from('standup_data').upsert(row);
    if (res && res.error) throw res.error;
  } catch(e) {
    // Graceful degradation: se una colonna nuova (`inattesa`, `stime`) non
    // esiste ancora (migrazione non applicata), si riprova senza, così il
    // resto dello stato del daily si salva comunque.
    var msg = String((e && e.message) || '');
    if (/stime/i.test(msg)) {
      try {
        var r2 = await c.getClient().from('standup_data').upsert({ id: 'current', oggi: data.oggi, risposte: data.risposte, inattesa: Array.isArray(data.inattesa) ? data.inattesa : [], updated_at: new Date().toISOString() });
        if (r2 && r2.error) throw r2.error;
      } catch(e2) { c.logErr('saveStandup', e2); }
    } else if (/inattesa/i.test(msg)) {
      try {
        await c.getClient().from('standup_data').upsert({ id: 'current', oggi: data.oggi, risposte: data.risposte, updated_at: new Date().toISOString() });
      } catch(e3) { c.logErr('saveStandup', e3); }
    } else {
      c.logErr('saveStandup', e);
    }
  }
}

function getStandupCache() {
  if (!_standupCache) _standupCache = emptyCache();
  if (!Array.isArray(_standupCache.inattesa)) _standupCache.inattesa = [];
  _standupCache.stime = stimeOf(_standupCache.stime);
  return _standupCache;
}

module.exports = { loadStandup: loadStandup, saveStandup: saveStandup, getStandupCache: getStandupCache };
