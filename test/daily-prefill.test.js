'use strict';

process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || 'x';
process.env.SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || 'x';
process.env.SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN || 'x';

var test = require('node:test');
var assert = require('node:assert/strict');
var Module = require('module');
var boltPath = require.resolve('@slack/bolt');
if (!require.cache[boltPath]) {
  var stub = new Module(boltPath); stub.filename = boltPath; stub.loaded = true;
  stub.exports = { App: function StubApp() { this.client = {}; this.error = function() {}; } };
  require.cache[boltPath] = stub;
}
var dsv2 = require('../src/handlers/dailyStandupV2');

test('prefillFromEstimate: righe del modale dalla stima, ore ai quarti, progetto nel testo', function() {
  var pre = dsv2.prefillFromEstimate({
    oggi: [{ task: 'Call Aitho', hours: 1, minutes: 0 }, { task: 'Grafiche Elfo', hours: 2, minutes: 20, project: 'Elfo' }],
    domani: [{ task: 'Revisione', hours: 0, minutes: 0 }], blocchi: null,
  });
  assert.deepEqual(pre.oggi, [{ task: 'Call Aitho', hours: 1 }, { task: 'Grafiche Elfo [Elfo]', hours: 2.25 }]);
  assert.deepEqual(pre.domani, [{ task: 'Revisione', hours: 0 }]);
  assert.equal(dsv2.prefillFromEstimate(null), null);
  assert.equal(dsv2.prefillFromEstimate({ oggi: [], domani: [] }), null);
});

test('respondedFromDb: chi ha una entry vera oggi conta come presente, le stime no', async function() {
  var clientPath = require.resolve('../src/services/db/client');
  var orig = require.cache[clientPath];
  var fake = new Module(clientPath); fake.filename = clientPath; fake.loaded = true;
  fake.exports = { getClient: function() { return { from: function() { return { select: function() { return { eq: function() { return { limit: async function() { return { data: [
    { slack_user_id: 'U_GIANNA', source: 'modal' }, { slack_user_id: 'U_PAOLO', source: 'estimate' }, { slack_user_id: 'U_SAM', source: 'channel' },
  ] }; } }; } }; } }; } }; }, useSupabase: true, logErr: function() {} };
  require.cache[clientPath] = fake;
  try {
    var r = await dsv2.respondedFromDb('2026-09-10');
    assert.deepEqual(Object.keys(r).sort(), ['U_GIANNA', 'U_SAM']);
    assert.equal(r.U_GIANNA.fromDb, true);
  } finally { if (orig) require.cache[clientPath] = orig; else delete require.cache[clientPath]; }
});
