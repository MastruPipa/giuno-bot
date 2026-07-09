'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var { buildOverview } = require('../src/services/workloadService');
var { aggregateStandupRows } = require('../src/tools/standupTools');

// Settimana lun 6/7 → dom 12/7 (5 giorni lavorativi)
var WEEK_START = '2026-07-06';
var WEEK_END = '2026-07-12';

function standupFixture() {
  var rows = [
    { slack_user_id: 'U_GIUSY', date: '2026-07-06', ieri_tasks: [], oggi_tasks: [{ task: 'Bagno Maria', hours: 8, minutes: 0 }] },
    { slack_user_id: 'U_GIUSY', date: '2026-07-07', ieri_tasks: [], oggi_tasks: [{ task: 'Tarocco', hours: 7, minutes: 30 }] },
  ];
  return aggregateStandupRows(rows, {}, WEEK_START, WEEK_END);
}

var PVA = {
  byUser: { U_GIUSY: { planned: 10, actual: 7.5, projects: {} } },
  byProject: {},
};

var WEEK_LOGS = [
  { slack_user_id: 'U_GIUSY', log_date: '2026-07-06', log_type: 'daily', hours: 7.5 },
  { slack_user_id: 'U_GIUSY', log_date: '2026-07-06', log_type: 'weekly', hours: 10 },
];

test('buildOverview: fonde stimato (daily), effettivo e pianificato (time_logs)', function() {
  var ov = buildOverview(standupFixture(), PVA, WEEK_LOGS, WEEK_START, WEEK_END);
  var u = ov.byUser.U_GIUSY;
  assert.equal(u.estimated_hours, 15.5);   // 8h + 7h30 dai daily
  assert.equal(u.actual_hours, 7.5);       // dai time_logs daily
  assert.equal(u.planned_hours, 10);       // dal weekly planner
  assert.equal(u.days_with_daily, 2);
  assert.equal(u.missing_dailies, 3);      // 5 lavorativi - 2 daily
  assert.equal(u.days_with_checkin, 1);    // solo il 6/7 (il weekly non conta)
  assert.equal(u.missing_checkins, 4);
  assert.equal(u.carico, 'pieno');         // 15.5h su 16h tracciate ≈ 97%
});

test('buildOverview: utente presente solo nei time_logs compare comunque', function() {
  var pva = { byUser: { U_SOLO_TT: { planned: 0, actual: 4, projects: {} } }, byProject: {} };
  var ov = buildOverview(null, pva, [], WEEK_START, WEEK_END);
  var u = ov.byUser.U_SOLO_TT;
  assert.equal(u.actual_hours, 4);
  assert.equal(u.estimated_hours, 0);
  assert.equal(u.days_with_daily, 0);
  assert.equal(u.carico, null); // nessun daily → nessun giudizio sulle stime
});

test('buildOverview: periodo dichiarato e legenda delle fonti presenti', function() {
  var ov = buildOverview(null, null, [], WEEK_START, WEEK_END);
  assert.equal(ov.workdays, 5);
  assert.ok(ov.periodo.indexOf(WEEK_START) !== -1);
  assert.ok(/dichiarato/.test(ov.legenda) && /effettivo/.test(ov.legenda));
});

test('buildOverview: emette sia le chiavi legacy week_* sia date_from/date_to', function() {
  var ov = buildOverview(null, null, [], WEEK_START, WEEK_END);
  assert.equal(ov.week_start, WEEK_START);
  assert.equal(ov.week_end, WEEK_END);
  assert.equal(ov.date_from, WEEK_START);
  assert.equal(ov.date_to, WEEK_END);
});

test('buildOverview: range di un solo giorno feriale → carico su 8h', function() {
  var day = '2026-07-07'; // martedì
  var agg = aggregateStandupRows([
    { slack_user_id: 'U_GIUSY', date: day, ieri_tasks: [], oggi_tasks: [{ task: 'Bagno Maria', hours: 9, minutes: 0 }] },
  ], {}, day, day);
  var ov = buildOverview(agg, null, [], day, day);
  assert.equal(ov.workdays, 1);
  assert.equal(ov.byUser.U_GIUSY.estimated_hours, 9);
  assert.equal(ov.byUser.U_GIUSY.carico, 'sovraccarico'); // 9h/8h ≈ 113%
  assert.equal(ov.byUser.U_GIUSY.missing_dailies, 0);
});

// ─── Consuntivo auto-derivato dal daily unico ─────────────────────────────────

var { deriveTimeLogRows } = require('../src/services/workloadService');

test('deriveTimeLogRows: aggrega per progetto solo i task agganciati', function() {
  var rows = deriveTimeLogRows([
    { task: 'Bagno Maria montaggio', hours: 3, minutes: 0, project_id: 'attio_1' },
    { task: 'Bagno Maria copy', hours: 1, minutes: 30, project_id: 'attio_1' },
    { task: 'Tarocco caroselli', hours: 2, minutes: 0, project_id: 'attio_2' },
    { task: 'mail varie', hours: 1, minutes: 0 }, // senza progetto → non consuntivato
  ], 'U_X', '2026-07-07');
  assert.equal(rows.length, 2);
  var bm = rows.find(function(r) { return r.project_id === 'attio_1'; });
  assert.equal(bm.hours, 4.5);
  assert.equal(bm.log_type, 'daily');
  assert.equal(bm.log_date, '2026-07-07');
  assert.equal(bm.slack_user_id, 'U_X');
});

test('deriveTimeLogRows: nessun task con progetto → nessuna riga', function() {
  assert.deepEqual(deriveTimeLogRows([{ task: 'x', hours: 2, minutes: 0 }], 'U_X', '2026-07-07'), []);
  assert.deepEqual(deriveTimeLogRows([], 'U_X', '2026-07-07'), []);
  // task con progetto ma 0 ore → non genera consuntivo
  assert.deepEqual(deriveTimeLogRows([{ task: 'x', hours: 0, minutes: 0, project_id: 'p1' }], 'U_X', '2026-07-07'), []);
});
