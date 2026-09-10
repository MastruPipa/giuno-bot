'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var grader = require('../eval/lib/grader');

test('deterministicChecks: no_reply atteso', function() {
  var c = { expect: { no_reply: true } };
  assert.deepEqual(grader.deterministicChecks(c, '[NO_REPLY]', []), []);
  var f = grader.deterministicChecks(c, 'Ciao a tutti', []);
  assert.equal(f.length, 1);
  assert.match(f[0], /silenzio/);
});

test('deterministicChecks: include, esclude, righe, tool, formato', function() {
  var c = { expect: {
    no_reply: false, must_include: ['venerdì'], must_not_include: ['non ho capito'],
    max_lines: 2, must_call_tool: ['query_standup'], must_not_call_tool: ['send_email'],
  } };
  var ok = grader.deterministicChecks(c, 'Consegna *venerdì*.\nPresentazione martedì.', ['query_standup']);
  assert.deepEqual(ok, []);
  var bad = grader.deterministicChecks(c, '**Non ho capito**\n## Titolo\nriga\nriga', ['send_email']);
  assert.ok(bad.some(function(x) { return /manca "venerdì"/.test(x); }));
  assert.ok(bad.some(function(x) { return /contiene "non ho capito"/.test(x); }));
  assert.ok(bad.some(function(x) { return /troppo lunga/.test(x); }));
  assert.ok(bad.some(function(x) { return /non ha chiamato il tool query_standup/.test(x); }));
  assert.ok(bad.some(function(x) { return /ha chiamato il tool send_email/.test(x); }));
  assert.ok(bad.some(function(x) { return /doppio asterisco/.test(x); }));
  assert.ok(bad.some(function(x) { return /titolo markdown/.test(x); }));
  var silent = grader.deterministicChecks(c, '[NO_REPLY]', []);
  assert.ok(silent.some(function(x) { return /doveva rispondere/.test(x); }));
});

test('buildJudgePrompt: include storia, messaggio, risposta e rubrica', function() {
  var c = { id: 'x', description: 'd', transcript: [{ role: 'user', content: 'ciao' }, { role: 'assistant', content: 'ehi' }],
    message: 'come va?', expect: { rubric: 'deve salutare' } };
  var p = grader.buildJudgePrompt(c, 'bene');
  assert.match(p, /UTENTE: ciao/);
  assert.match(p, /GIUNO: ehi/);
  assert.match(p, /MESSAGGIO DELL'UTENTE:\ncome va\?/);
  assert.match(p, /RISPOSTA DI GIUNO:\nbene/);
  assert.match(p, /RUBRICA:\ndeve salutare/);
});

test('judge: parsa il JSON del giudice e gestisce output sporco', async function() {
  var fakeClient = { messages: { create: async function() {
    return { content: [{ type: 'text', text: 'Ecco: {"score": 0.9, "pass": true, "reason": "ok"}' }] };
  } } };
  var v = await grader.judge(fakeClient, 'm', { expect: { rubric: 'r' }, transcript: [], message: 'm' }, 'r');
  assert.deepEqual(v, { score: 0.9, pass: true, reason: 'ok' });
  var noRubric = await grader.judge(fakeClient, 'm', { expect: {} }, 'r');
  assert.equal(noRubric, null);
  var bad = { messages: { create: async function() { return { content: [{ type: 'text', text: 'boh' }] }; } } };
  var v2 = await grader.judge(bad, 'm', { expect: { rubric: 'r' }, transcript: [], message: 'm' }, 'r');
  assert.equal(v2.pass, false);
});
