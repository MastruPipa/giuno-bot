'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var evalRunner = require('../src/utils/evalRunner');
var evalRun = require('../scripts/eval-run');

test('parseSummary/formatSummary leggono il riepilogo JSON dallo stdout', function() {
  var stdout = '[1/2] a … OK\n[2/2] b … FAIL\n1/2 casi superati\nEVAL_JSON {"passed":1,"total":2,"avg_judge":0.8,"failed":[{"id":"b","failures":["manca \\"x\\""],"judge":"troppo lungo","reply":"ciao"}]}\n';
  var sum = evalRunner.parseSummary(stdout);
  assert.equal(sum.passed, 1);
  var text = evalRunner.formatSummary(sum, stdout);
  assert.match(text, /\*Eval:\* 1\/2 casi superati · giudice medio 0\.80/);
  assert.match(text, /✗ \*b\* — manca "x" — giudice: troppo lungo/);
  assert.match(evalRunner.formatSummary(null, 'tail'), /senza riepilogo/);
});

test('simulateSideEffect: nessun effetto reale, forma compatibile con i tool veri', function() {
  var dm = evalRun.simulateSideEffect('send_dm', { target_user_names: ['Paolo', 'Giusy'], message: 'ciao' });
  assert.equal(dm.simulated, true);
  assert.equal(dm.sent.length, 2);
  var c = evalRun.simulateSideEffect('send_campaign', { target_user_ids: ['U1'] });
  assert.equal(c.campaign_id, 'cmp_eval');
  assert.equal(evalRun.simulateSideEffect('set_reminder', {}).success, true);
});

test('i casi eval sono validi: id unico, mode noto, expect presente, tool citati esistenti', function() {
  process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || 'x';
  process.env.SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || 'x';
  process.env.SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN || 'x';
  var Module = require('module');
  var boltPath = require.resolve('@slack/bolt');
  if (!require.cache[boltPath]) {
    var stub = new Module(boltPath); stub.filename = boltPath; stub.loaded = true;
    stub.exports = { App: function StubApp() { this.client = {}; this.error = function() {}; } };
    require.cache[boltPath] = stub;
  }
  var names = new Set(require('../src/tools/registry').getAllTools().map(function(t) { return t.name; }));
  var cases = evalRun.loadCases();
  assert.ok(cases.length >= 15, 'casi: ' + cases.length);
  var ids = new Set();
  cases.forEach(function(c) {
    assert.ok(!ids.has(c.id), 'id duplicato ' + c.id); ids.add(c.id);
    assert.ok(['dm', 'thread', 'mention'].indexOf(c.mode) !== -1, c.id + ': mode');
    assert.ok(c.expect && (c.expect.rubric || c.expect.no_reply === true), c.id + ': expect');
    (c.expect.must_call_tool || []).concat(c.expect.must_not_call_tool || []).forEach(function(t) { assert.ok(names.has(t), c.id + ': tool sconosciuto ' + t); });
  });
});
