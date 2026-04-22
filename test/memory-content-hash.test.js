'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');

// Require only the pure function exported from the memories module — this
// avoids touching the Supabase client at import time.
var { contentHash } = require('../src/services/db/memories');

test('contentHash collides on case / whitespace / punctuation differences', function() {
  var a = contentHash('Ieri ho parlato con Aitho.');
  var b = contentHash('IERI  ho parlato con Aitho');
  var c = contentHash('ieri ho parlato con aitho!');
  assert.equal(a, b);
  assert.equal(a, c);
});

test('contentHash differs on substantive content change', function() {
  var a = contentHash('Ieri ho parlato con Aitho');
  var b = contentHash('Oggi parlo con il cliente X');
  assert.notEqual(a, b);
});

test('contentHash returns null for empty / whitespace-only input', function() {
  assert.equal(contentHash(''), null);
  assert.equal(contentHash('   '), null);
  assert.equal(contentHash(null), null);
});

test('contentHash is a 16-char hex string for real content', function() {
  var h = contentHash('qualche contenuto reale');
  assert.equal(typeof h, 'string');
  assert.equal(h.length, 16);
  assert.ok(/^[0-9a-f]+$/.test(h));
});
