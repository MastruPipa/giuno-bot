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
