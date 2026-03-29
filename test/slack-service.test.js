'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var { shouldRetrySlackError } = require('../src/services/slackRetry');
var { TimeoutError } = require('../src/errors');

test('shouldRetrySlackError identifies transient errors', function() {
  assert.equal(shouldRetrySlackError({ message: 'socket hang up' }), true);
  assert.equal(shouldRetrySlackError({ message: 'ETIMEDOUT happened' }), true);
  assert.equal(shouldRetrySlackError({ data: { error: 'ratelimited' } }), true);
  assert.equal(shouldRetrySlackError(new TimeoutError('timeout')), true);
  assert.equal(shouldRetrySlackError({ message: 'invalid_auth' }), false);
});
