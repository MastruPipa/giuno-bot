'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var kbTools = require('../src/tools/kbTools');
var { toUserErrorMessage } = require('../src/utils/errorResponse');

test('integration: kb validation error maps to friendly message', async function() {
  try {
    await kbTools.execute('search_kb', { query: '' }, 'U1');
    assert.fail('expected error');
  } catch (e) {
    var msg = toUserErrorMessage(e);
    assert.equal(msg, 'Query KB mancante.');
  }
});
