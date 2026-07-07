'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var { normalizeParsed } = require('../src/services/dailyParser');

// Daily unico delle 16:00: "oggi" = fatto (ore reali), "domani" = piano.

test('normalizeParsed: output valido del modello → structured con totali', function() {
  var out = normalizeParsed({
    oggi: [
      { task: 'Bagno Maria montaggio', hours: 3, minutes: 0 },
      { task: 'Meeting Management', hours: 0, minutes: 45 },
    ],
    domani: [{ task: 'Gambino check video', hours: 1, minutes: 30 }],
    blocchi: null,
  });
  assert.equal(out.oggi.length, 2);
  assert.equal(out.domani.length, 1);
  assert.equal(out.totalOggi, 3.75);
  assert.equal(out.totalDomani, 1.5);
  assert.equal(out.blocchi, null);
});

test('normalizeParsed: task sotto "ieri" (vecchia abitudine) confluiscono nel fatto di oggi', function() {
  var out = normalizeParsed({
    oggi: [{ task: 'montaggio', hours: 2, minutes: 0 }],
    ieri: [{ task: 'shooting', hours: 5, minutes: 0 }],
    domani: [],
  });
  assert.equal(out.oggi.length, 2); // montaggio + shooting
  assert.equal(out.totalOggi, 7);
});

test('normalizeParsed: valori sporchi vengono clampati e i task vuoti scartati', function() {
  var out = normalizeParsed({
    oggi: [{ task: '', hours: 2 }, { task: 'X', hours: 99, minutes: 99 }, null],
    domani: [{ task: 'ok', hours: '2', minutes: '15' }],
    blocchi: '   ',
  });
  assert.equal(out.oggi.length, 1);
  assert.equal(out.oggi[0].hours, 24);   // clamp a 24h
  assert.equal(out.oggi[0].minutes, 59); // clamp a 59min
  assert.equal(out.domani[0].hours, 2);  // stringhe numeriche accettate
  assert.equal(out.domani[0].minutes, 15);
  assert.equal(out.blocchi, null);       // blocchi solo-spazi → null
});

test('normalizeParsed: nessun task utilizzabile → null (si salva solo raw_text)', function() {
  assert.equal(normalizeParsed({ oggi: [], domani: [], blocchi: null }), null);
  assert.equal(normalizeParsed(null), null);
  assert.equal(normalizeParsed('garbage'), null);
  assert.equal(normalizeParsed({ oggi: 'no', domani: 42 }), null);
});
