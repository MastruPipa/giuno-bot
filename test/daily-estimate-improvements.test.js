'use strict';

process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || 'x';
process.env.SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || 'x';
process.env.SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN || 'x';

var test = require('node:test');
var Module = require('module');
var boltPath = require.resolve('@slack/bolt');
if (!require.cache[boltPath]) {
  var stub = new Module(boltPath); stub.filename = boltPath; stub.loaded = true;
  stub.exports = { App: function StubApp() { this.client = {}; this.error = function() {}; } };
  require.cache[boltPath] = stub;
}
var assert = require('node:assert/strict');
var est = require('../src/agents/dailyEstimator');

var fakeDb = { getLogsForUserDate: async function() { return []; }, getProject: async function(id) { return { id: id, name: id === 'attio_1' ? 'Gambino Vini · Social' : 'Tarocco' }; } };
var recentSb = { from: function() { return { select: function() { return { eq: function() { return { gte: function() { return { limit: async function() { return { data: [{ project_id: 'attio_1', hours: 6, log_date: '2026-09-08' }, { project_id: 'attio_2', hours: 2, log_date: '2026-09-05' }] }; } }; } }; } }; } }; } };

test('diagnosi: per una persona senza tracce dice quale fonte era vuota e perché (token, admin, canali)', async function() {
  var dayContext = { users: [{ id: 'U_PAOLO', name: 'Paolo Spartano', email: 'paolo@katania.it' }], slackByUser: {}, driveByEmail: {}, driveByName: {}, driveEvents: { byEmail: {}, byName: {} }, figmaByEmail: {}, figmaByName: {}, figmaEvents: { byEmail: {}, byName: {} }, adminEvents: [] };
  var noTokens = { getUserTokens: function() { return {}; } };
  var why = await est.explainMissing('U_PAOLO', '2026-09-11', { db: fakeDb, app: { client: {} }, dayContext: dayContext, gauth: noTokens, roles: [], env: {}, supabase: null, activities: [], recent: [], calibration: null });
  assert.deepEqual(why, [
    'calendario: Google non collegato e nessun admin con Google (inviti non leggibili)',
    'Drive: nessun admin con Google, non leggibile',
    'canali: nessun messaggio suo oggi nei canali dove c\'è Giuno',
    'ricerca Slack: SLACK_USER_TOKEN mancante, vedo solo i canali con Giuno',
    'Figma: FIGMA_TOKEN/FIGMA_TEAM_ID non configurati',
    'email: Google non collegato',
    'nessun "domani" nel daily precedente',
    'nessun piano settimanale',
  ]);
  // con un admin che ha Google e i token impostati, le frasi cambiano
  var withAdmin = { getUserTokens: function() { return { U_ADM: {} }; } };
  var why2 = await est.explainMissing('U_PAOLO', '2026-09-11', { db: fakeDb, app: { client: {} }, dayContext: dayContext, gauth: withAdmin, roles: [{ slack_user_id: 'U_ADM', role: 'admin' }], env: { SLACK_USER_TOKEN: 'x', FIGMA_TOKEN: 'f', FIGMA_TEAM_ID: 't' }, supabase: null, activities: [], recent: [], calibration: null });
  assert.equal(why2[0], 'calendario: Google non collegato e nessun invito da un admin');
  assert.equal(why2[1], 'Drive: nessun file suo oggi (letto con il Google di 1 admin)');
  assert.equal(why2[3], 'ricerca Slack: nessun messaggio suo oggi');
  assert.equal(why2[4], 'Figma: nessuna versione sua oggi');
});

test('attività aperte sulle commesse recenti nel prompt della stima, con il vocabolario', async function() {
  var prompt;
  var fakeClient = { messages: { create: async function(req) { prompt = req.messages[0].content; return { content: [{ type: 'text', text: JSON.stringify({ oggi: [{ task: 'PED settembre 2026: caption e storie', hours: 2, minutes: 0, project: 'Gambino Vini · Social' }], domani: [], blocchi: null, confidence: 'media', note: '' }) }] }; } } };
  var dayContext = { users: [{ id: 'U_GIUSY', name: 'Giusy Russo', email: 'giusy@katania.it' }], slackByUser: { U_GIUSY: [{ channel: 'gambino', text: 'caricate le storie', files: [] }] }, driveByEmail: {}, driveByName: {}, driveEvents: { byEmail: {}, byName: {} }, figmaByEmail: {}, figmaByName: {}, figmaEvents: { byEmail: {}, byName: {} }, adminEvents: [] };
  var activities = [{ id: 'act_ped', project_id: 'attio_1', name: 'PED settembre 2026', status: 'open', vocabulary: ['caption', 'post', 'storie', 'reel'] }, { id: 'act_tpl', project_id: 'attio_1', name: 'PED', status: 'open', recurrence: 'mensile' }, { id: 'act_t', project_id: 'attio_2', name: 'Shooting', status: 'open', vocabulary: ['foto'] }];
  var out = await est.estimateDaily('U_GIUSY', '2026-09-11', { client: fakeClient, db: fakeDb, app: { client: {} }, dayContext: dayContext, calibration: null, supabase: recentSb, activities: activities });
  assert.ok(out);
  assert.match(prompt, /ATTIVITÀ APERTE SULLE COMMESSE RECENTI DELLA PERSONA[\s\S]*- Gambino Vini · Social: PED settembre 2026 \(caption, post, storie, reel\)\n- Tarocco: Shooting \(foto\)/);
  assert.ok(!/PED \(/.test(prompt.split('ATTIVITÀ APERTE')[1]), 'il modello ricorrente non compare');
});

test('stime in sospeso persistite in standup_data.stime, con degradazione se la colonna manca', async function() {
  var c = require('../src/services/db/client');
  var standup = require('../src/services/db/standup');
  var origUse = c.useSupabase, origGet = c.getClient;
  var rows = {}, attempts = [], failOnce = true;
  c.useSupabase = true;
  c.getClient = function() { return { from: function() { return {
    select: function() { return { eq: function() { return { single: async function() { return { data: rows.current || null }; } }; } }; },
    upsert: async function(row) { attempts.push(Object.keys(row).sort().join(',')); if (row.stime && failOnce) { failOnce = false; return { error: { message: 'column "stime" of relation "standup_data" does not exist' } }; } rows.current = row; return {}; },
  }; } }; };
  try {
    var sd = standup.getStandupCache();
    sd.oggi = '2026-09-11'; sd.stime = { U1: { date: '2026-09-11', structured: { oggi: [{ task: 'x', hours: 1 }] } } };
    await standup.saveStandup(sd);
    assert.deepEqual(attempts, ['id,inattesa,oggi,risposte,stime,updated_at', 'id,inattesa,oggi,risposte,updated_at'], 'primo tentativo con stime, poi senza se la colonna manca');
    attempts.length = 0; rows = {};
    await standup.saveStandup(sd);
    assert.deepEqual(attempts, ['id,inattesa,oggi,risposte,stime,updated_at']);
    assert.deepEqual(rows.current.stime.U1.structured.oggi[0].task, 'x');
    var loaded = await standup.loadStandup();
    assert.equal(loaded.stime.U1.date, '2026-09-11');
  } finally { c.useSupabase = origUse; c.getClient = origGet; }
});

test('bottoni rapidi: le commesse recenti della persona come bottoni (max 4), niente senza storico', async function() {
  var dsv2 = require('../src/handlers/dailyStandupV2');
  var recent = [];
  for (var i = 0; i < 6; i++) recent.push({ id: 'p' + i, hours: 6 - i });
  var deps = { context: { recentProjectsFor: async function() { return recent; } }, db: { getProject: async function(id) { return { id: id, name: 'Commessa ' + id.toUpperCase() }; } } };
  var btns = await dsv2.quickProjectButtons('U1', deps);
  assert.equal(btns.length, 4); assert.equal(btns[0].action_id, 'daily_quick_project'); assert.equal(btns[0].value, 'p0'); assert.equal(btns[0].text.text, 'Commessa P0');
  assert.deepEqual(await dsv2.quickProjectButtons('U1', { context: { recentProjectsFor: async function() { return []; } }, db: deps.db }), []);
});

test('diagnosi agli admin in DM: una riga per persona con le cause, più le istruzioni per sbloccare le fonti', async function() {
  var dsv2 = require('../src/handlers/dailyStandupV2');
  var sent = [];
  var n = await dsv2.notifyMissingEstimates([{ id: 'U_PAOLO', name: 'Paolo Spartano' }, { id: 'U_GIANNA', name: 'Gianna' }], '2026-09-11', {
    estimator: { explainMissing: async function(uid) { return uid === 'U_PAOLO' ? ['calendario: Google non collegato e nessun admin con Google (inviti non leggibili)', 'canali: nessun messaggio suo oggi nei canali dove c\'è Giuno'] : []; } },
    roles: [{ slack_user_id: 'U_ANT', role: 'admin' }, { slack_user_id: 'U_X', role: 'member' }],
    app: { client: { chat: { postMessage: async function(m) { sent.push(m); } } } },
  });
  assert.equal(n, 1); assert.equal(sent[0].channel, 'U_ANT');
  assert.match(sent[0].text, /Stime del daily mancanti oggi \(2\)[\s\S]*\*Paolo Spartano\*: calendario: Google non collegato[\s\S]*\*Gianna\*: nessuna fonte vuota registrata[\s\S]*SLACK_USER_TOKEN/);
});

test('stima consumata: sparisce dalla memoria E dallo stato persistito (un riavvio non la ricarica)', function() {
  var standup = require('../src/services/db/standup');
  var d = require('../src/handlers/dailyStandupV2');
  var sd = standup.getStandupCache();
  d.rememberPendingEstimate('U9', '2026-09-12', { oggi: [{ task: 'y', hours: 2 }] });
  assert.ok(sd.stime.U9, 'in standup_data.stime finché è in sospeso');
  assert.ok(d.getPendingEstimate('U9', '2026-09-12'));
  d.clearPendingEstimate('U9');
  assert.equal(sd.stime.U9, undefined, 'via dallo stato persistito');
  assert.equal(d.getPendingEstimate('U9', '2026-09-12'), null, 'e nemmeno la memoria la ripesca');
});
