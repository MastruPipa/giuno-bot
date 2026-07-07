'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var { aggregateStandupRows, workdaysBetween } = require('../src/tools/standupTools');

// Due daily consecutivi della stessa persona: il lavoro di lunedì compare come
// "oggi" nel daily di lunedì E come "ieri" nel daily di martedì — è la
// situazione reale che il 6/7 mostrava carichi raddoppiati (Giusy 74h/186%
// invece di ~38h/95%).
function dueDailyConsecutivi() {
  return [
    {
      slack_user_id: 'U_GIUSY',
      date: '2026-06-29', // lunedì
      ieri_tasks: [],
      oggi_tasks: [{ task: 'Bagno Maria montaggio', hours: 8, minutes: 0 }],
    },
    {
      slack_user_id: 'U_GIUSY',
      date: '2026-06-30', // martedì
      ieri_tasks: [{ task: 'Bagno Maria montaggio', hours: 8, minutes: 0 }], // stesse ore di lunedì
      oggi_tasks: [{ task: 'Tarocco caroselli', hours: 7, minutes: 30 }],
    },
  ];
}

test('scope default "oggi": nessun doppio conteggio delle giornate', function() {
  var res = aggregateStandupRows(dueDailyConsecutivi(), {}, '2026-06-29', '2026-06-30');
  assert.equal(res.scope, 'oggi');
  // 8h (lun) + 7h30 (mar) = 15h30 — NON 23h30 (che includerebbe il duplicato "ieri")
  assert.equal(res.total_minutes, 15 * 60 + 30);
  assert.equal(res.by_user[0].minutes, 15 * 60 + 30);
});

test('scope "entrambi" resta possibile ma porta un warning esplicito e nessuna percentuale', function() {
  var res = aggregateStandupRows(dueDailyConsecutivi(), { scope: 'entrambi' }, '2026-06-29', '2026-06-30');
  assert.equal(res.total_minutes, 23 * 60 + 30); // gonfiato, come da semantica
  assert.ok(res.warning && res.warning.indexOf('due volte') !== -1);
  assert.equal(res.by_user[0].pct_of_capacity, undefined);
});

test('pct_of_capacity calcolata su 8h × giorni lavorativi del periodo', function() {
  var res = aggregateStandupRows(dueDailyConsecutivi(), {}, '2026-06-29', '2026-06-30');
  // 2 giorni lavorativi → capacità 16h; 15h30 lavorate → 97%
  assert.equal(res.workdays_in_range, 2);
  assert.equal(res.capacity_minutes_per_person, 16 * 60);
  assert.equal(res.by_user[0].pct_of_capacity, 97);
});

test('il periodo è dichiarato nel risultato (risponde a "da quando a quando?")', function() {
  var res = aggregateStandupRows(dueDailyConsecutivi(), {}, '2026-06-29', '2026-06-30');
  assert.ok(res.periodo.indexOf('2026-06-29') !== -1);
  assert.ok(res.periodo.indexOf('2026-06-30') !== -1);
});

test('workdaysBetween conta lun-ven ed esclude i weekend', function() {
  assert.equal(workdaysBetween('2026-06-29', '2026-07-05'), 5); // lun→dom = 5 lavorativi
  assert.equal(workdaysBetween('2026-07-04', '2026-07-05'), 0); // sab+dom
  assert.equal(workdaysBetween('2026-07-06', '2026-07-06'), 1); // solo lunedì
  assert.equal(workdaysBetween('2026-07-07', '2026-07-06'), 0); // range invertito
});

test('filtro progetto: substring case-insensitive sul testo del task', function() {
  var res = aggregateStandupRows(dueDailyConsecutivi(), { project: 'bagno maria' }, '2026-06-29', '2026-06-30');
  assert.equal(res.total_minutes, 8 * 60); // solo il montaggio di lunedì (scope oggi)
});

// ─── Sistema di valutazione del carico ────────────────────────────────────────

function dailySingolo(minutiOggi) {
  return [{
    slack_user_id: 'U_X',
    date: '2026-07-06', // lunedì
    ieri_tasks: [],
    oggi_tasks: [{ task: 'Progetto Vario', hours: Math.floor(minutiOggi / 60), minutes: minutiOggi % 60 }],
  }];
}

test('carico: settimana piena (~100%) è "pieno", non sovraccarico', function() {
  var res = aggregateStandupRows(dailySingolo(8 * 60), {}, '2026-07-06', '2026-07-06');
  assert.equal(res.by_user[0].pct_of_tracked_days, 100);
  assert.equal(res.by_user[0].carico, 'pieno');
});

test('carico: sotto l\'85% è "ok"', function() {
  var res = aggregateStandupRows(dailySingolo(6 * 60), {}, '2026-07-06', '2026-07-06'); // 75%
  assert.equal(res.by_user[0].carico, 'ok');
});

test('carico: oltre il 105% è "sovraccarico"', function() {
  var res = aggregateStandupRows(dailySingolo(9 * 60), {}, '2026-07-06', '2026-07-06'); // 112%
  assert.equal(res.by_user[0].carico, 'sovraccarico');
});

test('carico valutato sui giorni CON daily, non sull\'intero periodo', function() {
  // 8h dichiarate in 1 solo daily su una settimana di 5 giorni lavorativi:
  // il carico del giorno tracciato è 100% (pieno), non 20% "libero".
  var res = aggregateStandupRows(dailySingolo(8 * 60), {}, '2026-07-06', '2026-07-10');
  assert.equal(res.by_user[0].days_with_daily, 1);
  assert.equal(res.by_user[0].pct_of_tracked_days, 100);
  assert.equal(res.by_user[0].carico, 'pieno');
  assert.equal(res.by_user[0].missing_dailies, 4); // e i 4 giorni scoperti sono segnalati
});

test('con filtro progetto niente giudizio di carico (le ore sono un sottoinsieme)', function() {
  var res = aggregateStandupRows(dueDailyConsecutivi(), { project: 'bagno maria' }, '2026-06-29', '2026-06-30');
  assert.equal(res.by_user[0].carico, undefined);
});

test('by_project usa il project_name agganciato dal matcher quando presente', function() {
  var rows = [{
    slack_user_id: 'U_X', date: '2026-07-06', ieri_tasks: [],
    oggi_tasks: [
      { task: 'montaggio video', hours: 2, minutes: 0, project_id: 'attio_1', project_name: 'Bagno Maria' },
      { task: 'Tarocco - caroselli', hours: 1, minutes: 0 }, // senza match → fallback prefisso
    ],
  }];
  var res = aggregateStandupRows(rows, {}, '2026-07-06', '2026-07-06');
  var names = res.by_project.map(function(p) { return p.project; });
  assert.ok(names.indexOf('bagno maria') !== -1, 'bucket dal project_name reale');
  assert.ok(names.indexOf('tarocco') !== -1, 'fallback prefisso testuale');
});

test('il filtro progetto matcha anche il project_name (non solo il testo del task)', function() {
  var rows = [{
    slack_user_id: 'U_X', date: '2026-07-06', ieri_tasks: [],
    oggi_tasks: [{ task: 'montaggio video x1', hours: 2, minutes: 0, project_id: 'attio_1', project_name: 'Bagno Maria' }],
  }];
  var res = aggregateStandupRows(rows, { project: 'bagno maria' }, '2026-07-06', '2026-07-06');
  assert.equal(res.total_minutes, 120, 'il task senza "bagno maria" nel testo si trova via project_name');
});
