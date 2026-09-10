'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var dedup = require('../src/jobs/projectDedupJob');

var P = function(id, name, client, extra) { return Object.assign({ id: id, name: name, client_name: client || null, status: 'active', tags: [] }, extra || {}); };

test('isDuplicatePair: nomi uguali, contenuti, cliente=nome; niente falsi positivi', function() {
  assert.equal(dedup.isDuplicatePair(P('chan_1', 'Tarocco', 'Tarocco'), P('attio_1', 'Tarocco- Lieviti e Magia')), 'nome contenuto');
  assert.equal(dedup.isDuplicatePair(P('chan_2', 'DICAR', 'DICAR'), P('attio_2', 'DICAR')), 'stesso nome');
  assert.equal(dedup.isDuplicatePair(P('chan_3', 'parco-cava-grottadeldrago'), P('attio_3', 'Parco Cava Grotta del Drago')), 'stesso nome');
  assert.equal(dedup.isDuplicatePair(P('chan_4', 'lo-scuru', 'KMP'), P('attio_4', 'Lo Scuru – Branded Content Reel IG')), 'nome contenuto');
  assert.equal(dedup.isDuplicatePair(P('chan_5', 'hammersud', 'hammersud'), P('chan_6', 'Hammersud', 'Hammersud')), 'stesso nome');
  assert.equal(dedup.isDuplicatePair(P('chan_5', 'hammersud', 'hammersud'), P('attio_7', 'HammerPodcast')), null);
  assert.equal(dedup.isDuplicatePair(P('attio_8', 'branding + lancio'), P('attio_9', 'branding movimento + lancio')), 'nome contenuto');
  assert.equal(dedup.isDuplicatePair(P('chan_a', 'ped', 'kataniastudio'), P('chan_b', 'eventi', 'kataniastudio')), 'stesso cliente');
  assert.equal(dedup.isDuplicatePair(P('attio_c', 'Meli Duci'), P('attio_d', 'Tekewei')), null);
  assert.equal(dedup.isDuplicatePair(P('chan_e', 'CSA', 'CSA'), P('attio_f', 'Casa Agromonte')), null, 'sigle corte non bastano');
});

test('proposeMerges: canonico = Attio (o manuale), duplicati canale; gruppi con più deal Attio ambigui', function() {
  var projects = [
    P('chan_1', 'Tarocco', 'Tarocco'), P('attio_1', 'Tarocco- Lieviti e Magia'),
    P('chan_2', 'hammersud', 'hammersud'), P('chan_3', 'Hammersud', 'Hammersud'), P('attio_2', 'App Hammersud'), P('attio_3', 'Hammersud Podcast'),
    P('prj_1', 'Patto per Restare - Campagna Raccolta Firme', 'Patto per Restare'), P('chan_4', 'patto per restare', 'Patto per Restare'),
    P('cat_prospect', 'Prospect'), P('attio_9', 'Meli Duci'),
  ];
  var stats = { chan_1: { logs: 5 }, chan_3: { docs: 2 } };
  var props = dedup.proposeMerges(projects, stats);
  var byCanon = {};
  props.forEach(function(p) { byCanon[p.ambiguous ? 'AMB' : p.canonical.id] = p; });
  assert.equal(byCanon.attio_1.duplicates[0].id, 'chan_1');
  assert.equal(byCanon.prj_1.duplicates[0].id, 'chan_4');
  assert.ok(byCanon.AMB, 'Hammersud con due deal Attio diversi è ambiguo');
  assert.equal(props.length, 3);
  var fields = dedup.mergedCanonicalFields(P('attio_1', 'Tarocco- Lieviti e Magia', null, { tags: ['attio-sync', 'tipo:cliente'] }), P('chan_1', 'Tarocco', 'Tarocco', { tags: ['channel-sync', 'tipo:interno'] }));
  assert.deepEqual(fields.aliases, ['Tarocco']);
  assert.equal(fields.client_name, 'Tarocco');
  assert.ok(fields.tags.indexOf('tipo:interno') === -1);
});

test('findNoiseProjects: canali di servizio e nomi generici nati come progetti', function() {
  var noise = dedup.findNoiseProjects([P('chan_1', 'generale'), P('chan_2', 'daily'), P('chan_3', 'ped', 'kataniastudio'), P('chan_4', 'Tarocco'), P('attio_1', 'generale')]);
  assert.deepEqual(noise.map(function(n) { return n.id; }), ['chan_1', 'chan_2', 'chan_3']);
  var text = dedup.formatReport({ proposals: dedup.proposeMerges([P('chan_4', 'Tarocco', 'Tarocco'), P('attio_1', 'Tarocco- Lieviti e Magia')], {}), noise: noise, applied: 0, archived: 0, ambiguous: 0 }, false);
  assert.match(text, /\*Tarocco- Lieviti e Magia\* ← Tarocco \(chan\)/);
  assert.match(text, /Rumore da archiviare: generale, daily, ped/);
});

test('projectMatcher: gli alias del canonico contano nel match', function() {
  var matcher = require('../src/services/projectMatcher');
  var catalog = [{ id: 'attio_1', name: 'Tarocco- Lieviti e Magia', norm: 'tarocco- lieviti e magia', norms: ['tarocco- lieviti e magia', 'tarocco'] }];
  assert.equal(matcher.matchTaskAgainstCatalog('grafiche tarocco per il post', catalog).id, 'attio_1');
});
