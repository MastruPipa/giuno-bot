// ─── Channel map + digests ───────────────────────────────────────────────────
'use strict';

var c = require('./client');

// ─── Channel map ─────────────────────────────────────────────────────────────

var _channelMapCache = null;

async function loadChannelMap() {
  if (!c.useSupabase) { _channelMapCache = c.readJSON('channel_map.json', {}); return _channelMapCache; }
  try {
    var res = await c.getClient().from('channel_map').select('*');
    var map = {};
    if (res.data) res.data.forEach(function(r) {
      map[r.channel_id] = { channel_name: r.channel_name, cliente: r.cliente, progetto: r.progetto, tags: r.tags || [], note: r.note, updated_at: r.updated_at };
    });
    _channelMapCache = map;
    return map;
  } catch(e) { c.logErr('loadChannelMap', e); _channelMapCache = {}; return {}; }
}

async function saveChannelMapping(channelId, data) {
  if (!_channelMapCache) _channelMapCache = {};
  _channelMapCache[channelId] = data;
  if (!c.useSupabase) { c.writeJSON('channel_map.json', _channelMapCache); return; }
  try {
    await c.getClient().from('channel_map').upsert({ channel_id: channelId, channel_name: data.channel_name, cliente: data.cliente, progetto: data.progetto, tags: data.tags || [], note: data.note || null, updated_at: new Date().toISOString() });
  } catch(e) { c.logErr('saveChannelMapping', e); }
}

function getChannelMapCache() { return _channelMapCache || {}; }

// ─── Channel digests ──────────────────────────────────────────────────────────

var _channelDigestCache = null;

async function loadChannelDigests() {
  if (!c.useSupabase) { _channelDigestCache = c.readJSON('channel_digests.json', {}); return _channelDigestCache; }
  try {
    var res = await c.getClient().from('channel_digests').select('*');
    var digests = {};
    if (res.data) res.data.forEach(function(r) {
      digests[r.channel_id] = { last_digest: r.last_digest, last_ts: r.last_ts, updated_at: r.updated_at };
    });
    _channelDigestCache = digests;
    return digests;
  } catch(e) { c.logErr('loadChannelDigests', e); _channelDigestCache = {}; return {}; }
}

async function saveChannelDigest(channelId, digest, lastTs) {
  if (!_channelDigestCache) _channelDigestCache = {};
  _channelDigestCache[channelId] = { last_digest: digest, last_ts: lastTs, updated_at: new Date().toISOString() };
  if (!c.useSupabase) { c.writeJSON('channel_digests.json', _channelDigestCache); return; }
  try {
    await c.getClient().from('channel_digests').upsert({ channel_id: channelId, last_digest: digest, last_ts: lastTs, updated_at: new Date().toISOString() });
  } catch(e) { c.logErr('saveChannelDigest', e); }
}

function getChannelDigestCache() { return _channelDigestCache || {}; }

module.exports = {
  loadChannelMap: loadChannelMap,
  saveChannelMapping: saveChannelMapping,
  getChannelMapCache: getChannelMapCache,
  loadChannelDigests: loadChannelDigests,
  saveChannelDigest: saveChannelDigest,
  getChannelDigestCache: getChannelDigestCache,
};
