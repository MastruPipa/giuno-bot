'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var resolver = require('../src/services/otherProjectResolver');
var matcher = require('../src/services/projectMatcher');
var dedup = require('../src/jobs/projectDedupJob');

var PROJECTS = [
  { id: 'attio_1', name: 'Gambino Vini · Social', client_name: 'Gambino Vini', status: 'active' },
  { id: 'attio_2', name: 'Tarocco - Lieviti e Magia', client_name: 'Tarocco', status: 'active' },
  { id: 'attio_3', name: 'Elios Sito', client_name: 'Elios Srl', status: 'active' },
  { id: 'attio_4', name: 'Elios Social', client_name: 'Elios Srl', status: 'active' },
  { id: 'cat_management', name: 'Management e direzione', client_name: 'Interno', status: 'active' },
];
var catalog = PROJECTS.map(matcher.catalogEntry);
var db = { created: [], searchProjects: async function() { return []; }, getProject: async function(id) { return PROJECTS.find(function(p) { return p.id === id; }) || null; }, updateProject: async function() { return null; }, createProject: async function(d) { db.created.push(d); return { id: 'prj_new', name: d.name }; } };

test('"Altro" non crea commesse: il testo si aggancia per nome, per cliente nominato (anche con le parole in altro ordine) o alle attività trasversali; altrimenti errore', async function() {
  var deps = { db: db, matcher: matcher, catalog: catalog, supabase: null, activities: [], ask: async function() { return 'NONE'; } };
  var r1 = await resolver.resolveOtherProject('tarocco - lieviti e magia', 'U1', PROJECTS, deps);
  assert.equal(r1.project.id, 'attio_2'); assert.equal(r1.via, 'nome');
  var r2 = await resolver.resolveOtherProject('Tarocco - organizzazione prossimo shooting e onboarding Samuele+ accounting', 'U1', PROJECTS, deps);
  assert.equal(r2.project.id, 'attio_2'); assert.equal(r2.via, 'testo'); assert.equal(r2.created, false);
  var r3 = await resolver.resolveOtherProject('Vini Gambino - riunione con cliente + fix premi + ricerca visiva shooting', 'U1', PROJECTS, deps);
  assert.equal(r3.project.id, 'attio_1', 'parole in altro ordine');
  var r4 = await resolver.resolveOtherProject('Riunione di management con i soci', 'U1', PROJECTS, deps);
  assert.equal(r4.project.id, 'cat_management');
  var r5 = await resolver.resolveOtherProject('Tutte le pubblicazioni e le caption dei contenuti che ancora non le hanno', 'U1', PROJECTS, deps);
  assert.match(r5.error, /Non capisco a quale commessa/);
  var r6 = await resolver.resolveOtherProject('Elios - call di allineamento', 'U1', PROJECTS, deps);
  assert.match(r6.error, /Non capisco a quale commessa/, 'due commesse dello stesso cliente: non si sceglie');
  assert.match((await resolver.resolveOtherProject('x', 'U1', PROJECTS, deps)).error, /almeno 2/);
  assert.equal(db.created.length, 0, 'mai una commessa nuova dal testo libero');
});

test('dedup: le righe nate dal planner finiscono nella commessa che nominano; quelle irriconoscibili restano in lista per il merge a mano; non entrano nei gruppi per somiglianza', async function() {
  var planner = [
    { id: 'prj_a', name: 'Tarocco - organizzazione prossimo shooting e onboarding Samuele+ accounting', status: 'active', tags: ['tipo:progetto', 'fonte:planner'] },
    { id: 'prj_b', name: 'Vini Gambino - riunione con cliente + fix premi + ricerca visiva shooting', status: 'active', description: 'Creato dal Weekly Planner da <@U1>', tags: [] },
    { id: 'prj_c', name: 'Tutte le pubblicazioni e le caption dei contenuti che ancora non le hanno', status: 'active', tags: ['fonte:planner'] },
  ];
  var all = PROJECTS.concat(planner);
  var pp = await dedup.plannerProposals(all, {}, { supabase: null, activities: [], ask: async function() { return 'NONE'; } });
  assert.deepEqual(pp.proposals.map(function(p) { return [p.duplicates[0].id, p.canonical.id]; }), [['prj_a', 'attio_2'], ['prj_b', 'attio_1']]);
  assert.deepEqual(pp.unresolved.map(function(p) { return p.id; }), ['prj_c']);
  var rep = await dedup.runDedup({ projects: all, stats: {}, deps: { client: { useSupabase: false }, supabase: null, activities: [], ask: async function() { return 'NONE'; } } });
  assert.equal(rep.proposals.filter(function(p) { return p.reasons[0].indexOf('planner') === 0; }).length, 0);
  assert.equal(rep.proposals.filter(function(p) { return /creato dal planner/.test(p.reasons[0]); }).length, 2);
  assert.ok(!rep.proposals.some(function(p) { return p.projects.some(function(x) { return x.id === 'prj_c'; }); }), 'la riga irriconoscibile non viene fusa per somiglianza');
  assert.deepEqual(rep.plannerUnresolved.map(function(p) { return p.id; }), ['prj_c']);
  // review Codex: se la commessa nominata è un canale che sta per essere unito a un deal, la riga del planner va sul deal
  var withChan = PROJECTS.concat([{ id: 'chan_t', name: 'Tarocco', client_name: 'Tarocco', status: 'active' }], planner);
  var rep2 = await dedup.runDedup({ projects: withChan, stats: {}, deps: { client: { useSupabase: false }, supabase: null, activities: [], ask: async function() { return 'NONE'; } } });
  var chanMerge = rep2.proposals.find(function(p) { return p.duplicates.some(function(d) { return d.id === 'chan_t'; }); });
  assert.ok(chanMerge && chanMerge.canonical.id === 'attio_2', 'il canale Tarocco va nel deal');
  var plannerA = rep2.proposals.find(function(p) { return p.duplicates[0].id === 'prj_a'; });
  assert.equal(plannerA.canonical.id, 'attio_2', 'la riga del planner salta il canale e va sul deal'); assert.match(plannerA.reasons[0], /Tarocco → Tarocco - Lieviti e Magia/);
  // review Codex: le righe irriconoscibili da sole fanno partire l'avviso agli admin, con chiave propria
  var sent = [];
  var n = await dedup.checkAndNotify({ db: { searchProjects: async function() { return PROJECTS.concat([planner[2]]); } }, client: { useSupabase: false }, supabase: {}, activities: [], ask: async function() { return 'NONE'; }, roles: [{ slack_user_id: 'U_ADM', role: 'admin' }], gate: { itemHash: function(k) { return k; }, notificheEnabled: function() { return true; }, followupAllowed: async function(sb, uid, hash) { sent.push(hash); return { allowed: true, attempts: 0 }; }, recordFollowup: async function() {} }, app: { client: { chat: { postMessage: async function() {} } } } });
  assert.equal(n, 1); assert.match(sent[0], /planner:prj_c/);
  var txt = dedup.formatReport(rep, false);
  assert.match(txt, /Tarocco - Lieviti e Magia\* ← Tarocco - organizzazione[\s\S]*creato dal planner: nomina Tarocco/);
  assert.match(txt, /senza una commessa riconoscibile\* \(1\)[\s\S]*Tutte le pubblicazioni/);
});

test('dal contesto: le commesse recenti della persona e il vocabolario delle attività decidono prima del modello; il modello vede le recenti per prime; NONE non inventa', async function() {
  var ctx = require('../src/services/projectContext');
  // Giusy ha registrato ore su Gambino Social e Tarocco; il PED di Gambino ha "caption" nel vocabolario
  var sb = { from: function() { return { select: function() { return { eq: function() { return { gte: function() { return { limit: async function() { return { data: [
    { project_id: 'attio_1', hours: 6, log_date: '2026-09-08' }, { project_id: 'attio_2', hours: 2, log_date: '2026-09-05' }, { project_id: 'cat_management', hours: 1, log_date: '2026-09-05' }] }; } }; } }; } }; } }; } };
  var recent = await ctx.recentProjectsFor('U_GIUSY', { deps: { supabase: sb } });
  assert.deepEqual(recent.map(function(r) { return r.id; }), ['attio_1', 'attio_2'], 'per ore, senza le attività interne');
  var activities = [{ id: 'act_ped', project_id: 'attio_1', name: 'PED settembre 2026', status: 'open', vocabulary: ['caption', 'post', 'storie'] }, { id: 'act_x', project_id: 'attio_2', name: 'Shooting', status: 'open', vocabulary: ['foto'] }];
  var v = ctx.matchByVocabulary('Tutte le pubblicazioni e le caption dei contenuti che ancora non le hanno', ['attio_1', 'attio_2'], activities);
  assert.equal(v.id, 'attio_1');
  assert.equal(ctx.matchByVocabulary('riunione generica', ['attio_1', 'attio_2'], activities), null);
  // modello: le recenti per prime, risposta con nome esatto o NONE
  var prompts = [];
  var ask = async function(p) { prompts.push(p); return /pubblicazioni/.test(p) ? 'Gambino Vini · Social' : 'NONE'; };
  var r = await ctx.resolveByContext('Tutte le pubblicazioni e le caption dei contenuti', 'U_GIUSY', catalog, { supabase: sb, activities: [], ask: ask });
  assert.equal(r.id, 'attio_1'); assert.equal(r.via, 'modello');
  assert.match(prompts[0], /HA LAVORATO DI RECENTE[\s\S]*Gambino Vini · Social[\s\S]*ALTRE COMMESSE/);
  assert.equal(await ctx.resolveByContext('cosa di ieri', 'U_GIUSY', catalog, { supabase: sb, activities: [], ask: ask }), null, 'NONE → nessuna attribuzione');
  // vocabolario prima del modello: il modello non viene chiamato
  var calls = 0;
  var r2 = await ctx.resolveByContext('caption e storie', 'U_GIUSY', catalog, { supabase: sb, activities: activities, ask: async function() { calls++; return 'NONE'; } });
  assert.equal(r2.via, 'vocabolario'); assert.equal(calls, 0);
  // "Altro" del planner: il testo senza cliente passa dal contesto; se nemmeno il modello sa, l'errore suggerisce le ultime commesse
  var ok = await resolver.resolveOtherProject('Tutte le pubblicazioni e le caption dei contenuti', 'U_GIUSY', PROJECTS, { db: db, matcher: matcher, catalog: catalog, supabase: sb, activities: [], ask: ask });
  assert.equal(ok.project.id, 'attio_1'); assert.equal(ok.via, 'modello');
  var ko = await resolver.resolveOtherProject('cosa di ieri', 'U_GIUSY', PROJECTS, { db: db, matcher: matcher, catalog: catalog, supabase: sb, activities: [], ask: ask });
  assert.match(ko.error, /le tue ultime: Gambino Vini · Social, Tarocco - Lieviti e Magia/);
  // daily: il matcher usa il contesto della persona (vocabolario) e passa le recenti al modello
  var seen = null;
  var tasks = [{ task: 'caption e storie', hours: 1 }, { task: 'boh', hours: 1 }];
  await matcher.enrichTasksWithProjects(tasks, { userId: 'U_GIUSY', catalog: catalog, deps: { supabase: sb }, activities: activities, llm: async function(texts, cat, recentIds) { seen = { texts: texts, recentIds: recentIds }; return {}; } });
  assert.equal(tasks[0].project_id, 'attio_1', 'dal vocabolario, senza modello');
  assert.deepEqual(seen, { texts: ['boh'], recentIds: ['attio_1', 'attio_2'] });
  // dedup: la riga irriconoscibile del planner si risolve dal contesto di chi l'ha scritta
  var row = { id: 'prj_c', name: 'Tutte le pubblicazioni e le caption dei contenuti che ancora non le hanno', status: 'active', tags: ['fonte:planner'], owner_slack_id: 'U_GIUSY' };
  var pp = await dedup.plannerProposals(PROJECTS.concat([row]), {}, { supabase: sb, activities: activities, ask: ask });
  assert.equal(pp.unresolved.length, 0); assert.equal(pp.proposals[0].canonical.id, 'attio_1'); assert.match(pp.proposals[0].reasons[0], /per contesto di chi l'ha scritta/);
});
