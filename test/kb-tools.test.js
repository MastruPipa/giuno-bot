'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var db = require('../supabase');
var kbTools = require('../src/tools/kbTools');

test('search_kb validates empty query', async function() {
  await assert.rejects(function() {
    return kbTools.execute('search_kb', { query: '   ' }, 'U1');
  }, /Query KB mancante/);
});

test('add_to_kb validates missing content', async function() {
  await assert.rejects(function() {
    return kbTools.execute('add_to_kb', { content: '' }, 'U1');
  }, /Contenuto KB mancante/);
});

test('search_kb supports async db.searchKB', async function() {
  var original = db.searchKB;
  db.searchKB = function() {
    return Promise.resolve([{ id: '1', content: 'x' }]);
  };

  try {
    var res = await kbTools.execute('search_kb', { query: 'test' }, 'U1');
    assert.equal(res.count, 1);
    assert.equal(Array.isArray(res.entries), true);
  } finally {
    db.searchKB = original;
  }
});
