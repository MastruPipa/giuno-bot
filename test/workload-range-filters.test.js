'use strict';

// resolveRangeFilters: querystring → intervallo [from, to] + filtri sanificati.
// Oggi fissato a giovedì 2026-07-09 (settimana 2026-07-06 → 2026-07-12).

var test = require('node:test');
var assert = require('node:assert/strict');
var { resolveRangeFilters } = require('../src/handlers/workloadDashboard');

var TODAY = '2026-07-09';

test('default: questa settimana (lun-dom)', function() {
  var f = resolveRangeFilters({}, TODAY);
  assert.equal(f.preset, 'settimana');
  assert.equal(f.from, '2026-07-06');
  assert.equal(f.to, '2026-07-12');
  assert.equal(f.weekAnchor, '2026-07-06');
  assert.equal(f.user, null);
  assert.equal(f.project, null);
});

test('preset oggi', function() {
  var f = resolveRangeFilters({ range: 'oggi' }, TODAY);
  assert.equal(f.from, TODAY);
  assert.equal(f.to, TODAY);
});

test('preset settimana_scorsa', function() {
  var f = resolveRangeFilters({ range: 'settimana_scorsa' }, TODAY);
  assert.equal(f.from, '2026-06-29');
  assert.equal(f.to, '2026-07-05');
});

test('preset due_settimane: settimana scorsa + corrente', function() {
  var f = resolveRangeFilters({ range: 'due_settimane' }, TODAY);
  assert.equal(f.from, '2026-06-29');
  assert.equal(f.to, '2026-07-12');
});

test('preset mese e mese_scorso', function() {
  var f = resolveRangeFilters({ range: 'mese' }, TODAY);
  assert.equal(f.from, '2026-07-01');
  assert.equal(f.to, '2026-07-31');
  var g = resolveRangeFilters({ range: 'mese_scorso' }, TODAY);
  assert.equal(g.from, '2026-06-01');
  assert.equal(g.to, '2026-06-30');
});

test('preset mese_scorso a gennaio scavalca l\'anno', function() {
  var f = resolveRangeFilters({ range: 'mese_scorso' }, '2026-01-15');
  assert.equal(f.from, '2025-12-01');
  assert.equal(f.to, '2025-12-31');
});

test('preset trimestre: quarter-to-date', function() {
  var f = resolveRangeFilters({ range: 'trimestre' }, TODAY);
  assert.equal(f.from, '2026-07-01'); // Q3
  assert.equal(f.to, TODAY);
  var g = resolveRangeFilters({ range: 'trimestre' }, '2026-05-20');
  assert.equal(g.from, '2026-04-01'); // Q2
});

test('?week= legacy: ancorata al lunedì', function() {
  var f = resolveRangeFilters({ week: '2026-06-10' }, TODAY); // mercoledì
  assert.equal(f.preset, 'settimana');
  assert.equal(f.from, '2026-06-08');
  assert.equal(f.to, '2026-06-14');
  assert.equal(f.weekAnchor, '2026-06-08');
});

test('from/to espliciti vincono su range e week', function() {
  var f = resolveRangeFilters({ from: '2026-05-01', to: '2026-05-15', range: 'mese', week: '2026-06-10' }, TODAY);
  assert.equal(f.preset, 'custom');
  assert.equal(f.from, '2026-05-01');
  assert.equal(f.to, '2026-05-15');
});

test('from/to invertiti vengono scambiati', function() {
  var f = resolveRangeFilters({ from: '2026-05-15', to: '2026-05-01' }, TODAY);
  assert.equal(f.from, '2026-05-01');
  assert.equal(f.to, '2026-05-15');
});

test('date invalide o parziali → fallback settimana', function() {
  var f = resolveRangeFilters({ from: '2026-99-99', to: '2026-05-15' }, TODAY);
  assert.equal(f.preset, 'settimana');
  var g = resolveRangeFilters({ from: '2026-05-01' }, TODAY); // manca to
  assert.equal(g.preset, 'settimana');
  var h = resolveRangeFilters({ range: 'inesistente', week: 'garbage' }, TODAY);
  assert.equal(h.preset, 'settimana');
});

test('user/project sanificati con whitelist', function() {
  var f = resolveRangeFilters({ user: 'U0DEADBEEF', project: 'prj_sito-web' }, TODAY);
  assert.equal(f.user, 'U0DEADBEEF');
  assert.equal(f.project, 'prj_sito-web');
  var g = resolveRangeFilters({ user: '<script>', project: '"><img src=x>' }, TODAY);
  assert.equal(g.user, null);
  assert.equal(g.project, null);
});
