'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var logger = require('../src/utils/logger');

test('logger exposes expected methods', function() {
  assert.equal(typeof logger.debug, 'function');
  assert.equal(typeof logger.info, 'function');
  assert.equal(typeof logger.warn, 'function');
  assert.equal(typeof logger.error, 'function');
});

test('logger methods are callable with different arg types', function() {
  logger.debug('debug message', { a: 1 });
  logger.info('info message', null);
  logger.warn('warn message', undefined);
  logger.error('error message', new Error('boom'));
  assert.ok(true);
});
