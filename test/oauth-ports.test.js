'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var oauth = require('../src/handlers/oauthHandler');

test('resolveListenPorts: locale → 3000; OAUTH_PORT esplicita; Railway → PORT + 3000', function() {
  assert.deepEqual(oauth.resolveListenPorts({}), [3000]);
  assert.deepEqual(oauth.resolveListenPorts({ OAUTH_PORT: '4000' }), [4000]);
  assert.deepEqual(oauth.resolveListenPorts({ PORT: '8080' }), [8080]);
  assert.deepEqual(oauth.resolveListenPorts({ PORT: '8080', RAILWAY_PROJECT_ID: 'x' }), [8080, 3000]);
  assert.deepEqual(oauth.resolveListenPorts({ PORT: '3000', RAILWAY_PROJECT_ID: 'x' }), [3000]);
  assert.deepEqual(oauth.resolveListenPorts({ PORT: '8080', OAUTH_PORT: '3000' }), [8080, 3000]);
});

test('checkPublicReachability: 200 ok, 502 ko, localhost saltato', async function() {
  var ok = await oauth.checkPublicReachability({ redirectUri: 'https://giuno.example/oauth/callback', fetch: async function(u) { assert.equal(u, 'https://giuno.example/healthz'); return { status: 200 }; } });
  assert.equal(ok.ok, true);
  var ko = await oauth.checkPublicReachability({ redirectUri: 'https://giuno.example/oauth/callback', fetch: async function() { return { status: 502 }; } });
  assert.equal(ko.ok, false);
  assert.equal(ko.status, 502);
  assert.match(oauth.publicUnreachableMessage(ko, [8080, 3000]), /Networking[\s\S]*8080, 3000/);
  var skipped = await oauth.checkPublicReachability({ redirectUri: 'http://localhost:3000/oauth/callback' });
  assert.equal(skipped.skipped, true);
});
