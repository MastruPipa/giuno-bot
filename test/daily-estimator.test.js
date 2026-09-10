'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var est = require('../src/agents/dailyEstimator');

test('previousWorkingDay: salta il weekend', function() {
  assert.equal(est.previousWorkingDay('2026-09-14'), '2026-09-11'); // lunedì → venerdì
  assert.equal(est.previousWorkingDay('2026-09-10'), '2026-09-09');
});

test('hasUsableEvidence: falso senza tracce', function() {
  var empty = { plan_yesterday: [], weekly_plan: [], calendar: [], slack: [], emails: [] };
  assert.equal(est.hasUsableEvidence(empty), false);
  assert.equal(est.hasUsableEvidence(Object.assign({}, empty, { calendar: [{ title: 'Call' }] })), true);
});

test('buildPrompt: include solo le sezioni presenti con durate e fonti', function() {
  var ev = {
    date: '2026-09-10',
    plan_yesterday: [{ task: 'Moodboard Tomarchio', hours: 3, minutes: 0, project: 'Tomarchio' }],
    weekly_plan: [{ project: 'Elfo', hours_week: 12 }],
    calendar: [{ title: 'Call Aitho', minutes: 45, attendees: 3 }],
    slack: [{ channel: 'progetto-elfo', text: 'ho chiuso le grafiche' }],
    emails: [],
  };
  var p = est.buildPrompt(ev);
  assert.match(p, /PIANO SCRITTO IERI[\s\S]*Moodboard Tomarchio \(3h\) \[Tomarchio\]/);
  assert.match(p, /PIANIFICAZIONE DELLA SETTIMANA[\s\S]*Elfo: 12h/);
  assert.match(p, /CALENDARIO DI OGGI[\s\S]*Call Aitho — 45 min, 3 partecipanti/);
  assert.match(p, /\[#progetto-elfo\] ho chiuso le grafiche/);
  assert.doesNotMatch(p, /EMAIL DI OGGI/);
});

test('estimateDaily: usa il modello, normalizza, tetto 8h e marca la stima', async function() {
  var fakeClient = { messages: { create: async function() {
    return { content: [{ type: 'text', text: JSON.stringify({
      oggi: [{ task: 'Call Aitho', hours: 1, minutes: 0 }, { task: 'Grafiche Elfo', hours: 9, minutes: 0 }],
      domani: [{ task: 'Revisione', hours: 0, minutes: 0 }],
      blocchi: null, confidence: 'media', note: 'niente email',
    }) }] };
  } } };
  var fakeDb = {
    getLogsForUserDate: async function() { return [{ project_id: 'p1', hours: 10 }]; },
    getProject: async function() { return { name: 'Elfo' }; },
  };
  var fakeApp = { client: { search: { messages: async function() { return { messages: { matches: [] } }; } } } };
  var out = await est.estimateDaily('U1', '2026-09-10', { client: fakeClient, db: fakeDb, app: fakeApp });
  assert.ok(out, 'stima prodotta con la pianificazione settimanale come evidenza');
  assert.equal(out.oggi.length, 2);
  assert.ok(out.totalOggi <= 8, 'totale ridotto al tetto di 8h: ' + out.totalOggi);
  assert.equal(out.estimate.confidence, 'media');
  assert.ok(out.estimate.sources.indexOf('pianificazione settimanale') !== -1);
  var body = est.formatEstimateBody(out);
  assert.match(body, /\*Oggi:\*\n• Call Aitho/);
  assert.match(body, /\*Domani:\*\n• Revisione/);
  assert.match(est.formatSourcesLine(out), /affidabilità media · niente email/);
});

test('estimateDaily: senza tracce ritorna null senza chiamare il modello', async function() {
  var called = 0;
  var fakeClient = { messages: { create: async function() { called++; return { content: [] }; } } };
  var fakeDb = { getLogsForUserDate: async function() { return []; }, getProject: async function() { return null; } };
  var out = await est.estimateDaily('U1', '2026-09-10', { client: fakeClient, db: fakeDb, app: { client: {} } });
  assert.equal(out, null);
  assert.equal(called, 0);
});
