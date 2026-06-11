'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var dates = require('../src/utils/trackingDates');

test('addDays attraversa mesi e DST senza slittamenti', function() {
  assert.equal(dates.addDays('2026-06-30', 1), '2026-07-01');
  assert.equal(dates.addDays('2026-03-28', 2), '2026-03-30'); // cambio ora legale EU (29/3)
  assert.equal(dates.addDays('2026-01-01', -1), '2025-12-31');
});

test('nextMonday non ritorna mai la data stessa', function() {
  assert.equal(dates.nextMonday('2026-06-11'), '2026-06-15'); // giovedì → lunedì
  assert.equal(dates.nextMonday('2026-06-15'), '2026-06-22'); // lunedì → lunedì +7
  assert.equal(dates.nextMonday('2026-06-14'), '2026-06-15'); // domenica → lunedì
});

test('weekStartOf ritorna il lunedì della settimana', function() {
  assert.equal(dates.weekStartOf('2026-06-10'), '2026-06-08'); // mercoledì
  assert.equal(dates.weekStartOf('2026-06-08'), '2026-06-08'); // lunedì stesso
  assert.equal(dates.weekStartOf('2026-06-14'), '2026-06-08'); // domenica → lunedì precedente
});

test('previousWorkingDay salta il weekend', function() {
  assert.equal(dates.previousWorkingDay('2026-06-15'), '2026-06-12'); // lunedì → venerdì
  assert.equal(dates.previousWorkingDay('2026-06-10'), '2026-06-09'); // mercoledì → martedì
  assert.equal(dates.previousWorkingDay('2026-06-14'), '2026-06-12'); // domenica → venerdì
});

test('isWorkingDay distingue lun-ven da sabato/domenica', function() {
  assert.equal(dates.isWorkingDay('2026-06-12'), true);  // venerdì
  assert.equal(dates.isWorkingDay('2026-06-13'), false); // sabato
  assert.equal(dates.isWorkingDay('2026-06-14'), false); // domenica
});

test('oggiRome/oraRome hanno il formato atteso', function() {
  assert.match(dates.oggiRome(), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(dates.oraRome(), /^\d{2}:\d{2}$/);
});
