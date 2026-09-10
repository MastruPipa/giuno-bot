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

test('send_campaign: avvia la campagna e riferisce controllo e solleciti', async function() {
  posted = [];
  var denied = await slackTools.execute('send_campaign', { message: 'ciao', target_user_names: ['Paolo'] }, 'U2', 'manager');
  assert.match(denied.error, /Solo gli admin/);
  var out = await slackTools.execute('send_campaign', { message: 'Rispondete LETTO', target_user_names: ['Paolo', 'Samuele'], expected_reply: 'LETTO', check_after_minutes: 60, max_pushes: 2 }, 'U1', 'admin');
  assert.equal(out.success, true);
  assert.deepEqual(out.sent_to, ['Paolo Spartano', 'Samuele Licciardello']);
  assert.match(out.message, /primo controllo tra 60 minuti, massimo 2 solleciti/);
  assert.equal(posted.length, 2);
});

test('team_member_joined / team_member_left passano dal roster', async function() {
  var db = require('../supabase');
  var ups = [], deact = [];
  var origUp = db.upsertTeamMember, origDe = db.deactivateTeamMember, origFind = db.findTeamMemberByName;
  db.upsertTeamMember = async function(r) { ups.push(r); return r; };
  db.deactivateTeamMember = async function(id) { deact.push(id); return true; };
  db.findTeamMemberByName = function(n) { return /nicol/i.test(n) ? { slack_user_id: 'U_NIC', canonical_name: 'Nicolò Paolucci' } : null; };
  try {
    var j = await slackTools.execute('team_member_joined', { name: 'Samuele', role: 'Video content' }, 'U1', 'admin');
    assert.equal(j.success, true);
    assert.equal(ups[0].slack_user_id, 'U3');
    assert.equal(ups[0].role, 'Video content');
    var l = await slackTools.execute('team_member_left', { name: 'Nicolò' }, 'U1', 'manager');
    assert.match(l.message, /Nicolò Paolucci segnato come uscito/);
    assert.deepEqual(deact, ['U_NIC']);
    var no = await slackTools.execute('team_member_left', { name: 'Nicolò' }, 'U1', 'member');
    assert.match(no.error, /Solo admin/);
  } finally { db.upsertTeamMember = origUp; db.deactivateTeamMember = origDe; db.findTeamMemberByName = origFind; }
});

test('send_dm: stesso testo alla stessa persona entro 30 minuti non viene rimandato (force=true sì)', async function() {
  slackTools._resetDmDedupForTests();
  posted = [];
  var a = await slackTools.execute('send_dm', { target_user_ids: ['U2', 'U3'], message: 'Ciao team, rispondete LETTO' }, 'U1', 'admin');
  assert.equal(a.sent.length, 2);
  var b = await slackTools.execute('send_dm', { target_user_ids: ['U2', 'U3'], message: 'Ciao team,  rispondete LETTO' }, 'U1', 'admin');
  assert.equal(b.success, true);
  assert.equal(b.already_sent.length, 2);
  assert.match(b.message, /NON rimandato/);
  assert.equal(posted.length, 2, 'nessun nuovo DM');
  var c = await slackTools.execute('send_dm', { target_user_ids: ['U2'], message: 'Ciao team, rispondete LETTO', force: true }, 'U1', 'admin');
  assert.equal(c.sent.length, 1);
  assert.equal(posted.length, 3);
  slackTools._resetDmDedupForTests();
});

test('check_dm_replies: legge i DM di Giuno e distingue chi ha confermato', async function() {
  var nowSec = Math.floor(Date.now() / 1000);
  slackService.app.client.conversations.history = async function(a) {
    if (a.channel === 'D_U2') return { messages: [{ user: 'U2', text: 'LETTO, grazie', ts: String(nowSec - 60) }, { user: 'UBOT', bot_id: 'B1', text: 'msg', ts: String(nowSec - 120) }] };
    if (a.channel === 'D_U3') return { messages: [{ user: 'U3', text: 'una domanda: vale anche il venerdì?', ts: String(nowSec - 30) }] };
    return { messages: [] };
  };
  var noManager = await slackTools.execute('check_dm_replies', { target_user_names: ['Paolo'] }, 'U1', 'manager');
  assert.match(noManager.error, /Solo gli admin/);
  var out = await slackTools.execute('check_dm_replies', { target_user_names: ['Paolo', 'Samuele', 'Antonio'], expected_reply: 'LETTO', since_minutes: 120 }, 'U1', 'admin');
  assert.equal(out.checked, 3);
  assert.deepEqual(out.confirmed, ['Paolo Spartano']);
  assert.deepEqual(out.missing, ['Samuele Licciardello', 'Antonio Paratore']);
  var sam = out.details.find(function(d) { return d.user_id === 'U3'; });
  assert.equal(sam.replied, true);
  assert.equal(sam.confirmed, false);
  delete slackService.app.client.conversations.history;
});

test('privacy: campaign_status solo admin, testo delle risposte solo al creatore; read_channel su DM solo admin', async function() {
  var campaignsDb = require('../src/services/db/campaigns');
  var orig = campaignsDb.getCampaign;
  campaignsDb.getCampaign = async function() { return { id: 'cmp_x', status: 'active', created_by: 'U1', title: 't', max_pushes: 2, recipients: [{ user_id: 'U2', name: 'Paolo', status: 'replied', reply_text: 'LETTO ma ho un dubbio personale' }] }; };
  try {
    var denied = await slackTools.execute('campaign_status', { campaign_id: 'cmp_x' }, 'U2', 'manager');
    assert.match(denied.error, /Solo gli admin/);
    var creator = await slackTools.execute('campaign_status', { campaign_id: 'cmp_x' }, 'U1', 'admin');
    assert.equal(creator.campaign.recipients[0].reply_text, 'LETTO ma ho un dubbio personale');
    var otherAdmin = await slackTools.execute('campaign_status', { campaign_id: 'cmp_x' }, 'U9', 'admin');
    assert.equal(otherAdmin.campaign.recipients[0].reply_text, undefined);
    assert.equal(otherAdmin.campaign.recipients[0].status, 'replied');
  } finally { campaignsDb.getCampaign = orig; }
  var dm = await slackTools.execute('read_channel', { channel_id: 'D0ANFQUUFV3' }, 'U2', 'member');
  assert.match(dm.error, /privati/);
});
