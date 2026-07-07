'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var { matchTaskAgainstCatalog } = require('../src/services/projectMatcher');

var CATALOG = [
  { id: 'attio_1', name: 'Bagno Maria', norm: 'bagno maria' },
  { id: 'attio_2', name: 'Tarocco', norm: 'tarocco' },
  { id: 'attio_3', name: 'Bagno Maria Tarocco', norm: 'bagno maria tarocco' },
  { id: 'prj_ks', name: 'KS', norm: 'ks' }, // <4 char: mai matchato per substring
];

test('match deterministico: nome progetto come substring del task', function() {
  var hit = matchTaskAgainstCatalog('Bagno Maria montaggio video 1h', CATALOG);
  assert.equal(hit.id, 'attio_1');
});

test('match deterministico: case-insensitive', function() {
  var hit = matchTaskAgainstCatalog('check copy TAROCCO', CATALOG);
  assert.equal(hit.id, 'attio_2');
});

test('a parità di match vince il nome più lungo (più specifico)', function() {
  var hit = matchTaskAgainstCatalog('Bagno Maria Tarocco check copy', CATALOG);
  assert.equal(hit.id, 'attio_3');
});

test('nomi corti (<4 char) non matchano mai per substring', function() {
  // "ks" comparirebbe dentro moltissime parole: troppo rischioso
  assert.equal(matchTaskAgainstCatalog('task generico ks', CATALOG), null);
});

test('nessun match → null (il task resta senza progetto)', function() {
  assert.equal(matchTaskAgainstCatalog('accounting generico', CATALOG), null);
  assert.equal(matchTaskAgainstCatalog('', CATALOG), null);
});
