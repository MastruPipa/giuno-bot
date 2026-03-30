'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var test = require('node:test');
var assert = require('node:assert/strict');
var dbClient = require('../src/services/db/client');

function tmpFile(name) {
  return path.join(os.tmpdir(), 'giuno-' + process.pid + '-' + Date.now() + '-' + name);
}

test('writeJSON/readJSON roundtrip works', function() {
  var file = tmpFile('ok.json');
  var payload = { hello: 'world', n: 42 };
  dbClient.writeJSON(file, payload);

  var parsed = dbClient.readJSON(file, null);
  assert.deepEqual(parsed, payload);

  fs.unlinkSync(file);
});

test('readJSON returns default for malformed json', function() {
  var file = tmpFile('bad.json');
  fs.writeFileSync(file, '{oops', 'utf8');

  var fallback = { fallback: true };
  var parsed = dbClient.readJSON(file, fallback);
  assert.deepEqual(parsed, fallback);

  fs.unlinkSync(file);
});
