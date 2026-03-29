'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');

function loadOauthHandlerWithToken(token) {
  var prev = process.env.OAUTH_ADMIN_TOKEN;
  if (token == null) delete process.env.OAUTH_ADMIN_TOKEN;
  else process.env.OAUTH_ADMIN_TOKEN = token;

  delete require.cache[require.resolve('../src/handlers/oauthHandler')];
  var mod = require('../src/handlers/oauthHandler');

  if (prev == null) delete process.env.OAUTH_ADMIN_TOKEN;
  else process.env.OAUTH_ADMIN_TOKEN = prev;

  return mod;
}

test('oauth admin guard: protected paths are detected', function() {
  var oauthHandler = loadOauthHandlerWithToken(null);
  assert.equal(oauthHandler.isProtectedPath('/dashboard'), true);
  assert.equal(oauthHandler.isProtectedPath('/metrics'), true);
  assert.equal(oauthHandler.isProtectedPath('/debug/search'), true);
  assert.equal(oauthHandler.isProtectedPath('/oauth/callback'), false);
});

test('oauth admin guard: allows all requests when token is not configured', function() {
  var oauthHandler = loadOauthHandlerWithToken(null);
  var req = { headers: {} };
  var parsed = { query: {} };
  assert.equal(oauthHandler.isAuthorizedAdminRequest(req, parsed), true);
});

test('oauth admin guard: validates x-admin-token or query token', function() {
  var oauthHandler = loadOauthHandlerWithToken('secret-token');

  assert.equal(
    oauthHandler.isAuthorizedAdminRequest({ headers: { 'x-admin-token': 'secret-token' } }, { query: {} }),
    true
  );
  assert.equal(
    oauthHandler.isAuthorizedAdminRequest({ headers: {} }, { query: { token: 'secret-token' } }),
    true
  );
  assert.equal(
    oauthHandler.isAuthorizedAdminRequest({ headers: { 'x-admin-token': 'wrong' } }, { query: {} }),
    false
  );
});
