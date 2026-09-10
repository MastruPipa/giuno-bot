'use strict';

process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || 'x';
process.env.SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || 'x';
process.env.SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN || 'x';
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'cid.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'sec';
process.env.OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI || 'https://giuno.example/oauth/callback';

var test = require('node:test');
var assert = require('node:assert/strict');

var Module = require('module');
var boltPath = require.resolve('@slack/bolt');
var stubBolt = new Module(boltPath);
stubBolt.filename = boltPath;
stubBolt.loaded = true;
stubBolt.exports = { App: function StubApp() { this.client = {}; this.error = function() {}; } };
require.cache[boltPath] = stubBolt;

var slackService = require('../src/services/slackService');
var slackTools = require('../src/tools/slackTools');
var gauth = require('../src/services/googleAuthService');

var posted = [];
slackService.app.client = {
  conversations: { open: async function(a) { return { channel: { id: 'D_' + a.users } }; } },
  chat: { postMessage: async function(a) { posted.push(a); return { ts: '1.' + posted.length }; } },
};
slackService.getUtenti = async function() {
  return [{ id: 'U1', name: 'Antonio Paratore' }, { id: 'U2', name: 'Paolo Spartano' }, { id: 'U3', name: 'Samuele Licciardello' }];
};

test('send_dm: più destinatari in una chiamata, per id e per nome', async function() {
  posted = [];
  var out = await slackTools.execute('send_dm', { target_user_ids: ['U2'], target_user_names: ['Samuele'], message: 'Ciao a tutti' }, 'U1', 'admin');
  assert.equal(out.success, true);
  assert.equal(out.sent.length, 2);
  assert.deepEqual(out.sent.map(function(s) { return s.target; }), ['U2', 'U3']);
  assert.equal(posted.length, 2);
  assert.equal(posted[0].channel, 'D_U2');
  assert.match(out.message, /2 persone/);
});

test('send_dm: destinatario singolo come prima, sconosciuto → errore', async function() {
  posted = [];
  var one = await slackTools.execute('send_dm', { target_user_name: 'Paolo', message: 'ciao' }, 'U1', 'member');
  assert.equal(one.target, 'U2');
  assert.equal(posted.length, 1);
  var none = await slackTools.execute('send_dm', { target_user_name: 'Nessuno', message: 'ciao' }, 'U1', 'member');
  assert.match(none.error, /non trovato/);
});

test('send_dm: dati sensibili → conferma richiesta, poi confirmed=true invia', async function() {
  posted = [];
  var long = 'Il preventivo per il cliente vale €12.000 e va confermato entro venerdì. '.repeat(4);
  var ask = await slackTools.execute('send_dm', { target_user_id: 'U2', message: long }, 'U1', 'admin');
  assert.equal(ask.requires_confirmation, true);
  assert.equal(posted.length, 0);
  var ok = await slackTools.execute('send_dm', { target_user_id: 'U2', message: long, confirmed: true }, 'U1', 'admin');
  assert.equal(ok.success, true);
  assert.equal(posted.length, 1);
});

test('send_google_link: solo ruoli alti, link personale del destinatario in DM', async function() {
  posted = [];
  var denied = await slackTools.execute('send_google_link', { target_user_name: 'Samuele' }, 'U2', 'member');
  assert.match(denied.error, /Solo admin/);
  var origTokens = gauth.getUserTokens;
  gauth.getUserTokens = function() { return { U2: 'rt' }; };
  try {
    var already = await slackTools.execute('send_google_link', { target_user_name: 'Paolo' }, 'U1', 'admin');
    assert.equal(already.already_connected, true);
    var sent = await slackTools.execute('send_google_link', { target_user_name: 'Samuele', note: 'Antonio mi ha chiesto di attivarti.' }, 'U1', 'admin');
    assert.equal(sent.success, true);
    assert.equal(sent.target, 'U3');
    assert.equal(posted.length, 1);
    assert.match(posted[0].text, /accounts\.google\.com/);
    assert.match(posted[0].text, /state=U3/);
    assert.match(posted[0].text, /Ciao Samuele! Antonio mi ha chiesto/);
  } finally { gauth.getUserTokens = origTokens; }
});
