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
  assert.deepEqual(kinds, ['kickoff:2026-08-20→2026-11-18', 'recap:2026-09-08→2026-10-08', 'action_open:2026-09-08→2026-10-04', 'calendar:2026-09-11→2026-09-22', 'admin:2026-09-01→2026-10-31', 'hours_declared:2026-09-03→2026-09-24', 'crm_won:2026-09-11→2026-09-11']);
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

test('review Codex: sospeso da una persona non si riattiva da solo; evidenze nuove → domanda al PM', function() {
  var held = prj({ status: 'on_hold', lifecycle_evidence: { state: 'on_hold', kind: 'admin', source_url: 'https://katania.slack.com/archives/D1/p1', observed_on: '2026-09-05', valid_until: '2027-03-04', decided_by: 'U_PM' } });
  var oldKick = { today: TODAY, existing: held.lifecycle_evidence, docs: [{ doc_role: 'kickoff', drive_link: 'https://d/K', notes: '2026-08-20' }] };
  var a = lc.assess(held, lc.evidenceFromSources(held, oldKick), oldKick);
  assert.equal(a.state, 'invariato'); assert.match(a.reason, /sospeso da una persona il 2026-09-05/);
  var newRecap = { today: TODAY, existing: held.lifecycle_evidence, docs: [{ doc_role: 'recap', drive_link: 'https://d/R', notes: '2026-09-09' }] };
  var b = lc.assess(held, lc.evidenceFromSources(held, newRecap), newRecap);
  assert.equal(b.state, 'operativo?'); assert.match(b.reason, /sospeso dal 2026-09-05, ma trovo evidenze nuove/);
});

test('review Codex: evidenza scaduta → sospeso? anche se la sync ha già riportato a planning; date impossibili rifiutate; update nullo = non applicato', async function() {
  var expired = { state: 'active', kind: 'recap', source_url: 'https://d/R', observed_on: '2026-07-01', valid_until: '2026-07-31' };
  var ctx = { today: TODAY, existing: expired };
  assert.equal(lc.assess(prj({ status: 'planning', lifecycle_evidence: expired }), [], ctx).state, 'sospeso?');
  var bad = { today: TODAY, docs: [{ doc_role: 'kickoff', drive_link: 'https://d/K', notes: '2026-06-31' }] };
  assert.equal(lc.evidenceFromSources(prj(), bad).filter(function(e) { return e.kind !== 'crm_won'; }).length, 0, '2026-06-31 non esiste');
  var deps = {
    db: { searchProjects: async function() { return [prj()]; }, updateProject: async function() { return null; } },
    dossiers: { getProjectDocuments: async function() { return [{ doc_role: 'kickoff', drive_link: 'https://d/K', notes: '2026-09-01' }]; }, getDossier: async function() { return null; }, listProjectActions: async function() { return []; } },
    supabase: {}, logsFor: async function() { return []; }, calendarEvents: [], roles: [], today: TODAY,
  };
  var r = await lc.refreshLifecycle({ apply: true, deps: deps });
  assert.equal(r.items[0].applied, false); assert.match(r.items[0].error, /null/);
  assert.match(lc.formatReport(r, true), /⚠️ non scritto/);
});

test('pianificazione settimanale: con il permalink del recap è evidenza (settimana + 7), senza link è un indizio che fa chiedere al PM', function() {
  var withLink = { today: TODAY, logs: [{ log_type: 'weekly', log_date: '2026-09-14', hours: 6, notes: 'weekly planner · https://katania.slack.com/archives/C1/p1' }] };
  var ev = lc.evidenceFromSources(prj(), withLink);
  assert.equal(ev[0].kind, 'weekly_plan'); assert.equal(ev[0].observed_on, TODAY, 'la settimana è futura: osservata oggi'); assert.equal(ev[0].valid_until, '2026-09-27');
  var a = lc.assess(prj(), ev, withLink);
  assert.equal(a.state, 'operativo'); assert.equal(a.evidence.kind, 'weekly_plan');
  assert.equal(scope.hasActiveEvidence({ lifecycle_evidence: a.evidence }, TODAY), true);
  var noLink = { today: TODAY, logs: [{ log_type: 'weekly', log_date: '2026-09-07', hours: 6, notes: 'weekly planner' }] };
  var b = lc.assess(prj(), lc.evidenceFromSources(prj(), noLink), noLink);
  assert.equal(b.state, 'operativo?'); assert.match(b.reason, /pianificate 6h[\s\S]*senza recap/);
});

test('fatturazione: una riga del cliente nel mese è evidenza primaria (mese + 15); mesi futuri contano da oggi; righe di altre commesse dello stesso cliente escluse', function() {
  var social = prj({ id: 'attio_s', name: 'Gambino Social', client_name: 'Gambino Vini' });
  var sito = prj({ id: 'attio_w', name: 'Gambino Sito', client_name: 'Gambino Vini' });
  var rows = [
    { client: 'gambino vini', description: 'Comunicazione e Marketing: produzioni contenuti', monthly: 2105, one_off: 0, invoiced: true, paid: false, month: '2026-09', source_url: 'https://docs.google.com/spreadsheets/d/S/edit#gid=9' },
    { client: 'gambino vini', description: 'Gambino Sito 1/3', monthly: 0, one_off: 1500, invoiced: false, paid: false, month: '2026-10', source_url: 'https://docs.google.com/spreadsheets/d/S/edit#gid=10' },
    { client: 'gambino vini', description: '', monthly: 1660, one_off: 0, invoiced: true, paid: true, month: '2026-06', source_url: 'https://docs.google.com/spreadsheets/d/S/edit#gid=6' },
    { client: 'Tarocco', description: '', monthly: 1084, one_off: 0, month: '2026-09', source_url: 'https://docs.google.com/spreadsheets/d/S/edit#gid=9' },
  ];
  var bs = require('../src/agents/billingSheet');
  var mine = bs.rowsForProject(rows, social, [social, sito]);
  assert.deepEqual(mine.map(function(r) { return r.month; }), ['2026-09', '2026-06'], 'la riga "Gambino Sito" va solo al sito');
  assert.deepEqual(bs.rowsForProject(rows, sito, [social, sito]).map(function(r) { return r.month; }), ['2026-09', '2026-10', '2026-06'], 'senza descrizione specifica la riga vale per tutte le commesse del cliente');
  var ctx = { today: TODAY, billing: bs.rowsForProject(rows, sito, [social, sito]) };
  var ev = lc.evidenceFromSources(sito, ctx).filter(function(e) { return e.kind === 'billing'; });
  assert.deepEqual(ev.map(function(e) { return e.observed_on + '→' + e.valid_until; }), ['2026-09-01→2026-10-15', '2026-09-11→2026-11-15'], 'giugno è scaduta (30/6 + 15), ottobre conta da oggi');
  assert.match(ev[0].detail, /in fatturazione a 09\/2026 \(2105 €, fattura inviata\)/);
  var a = lc.assess(sito, lc.evidenceFromSources(sito, ctx), ctx);
  assert.equal(a.state, 'operativo'); assert.equal(a.evidence.kind, 'billing'); assert.equal(a.evidence.valid_until, '2026-11-15');
  assert.equal(scope.hasActiveEvidence({ lifecycle_evidence: a.evidence }, TODAY), true);
});

test('indizi deboli: deal won da solo → acquisito; canale attivo da solo → acquisito; due indizi diversi → domanda al PM; mai attivazione automatica', function() {
  var won = prj();
  assert.equal(lc.assess(won, lc.evidenceFromSources(won, { today: TODAY }), { today: TODAY }).state, 'acquisito', 'won da solo non basta');
  var manual = { id: 'prj_m', name: 'Mandorle', client_name: 'Mandorle Srl', status: 'planning' };
  var chOnly = { today: TODAY, channels: [{ channel_id: 'C1', channel_name: 'mandorle', count: 4, last_on: '2026-09-09', link: 'https://slack.com/archives/C1' }] };
  var evCh = lc.evidenceFromSources(manual, chOnly);
  assert.equal(evCh.length, 1); assert.equal(evCh[0].kind, 'channel_activity'); assert.equal(evCh[0].valid_until, '2026-09-23');
  assert.equal(lc.assess(manual, evCh, chOnly).state, 'invariato', 'un solo indizio non fa nulla');
  var two = { today: TODAY, channels: chOnly.channels, emails: [{ date: '2026-09-05', subject: 'Re: bozze packaging', link: 'https://mail.google.com/mail/#all/1' }] };
  var a = lc.assess(won, lc.evidenceFromSources(won, two), two);
  assert.equal(a.state, 'operativo?'); assert.match(a.reason, /4 messaggi del team in #mandorle[\s\S]*email del 2026-09-05/);
  assert.equal(a.evidence, undefined, 'nessuna attivazione senza fonte documentale');
  var stale = { today: TODAY, channels: [{ channel_id: 'C1', channel_name: 'mandorle', count: 4, last_on: '2026-08-01', link: 'https://slack.com/archives/C1' }], emails: two.emails };
  assert.equal(lc.assess(manual, lc.evidenceFromSources(manual, stale), stale).state, 'invariato', 'canale fermo da 40 giorni non conta: resta solo l\'email');
  assert.equal(lc.assess(won, lc.evidenceFromSources(won, stale), stale).state, 'operativo?', 'email + deal won sono due indizi diversi');
});

test('loadChannelActivity/loadEmails: contano solo i messaggi umani nei canali della commessa; email cercate per nome cliente con un budget', async function() {
  var app = { client: { conversations: { history: async function(p) { return p.channel === 'C1' ? { messages: [{ user: 'U1', ts: '1757500000.1' }, { bot_id: 'B1', ts: '1757500001.1' }, { user: 'U2', subtype: 'channel_join', ts: '1757500002.1' }] } : { messages: [] }; } } } };
  var projects = [{ id: 'attio_1', name: 'Mandorle', client_name: 'Mandorle Srl' }, { id: 'attio_2', name: 'Elios', client_name: 'Elios Srl' }];
  var locDeps = { supabase: null, db: { getChannelMapCache: function() { return {}; } }, projects: projects, channelMap: {} };
  var loc = require('../src/services/projectLocations');
  var origLoad = loc.loadRegistry;
  loc.loadRegistry = async function() { return [
    { project_id: 'attio_1', kind: 'slack_channel', ref: 'C1', name: '#mandorle', source: 'channel_map', confidence: 'media' },
    { project_id: 'attio_2', kind: 'slack_channel', ref: 'C2', name: '#elios', source: 'channel_map', confidence: 'media' },
    // review Codex: lo stesso canale anche su un altro progetto → vince la riga admin, la storia va a UNO solo
    { project_id: 'attio_2', kind: 'slack_channel', ref: 'C1', name: '#mandorle', source: 'admin', confidence: 'alta' },
    { project_id: 'attio_1', kind: 'drive_folder', ref: 'F' }]; };
  try {
    var act = await lc.loadChannelActivity({ app: app, locationDeps: locDeps }, projects, TODAY);
    assert.deepEqual(Object.keys(act), ['attio_2'], 'C1 accreditato solo al progetto della riga admin');
    assert.equal(act.attio_2[0].count, 1); assert.equal(act.attio_2[0].channel_name, 'mandorle'); assert.match(act.attio_2[0].last_on, /^2025-09-10$/);
    // due righe dedotte di pari rango sullo stesso canale → ambiguo → a nessuno
    loc.loadRegistry = async function() { return [{ project_id: 'attio_1', kind: 'slack_channel', ref: 'C1', source: 'channel_map', confidence: 'media' }, { project_id: 'attio_2', kind: 'slack_channel', ref: 'C1', source: 'channel_map', confidence: 'media' }]; };
    assert.deepEqual(await lc.loadChannelActivity({ app: app, locationDeps: locDeps }, projects, TODAY), {});
  } finally { loc.loadRegistry = origLoad; }
  assert.deepEqual(await lc.loadChannelActivity({ app: null }, projects, TODAY), {});
  assert.deepEqual(await lc.loadEmails({ roles: [] }, projects, TODAY), {}, 'senza token Gmail nessuna email');
});
