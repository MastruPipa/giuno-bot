'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var runtime = require('../src/config/runtime');

test('getMissingEnv returns only missing/blank vars', function() {
  process.env.RUNTIME_TEST_OK = '1';
  process.env.RUNTIME_TEST_BLANK = '   ';

  var missing = runtime.getMissingEnv(['RUNTIME_TEST_OK', 'RUNTIME_TEST_BLANK', 'RUNTIME_TEST_MISSING']);
  assert.deepEqual(missing, ['RUNTIME_TEST_BLANK', 'RUNTIME_TEST_MISSING']);
});

test('validateEnv throws when required vars are missing', function() {
  delete process.env.RUNTIME_TEST_NEVER_SET;
  assert.throws(function() {
    runtime.validateEnv(['RUNTIME_TEST_NEVER_SET'], 'RUNTIME_TEST');
  }, /Variabili ambiente mancanti/);
});
