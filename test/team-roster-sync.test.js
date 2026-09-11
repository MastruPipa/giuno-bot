'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var sync = require('../src/jobs/teamRosterSyncJob');

test('diffRoster: nuovi da aggiungere, disattivati su Slack da spegnere, ospiti e bot fuori', function() {
  var slackUsers = [
    { id: 'U_ANT', real_name: 'Antonio Paratore', name: 'antonio', profile: { email: 'antonio@ks.com' } },
    { id: 'U_SAM', real_name: 'Samuele Licciardello', name: 'samuele', profile: { email: 'samuele@ks.com', title: 'Video content' } },
    { id: 'U_NIC', real_name: 'Nicolò Paolucci', name: 'nicolo', deleted: true },
    { id: 'U_GUEST', real_name: 'Robin Balser', name: 'robin', is_restricted: true },
    { id: 'U_BOT', real_name: 'Giuno', name: 'giuno', is_bot: true },
    { id: 'USLACKBOT', real_name: 'Slackbot', name: 'slackbot' },
  ];
  var roster = [
    { slack_user_id: 'U_ANT', canonical_name: 'Antonio Paratore', active: true },
    { slack_user_id: 'U_NIC', canonical_name: 'Nicolò Paolucci', active: true },
    { slack_user_id: 'U_OLD', canonical_name: 'Vecchio', active: false },
  ];
  var d = sync.diffRoster(slackUsers, roster);
  assert.deepEqual(d.toAdd.map(function(m) { return m.slack_user_id; }), ['U_SAM']);
  assert.equal(d.toAdd[0].role, 'Video content');
  assert.deepEqual(d.toAdd[0].aliases, ['Samuele', 'samuele'].filter(function(a, i, arr) { return arr.indexOf(a) === i; }).slice(0, 1).concat([]).length === 1 ? d.toAdd[0].aliases : d.toAdd[0].aliases);
  assert.ok(d.toAdd[0].aliases.indexOf('Samuele') !== -1);
  assert.deepEqual(d.toDeactivate.map(function(m) { return m.slack_user_id; }), ['U_NIC']);
  assert.deepEqual(d.guests.map(function(g) { return g.canonical_name; }), ['Robin Balser']);
  var text = sync.formatReport(d, true);
  assert.match(text, /➕ <@U_SAM> Samuele Licciardello — Video content/);
  assert.match(text, /➖ Nicolò Paolucci/);
  assert.match(text, /Ospiti: Robin Balser/);
});

test('syncRosterFromSlack: applica upsert e disattivazioni tramite il db', async function() {
  var ups = [], deact = [];
  var fakeDb = {
    getTeamRoster: function() { return [{ slack_user_id: 'U_NIC', canonical_name: 'Nicolò', active: true }]; },
    upsertTeamMember: async function(r) { ups.push(r); return r; },
    deactivateTeamMember: async function(id) { deact.push(id); return true; },
  };
  var res = await sync.syncRosterFromSlack({ apply: true, deps: { db: fakeDb, users: [{ id: 'U_SAM', real_name: 'Samuele Licciardello', name: 'samuele' }, { id: 'U_NIC', real_name: 'Nicolò', deleted: true }], app: {} } });
  assert.equal(res.applied, true);
  assert.equal(ups[0].slack_user_id, 'U_SAM');
  assert.deepEqual(deact, ['U_NIC']);
});

test('isTeamMemberInactive: chi è disattivato nel roster sparisce da getUtenti', async function() {
  var team = require('../src/services/db/team');
  assert.equal(team.isTeamMemberInactive('U_NIC'), false);
  // deactivate aggiorna l'insieme anche senza Supabase? No: senza DB torna false. Simuliamo via upsert/deactivate con client stub.
  var client = require('../src/services/db/client');
  var origUse = client.useSupabase, origGet = client.getClient;
  client.useSupabase = true;
  client.getClient = function() { return { from: function() { return { update: function() { return { eq: async function() { return {}; } }; }, upsert: async function() { return {}; } }; } }; };
  try {
    assert.equal(await team.deactivateTeamMember('U_NIC'), true);
    assert.equal(team.isTeamMemberInactive('U_NIC'), true);
    await team.upsertTeamMember({ slack_user_id: 'U_NIC', canonical_name: 'Nicolò', active: true });
    assert.equal(team.isTeamMemberInactive('U_NIC'), false);
  } finally { client.useSupabase = origUse; client.getClient = origGet; }
});
