'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var models = require('../src/config/models');
var utility = require('../src/services/utilityModel');
var costTracker = require('../src/services/costTracker');

// 17/9: Sonnet 5 ragiona di default e con max_tokens piccoli non scriveva la
// risposta (blocco thinking, nessun testo): stime del daily a zero per una
// settimana, parser dei daily a zero task.
test('thinkingOffParams: spento dove accettato, effort basso su Fable, niente su Haiku', function() {
  assert.deepEqual(models.thinkingOffParams('claude-sonnet-5'), { thinking: { type: 'disabled' } });
  assert.deepEqual(models.thinkingOffParams('claude-opus-5'), { thinking: { type: 'disabled' } });
  assert.deepEqual(models.thinkingOffParams('claude-fable-5-1'), { output_config: { effort: 'low' } });
  assert.deepEqual(models.thinkingOffParams('claude-haiku-4-5'), {});
});

test('create: manda il modello utility senza thinking, traccia il costo per funzione, textOf ignora i blocchi thinking', async function() {
  var seen;
  var fake = { messages: { create: async function(req) { seen = req; return { stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 5000 },
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"ok":true}' }] }; } } };
  var res = await utility.create({ max_tokens: 900, system: 's', messages: [{ role: 'user', content: 'x' }] }, 'daily_estimate', { client: fake });
  assert.equal(seen.model, models.MODELS.UTILITY);
  assert.deepEqual(seen.thinking, models.thinkingOffParams(models.MODELS.UTILITY).thinking);
  assert.equal(seen.max_tokens, 900);
  assert.equal(utility.textOf(res), '{"ok":true}');
  var key = Object.keys(costTracker.bufferSnapshot()).find(function(k) { return /daily_estimate$/.test(k); });
  assert.ok(key, 'la chiamata è nel tracker con la sua funzione');
  var buf = costTracker.bufferSnapshot()[key];
  assert.equal(buf.calls, 1); assert.equal(buf.input_tokens, 1000); assert.equal(buf.cache_read, 5000);
});

test('create: il client wrapper mantiene messages.create; risposta senza testo non esplode', async function() {
  var fake = { messages: { create: async function() { return { stop_reason: 'max_tokens', usage: {}, content: [{ type: 'thinking', thinking: '' }] }; } } };
  var res = await utility.client('daily_parser', { client: fake }).messages.create({ max_tokens: 60, messages: [] });
  assert.equal(utility.textOf(res), '');
});

test('estimateCost: cache letta a un decimo, scritta a 1,25', function() {
  // Opus 5: $5 input. 1M input pieni = 5; 1M cache read = 0.5; 1M cache write = 6.25
  assert.equal(costTracker.estimateCost('claude-opus-5', 1000000, 0), 5);
  assert.equal(costTracker.estimateCost('claude-opus-5', 0, 0, 1000000, 0), 0.5);
  assert.equal(costTracker.estimateCost('claude-opus-5', 0, 0, 0, 1000000), 6.25);
  assert.equal(costTracker.estimateCost('claude-sonnet-5', 0, 100000), 1);
});
