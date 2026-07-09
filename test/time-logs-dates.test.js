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

test('monthStartOf/monthEndOf: metà mese, cambio anno, bisestile', function() {
  assert.equal(dates.monthStartOf('2026-07-15'), '2026-07-01');
  assert.equal(dates.monthEndOf('2026-07-15'), '2026-07-31');
  assert.equal(dates.monthEndOf('2026-12-05'), '2026-12-31'); // dic → gen senza slittare anno
  assert.equal(dates.monthEndOf('2026-02-10'), '2026-02-28');
  assert.equal(dates.monthEndOf('2028-02-10'), '2028-02-29'); // bisestile
  assert.equal(dates.monthEndOf('2026-04-01'), '2026-04-30');
});

test('quarterStartOf: i quattro trimestri solari', function() {
  assert.equal(dates.quarterStartOf('2026-02-15'), '2026-01-01'); // Q1
  assert.equal(dates.quarterStartOf('2026-05-20'), '2026-04-01'); // Q2
  assert.equal(dates.quarterStartOf('2026-07-09'), '2026-07-01'); // Q3
  assert.equal(dates.quarterStartOf('2026-12-31'), '2026-10-01'); // Q4
  assert.equal(dates.quarterStartOf('2026-10-01'), '2026-10-01'); // primo giorno del trimestre
});

// ─── foldPlannedVsActual (fold puro su righe time_logs) ──────────────────────

var { foldPlannedVsActual } = require('../src/services/db/timeLogs');

test('foldPlannedVsActual: daily → actual, weekly → planned, nesting per progetto', function() {
  var out = foldPlannedVsActual([
    { slack_user_id: 'U1', project_id: 'p1', log_type: 'daily', hours: '3.5', projects: { name: 'Sito' } },
    { slack_user_id: 'U1', project_id: 'p1', log_type: 'daily', hours: 2, projects: { name: 'Sito' } },
    { slack_user_id: 'U1', project_id: 'p1', log_type: 'weekly', hours: 8, projects: { name: 'Sito' } },
    { slack_user_id: 'U2', project_id: 'p2', log_type: 'daily', hours: 4 }, // senza join → nome = id
  ]);
  assert.equal(out.byUser.U1.actual, 5.5);
  assert.equal(out.byUser.U1.planned, 8);
  assert.equal(out.byUser.U1.projects.p1.actual, 5.5);
  assert.equal(out.byUser.U1.projects.p1.name, 'Sito');
  assert.equal(out.byProject.p1.planned, 8);
  assert.equal(out.byProject.p2.name, 'p2'); // fallback nome → project_id
  assert.equal(out.byUser.U2.planned, 0);
});

test('foldPlannedVsActual: input vuoto o nullo → aggregati vuoti', function() {
  assert.deepEqual(foldPlannedVsActual([]), { byUser: {}, byProject: {} });
  assert.deepEqual(foldPlannedVsActual(null), { byUser: {}, byProject: {} });
});
