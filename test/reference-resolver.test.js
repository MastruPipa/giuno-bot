'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var { parseNumberedList, parseOrdinalReference, resolveOrdinalReference } = require('../src/utils/referenceResolver');

var COCCO_REPLY =
  'Ecco i contatti più recenti inseriti nel CRM:\n\n' +
  '1. **Unimed** (31/03) - Performance Marketing, €9.900, proposta inviata\n' +
  '2. **Tarocco/Pacman** (30/03) - Lido/bar in apertura\n' +
  '3. **Ludoteca Asilonido** (30/03) - Dario Zingherino, branding\n' +
  '4. **Skimpy** (30/03) - cabinati arcade\n' +
  '5. **Casa Matta** (30/03) - Lead nuovo\n' +
  '6. **SHUT UP S.R.L.S. - L\'Elfo** (29/03) - videoclip\n';

test('parseNumberedList extracts entity name per index', function() {
  var items = parseNumberedList(COCCO_REPLY);
  assert.equal(items[1], 'Unimed');
  assert.equal(items[2], 'Tarocco/Pacman');
  assert.equal(items[3], 'Ludoteca Asilonido');
  assert.equal(items[6], 'SHUT UP S.R.L.S. - L\'Elfo');
});

test('parseOrdinalReference matches numeric shorthand', function() {
  assert.deepEqual(parseOrdinalReference('1. persa'), { index: 1, payload: 'persa' });
  assert.deepEqual(parseOrdinalReference('2) won'), { index: 2, payload: 'won' });
  assert.deepEqual(parseOrdinalReference('3 - chiuso'), { index: 3, payload: 'chiuso' });
  assert.deepEqual(parseOrdinalReference('1: persa'), { index: 1, payload: 'persa' });
});

test('parseOrdinalReference matches Italian ordinals', function() {
  assert.deepEqual(parseOrdinalReference('il primo è persa'), { index: 1, payload: 'persa' });
  assert.deepEqual(parseOrdinalReference('la seconda è chiusa'), { index: 2, payload: 'chiusa' });
});

test('parseOrdinalReference ignores long sentences', function() {
  var long = '1. persa ma soprattutto vorrei che tu controllassi tutti gli altri clienti e poi anche quei lead che abbiamo abbandonato durante il trimestre scorso';
  assert.equal(parseOrdinalReference(long), null);
});

test('resolveOrdinalReference rewrites Cocco-style replies', function() {
  var conv = [
    { role: 'user', content: 'Mi dai tutti gli ultimi contatti inseriti nel crm?' },
    { role: 'assistant', content: COCCO_REPLY },
  ];
  var r = resolveOrdinalReference('1. persa', conv);
  assert.ok(r, 'should resolve');
  assert.equal(r.entity, 'Unimed');
  assert.equal(r.index, 1);
  assert.equal(r.payload, 'persa');
  assert.ok(r.rewritten.indexOf('Unimed') !== -1);
  assert.ok(r.rewritten.indexOf('persa') !== -1);
});

test('resolveOrdinalReference returns null when no list precedes', function() {
  var conv = [
    { role: 'user', content: 'ciao' },
    { role: 'assistant', content: 'Ciao Antonio, come va?' },
  ];
  assert.equal(resolveOrdinalReference('1. persa', conv), null);
});

test('resolveOrdinalReference returns null for normal messages', function() {
  var conv = [
    { role: 'user', content: 'Mi dai gli ultimi contatti?' },
    { role: 'assistant', content: COCCO_REPLY },
  ];
  assert.equal(resolveOrdinalReference('mandami il dettaglio di Unimed', conv), null);
  assert.equal(resolveOrdinalReference('grazie', conv), null);
});
