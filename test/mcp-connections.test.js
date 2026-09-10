'use strict';

// Ciclo OAuth verso un server MCP (Higgsfield) senza rete: fetch stubbato,
// persistenza disattivata, stato in memoria azzerato.

var test = require('node:test');
var assert = require('node:assert/strict');
var crypto = require('crypto');

var dbClient = require('../src/services/db/client');
dbClient.useSupabase = false;
dbClient.writeJSON = function() {};
dbClient.readJSON = function(_, def) { return def; };

var mcp = require('../src/services/mcpConnections');

var META = {
  authorization_endpoint: 'https://mcp.example.test/oauth2/authorize',
  token_endpoint: 'https://mcp.example.test/oauth2/token',
  registration_endpoint: 'https://mcp.example.test/oauth2/register',
};
var ORIGIN = new URL(mcp.getServer('higgsfield').mcpUrl).origin;

function seedMeta() { var m = {}; m[ORIGIN] = META; return m; }

function stubFetch(handler) {
  var calls = [];
  global.fetch = async function(url, opts) {
    calls.push({ url: String(url), opts: opts || {} });
    var out = await handler(String(url), opts || {});
    var status = out.status || 200;
    return { ok: status < 400, status: status, text: async function() { return JSON.stringify(out.body || {}); } };
  };
  return calls;
}

test('makePkce: verifier url-safe e challenge S256 coerente', function() {
  var p = mcp.makePkce();
  assert.match(p.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  var expected = crypto.createHash('sha256').update(p.verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(p.challenge, expected);
});

test('buildAuthorizeUrl: parametri OAuth 2.1 + resource', function() {
  var u = new URL(mcp.buildAuthorizeUrl(META, { clientId: 'cid', redirectUri: 'https://g.test/oauth/mcp/higgsfield/callback', scope: 'openid', state: 's1', challenge: 'ch', resource: 'https://mcp.example.test/mcp' }));
  assert.equal(u.origin + u.pathname, META.authorization_endpoint);
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('code_challenge'), 'ch');
  assert.equal(u.searchParams.get('resource'), 'https://mcp.example.test/mcp');
  assert.equal(u.searchParams.get('state'), 's1');
});

test('isExpired: senza token è scaduto, senza scadenza no, margine di 60s', function() {
  var now = Date.parse('2026-09-10T10:00:00Z');
  assert.equal(mcp.isExpired(null, now), true);
  assert.equal(mcp.isExpired({ access_token: 'a' }, now), false);
  assert.equal(mcp.isExpired({ access_token: 'a', expires_at: '2026-09-10T10:00:30Z' }, now), true);
  assert.equal(mcp.isExpired({ access_token: 'a', expires_at: '2026-09-10T11:00:00Z' }, now), false);
});

test('redirectUriFor: stessa origine del callback Google', function() {
  assert.equal(mcp.redirectUriFor('higgsfield', 'https://giuno.up.railway.app/oauth/callback'), 'https://giuno.up.railway.app/oauth/mcp/higgsfield/callback');
});

test('startAuth + handleCallback: registra il client, scambia il code con PKCE, salva i token', async function() {
  mcp._resetForTests({ metadata: seedMeta() });
  var calls = stubFetch(async function(url, opts) {
    if (url === META.registration_endpoint) {
      var reg = JSON.parse(opts.body);
      assert.equal(reg.token_endpoint_auth_method, 'none');
      assert.deepEqual(reg.redirect_uris, ['https://giuno.test/oauth/mcp/higgsfield/callback']);
      return { body: { client_id: 'client-123' } };
    }
    if (url === META.token_endpoint) {
      var body = new URLSearchParams(opts.body);
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(body.get('code'), 'CODE');
      assert.equal(body.get('client_id'), 'client-123');
      assert.ok(body.get('code_verifier'));
      assert.equal(body.get('resource'), mcp.getServer('higgsfield').mcpUrl);
      return { body: { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600 } };
    }
    throw new Error('fetch inatteso ' + url);
  });

  var authUrl = await mcp.startAuth('higgsfield', { slackUserId: 'U_ADMIN', googleRedirectUri: 'https://giuno.test/oauth/callback' });
  var u = new URL(authUrl);
  var state = u.searchParams.get('state');
  assert.ok(state);
  assert.equal(u.searchParams.get('client_id'), 'client-123');
  assert.equal(mcp.getStatus('higgsfield').registered, true);
  assert.equal(mcp.getStatus('higgsfield').connected, false);

  var res = await mcp.handleCallback('CODE', state);
  assert.equal(res.slackUserId, 'U_ADMIN');
  var st = mcp.getStatus('higgsfield');
  assert.equal(st.connected, true);
  assert.equal(st.connected_by, 'U_ADMIN');
  assert.equal(st.has_refresh, true);
  assert.equal(await mcp.getAccessToken('higgsfield'), 'AT1');
  assert.equal(calls.length, 2);

  await assert.rejects(mcp.handleCallback('CODE', state), /sconosciuto o scaduto/);
});

test('getAccessToken: rinnova col refresh token quando scaduto; refresh respinto → da ricollegare', async function() {
  mcp._resetForTests({
    metadata: seedMeta(),
    connections: { higgsfield: { name: 'higgsfield', client_id: 'c', access_token: 'OLD', refresh_token: 'RT', expires_at: '2020-01-01T00:00:00Z' } },
  });
  stubFetch(async function(url, opts) {
    var body = new URLSearchParams(opts.body);
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), 'RT');
    return { body: { access_token: 'NEW', expires_in: 600 } };
  });
  assert.equal(await mcp.getAccessToken('higgsfield'), 'NEW');
  assert.equal(mcp.getStatus('higgsfield').has_refresh, true, 'senza nuovo refresh token tiene il vecchio');

  mcp._resetForTests({
    metadata: seedMeta(),
    connections: { higgsfield: { name: 'higgsfield', client_id: 'c', access_token: 'OLD', refresh_token: 'RT', expires_at: '2020-01-01T00:00:00Z' } },
  });
  stubFetch(async function() { return { status: 401, body: { error: 'invalid_grant' } }; });
  assert.equal(await mcp.getAccessToken('higgsfield'), null);
  var st = mcp.getStatus('higgsfield');
  assert.equal(st.connected, false);
  assert.equal(st.needs_reconnect, true);
});

test('disconnect: butta i token ma tiene il client', async function() {
  mcp._resetForTests({ connections: { higgsfield: { name: 'higgsfield', client_id: 'c', access_token: 'A', refresh_token: 'R' } } });
  await mcp.disconnect('higgsfield');
  var st = mcp.getStatus('higgsfield');
  assert.equal(st.connected, false);
  assert.equal(st.registered, true);
});
