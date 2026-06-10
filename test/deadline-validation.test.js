'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var { validateDeadline } = require('../src/agents/deadlineDetector');

var TODAY = '2026-06-10';

test('scadenza ISO valida e futura → ok con data concreta', function() {
  var res = validateDeadline('2026-06-15', TODAY);
  assert.equal(res.ok, true);
  assert.equal(res.iso, '2026-06-15');
});

test('scadenza oggi stesso → valida', function() {
  var res = validateDeadline(TODAY, TODAY);
  assert.equal(res.ok, true);
  assert.equal(res.iso, TODAY);
});

test('data passata → scartata (non deve diventare un reminder)', function() {
  var res = validateDeadline('2026-06-09', TODAY);
  assert.equal(res.ok, false);
  assert.match(res.reason, /passata/);
});

test('data allucinata (2026-99-99, 2026-02-31) → scartata', function() {
  assert.equal(validateDeadline('2026-99-99', TODAY).ok, false);
  assert.equal(validateDeadline('2026-02-31', TODAY).ok, false);
});

test('anno sbagliato oltre orizzonte (es. +2 anni) → scartata', function() {
  var res = validateDeadline('2028-06-10', TODAY);
  assert.equal(res.ok, false);
  assert.match(res.reason, /orizzonte/);
});

test('descrizione testuale ("fine mese") → salvabile ma senza reminder', function() {
  var res = validateDeadline('fine mese', TODAY);
  assert.equal(res.ok, true);
  assert.equal(res.iso, null);
});

test('vuota/null → scartata', function() {
  assert.equal(validateDeadline('', TODAY).ok, false);
  assert.equal(validateDeadline(null, TODAY).ok, false);
});
