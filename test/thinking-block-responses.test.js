'use strict';

// 17/9: con Sonnet 5 / Opus 5 il primo blocco della risposta può essere
// "thinking": chi leggeva content[0].text esplodeva (CONSOLIDATE: "reading
// 'trim' of undefined") o, peggio, falliva in silenzio (aggancio commesse).
// Qui l'SDK è finto e risponde SEMPRE con un blocco thinking davanti.

var test = require('node:test');
var assert = require('node:assert/strict');
var Module = require('module');

var seen = [];
var sdkPath = require.resolve('@anthropic-ai/sdk');
var stub = new Module(sdkPath); stub.filename = sdkPath; stub.loaded = true;
stub.exports = function FakeAnthropic() {
  this.messages = { create: async function(req) {
    seen.push(req);
    var text = /commessa/.test(req.system || '') ? 'Elfo' : '{"matches":{"0":"Elfo"}}';
    return { stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: text }] };
  } };
};
require.cache[sdkPath] = stub;

var utility = require('../src/services/utilityModel');
var projectContext = require('../src/services/projectContext');

test('utilityModel: thinking spento nella richiesta, testo letto dal blocco giusto', async function() {
  var res = await utility.create({ max_tokens: 60, system: 's', messages: [{ role: 'user', content: 'x' }] }, 'test');
  assert.deepEqual(seen[seen.length - 1].thinking, { type: 'disabled' });
  assert.equal(utility.textOf(res), '{"matches":{"0":"Elfo"}}');
});

test('projectContext.matchByModel: con il blocco thinking davanti l\'aggancio alla commessa funziona', async function() {
  var catalog = [{ id: 'attio_1', name: 'Elfo', norms: ['elfo'] }, { id: 'attio_2', name: 'Vinokilo', norms: ['vinokilo'] }, { id: 'cat_x', name: 'Interno' }];
  var hit = await projectContext.matchByModel('setting canali social e Business Manager con Gianna', catalog, ['attio_1']);
  assert.ok(hit, 'prima: risposta letta da content[0] (thinking) → stringa vuota → null silenzioso');
  assert.equal(hit.id, 'attio_1');
});
