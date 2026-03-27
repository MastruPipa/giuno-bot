// ─── Conversations ───────────────────────────────────────────────────────────
'use strict';

var c = require('./client');

var _convCache = null;

async function loadConversations() {
  if (!c.useSupabase) {
    _convCache = c.readJSON('conversations.json', {});
    return _convCache;
  }
  try {
    var res = await c.getClient().from('conversations').select('conv_key, messages');
    var convs = {};
    if (res.data) res.data.forEach(function(r) { convs[r.conv_key] = r.messages; });
    _convCache = convs;
    return convs;
  } catch(e) { c.logErr('loadConversations', e); _convCache = {}; return {}; }
}

async function saveConversation(convKey, messages) {
  if (!_convCache) _convCache = {};
  _convCache[convKey] = messages;
  if (!c.useSupabase) {
    c.writeJSON('conversations.json', _convCache);
    return;
  }
  try {
    await c.getClient().from('conversations').upsert({
      conv_key: convKey,
      messages: messages,
      updated_at: new Date().toISOString(),
    });
  } catch(e) { c.logErr('saveConversation', e); }
}

function getConvCache() { return _convCache || {}; }

async function saveConversationSummary(convKey, summary, messagesCount, topics, proposedActions) {
  if (!c.useSupabase) return;
  try {
    await c.getClient().from('conversation_summaries').upsert({
      conv_key: convKey,
      summary: summary,
      messages_count: messagesCount || 0,
      topics: topics || [],
      proposed_actions: proposedActions || [],
      updated_at: new Date().toISOString(),
    }, { onConflict: 'conv_key' });
  } catch(e) { c.logErr('saveConversationSummary', e); }
}

async function getConversationSummary(convKey) {
  if (!c.useSupabase) return null;
  try {
    var res = await c.getClient().from('conversation_summaries').select('*').eq('conv_key', convKey).single();
    return res.data || null;
  } catch(e) { return null; }
}

module.exports = {
  loadConversations: loadConversations,
  saveConversation: saveConversation,
  getConvCache: getConvCache,
  saveConversationSummary: saveConversationSummary,
  getConversationSummary: getConversationSummary,
};
