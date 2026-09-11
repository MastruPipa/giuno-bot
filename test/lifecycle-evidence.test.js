'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var lc = require('../src/agents/lifecycleEvidence');
var scope = require('../src/giunos/projectScope');

var TODAY = '2026-09-11';
function prj(extra) { return Object.assign({ id: 'attio_1', name: 'Mandorle', client_name: 'Mandorle Srl', status: 'planning', tags: ['attio-sync', 'sales:won'] }, extra || {}); }

test('evidenceFromSources: kick-off, recap, azioni con link, calendario, decisione admin; ore dichiarate solo come indizio', function() {
  var ctx = { today: TODAY,
    docs: [
      { doc_role: 'kickoff', drive_link: 'https://docs.google.com/d/K', file_name: 'Kick-off Mandorle', notes: '2026-08-20 — avvio' },
      { doc_role: 'recap', drive_link: 'https://docs.google.com/d/R', file_name: 'Weekly', notes: '2026-09-08 — packaging' },
      { doc_role: 'recap', drive_link: 'http://insicuro', notes: '2026-09-09' },
      { doc_role: 'brief', drive_link: 'https://docs.google.com/d/B', notes: '2026-09-01' },
    ],
    actions: [
      { project_id: 'attio_1', status: 'open', source_link: 'https://docs.google.com/d/R', meeting_date: '2026-09-08', due_date: '2026-09-20', description: 'inviare documenti' },
      { project_id: 'attio_1', status: 'done', source_link: 'https://docs.google.com/d/R', meeting_date: '2026-09-01', description: 'fatta' },
      { project_id: 'other', status: 'open', source_link: 'https://x', meeting_date: '2026-09-08', description: 'altro' },
    ],
    calendar: [{ date: '2026-09-15', summary: 'Call Mandorle packaging', htmlLink: 'https://calendar.google.com/e/1' }, { date: '2026-09-15', summary: 'Riunione interna', htmlLink: 'https://calendar.google.com/e/2' }],
    logs: [{ log_date: '2026-09-01', hours: 3, validation: { status: 'ok' } }, { log_date: '2026-09-03', hours: 2 }, { log_date: '2026-09-05', hours: 4, validation: { status: 'estimate' } }],
    existing: { kind: 'admin', state: 'active', source_url: 'https://katania.slack.com/archives/D1/p1', observed_on: '2026-09-01', valid_until: '2026-10-31', decided_by: 'U_ANT' },
  };
  var ev = lc.evidenceFromSources(prj(), ctx);
  var kinds = ev.map(function(e) { return e.kind + ':' + e.observed_on + '→' + e.valid_until; });
  assert.deepEqual(kinds, ['kickoff:2026-08-20→2026-11-18', 'recap:2026-09-08→2026-10-08', 'action_open:2026-09-08→2026-10-04', 'calendar:2026-09-11→2026-09-22', 'admin:2026-09-01→2026-10-31', 'hours_declared:2026-09-03→2026-09-24']);
  assert.match(ev[5].detail, /^5h dichiarate su 2 giorni/);
  assert.equal(ev[5].source_url, null);
});

test('assess: evidenza documentale → operativo con lifecycle_evidence valida per la dashboard', function() {
  var ctx = { today: TODAY, now: Date.parse(TODAY + 'T07:00:00Z'), docs: [{ doc_role: 'recap', drive_link: 'https://docs.google.com/d/R', file_name: 'Weekly', notes: '2026-09-08' }], dossier: { dossier: { fase: 'in corso', deliverable: [{ nome: 'sito', stato: 'in corso' }] } } };
  var a = lc.assess(prj(), lc.evidenceFromSources(prj(), ctx), ctx);
  assert.equal(a.state, 'operativo');
  assert.equal(a.evidence.kind, 'recap'); assert.equal(a.evidence.valid_until, '2026-10-08'); assert.equal(a.evidence.decided_by, 'giuno');
  assert.equal(scope.hasActiveEvidence({ lifecycle_evidence: a.evidence }, TODAY), true);
  assert.equal(scope.isActiveProject(prj({ status: 'active', lifecycle_evidence: a.evidence }), TODAY), true);
  assert.equal(scope.hasActiveEvidence({ lifecycle_evidence: a.evidence }, '2026-10-09'), false, 'scade');
});

test('assess: solo ore dichiarate → chiedere al PM; scheda "chiuso" → concluso?; evidenza scaduta → sospeso?; nulla → acquisito', function() {
  var onlyHours = { today: TODAY, logs: [{ log_date: '2026-09-01', hours: 3 }, { log_date: '2026-09-03', hours: 2 }] };
  var a1 = lc.assess(prj(), lc.evidenceFromSources(prj(), onlyHours), onlyHours);
  assert.equal(a1.state, 'operativo?'); assert.match(a1.reason, /5h dichiarate/);
  var closed = { today: TODAY, docs: [{ doc_role: 'recap', drive_link: 'https://d/R', notes: '2026-09-08' }], dossier: { dossier: { fase: 'chiuso' } } };
  assert.equal(lc.assess(prj({ status: 'active' }), lc.evidenceFromSources(prj(), closed), closed).state, 'concluso?');
  var expired = { today: TODAY, existing: { state: 'active', kind: 'recap', source_url: 'https://d/R', observed_on: '2026-07-01', valid_until: '2026-07-31' } };
  var a3 = lc.assess(prj({ status: 'active', lifecycle_evidence: expired.existing }), lc.evidenceFromSources(prj(), expired), expired);
  assert.equal(a3.state, 'sospeso?'); assert.match(a3.reason, /scaduta il 2026-07-31/);
  var nothing = { today: TODAY };
  assert.equal(lc.assess(prj(), [], nothing).state, 'acquisito');
  assert.equal(lc.assess({ id: 'prj_manual', name: 'Interno', status: 'active' }, [], nothing).state, 'invariato');
  var stopped = { today: TODAY, dossier: { dossier: { fase: 'fermo' } } };
  assert.equal(lc.assess(prj({ status: 'active' }), [], stopped).state, 'sospeso?');
});

test('refreshLifecycle: attiva chi ha evidenze (apply), propone via DM con bottoni il resto, anteprima non scrive', async function() {
  var updates = [], posted = [], recorded = [];
  var projects = [prj(), prj({ id: 'chan_2', name: 'Vinokilo', tags: ['channel-sync'] }), prj({ id: 'attio_3', name: 'Caritas', status: 'active', owner_slack_id: 'U_PM' }), prj({ id: 'cat_x', name: 'Prospect' })];
  var deps = {
    db: { searchProjects: async function(q) { assert.deepEqual(q.statuses, ['active', 'planning', 'on_hold']); return projects; }, updateProject: async function(id, u) { updates.push({ id: id, u: u }); return { id: id }; } },
    dossiers: {
      getProjectDocuments: async function(id) { return id === 'attio_1' ? [{ doc_role: 'kickoff', drive_link: 'https://d/K', file_name: 'Kick-off', notes: '2026-09-01' }] : []; },
      getDossier: async function() { return null; },
      listProjectActions: async function() { return []; },
    },
    supabase: {},
    logsFor: async function(id) { return id === 'attio_3' ? [{ log_date: '2026-09-02', hours: 2 }, { log_date: '2026-09-04', hours: 1 }] : []; },
    calendarEvents: [],
    roles: [{ slack_user_id: 'U_ADM', role: 'admin' }],
    today: TODAY,
    gate: { notificheEnabled: function() { return true; }, itemHash: function(s) { return 'h:' + s; }, followupAllowed: async function(_, uid, hash) { return { allowed: recorded.indexOf(hash) === -1, attempts: 0 }; }, recordFollowup: async function(_, uid, hash) { recorded.push(hash); } },
    app: { client: { chat: { postMessage: async function(m) { posted.push(m); return { ts: '1' }; } } } },
  };
  var preview = await lc.refreshLifecycle({ deps: deps });
  assert.equal(preview.considered, 3); assert.equal(preview.activated, 1); assert.equal(preview.proposals, 1); assert.equal(updates.length, 0); assert.equal(posted.length, 0);
  assert.match(lc.formatReport(preview, false), /▶️ Operativi[\s\S]*Mandorle → fino al 2026-11-30[\s\S]*❓ Probabilmente operativi[\s\S]*Caritas[\s\S]*📋 Acquisiti[\s\S]*Vinokilo/);
  var applied = await lc.refreshLifecycle({ apply: true, notify: true, deps: deps });
  assert.equal(updates.length, 1); assert.equal(updates[0].id, 'attio_1'); assert.equal(updates[0].u.status, 'active'); assert.equal(updates[0].u.lifecycle_evidence.kind, 'kickoff');
  assert.equal(scope.hasActiveEvidence({ lifecycle_evidence: updates[0].u.lifecycle_evidence }, TODAY), true);
  assert.equal(posted.length, 1); assert.equal(posted[0].channel, 'U_PM', 'al PM, non agli admin');
  assert.equal(posted[0].blocks[1].elements.map(function(b) { return b.action_id; }).join(','), 'lifecycle_active,lifecycle_hold,lifecycle_done');
  assert.equal(posted[0].blocks[1].elements[0].value, 'attio_3');
  assert.equal(applied.notified, 1);
  var again = await lc.refreshLifecycle({ apply: true, notify: true, deps: deps });
  assert.equal(again.notified, 0, 'gate: non richiede due volte');
});

test('recordDecision/handleLifecycleButton: il permalink Slack diventa evidenza; senza https rifiuta; ruoli', async function() {
  var updates = [];
  var db = { getProject: async function(id) { return id === 'attio_1' ? prj({ owner_slack_id: 'U_PM' }) : null; }, updateProject: async function(id, u) { updates.push(u); return { id: id }; } };
  var r = await lc.recordDecision('attio_1', 'active', { source_url: 'https://katania.slack.com/archives/D1/p1', by: 'U_ANT', today: TODAY, deps: { db: db } });
  assert.equal(r.success, true); assert.equal(r.valid_until, '2026-11-10'); assert.equal(updates[0].status, 'active'); assert.equal(updates[0].lifecycle_evidence.kind, 'admin');
  assert.equal(scope.isActiveProject(prj({ status: 'active', lifecycle_evidence: updates[0].lifecycle_evidence }), TODAY), true);
  var d = await lc.recordDecision('attio_1', 'done', { source_url: 'https://katania.slack.com/archives/D1/p2', by: 'U_ANT', today: TODAY, deps: { db: db } });
  assert.equal(updates[1].status, 'completed'); assert.equal(updates[1].end_date, TODAY); assert.match(d.message, /concluso/);
  var h = await lc.recordDecision('attio_1', 'hold', { source_url: 'https://katania.slack.com/archives/D1/p3', by: 'U_ANT', today: TODAY, deps: { db: db } });
  assert.equal(updates[2].status, 'on_hold'); assert.match(h.message, /ore restano/);
  assert.match((await lc.recordDecision('attio_1', 'active', { source_url: null, by: 'U', deps: { db: db } })).error, /permalink/);
  var app = { client: { chat: { getPermalink: async function() { return { permalink: 'https://katania.slack.com/archives/D1/p9' }; } } } };
  var body = { channel: { id: 'D1' }, message: { ts: '9' } };
  assert.match(await lc.handleLifecycleButton('lifecycle_active', 'attio_1', 'U_PM', body, { app: app, db: db, role: 'member' }), /^✅ Mandorle segnato operativo/);
  assert.match(await lc.handleLifecycleButton('lifecycle_active', 'attio_1', 'U_X', body, { app: app, db: db, role: 'member' }), /Solo il PM/);
  assert.match(await lc.handleLifecycleButton('lifecycle_hold', 'attio_1', 'U_X', body, { app: app, db: db, role: 'manager' }), /sospeso/);
});
