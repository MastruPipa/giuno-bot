'use strict';

var test = require('node:test');
var assert = require('node:assert');

// Ensure the module loads with no Attio key configured.
delete process.env.ATTIO_API_KEY;
var attioTools = require('../src/tools/attioTools');
var attioService = require('../src/services/attioService');

test('attioTools exposes the 5 CRM tools', function() {
  var names = attioTools.definitions.map(function(d) { return d.name; });
  ['attio_search', 'attio_get_record', 'attio_create_record', 'attio_update_record', 'attio_add_note']
    .forEach(function(n) { assert.ok(names.includes(n), 'missing tool: ' + n); });
});

test('every definition has a valid input_schema', function() {
  attioTools.definitions.forEach(function(d) {
    assert.equal(typeof d.description, 'string');
    assert.equal(d.input_schema.type, 'object');
    assert.equal(typeof d.input_schema.properties, 'object');
  });
});

test('service reports not configured without a key', function() {
  assert.equal(attioService.isConfigured(), false);
});

test('execute degrades gracefully when Attio is not configured', async function() {
  var res = await attioTools.execute('attio_search', { object: 'companies', query: 'Acme' }, 'U1', 'admin');
  assert.ok(res.error && /ATTIO_API_KEY/.test(res.error), 'expected not-configured error, got: ' + JSON.stringify(res));
});

test('invalid object is rejected once configured', async function() {
  process.env.ATTIO_API_KEY = 'dummy-key';
  var res = await attioTools.execute('attio_search', { object: 'invoices' }, 'U1', 'admin');
  delete process.env.ATTIO_API_KEY;
  assert.ok(res.error && /object non valido/.test(res.error), 'expected invalid-object error, got: ' + JSON.stringify(res));
});
