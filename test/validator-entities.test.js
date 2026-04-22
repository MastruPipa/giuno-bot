'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var { extractNamedEntities, findUngroundedEntities } = require('../src/orchestrator/validator');

test('extractNamedEntities captures capitalized tokens and skips common words', function() {
  var names = extractNamedEntities('Ho parlato con Antonio di Aitho e Fantacalcio. Ieri era martedì.');
  assert.ok(names.indexOf('Antonio') !== -1);
  assert.ok(names.indexOf('Aitho') !== -1);
  assert.ok(names.indexOf('Fantacalcio') !== -1);
  // Common Italian words (giorni, mesi) must be skipped
  assert.equal(names.indexOf('Ieri'), -1);
  assert.equal(names.indexOf('Martedì'), -1);
});

test('findUngroundedEntities only flags names missing from evidence', function() {
  var reply = 'Ho visto con Antonio un problema su Aitho.';
  var evidence = ['Dimmi di Aitho'];
  var ungrounded = findUngroundedEntities(reply, evidence);
  assert.ok(ungrounded.indexOf('Antonio') !== -1, 'Antonio not in evidence → flagged');
  assert.equal(ungrounded.indexOf('Aitho'), -1, 'Aitho grounded in evidence');
});

test('findUngroundedEntities returns empty list when everything is grounded', function() {
  var reply = 'Aitho è un cliente attivo.';
  var evidence = ['Mi parli di Aitho?'];
  assert.deepEqual(findUngroundedEntities(reply, evidence), []);
});
