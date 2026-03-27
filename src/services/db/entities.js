// ─── Entity resolution ───────────────────────────────────────────────────────
'use strict';

var c = require('./client');

async function resolveEntity(name) {
  if (!c.useSupabase || !name) return null;
  try {
    var res = await c.getClient().rpc('resolve_entity', { p_name: name });
    if (res.data && res.data.length > 0) return res.data[0];
    return null;
  } catch(e) { c.logErr('resolveEntity', e); return null; }
}

module.exports = { resolveEntity: resolveEntity };
