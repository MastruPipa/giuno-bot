'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var cc = require('../src/orchestrator/crmCompare');

test('bucket: stage Attio e status interno finiscono nello stesso spazio', function() {
  assert.equal(cc.bucketOfAttioStage('Won'), 'won');
  assert.equal(cc.bucketOfAttioStage(['Lost']), 'lost');
  assert.equal(cc.bucketOfAttioStage('Proposta inviata'), 'open');
  assert.equal(cc.bucketOfAttioStage('Contratto'), 'won');
  assert.equal(cc.bucketOfAttioStage(null), 'unknown');
  assert.equal(cc.bucketOfLocalStatus('negotiating'), 'open');
  assert.equal(cc.bucketOfLocalStatus('won'), 'won');
  assert.equal(cc.bucketOfLocalStatus('boh'), 'unknown');
});

test('namesMatch: ignora forma societaria, punteggiatura e contenimento', function() {
  assert.equal(cc.namesMatch('Aitho S.r.l.', 'aitho'), true);
  assert.equal(cc.namesMatch('Tomarchio Bibite', 'Tomarchio'), true);
  assert.equal(cc.namesMatch('Aitho', 'Agromonte'), false);
  assert.equal(cc.namesMatch('Ab', 'Ab Srl'), true);
  assert.equal(cc.namesMatch('Ab', 'Abc'), false);
});

test('compareRecords: discrepanze di stato e valore, solo-Attio e solo-interno', function() {
  var deals = [
    { record_id: 'd1', values: { name: 'Aitho', stage: 'Won', value: 15000 } },
    { record_id: 'd2', values: { name: 'Agromonte', stage: 'Proposta', value: 8000 } },
    { record_id: 'd3', values: { name: 'Nuovo Cliente', stage: 'Lead' } },
  ];
  var leads = [
    { id: 'l1', company_name: 'Aitho Srl', status: 'negotiating', estimated_value: 15000 },
    { id: 'l2', company_name: 'Agromonte', status: 'proposal_sent', estimated_value: 5000 },
    { id: 'l3', company_name: 'Vecchio Lead', status: 'dormant' },
  ];
  var r = cc.compareRecords(deals, leads);
  assert.equal(r.pairs.length, 2);
  assert.match(r.pairs[0].discrepancies[0], /stato: Attio "Won" vs interno "negotiating"/);
  assert.match(r.pairs[1].discrepancies[0], /valore: Attio 8000 vs interno 5000/);
  assert.equal(r.attioOnly[0].name, 'Nuovo Cliente');
  assert.equal(r.localOnly[0].name, 'Vecchio Lead');
});

test('compareRecords: allineati non producono discrepanze', function() {
  var r = cc.compareRecords(
    [{ values: { name: 'Elfo', stage: 'In progress', value: 1000 } }],
    [{ company_name: 'Elfo', status: 'won', estimated_value: 1050 }]
  );
  assert.equal(r.pairs.length, 1);
  assert.deepEqual(r.pairs[0].discrepancies, []);
});

test('formatComparison: blocco contesto solo con discrepanze, report completo con tutto', function() {
  var r = cc.compareRecords(
    [{ values: { name: 'Aitho', stage: 'Won' } }, { values: { name: 'Elfo', stage: 'Won' } }],
    [{ company_name: 'Aitho', status: 'lost' }, { company_name: 'Elfo', status: 'won' }, { company_name: 'Solo', status: 'new' }]
  );
  var ctx = cc.formatComparison(r);
  assert.match(ctx, /^CONFRONTO CRM/);
  assert.match(ctx, /Aitho — NON ALLINEATO/);
  assert.doesNotMatch(ctx, /Elfo/);
  assert.match(ctx, /fa fede Attio/);
  var full = cc.formatComparison(r, { full: true });
  assert.match(full, /Elfo — allineato/);
  assert.match(full, /Solo — solo nel CRM interno/);

  var none = cc.formatComparison(cc.compareRecords([{ values: { name: 'X', stage: 'Won' } }], [{ company_name: 'X', status: 'won' }]));
  assert.match(none, /nessuna discrepanza/);
  assert.equal(cc.formatComparison(cc.compareRecords([], [])), '');
});

test('compareForContext: senza contesto Attio ritorna stringa vuota', async function() {
  assert.equal(await cc.compareForContext(null), '');
  assert.equal(await cc.compareForContext({ companies: [], deals: [] }), '');
});
