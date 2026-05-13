'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var { scoreMemory, expandQueryTokens } = require('../src/services/db/search');

test('superseded memories never resurface', function() {
  var tokens = expandQueryTokens('claudia branding imperfecto');
  var killed = {
    content: 'Paolo lavora al branding di Imperfecto',
    memory_type: 'semantic',
    superseded_by: 'mem-newer',
    confidence_score: 0.7,
  };
  assert.equal(scoreMemory(killed, tokens, Date.now()), 0);
});

test('confidence weighs the result — high-conf beats keyword-rich low-conf', function() {
  var tokens = expandQueryTokens('elios progetto');
  var now = Date.now();
  var highConf = {
    content: 'Elios progetto chiuso',
    memory_type: 'semantic',
    confidence_score: 0.9,
  };
  var lowConfHighOverlap = {
    content: 'Elios progetto progetto Elios progetto',
    memory_type: 'episodic',
    confidence_score: 0.25,
  };
  var hi = scoreMemory(highConf, tokens, now);
  var lo = scoreMemory(lowConfHighOverlap, tokens, now);
  assert.ok(hi > 0, 'high-confidence memory must score > 0');
  assert.ok(lo > 0, 'low-confidence memory must score > 0');
  assert.ok(hi > lo, 'high-confidence memory should outrank a keyword-rich low-confidence one (got hi=' + hi + ' lo=' + lo + ')');
});

test('corrections get a boost over normal memories', function() {
  var tokens = expandQueryTokens('claudia paolo branding');
  var normal = {
    content: 'Paolo lavora al branding',
    memory_type: 'semantic',
    confidence_score: 0.7,
  };
  var correction = {
    content: 'Claudia lavora al branding, non Paolo',
    memory_type: 'semantic',
    tags: ['correzione', 'feedback'],
    confidence_score: 0.7,
  };
  var nScore = scoreMemory(normal, tokens, Date.now());
  var cScore = scoreMemory(correction, tokens, Date.now());
  assert.ok(cScore > nScore, 'correction should outrank a normal same-keyword memory');
});

test('expired memories return 0 score', function() {
  var tokens = expandQueryTokens('test');
  var expired = {
    content: 'test content',
    memory_type: 'episodic',
    expires_at: new Date(Date.now() - 1000).toISOString(),
  };
  assert.equal(scoreMemory(expired, tokens, Date.now()), 0);
});
