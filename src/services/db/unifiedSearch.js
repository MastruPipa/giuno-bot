// ─── Unified Search Module ───────────────────────────────────────────────────
// Wraps Supabase RPCs: unified_search, get_channel_context, get_entity_context
// All functions have graceful fallback if RPCs don't exist yet.
'use strict';

var c = require('./client');

function logWarn(fn, msg) {
  process.stdout.write('[unifiedSearch/' + fn + '] ' + msg + '\n');
}

async function safeRPC(name, params) {
  if (!c.useSupabase) return null;
  try {
    var res = await c.getClient().rpc(name, params);
    if (res.error) throw res.error;
    return res.data;
  } catch(e) {
    logWarn(name, 'RPC unavailable: ' + (e.message || '').substring(0, 80));
    return null;
  }
}

async function unifiedSearch(query, userId, limit, sources) {
  return safeRPC('unified_search', {
    p_query: (query || '').substring(0, 200),
    p_user_id: userId || null,
    p_limit: limit || 15,
    p_sources: sources || ['memories', 'kb', 'entities', 'drive', 'channels'],
  });
}

async function getChannelContext(channelId, limit) {
  return safeRPC('get_channel_context', { p_channel_id: channelId, p_limit: limit || 10 });
}

async function getEntityContext(entityName, depth) {
  return safeRPC('get_entity_context', { p_entity_name: entityName, p_depth: depth || 1 });
}

async function upsertChannelProfile(channelId, profileData) {
  if (!c.useSupabase) return;
  try {
    await c.getClient().from('channel_profiles').upsert(
      Object.assign({ channel_id: channelId, updated_at: new Date().toISOString() }, profileData),
      { onConflict: 'channel_id' }
    );
  } catch(e) { c.logErr('upsertChannelProfile', e); }
}

async function saveDriveContent(entry) {
  if (!c.useSupabase) return;
  try {
    await c.getClient().from('drive_content_index').upsert(entry, { onConflict: 'file_id' });
  } catch(e) { c.logErr('saveDriveContent', e); }
}

async function searchDriveContent(query, limit) {
  if (!c.useSupabase || !query) return [];
  try {
    var res = await c.getClient().from('drive_content_index')
      .select('file_name, ai_summary, web_link, doc_category, related_client, key_facts')
      .or('file_name.ilike.%' + query + '%,ai_summary.ilike.%' + query + '%,related_client.ilike.%' + query + '%')
      .order('confidence_score', { ascending: false })
      .limit(limit || 10);
    return res.data || [];
  } catch(e) { c.logErr('searchDriveContent', e); return []; }
}

async function upsertEntity(canonicalName, entityType, aliases, context) {
  if (!c.useSupabase) return;
  try {
    var existing = await c.getClient().from('kb_entities')
      .select('id, mention_count').eq('canonical_name', canonicalName).eq('entity_type', entityType).maybeSingle();
    if (existing.data) {
      await c.getClient().from('kb_entities').update({
        mention_count: (existing.data.mention_count || 0) + 1,
        last_seen_at: new Date().toISOString(),
      }).eq('id', existing.data.id);
    } else {
      await c.getClient().from('kb_entities').insert({
        canonical_name: canonicalName, entity_type: entityType,
        aliases: aliases || [canonicalName.toLowerCase()],
        context: context || {}, mention_count: 1, last_seen_at: new Date().toISOString(),
      });
    }
  } catch(e) { c.logErr('upsertEntity', e); }
}

async function addGraphEdge(fromType, fromId, relationship, toType, toId, weight) {
  if (!c.useSupabase) return;
  try {
    await c.getClient().from('memory_graph').insert({
      from_type: fromType, from_id: fromId, relationship: relationship,
      to_type: toType, to_id: toId, weight: weight || 1.0, created_by: 'system',
    });
  } catch(e) {
    if (!e.message || !e.message.includes('duplicate')) c.logErr('addGraphEdge', e);
  }
}

module.exports = {
  unifiedSearch: unifiedSearch, getChannelContext: getChannelContext,
  getEntityContext: getEntityContext, upsertChannelProfile: upsertChannelProfile,
  saveDriveContent: saveDriveContent, searchDriveContent: searchDriveContent,
  upsertEntity: upsertEntity, addGraphEdge: addGraphEdge,
};
