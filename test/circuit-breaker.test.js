'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var { createCircuitBreaker } = require('../src/utils/circuitBreaker');

test('circuit breaker opens after threshold and blocks calls', async function() {
  var cb = createCircuitBreaker('t', { failureThreshold: 2, cooldownMs: 50 });

  await assert.rejects(function() { return cb.exec(async function() { throw new Error('x1'); }); });
  await assert.rejects(function() { return cb.exec(async function() { throw new Error('x2'); }); });

  await assert.rejects(function() { return cb.exec(async function() { return 'ok'; }); }, /Circuit open/);
  assert.equal(cb.status().state, 'open');
});
