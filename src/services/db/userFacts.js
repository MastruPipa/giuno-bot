// ─── User facts ──────────────────────────────────────────────────────────────
// Per-user sticky truths — role, communication style, recurring clients/projects,
// explicit preferences. Extracted from DM rolling summary and reused as
// persistent context in askGiuno.
'use strict';

var crypto = require('crypto');
var c = require('./client');
var logger = require('../../utils/logger');

function factId(slackUserId, category, fact) {
  return 'uf_' + crypto.createHash('sha1')
    .update((slackUserId || '') + '|' + (category || '') + '|' + (fact || '').trim().toLowerCase())
    .digest('hex').slice(0, 16);
}

async function upsertUserFact(slackUserId, category, fact, confidence) {
  if (!slackUserId || !fact) return null;
  var trimmed = String(fact).trim();
  if (trimmed.length < 2 || trimmed.length > 300) return null;
  if (!c.useSupabase) return null;
  try {
    var row = {
      id: factId(slackUserId, category, trimmed),
      slack_user_id: slackUserId,
      category: category || null,
      fact: trimmed,
      confidence: confidence == null ? 0.6 : confidence,
      source: 'dm_summary',
      last_confirmed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await c.getClient().from('user_facts').upsert(row, { onConflict: 'id' });
    return row;
  } catch(e) {
    // Table may not exist yet — degrade silently
    if (!/user_facts/i.test(String(e && e.message || ''))) {
      logger.warn('[USER-FACTS] upsert failed:', e.message);
    }
    return null;
  }
}

async function getUserFacts(slackUserId, limit) {
  if (!slackUserId || !c.useSupabase) return [];
  try {
    var res = await c.getClient().from('user_facts')
      .select('category, fact, confidence, last_confirmed_at')
      .eq('slack_user_id', slackUserId)
      .order('confidence', { ascending: false })
      .limit(limit || 20);
    return (res && res.data) || [];
  } catch(e) {
    if (!/user_facts/i.test(String(e && e.message || ''))) {
      logger.debug('[USER-FACTS] fetch failed:', e.message);
    }
    return [];
  }
}

async function touchUserFact(slackUserId, category, fact) {
  if (!slackUserId || !fact || !c.useSupabase) return;
  try {
    await c.getClient().from('user_facts')
      .update({ last_confirmed_at: new Date().toISOString() })
      .eq('id', factId(slackUserId, category, String(fact).trim()));
  } catch(e) { /* non-blocking */ }
}

module.exports = {
  upsertUserFact: upsertUserFact,
  getUserFacts: getUserFacts,
  touchUserFact: touchUserFact,
};
