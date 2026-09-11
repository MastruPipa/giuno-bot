'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var tv = require('../src/services/transversalRules');
var matcher = require('../src/services/projectMatcher');
var sync = require('../src/jobs/projectSyncJob');
var dedup = require('../src/jobs/projectDedupJob');

test('matchTransversal: daily, management, team building, formazione, amministrazione, commerciale; "daily con il cliente" no', function() {
  assert.equal(tv.matchTransversal('Daily meeting team 15min').id, 'cat_riunioni_team');
  assert.equal(tv.matchTransversal('Weekly di allineamento interno').id, 'cat_riunioni_team');
  assert.equal(tv.matchTransversal('Riunione di management 1h').id, 'cat_management');
  assert.equal(tv.matchTransversal('Team building al mare').id, 'cat_team_building');
  assert.equal(tv.matchTransversal('Allineamento scuola di content 15min').id, 'cat_formazione_admin');
  assert.equal(tv.matchTransversal('Corso Figma avanzato').id, 'cat_formazione_admin');
  assert.equal(tv.matchTransversal('Registro cassa e fatture').id, 'cat_flussi_interni');
  assert.equal(tv.matchTransversal('Preventivo per un nuovo cliente').id, 'cat_prospect');
  assert.equal(tv.matchTransversal('Daily con il cliente sul sito'), null, 'con il cliente non è interno');
  assert.equal(tv.matchTransversal('SAL settimanale'), null);
  assert.equal(tv.matchTransversal('Montaggio video'), null);
  assert.equal(tv.matchTransversal(''), null);
});

test('resolveTask: il cliente vince sulle regole trasversali, poi le trasversali, poi le commesse interne del catalogo', function() {
  var catalog = [
    { id: 'attio_1', name: 'Elios', norm: 'elios', norms: ['elios'] },
    { id: 'cat_riunioni_team', name: 'Daily e riunioni di team', norm: 'daily e riunioni di team', norms: ['daily e riunioni di team'] },
  ];
  assert.equal(matcher.resolveTask('Daily interno su Elios 30min', catalog).id, 'attio_1', 'riunione interna su un cliente → il cliente');
  assert.equal(matcher.resolveTask('Daily meeting team 15min', catalog).id, 'cat_riunioni_team');
  assert.equal(matcher.resolveTask('Daily meeting team 15min', []).id, 'cat_riunioni_team', 'anche con catalogo vuoto');
  assert.equal(matcher.resolveTask('Montaggio video', catalog), null);
});

test('Attio: il cliente della commessa è l\'azienda collegata al deal, letta una volta per azienda', async function() {
  var calls = [];
  var fakeAttio = { getRecord: async function(obj, id) { calls.push(id); return { values: { name: 'Elios Srl' } }; } };
  var deal = { record_id: 'd1', values: { name: 'Sito Elios', associated_company: { object: 'companies', record_id: 'c1' } } };
  assert.equal(sync.companyRefOf(deal.values), 'c1');
  assert.equal(sync.companyRefOf({ name: 'x', people: [{ object: 'people', record_id: 'p' }] }), null);
  var cache = {};
  assert.equal(await sync.companyNameOf(deal, cache, { attio: fakeAttio }), 'Elios Srl');
  assert.equal(await sync.companyNameOf(deal, cache, { attio: fakeAttio }), 'Elios Srl');
  assert.equal(calls.length, 1, 'cache per azienda');
  var broken = { getRecord: async function() { throw new Error('offline'); } };
  assert.equal(await sync.companyNameOf(deal, {}, { attio: broken }), null);
  assert.equal(sync.dealToProjectRow({ record_id: 'd1', name: 'Sito Elios', values: {} }).client_name, undefined);
});

test('dedup: due deal Attio dello stesso cliente restano commesse distinte; canale + deal dello stesso cliente si uniscono', function() {
  var a = { id: 'attio_1', name: 'Sito Elios', client_name: 'Elios Srl' };
  var b = { id: 'attio_2', name: 'Campagna social Elios 2026', client_name: 'Elios Srl' };
  var c = { id: 'chan_C1', name: 'elios', client_name: 'Elios Srl' };
  assert.equal(dedup.findDuplicateGroups([a, b, c]).length, 0, 'cliente con due commesse: il canale resta al livello cliente, i deal restano distinti');
  var one = dedup.findDuplicateGroups([a, c]);
  assert.equal(one.length, 1); assert.deepEqual(one[0].projects.map(function(p) { return p.id; }).sort(), ['attio_1', 'chan_C1']); assert.deepEqual(one[0].reasons, ['stesso cliente']);
});

test('review Codex: un task che nomina solo il cliente non diventa interno (una commessa → quella; più commesse → al modello)', function() {
  var catalog = [
    { id: 'attio_1', name: 'Website refresh', norm: 'website refresh', norms: ['website refresh'], client: 'acme' },
    { id: 'attio_2', name: 'Campagna', norm: 'campagna', norms: ['campagna'], client: 'globex' },
    { id: 'attio_3', name: 'Video', norm: 'video', norms: ['video'], client: 'globex' },
    { id: 'cat_riunioni_team', name: 'Daily e riunioni di team', norm: 'daily e riunioni di team', norms: ['daily e riunioni di team'], client: null },
  ];
  assert.equal(matcher.resolveTask('Daily interno Acme', catalog).id, 'attio_1');
  assert.equal(matcher.resolveTask('Daily interno Globex', catalog), null, 'due commesse dello stesso cliente: decide il modello, non è interno');
  assert.equal(matcher.resolveTask('Daily team', catalog).id, 'cat_riunioni_team');
});
