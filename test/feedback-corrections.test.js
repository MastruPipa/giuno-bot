'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var { isCorrectionFeedback, buildCorrectionPrompt } = require('../src/utils/feedbackCorrections');

test('isCorrectionFeedback detects explicit correction phrases', function() {
  assert.equal(isCorrectionFeedback('Sputo 16 è stato chiuso e inviato'), true);
  assert.equal(isCorrectionFeedback('Non è un cliente, è un progetto interno'), true);
  assert.equal(isCorrectionFeedback('Non hai menzionato tutto il lavoro da fare'), true);
  assert.equal(isCorrectionFeedback('Rimuovi dalle memories il sistema tracking catania studio'), true);
});

test('isCorrectionFeedback ignores neutral chat messages', function() {
  assert.equal(isCorrectionFeedback('grazie mille'), false);
  assert.equal(isCorrectionFeedback('ok perfetto'), false);
});

test('buildCorrectionPrompt includes correction and operational instructions', function() {
  var prompt = buildCorrectionPrompt('Non è un cliente');
  assert.equal(prompt.includes('Correzione esplicita dell\'utente'), true);
  assert.equal(prompt.includes('Non è un cliente'), true);
  assert.equal(prompt.includes('correggi il contenuto'), true);
});
