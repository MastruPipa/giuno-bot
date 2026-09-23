'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var ha = require('../src/agents/hoursAttribution');

test('findOrphanTasks: solo task con ore e senza progetto', function() {
  var o = ha.findOrphanTasks([{ id: 'e1', slack_user_id: 'U1', date: '2026-09-09', oggi_tasks: [
    { task: 'call Mandorle', hours: 1, project_id: 'p1' }, { task: 'admin varie', hours: 1, minutes: 30 }, { task: 'niente ore' }, null,
  ] }]);
  assert.equal(o.length, 1); assert.equal(o[0].hours, 1.5); assert.equal(o[0].index, 1); assert.equal(o[0].user_id, 'U1');
});

test('attributeOrphans: riprova il match, aggiorna il daily e il consuntivo; il resto resta orfano', async function() {
  var updates = [], synced = [];
  var entries = [
    { id: 'e1', slack_user_id: 'U1', date: '2026-09-09', source: 'daily', oggi_tasks: [{ task: 'landing Vinokilo', hours: 3 }, { task: 'riunione interna', hours: 1 }], domani_tasks: [] },
    { id: 'e2', slack_user_id: 'U2', date: '2026-09-08', source: 'estimate', oggi_tasks: [{ task: 'tutto già agganciato', hours: 2, project_id: 'p9' }] },
  ];
  var supabase = { from: function(table) { assert.equal(table, 'standup_entries'); return { update: function(row) { return { eq: async function(_, id) { updates.push({ id: id, row: row }); return {}; } }; } }; } };
  var matcher = { enrichTasksWithProjects: async function(tasks, o) { assert.equal(o.llmFallback, false); tasks.forEach(function(t) { if (/vinokilo/i.test(t.task)) { t.project_id = 'p_vk'; t.project_name = 'Vinokilo'; } }); return tasks; } };
  var r = await ha.attributeOrphans({ entries: entries, llm: false, deps: { supabase: supabase, matcher: matcher, syncTimeLogs: async function(uid, date, structured, opts) { synced.push({ uid: uid, date: date, n: structured.oggi.length, estimate: opts.estimate }); } } });
  assert.equal(r.entries, 2); assert.equal(r.orphans, 2); assert.equal(r.resolved, 1); assert.equal(r.still.length, 1);
  assert.equal(updates.length, 1); assert.equal(updates[0].row.oggi_tasks[0].project_id, 'p_vk');
  assert.deepEqual(synced, [{ uid: 'U1', date: '2026-09-09', n: 2, estimate: false }]);
  assert.equal(r.byUser.U1, 1);
  assert.match(ha.formatReport(r), /2 task senza progetto, 1 attribuiti ora, 1 ancora orfani[\s\S]*<@U1>: 1h senza progetto — "riunione interna"/);
  // anteprima: niente scritture
  updates.length = 0;
  var entries2 = [{ id: 'e3', slack_user_id: 'U1', date: '2026-09-09', oggi_tasks: [{ task: 'landing Vinokilo', hours: 3 }] }];
  var r2 = await ha.attributeOrphans({ entries: entries2, apply: false, llm: false, deps: { supabase: supabase, matcher: matcher, syncTimeLogs: async function() { throw new Error('non deve sincronizzare'); } } });
  assert.equal(r2.resolved, 1); assert.equal(updates.length, 0);
});

test('la sincronizzazione di default esiste davvero (il 18-22/9 il job falliva con "sync is not a function")', function() {
  process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || 'x';
  process.env.SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || 'x';
  process.env.SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN || 'x';
  var Module = require('module');
  var boltPath = require.resolve('@slack/bolt');
  if (!require.cache[boltPath]) {
    var stub = new Module(boltPath); stub.filename = boltPath; stub.loaded = true;
    stub.exports = { App: function StubApp() { this.client = {}; this.error = function() {}; } };
    require.cache[boltPath] = stub;
  }
  assert.equal(typeof require('../src/handlers/dailyStandupV2').syncTimeLogsFromDaily, 'function');
});

test('sameLedger: confronta progetti e ore, ignora le righe dell\'altro tipo (stima vs reale)', function() {
  var expected = [{ project_id: 'p1', hours: 2 }, { project_id: 'p2', hours: 1.5 }];
  assert.equal(ha.sameLedger(expected, [{ project_id: 'p1', hours: '2.00' }, { project_id: 'p2', hours: '1.50' }], false), true);
  assert.equal(ha.sameLedger(expected, [{ project_id: 'p1', hours: '2.00' }], false), false, 'manca p2');
  assert.equal(ha.sameLedger(expected, [{ project_id: 'p1', hours: '2.00' }, { project_id: 'p2', hours: '1.50' }, { project_id: 'p3', hours: '1' }], false), false, 'riga in più');
  assert.equal(ha.sameLedger(expected, [{ project_id: 'p1', hours: '2.00' }, { project_id: 'p2', hours: '1.50' }, { project_id: 'p3', hours: '1', validation: { status: 'estimate' } }], false), true, 'la stima non conta per un daily vero');
  assert.equal(ha.sameLedger(expected, [{ project_id: 'p1', hours: '2.00' }, { project_id: 'p2', hours: '1.50' }], true), false, 'per una stima contano solo le righe stimate');
});

test('reconcileLedger: risincronizza solo i daily il cui registro non torna, con il flag stima giusto', async function() {
  var synced = [];
  var entries = [
    { id: 'e1', slack_user_id: 'U1', date: '2026-09-17', source: 'modal', oggi_tasks: [{ task: 'a', hours: 1, project_id: 'cat_riunioni_team' }, { task: 'b', hours: 4, project_id: 'p_elfo' }, { task: 'c', hours: 1, minutes: 30, project_id: 'p_club' }] },
    { id: 'e2', slack_user_id: 'U2', date: '2026-09-17', source: 'modal', oggi_tasks: [{ task: 'ok', hours: 6, minutes: 30, project_id: 'p_ok' }] },
    { id: 'e3', slack_user_id: 'U3', date: '2026-09-18', source: 'estimate', oggi_tasks: [{ task: 'stima', hours: 5, project_id: 'p_x' }] },
    { id: 'e4', slack_user_id: 'U4', date: '2026-09-18', source: 'dm', oggi_tasks: [{ task: 'senza progetto', hours: 3 }] },
  ];
  var ledger = {
    'U1|2026-09-17': [{ project_id: 'cat_riunioni_team', hours: '1.00' }, { project_id: 'p_club', hours: '1.00' }],
    'U2|2026-09-17': [{ project_id: 'p_ok', hours: '6.50' }],
    'U3|2026-09-18': [],
  };
  var db = { getLogsForUserDate: async function(u, d) { return ledger[u + '|' + d] || []; } };
  var r = await ha.reconcileLedger({ entries: entries, apply: true, deps: { supabase: {}, db: db, syncTimeLogs: async function(uid, date, structured, opts) { synced.push({ uid: uid, date: date, n: structured.oggi.length, estimate: opts.estimate }); } } });
  assert.equal(r.entries, 4); assert.equal(r.checked, 3);
  assert.deepEqual(synced, [{ uid: 'U1', date: '2026-09-17', n: 3, estimate: false }, { uid: 'U3', date: '2026-09-18', n: 1, estimate: true }]);
  assert.equal(r.realigned, 2); assert.equal(r.realignedHours, 9.5);
  assert.deepEqual(r.rows, [{ user_id: 'U1', date: '2026-09-17', before: 2, after: 6.5 }, { user_id: 'U3', date: '2026-09-18', before: 0, after: 5 }]);
  // anteprima: conta ma non scrive
  synced.length = 0;
  var r2 = await ha.reconcileLedger({ entries: entries, apply: false, deps: { supabase: {}, db: db, syncTimeLogs: async function() { throw new Error('non deve scrivere'); } } });
  assert.equal(r2.realigned, 2); assert.equal(synced.length, 0);
});
