'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var {
  isInternalProjectText,
  isLikelyStaleEvent,
  extractExcludedPhrases,
  shouldExcludeText,
} = require('../src/utils/briefingFilters');

test('briefing filters classify internal projects', function() {
  assert.equal(isInternalProjectText('Katania Studio / interno'), true);
  assert.equal(isInternalProjectText('Imperfecto partnership'), true);
  assert.equal(isInternalProjectText('Cliente Gambino Vini'), false);
});

test('briefing filters detect stale events and exclusions', function() {
  assert.equal(isLikelyStaleEvent('Friends of Figma 2025 - evento chiuso'), true);
  var phrases = extractExcludedPhrases([
    { content: 'CORREZIONE_BRIEFING: non menzionare sistema tracking catania studio nel briefing' },
  ]);
  assert.equal(phrases.length > 0, true);
  assert.equal(shouldExcludeText('Sistema tracking Catania Studio fase alfa', phrases), true);
});
