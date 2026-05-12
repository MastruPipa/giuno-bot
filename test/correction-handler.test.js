'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');

// We only test pure helpers from correctionHandler. The DB-touching paths
// require a Supabase client and live in integration territory.
var ch = require('../src/services/correctionHandler');

test('isCorrection picks up explicit + accusatory rephrase patterns', function() {
  assert.equal(ch.isCorrection('No, è sbagliato — Claudia non Paolo'), true);
  assert.equal(ch.isCorrection('In realtà il cliente è chiuso da mesi'), true);
  assert.equal(ch.isCorrection('Ma dove l\'hai letto questo?'), true);
  assert.equal(ch.isCorrection('Chi te l\'ha detto?'), true);
  assert.equal(ch.isCorrection('ma è chiuso quel progetto'), true);
  assert.equal(ch.isCorrection('Ottimo, grazie'), false);
  assert.equal(ch.isCorrection('Puoi mandarmi il file?'), false);
});

test('extractKeywords drops stopwords and filler', function() {
  var kw = ch._extractKeywords('No, è sbagliato — Claudia lavora al branding di Imperfecto, non Paolo');
  assert.ok(kw.indexOf('claudia') !== -1);
  assert.ok(kw.indexOf('branding') !== -1);
  assert.ok(kw.indexOf('imperfecto') !== -1);
  assert.ok(kw.indexOf('sono') === -1);
  assert.ok(kw.indexOf('non') === -1);
});
