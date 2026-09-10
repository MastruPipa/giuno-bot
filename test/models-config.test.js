'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var cfg = require('../src/config/models');

test('models config: tre livelli con ID senza suffisso data', function() {
  assert.match(cfg.MODELS.PRIMARY, /^claude-/);
  assert.match(cfg.MODELS.UTILITY, /^claude-/);
  assert.match(cfg.MODELS.FAST, /^claude-/);
  assert.doesNotMatch(cfg.MODELS.FAST, /\d{8}$/);
});

test('supportsEffort: sì per opus-5/sonnet-5, no per haiku 4.5', function() {
  assert.equal(cfg.supportsEffort('claude-opus-5'), true);
  assert.equal(cfg.supportsEffort('claude-sonnet-5'), true);
  assert.equal(cfg.supportsEffort('claude-opus-4-8'), true);
  assert.equal(cfg.supportsEffort('claude-haiku-4-5'), false);
  assert.equal(cfg.supportsEffort(''), false);
});

test('refusal fallback: beta header noto, abilitato di default', function() {
  assert.equal(cfg.REFUSAL_FALLBACK_BETA, 'server-side-fallback-2026-07-01');
  assert.equal(typeof cfg.REFUSAL_FALLBACK_ENABLED, 'boolean');
});
