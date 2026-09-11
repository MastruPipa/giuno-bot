'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var acts = require('../src/services/projectActivities');
var matcher = require('../src/services/projectMatcher');

var PED_SET = { id: 'act_ped9', project_id: 'prj_gambino_social', name: 'PED settembre 2026', status: 'open', period_start: '2026-09-01', period_end: '2026-09-30', template_id: 'act_ped', vocabulary: ['caption', 'post', 'storie', 'reel'] };
var SHOOT = { id: 'act_shoot', project_id: 'prj_gambino_social', name: 'Shooting vendemmia', status: 'open', period_start: '2026-09-10', period_end: '2026-09-20', vocabulary: ['shooting', 'foto', 'riprese'] };
var TEMPLATE = { id: 'act_ped', project_id: 'prj_gambino_social', name: 'PED', status: 'open', recurrence: 'mensile', vocabulary: ['caption', 'post', 'storie', 'reel'] };
var SITO = { id: 'act_sito', project_id: 'prj_gambino_sito', name: 'Home page', status: 'open', vocabulary: [] };

test('tokens e parseSpec: parole vuote fuori, ricorrenza, scadenza e vocabolario letti dal comando', function() {
  assert.deepEqual(acts.tokens('Caption video Gambino per il cliente, 2 ore'), ['caption', 'video', 'gambino']);
  var s = acts.parseSpec('Gambino Vini Social = PED mensile parole: caption, post, storie');
  assert.deepEqual(s, { projectName: 'Gambino Vini Social', name: 'PED', recurrence: 'mensile', period_end: null, vocabulary: ['caption', 'post', 'storie'] });
  var d = acts.parseSpec('Elios = Consegna sito entro 2026-10-15');
  assert.equal(d.name, 'Consegna sito'); assert.equal(d.period_end, '2026-10-15'); assert.equal(d.recurrence, null);
  assert.equal(acts.parseSpec('senza uguale'), null);
  assert.equal(acts.parseSpec('Elios = '), null);
});

test('resolveActivity: una sola aperta → quella; più di una → vince il vocabolario; parità o niente in comune → nessuna; periodi e modelli rispettati', function() {
  var all = [PED_SET, SHOOT, TEMPLATE, SITO];
  // il 5 settembre lo shooting non è ancora iniziato: unica candidata il PED
  assert.equal(acts.resolveActivity('call con il cliente', 'prj_gambino_social', all, '2026-09-05').id, 'act_ped9');
  // il 12 settembre sono due: decide il vocabolario
  assert.equal(acts.resolveActivity('caption video gambino', 'prj_gambino_social', all, '2026-09-12').id, 'act_ped9');
  assert.equal(acts.resolveActivity('selezione foto riprese', 'prj_gambino_social', all, '2026-09-12').id, 'act_shoot');
  assert.equal(acts.resolveActivity('caption per le foto', 'prj_gambino_social', all, '2026-09-12'), null, 'parità → nessuna attribuzione');
  assert.equal(acts.resolveActivity('call con il cliente', 'prj_gambino_social', all, '2026-09-12'), null, 'niente in comune → resta sulla commessa');
  // il modello ricorrente non è mai una candidata; a ottobre non c'è istanza
  assert.equal(acts.resolveActivity('caption', 'prj_gambino_social', all, '2026-10-02'), null);
  assert.equal(acts.resolveActivity('qualsiasi cosa', 'prj_gambino_sito', all, '2026-09-12').id, 'act_sito');
  assert.equal(acts.resolveActivity('x', null, all, '2026-09-12'), null);
});

test('enrichTasks dal matcher: il task con commessa riceve activity_id/activity_name, gli altri restano intatti', async function() {
  var tasks = [
    { task: 'caption video gambino', hours: 1, project_id: 'prj_gambino_social', project_name: 'Gambino Vini · Social' },
    { task: 'call con il cliente', hours: 1, project_id: 'prj_gambino_social' },
    { task: 'senza progetto', hours: 1 },
  ];
  await matcher.enrichTasksWithProjects(tasks, { useLlm: false, activities: [PED_SET, SHOOT, TEMPLATE], date: '2026-09-12' });
  assert.equal(tasks[0].activity_id, 'act_ped9'); assert.equal(tasks[0].activity_name, 'PED settembre 2026');
  assert.equal(tasks[1].activity_id, undefined);
  assert.equal(tasks[2].project_id, undefined);
  var untouched = [{ task: 'caption', hours: 1, project_id: 'prj_gambino_social' }];
  await matcher.enrichTasksWithProjects(untouched, { useLlm: false, activities: false });
  assert.equal(untouched[0].activity_id, undefined, 'activities:false salta il livello');
});

// Supabase finto: tabelle in memoria con le sole operazioni usate dal servizio.
function fakeSupabase(tables) {
  var writes = [];
  function q(table) {
    var rows = tables[table] || [];
    var filters = [];
    var chain = {
      select: function() { return chain; },
      in: function(col, vals) { filters.push(function(r) { return vals.indexOf(r[col]) !== -1; }); return chain; },
      eq: function(col, v) { filters.push(function(r) { return r[col] === v; }); return chain; },
      ilike: function(col, v) { filters.push(function(r) { return String(r[col]).toLowerCase() === String(v).toLowerCase(); }); return chain; },
      gte: function(col, v) { filters.push(function(r) { return r[col] >= v; }); return chain; },
      limit: function() { return chain; },
      single: function() { return chain; },
      insert: function(row) { rows.push(row); tables[table] = rows; writes.push({ table: table, op: 'insert', row: row }); return { select: function() { return { single: async function() { return { data: row }; } }; } }; },
      update: function(patch) { return { eq: async function(col, v) { rows.filter(function(r) { return r[col] === v; }).forEach(function(r) { Object.assign(r, patch); }); writes.push({ table: table, op: 'update', id: v, patch: patch }); return {}; } }; },
      then: function(res) { var out = rows.filter(function(r) { return filters.every(function(f) { return f(r); }); }); return Promise.resolve({ data: out }).then(res); },
    };
    return chain;
  }
  return { from: q, writes: writes, tables: tables };
}

test('rollRecurring: apre l\'istanza del mese corrente dal modello e chiude quella finita; senza apply solo anteprima', async function() {
  var aug = { id: 'act_ped8', project_id: 'prj_gambino_social', name: 'PED agosto 2026', status: 'open', period_start: '2026-08-01', period_end: '2026-08-31', template_id: 'act_ped', vocabulary: [] };
  var sb = fakeSupabase({ project_activities: [Object.assign({}, TEMPLATE), aug] });
  var preview = await acts.rollRecurring({ today: '2026-09-12', deps: { supabase: sb } });
  assert.equal(preview.templates, 1); assert.equal(preview.opened.length, 1); assert.equal(preview.closed.length, 1); assert.equal(sb.writes.length, 0);
  assert.equal(preview.opened[0].name, 'PED settembre 2026'); assert.equal(preview.opened[0].period_end, '2026-09-30');
  assert.match(acts.formatRollReport(preview, false), /apre "PED settembre 2026"[\s\S]*chiude "PED agosto 2026"[\s\S]*Anteprima/);
  var applied = await acts.rollRecurring({ today: '2026-09-12', apply: true, deps: { supabase: sb } });
  var ins = sb.writes.find(function(w) { return w.op === 'insert'; });
  assert.ok(ins && ins.row.template_id === 'act_ped' && ins.row.kind === 'ricorrente' && ins.row.period_start === '2026-09-01', 'istanza creata dal modello');
  assert.deepEqual(ins.row.vocabulary, ['caption', 'post', 'storie', 'reel'], 'eredita il vocabolario');
  assert.equal(sb.tables.project_activities.find(function(a) { return a.id === 'act_ped8'; }).status, 'done');
  assert.equal(applied.opened.length, 1);
  // seconda corsa: niente da fare
  var again = await acts.rollRecurring({ today: '2026-09-12', apply: true, deps: { supabase: sb } });
  assert.equal(again.opened.length, 0); assert.equal(again.closed.length, 0);
});

test('reattach: aggancia le microtask con commessa ma senza attività, impara le parole, elenca le orfane per commessa', async function() {
  var entries = [
    { id: 1, slack_user_id: 'U_GIUSY', date: '2026-09-11', oggi_tasks: [{ task: 'caption video gambino', hours: 2, project_id: 'prj_gambino_social' }, { task: 'call con il cliente', hours: 1, project_id: 'prj_gambino_social' }, { task: 'daily team', hours: 0, minutes: 15, project_id: 'cat_riunioni_team' }] },
    { id: 2, slack_user_id: 'U_LUCA', date: '2026-09-11', oggi_tasks: [{ task: 'montaggio reel vendemmia gambino', hours: 3, project_id: 'prj_gambino_social', activity_id: 'act_ped9', activity_name: 'PED settembre 2026' }] },
  ];
  var sb = fakeSupabase({ project_activities: [JSON.parse(JSON.stringify(PED_SET)), JSON.parse(JSON.stringify(SHOOT))], standup_entries: entries });
  var r = await acts.reattach({ days: 14, apply: true, deps: { supabase: sb } });
  assert.equal(r.entries, 2); assert.equal(r.tasks, 2); assert.equal(r.attached, 1);
  assert.equal(entries[0].oggi_tasks[0].activity_id, 'act_ped9');
  assert.ok(sb.writes.some(function(w) { return w.table === 'standup_entries' && w.id === 1; }), 'il daily viene riscritto');
  assert.equal(r.orphans.length, 1); assert.equal(r.orphans[0].task, 'call con il cliente');
  assert.equal(r.byProject.prj_gambino_social.hours, 1);
  // apprendimento: "montaggio", "vendemmia", "gambino", "video" entrano nel vocabolario del PED (non le parole vuote)
  var ped = sb.tables.project_activities.find(function(a) { return a.id === 'act_ped9'; });
  ['montaggio', 'vendemmia', 'gambino', 'video'].forEach(function(w) { assert.ok(ped.vocabulary.indexOf(w) !== -1, w); });
  assert.equal(r.learned, 1);
  assert.match(acts.formatReattachReport(r, true), /1 agganciate[\s\S]*Gambino|prj_gambino_social/);
  // "vendemmia" l'ha imparata anche il PED, ma lo shooting la porta nel nome e ha "foto": 2 a 1, vince lo shooting
  assert.equal(acts.resolveActivity('foto vendemmia', 'prj_gambino_social', sb.tables.project_activities, '2026-09-12').id, 'act_shoot');
  // parità vera (una parola a testa) → nessuna attribuzione
  assert.equal(acts.resolveActivity('foto per il post', 'prj_gambino_social', sb.tables.project_activities, '2026-09-12'), null);
});

test('createActivity: idempotente su commessa+nome+periodo; senza database errore chiaro', async function() {
  var sb = fakeSupabase({ project_activities: [] });
  var a = await acts.createActivity({ project_id: 'prj_x', name: 'Landing', vocabulary: ['Home', 'wireframe'], created_by: 'U1' }, { supabase: sb });
  assert.equal(a.existed, false); assert.deepEqual(a.activity.vocabulary, ['home', 'wireframe']); assert.equal(a.activity.kind, 'consegna');
  var b = await acts.createActivity({ project_id: 'prj_x', name: 'landing' }, { supabase: sb });
  assert.equal(b.existed, true); assert.equal(b.activity.id, a.activity.id);
  var t = await acts.createActivity({ project_id: 'prj_x', name: 'PED', recurrence: 'mensile' }, { supabase: sb });
  assert.equal(t.activity.kind, 'ricorrente'); assert.equal(t.activity.recurrence, 'mensile');
  assert.match((await acts.createActivity({ project_id: 'prj_x', name: 'y' }, { supabase: null })).error, /Database/);
  assert.match((await acts.createActivity({ name: 'y' }, { supabase: sb })).error, /commessa/);
});
