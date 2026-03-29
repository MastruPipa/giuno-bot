'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var { withTimeout, withRetry } = require('../src/utils/retryPolicy');

test('withTimeout resolves before deadline', async function() {
  var res = await withTimeout(Promise.resolve('ok'), 200, 'quick');
  assert.equal(res, 'ok');
});

test('withTimeout rejects after deadline', async function() {
  await assert.rejects(function() {
    return withTimeout(new Promise(function(resolve) { setTimeout(resolve, 80); }), 10, 'slow');
  }, /Timeout slow/);
});

test('withRetry retries and succeeds', async function() {
  var calls = 0;
  var result = await withRetry(async function() {
    calls++;
    if (calls < 3) throw new Error('transient');
    return 'done';
  }, { retries: 3, baseDelayMs: 1, maxDelayMs: 5 });

  assert.equal(result, 'done');
  assert.equal(calls, 3);
});

test('withRetry stops on max retries', async function() {
  var calls = 0;
  await assert.rejects(function() {
    return withRetry(async function() {
      calls++;
      throw new Error('always-fail');
    }, { retries: 1, baseDelayMs: 1, maxDelayMs: 5 });
  }, /always-fail/);

  assert.equal(calls, 2);
});
