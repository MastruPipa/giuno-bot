'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var {
  UserInputError,
  ExternalServiceError,
  PermissionError,
  TransientError,
  TimeoutError,
  isTransientError,
} = require('../src/errors');

test('error taxonomy exposes expected classes and metadata', function() {
  var e1 = new UserInputError('bad input');
  var e2 = new ExternalServiceError('external down');
  var e3 = new PermissionError('denied');
  var e4 = new TransientError('retry me');
  var e5 = new TimeoutError('too slow', { timeoutMs: 1000 });

  assert.equal(e1.code, 'USER_INPUT_ERROR');
  assert.equal(e2.code, 'EXTERNAL_SERVICE_ERROR');
  assert.equal(e3.code, 'PERMISSION_ERROR');
  assert.equal(e4.code, 'TRANSIENT_ERROR');
  assert.equal(e5.code, 'TIMEOUT_ERROR');
  assert.equal(e5.metadata.timeoutMs, 1000);
});

test('isTransientError detects transient/timeout classes', function() {
  assert.equal(isTransientError(new TransientError('x')), true);
  assert.equal(isTransientError(new TimeoutError('y')), true);
  assert.equal(isTransientError(new Error('z')), false);
});
