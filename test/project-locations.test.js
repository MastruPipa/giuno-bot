'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var loc = require('../src/services/projectLocations');

var projects = [
  { id: 'chan_C1', name: 'offkatania', client_name: null },
  { id: 'attio_2', name: 'Elios', client_name: 'Elios Srl' },
  { id: 'attio_3', name: 'Vinokilo Swiss', client_name: 'Vinokilo' },
];
var channelMap = { C1: { channel_name: 'offkatania', cliente: 'OFFKATANIA' }, C2: { channel_name: 'progetto-elios', cliente: 'Elios' }, C9: { channel_name: 'random' } };

test('channelRowsFromMap + index/lookup: chan_ id → alta, per nome → media', function() {
  var rows = loc.channelRowsFromMap(projects, channelMap);
  var idx = loc.index(rows);
  assert.equal(loc.lookup(idx, 'slack_channel', 'C1').id, 'chan_C1'); assert.equal(loc.lookup(idx, 'slack_channel', 'C1').confidence, 'alta');
  assert.equal(loc.lookup(idx, 'slack_channel', 'C2').id, 'attio_2'); assert.equal(loc.lookup(idx, 'slack_channel', 'C2').confidence, 'media');
  assert.equal(loc.lookup(idx, 'slack_channel', 'C9'), null);
  assert.equal(loc.lookup(idx, 'drive_folder', 'x'), null);
  // una riga admin vince su una dedotta per lo stesso ref
  var idx2 = loc.index(rows.concat([{ project_id: 'attio_3', kind: 'slack_channel', ref: 'C2', source: 'admin', confidence: 'alta', project_name: 'Vinokilo Swiss' }]));
  assert.equal(loc.lookup(idx2, 'slack_channel', 'C2').id, 'attio_3');
});

test('rebuild: cartella del kick-off (non dei recap, non "Appunti di Gemini"), progetti Figma per nome; apply scrive e rispetta le righe admin', async function() {
  var gets = [], writes = [];
  var drive = { files: { get: async function(p) { gets.push(p.fileId);
    if (p.fields === 'parents') return { data: { parents: [p.fileId === 'K' ? 'F_ELIOS' : 'F_GEM'] } };
    return { data: { name: p.fileId === 'F_ELIOS' ? 'Elios — progetto' : 'Appunti di Gemini' } }; } } };
  var dossiers = { getProjectDocuments: async function(id) { return id === 'attio_2' ? [{ file_id: 'K', doc_role: 'kickoff', file_name: 'Kick-off' }, { file_id: 'R', doc_role: 'recap' }, { file_id: 'B', doc_role: 'brief' }] : []; } };
  var supabase = { from: function(t) { assert.equal(t, 'project_locations'); return {
    select: function() { return { limit: async function() { return { data: [{ project_id: 'attio_2', kind: 'figma_project', ref: '77', source: 'admin', confidence: 'alta' }] }; } }; },
    upsert: async function(row) { writes.push(row); return {}; } }; } };
  var deps = { supabase: supabase, db: { getChannelMapCache: function() { return channelMap; } }, dossiers: dossiers, projects: projects, channelMap: channelMap, drive: drive,
    figmaProjects: [{ id: '77', name: 'Elios landing' }, { id: '78', name: 'Vinokilo' }, { id: '79', name: 'Altro' }] };
  var prev = await loc.rebuild({ deps: deps });
  assert.equal(prev.channels, 2); assert.equal(prev.folders, 1); assert.equal(prev.figma, 2); assert.equal(writes.length, 0);
  assert.ok(prev.items.some(function(r) { return r.kind === 'drive_folder' && r.ref === 'F_ELIOS' && r.confidence === 'alta' && r.name === 'Elios — progetto'; }));
  assert.ok(!prev.items.some(function(r) { return r.ref === 'F_GEM'; }), 'Appunti di Gemini non è una cartella di progetto');
  assert.ok(!gets.some(function(id) { return id === 'R'; }), 'i recap non si guardano');
  var applied = await loc.rebuild({ apply: true, deps: deps });
  assert.equal(applied.skipped_admin, 1); assert.equal(applied.written, 4);
  assert.match(loc.formatReport(applied, true), /2 canali, 1 cartelle Drive, 2 progetti Figma → 4 righe scritte, 1 impostate a mano lasciate intatte[\s\S]*\*Elios\*: #progetto-elios \?, Elios — progetto/);
});

test('parseLocation/setManual: #canale, cartella Drive, progetto e file Figma; errori chiari', async function() {
  assert.deepEqual(loc.parseLocation('<#C2|progetto-elios>', channelMap), { kind: 'slack_channel', ref: 'C2', name: '#progetto-elios' });
  assert.equal(loc.parseLocation('#progetto-elios', channelMap).ref, 'C2');
  assert.equal(loc.parseLocation('#boh', channelMap), null);
  assert.equal(loc.parseLocation('https://drive.google.com/drive/u/0/folders/1AbC_def-123?usp=sharing', {}).ref, '1AbC_def-123');
  assert.equal(loc.parseLocation('https://www.figma.com/files/team/12/project/4567/Elios?fuid=1', {}).ref, '4567');
  assert.equal(loc.parseLocation('https://www.figma.com/design/AbC123xyz/Landing?node-id=1', {}).kind, 'figma_file');
  assert.equal(loc.parseLocation('ciao', {}), null);
  var writes = [];
  var supabase = { from: function() { return { upsert: async function(row) { writes.push(row); return {}; } }; } };
  var deps = { supabase: supabase, db: {}, channelMap: channelMap, findProject: async function(n) { return /elios/i.test(n) ? { id: 'attio_2', name: 'Elios' } : null; } };
  var r = await loc.setManual('elios', '#progetto-elios', { deps: deps });
  assert.equal(r.success, true); assert.equal(writes[0].source, 'admin'); assert.equal(writes[0].ref, 'C2'); assert.match(r.message, /Elios ← #progetto-elios/);
  assert.match((await loc.setManual('boh', '#progetto-elios', { deps: deps })).error, /non trovato/);
  assert.match((await loc.setManual('elios', 'ciao', { deps: deps })).error, /Non riconosco/);
  var missing = { from: function() { return { upsert: async function() { return { error: new Error('relation "project_locations" does not exist') }; } }; } };
  assert.match((await loc.setManual('elios', '#progetto-elios', { deps: Object.assign({}, deps, { supabase: missing }) })).error, /migrazione/);
});

test('loadRegistry: righe salvate + canali derivati, senza doppioni, con nome progetto', async function() {
  var supabase = { from: function() { return { select: function() { return { limit: async function() { return { data: [{ project_id: 'attio_2', kind: 'drive_folder', ref: 'F1', name: 'Elios', source: 'document', confidence: 'alta' }, { project_id: 'attio_2', kind: 'slack_channel', ref: 'C2', name: '#progetto-elios', source: 'channel_map', confidence: 'media' }] }; } }; } }; } };
  var rows = await loc.loadRegistry({ deps: { supabase: supabase, db: { searchProjects: async function() { return projects; }, getChannelMapCache: function() { return channelMap; } } } });
  assert.equal(rows.length, 3, 'F1 + C2 (una volta) + C1');
  assert.equal(rows.find(function(r) { return r.ref === 'F1'; }).project_name, 'Elios');
  assert.match(loc.formatRows(rows, 'Elios'), /\*Elios\*: Elios, #progetto-elios \?/);
  assert.match(loc.formatRows([], null), /Registro vuoto/);
});

test('review Codex: una posizione contesa da due progetti dedotti non va a nessuno; admin vince; nomi normalizzati allo stesso modo', async function() {
  var rows = [
    { project_id: 'a', project_name: 'Caffè 2.0', kind: 'slack_channel', ref: 'C5', source: 'channel_map', confidence: 'media' },
    { project_id: 'b', project_name: 'Caffe', kind: 'slack_channel', ref: 'C5', source: 'channel_map', confidence: 'media' },
    { project_id: 'c', project_name: 'Terzo', kind: 'slack_channel', ref: 'C6', source: 'channel_map', confidence: 'media' },
    { project_id: 'd', project_name: 'Quarto', kind: 'slack_channel', ref: 'C6', source: 'admin', confidence: 'alta' },
  ];
  var idx = loc.index(rows);
  assert.equal(loc.lookup(idx, 'slack_channel', 'C5'), null, 'contesa a pari rango');
  assert.equal(loc.lookup(idx, 'slack_channel', 'C6').id, 'd', 'admin vince');
  assert.deepEqual(loc.projectIdForName(rows, 'caffè 2.0'), { id: 'a', name: 'Caffè 2.0' });
  assert.deepEqual(loc.projectIdForName(rows, 'CAFFE 2 0'), { id: 'a', name: 'Caffè 2.0' });
  assert.equal(loc.projectIdForName(rows, 'boh'), null);
  // rebuild: la contesa viene riportata e non scritta; upsert su (kind, ref)
  var writes = [];
  var supabase = { from: function() { return { select: function() { return { limit: async function() { return { data: [] }; } }; } , upsert: async function(row, o) { writes.push({ row: row, o: o }); return {}; } }; } };
  var projects2 = [{ id: 'a', name: 'Elios' }, { id: 'b', name: 'Altro', client_name: 'Elios' }];
  var cm = { C7: { channel_name: 'elios' } };
  var r = await loc.rebuild({ apply: true, deps: { supabase: supabase, db: {}, dossiers: { getProjectDocuments: async function() { return []; } }, projects: projects2, channelMap: cm, drive: null, figmaProjects: [] } });
  assert.equal(r.ambiguous.length, 1); assert.equal(r.written, 0);
  assert.match(loc.formatReport(r, true), /Contese, non attribuite:\*? #elios \(Elios \/ Altro\)/);
  var r2 = await loc.rebuild({ apply: true, deps: { supabase: supabase, db: {}, dossiers: { getProjectDocuments: async function() { return []; } }, projects: [projects2[0]], channelMap: cm, drive: null, figmaProjects: [] } });
  assert.equal(r2.written, 1); assert.equal(writes[0].o.onConflict, 'kind,ref'); assert.equal(writes[0].row.id, 'ploc_slack_channel_C7');
});
