// ─── DB: campagne di messaggi con conferma di lettura ────────────────────────
// Una campagna = un messaggio mandato in DM a N persone con una risposta
// attesa ("LETTO"), controlli periodici, solleciti fino a max_pushes e report
// a chi l'ha lanciata. recipients è un array JSON:
//   { user_id, name, channel, ts, status: sent|replied|unanswered, pushes,
//     last_push_at, replied_at, reply_text }

'use strict';

function _c() { return require('./client'); }
var FILE = 'message_campaigns.json';
function _read() { return _c().readJSON(FILE, {}); }

async function createCampaign(row) {
  row.id = row.id || ('cmp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6));
  row.status = row.status || 'active';
  row.created_at = row.created_at || new Date().toISOString();
  row.updated_at = row.created_at;
  var c = _c();
  if (!c.useSupabase) { var all = _read(); all[row.id] = row; c.writeJSON(FILE, all); return row; }
  try {
    var res = await c.getClient().from('message_campaigns').insert(row);
    if (res.error) throw res.error;
  } catch(e) { c.logErr('createCampaign', e); }
  return row;
}

async function getCampaign(id) {
  var c = _c();
  if (!c.useSupabase) return _read()[id] || null;
  try {
    var res = await c.getClient().from('message_campaigns').select('*').eq('id', id).maybeSingle();
    if (res.error) throw res.error;
    return res.data || null;
  } catch(e) { c.logErr('getCampaign', e); return null; }
}

async function listCampaigns(filter) {
  filter = filter || {};
  var c = _c();
  var rows;
  if (!c.useSupabase) { var all = _read(); rows = Object.keys(all).map(function(k) { return all[k]; }); }
  else {
    try {
      var q = c.getClient().from('message_campaigns').select('*').order('created_at', { ascending: false }).limit(filter.limit || 50);
      if (filter.status) q = q.eq('status', filter.status);
      if (filter.createdBy) q = q.eq('created_by', filter.createdBy);
      var res = await q;
      if (res.error) throw res.error;
      rows = res.data || [];
    } catch(e) { c.logErr('listCampaigns', e); rows = []; }
  }
  return rows.filter(function(r) { return (!filter.status || r.status === filter.status) && (!filter.createdBy || r.created_by === filter.createdBy); });
}

async function updateCampaign(id, fields) {
  fields.updated_at = new Date().toISOString();
  var c = _c();
  if (!c.useSupabase) { var all = _read(); if (all[id]) all[id] = Object.assign({}, all[id], fields); c.writeJSON(FILE, all); return all[id] || null; }
  try {
    var res = await c.getClient().from('message_campaigns').update(fields).eq('id', id);
    if (res.error) throw res.error;
  } catch(e) { c.logErr('updateCampaign', e); }
  return null;
}

module.exports = { createCampaign: createCampaign, getCampaign: getCampaign, listCampaigns: listCampaigns, updateCampaign: updateCampaign };
