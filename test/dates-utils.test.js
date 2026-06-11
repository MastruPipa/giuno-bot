'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var dates = require('../src/utils/dates');

test('todayISO è la data di Roma, non UTC', function() {
  var expected = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date());
  assert.equal(dates.todayISO(), expected);
  assert.match(dates.todayISO(), /^\d{4}-\d{2}-\d{2}$/);
});

test('daysFromTodayISO: aritmetica relativa a oggi (Roma)', function() {
  assert.equal(dates.daysFromTodayISO(0), dates.todayISO());
  var plus1 = new Date(dates.todayISO() + 'T12:00:00Z');
  plus1.setUTCDate(plus1.getUTCDate() + 1);
  assert.equal(dates.daysFromTodayISO(1), plus1.toISOString().slice(0, 10));
  assert.match(dates.daysFromTodayISO(-30), /^\d{4}-\d{2}-\d{2}$/);
});

test('mondayISO: è un lunedì ed è <= oggi', function() {
  var monday = dates.mondayISO();
  assert.equal(new Date(monday + 'T12:00:00Z').getUTCDay(), 1);
  assert.ok(monday <= dates.todayISO());
});

test('dateContextIt contiene giorno settimana, data ISO e anno esplicito', function() {
  var ctx = dates.dateContextIt();
  var iso = dates.todayISO();
  assert.ok(ctx.indexOf(iso) !== -1, 'manca la data ISO');
  assert.ok(ctx.indexOf('Anno corrente: ' + iso.slice(0, 4)) !== -1, 'manca l\'anno esplicito');
  assert.ok(ctx.indexOf('Europe/Rome') !== -1, 'manca il fuso');
});

test('ageLabelIt: etichette umane per ogni fascia di età', function() {
  var now = Date.now();
  assert.equal(dates.ageLabelIt(new Date(now - 3600000).toISOString()), 'oggi');
  assert.equal(dates.ageLabelIt(new Date(now - 1.2 * 86400000).toISOString()), 'ieri');
  assert.equal(dates.ageLabelIt(new Date(now - 12 * 86400000).toISOString()), '12 giorni fa');
  assert.match(dates.ageLabelIt(new Date(now - 95 * 86400000).toISOString()), /^~3 mesi fa$/);
  assert.match(dates.ageLabelIt(new Date(now - 400 * 86400000).toISOString()), /^~1 anno fa$/);
  assert.match(dates.ageLabelIt(new Date(now - 800 * 86400000).toISOString()), /^~2 anni fa$/);
  assert.equal(dates.ageLabelIt(null), null);
  assert.equal(dates.ageLabelIt('non-una-data'), null);
});

test('isValidISODate: respinge formati errati e date impossibili', function() {
  assert.equal(dates.isValidISODate('2026-06-10'), true);
  assert.equal(dates.isValidISODate('2026-99-99'), false);
  assert.equal(dates.isValidISODate('2026-02-31'), false);
  assert.equal(dates.isValidISODate('10/06/2026'), false);
  assert.equal(dates.isValidISODate('fine mese'), false);
  assert.equal(dates.isValidISODate(''), false);
  assert.equal(dates.isValidISODate(null), false);
});
