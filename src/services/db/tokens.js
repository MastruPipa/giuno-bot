// ─── User tokens ────────────────────────────────────────────────────────────
'use strict';

var c = require('./client');

var _tokenCache = null;

async function loadTokens() {
  if (!c.useSupabase) {
    _tokenCache = c.readJSON('user_tokens.json', {});
    return _tokenCache;
  }
  try {
    var res = await c.getClient().from('user_tokens').select('slack_user_id, refresh_token');
    var tokens = {};
    if (res.data) res.data.forEach(function(r) { tokens[r.slack_user_id] = r.refresh_token; });
    _tokenCache = tokens;
    return tokens;
  } catch(e) { c.logErr('loadTokens', e); _tokenCache = {}; return {}; }
}

async function saveToken(slackUserId, refreshToken) {
  if (_tokenCache) _tokenCache[slackUserId] = refreshToken;
  if (!c.useSupabase) {
    var tokens = _tokenCache || c.readJSON('user_tokens.json', {});
    tokens[slackUserId] = refreshToken;
    c.writeJSON('user_tokens.json', tokens);
    return;
  }
  try {
    await c.getClient().from('user_tokens').upsert({
      slack_user_id: slackUserId,
      refresh_token: refreshToken,
      updated_at: new Date().toISOString(),
    });
  } catch(e) { c.logErr('saveToken', e); }
}

async function removeToken(slackUserId) {
  if (_tokenCache) delete _tokenCache[slackUserId];
  if (!c.useSupabase) {
    var tokens = _tokenCache || c.readJSON('user_tokens.json', {});
    delete tokens[slackUserId];
    c.writeJSON('user_tokens.json', tokens);
    return;
  }
  try {
    await c.getClient().from('user_tokens').delete().eq('slack_user_id', slackUserId);
  } catch(e) { c.logErr('removeToken', e); }
}

function getTokenCache() { return _tokenCache || {}; }

module.exports = { loadTokens: loadTokens, saveToken: saveToken, removeToken: removeToken, getTokenCache: getTokenCache };
