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

test('romeDayBounds: giorno di Roma con offset estivo/invernale', function() {
  assert.deepEqual(est.romeDayBounds('2026-09-10'), { start: '2026-09-10T00:00:00+02:00', end: '2026-09-11T00:00:00+02:00', offset: '+02:00' });
  assert.equal(est.romeDayBounds('2026-12-10').offset, '+01:00');
});

test('collectSlackChannelActivity: messaggi e allegati di oggi per autore, solo canali con Giuno, niente bot', async function() {
  var calls = [];
  var app = { client: { conversations: {
    list: async function() { return { channels: [{ id: 'C1', name: 'progetto-elios', is_member: true }, { id: 'C2', name: 'altro', is_member: false }] }; },
    history: async function(p) { calls.push(p); return { messages: [
      { user: 'U1', text: 'inviata documentazione a Elios', ts: '1' }, { user: 'U1', subtype: 'file_share', text: '', files: [{ name: 'brief.pdf' }] },
      { user: 'U2', bot_id: 'B1', text: 'bot' }, { user: 'U3', subtype: 'channel_join', text: 'joined' },
    ] }; },
  } } };
  var by = await est.collectSlackChannelActivity(app, '2026-09-10');
  assert.equal(calls.length, 1); assert.equal(calls[0].channel, 'C1');
  assert.equal(calls[0].oldest, String(Date.parse('2026-09-10T00:00:00+02:00') / 1000));
  assert.deepEqual(Object.keys(by), ['U1']);
  assert.equal(by.U1.length, 2); assert.deepEqual(by.U1[1].files, ['brief.pdf']);
});

test('collectDriveActivity/collectAdminCalendar: output di giornata per email e nome; inviti per email', async function() {
  var q;
  var drives = { U_ADM: { files: { list: async function(p) { q = p.q; return { data: { files: [
    { id: 'f1', name: 'Registro cassa OFFKATANIA', mimeType: 'application/vnd.google-apps.spreadsheet', createdTime: '2026-09-10T09:00:00Z', modifiedTime: '2026-09-10T10:30:00Z', webViewLink: 'https://d/1', lastModifyingUser: { emailAddress: 'Peppe@katania.it', displayName: 'Peppe Rossi' } },
    { id: 'f2', name: 'Analisi comunicativa KS', mimeType: 'application/vnd.google-apps.document', createdTime: '2026-08-01T00:00:00Z', modifiedTime: '2026-09-10T15:00:00Z', lastModifyingUser: { displayName: 'Samuele Licciardello' } },
  ] } }; } } } };
  var r = await est.collectDriveActivity('2026-09-10', ['U_ADM', 'U_NOTOKEN'], { drives: drives });
  assert.match(q, /modifiedTime >= '2026-09-10T00:00:00\+02:00' and modifiedTime < '2026-09-11T00:00:00\+02:00'/);
  assert.equal(r.byEmail['peppe@katania.it'][0].created_today, true); assert.equal(r.byEmail['peppe@katania.it'][0].type, 'spreadsheet');
  assert.equal(r.byName['samuele licciardello'][0].created_today, false);
  var calendars = { U_ADM: { events: { list: async function() { return { data: { items: [
    { id: 'e1', summary: 'SAL OFFKATANIA', start: { dateTime: '2026-09-10T10:00:00+02:00' }, end: { dateTime: '2026-09-10T10:30:00+02:00' }, attendees: [{ email: 'peppe@katania.it' }, { email: 'x@y.it', responseStatus: 'declined' }] },
    { id: 'e2', summary: 'Tutto il giorno', start: { date: '2026-09-10' }, end: { date: '2026-09-11' } },
  ] } }; } } } };
  var ev = await est.collectAdminCalendar('2026-09-10', ['U_ADM'], { calendars: calendars });
  assert.equal(ev.length, 1); assert.equal(ev[0].minutes, 30); assert.deepEqual(ev[0].attendees, ['peppe@katania.it']);
});

test('estimateDaily: senza token usa Drive, canali e inviti dal contesto di giornata; ogni task ha ore', async function() {
  var prompt;
  var fakeClient = { messages: { create: async function(req) { prompt = req.messages[0].content; return { content: [{ type: 'text', text: JSON.stringify({
    oggi: [{ task: 'SAL OFFKATANIA', hours: 0, minutes: 30 }, { task: 'Registro uscite cassa OFFKATANIA (Sheets)', hours: 0, minutes: 0 }], domani: [], blocchi: null, confidence: 'alta', note: '',
  }) }] }; } } };
  var fakeDb = { getLogsForUserDate: async function() { return []; }, getProject: async function() { return null; } };
  var dayContext = {
    users: [{ id: 'U_PEPPE', name: 'Peppe Rossi', email: 'peppe@katania.it' }],
    slackByUser: { U_PEPPE: [{ channel: 'offkatania', text: 'caricato il registro', files: ['registro.xlsx'] }] },
    driveByEmail: { 'peppe@katania.it': [{ name: 'Registro cassa OFFKATANIA', type: 'spreadsheet', created_today: true, modified_at: '2026-09-10T10:30:00Z' }] },
    driveByName: {},
    adminEvents: [{ title: 'SAL OFFKATANIA', start: '2026-09-10T10:00:00+02:00', minutes: 30, attendees: ['peppe@katania.it'] }],
  };
  var out = await est.estimateDaily('U_PEPPE', '2026-09-10', { client: fakeClient, db: fakeDb, app: { client: {} }, dayContext: dayContext, calibration: null });
  assert.ok(out);
  assert.match(prompt, /CALENDARIO DI OGGI:\n- SAL OFFKATANIA — 30 min/);
  assert.match(prompt, /DOCUMENTI SU DRIVE CREATI O MODIFICATI OGGI[\s\S]*Registro cassa OFFKATANIA \(spreadsheet, creato oggi alle 10:30\)/);
  assert.match(prompt, /MESSAGGI E ALLEGATI DI OGGI NEI CANALI[\s\S]*\[#offkatania\] caricato il registro \[allegati: registro.xlsx\]/);
  assert.deepEqual(out.estimate.sources, ['calendario (inviti)', 'documenti Drive', 'messaggi nei canali', 'sessioni di lavoro']);
  assert.match(prompt, /SESSIONI DI LAVORO RICOSTRUITE DAI TIMESTAMP \(totale 30min\):\n- 10:00–10:30 \(30min\): riunione "SAL OFFKATANIA"/);
  assert.equal(out.estimate.sessions_minutes, 30);
  assert.equal(out.oggi[1].minutes, 30, 'task a 0 ore → 30 min');
  assert.equal(out.totalOggi, 1);
});

test('collectDriveActivity: le revisioni di oggi diventano eventi per autore, anche chi non è l\'ultimo', async function() {
  var drives = { U_ADM: { files: { list: async function() { return { data: { files: [
    { id: 'f1', name: 'Deck Elios', mimeType: 'application/vnd.google-apps.presentation', modifiedTime: '2026-09-10T15:00:00Z', lastModifyingUser: { emailAddress: 'paolo@k.it', displayName: 'Paolo' } },
  ] } }; } }, revisions: { list: async function() { return { data: { revisions: [
    { id: '1', modifiedTime: '2026-09-09T10:00:00Z', lastModifyingUser: { emailAddress: 'paolo@k.it' } },
    { id: '2', modifiedTime: '2026-09-10T08:10:00Z', lastModifyingUser: { emailAddress: 'gianna@k.it', displayName: 'Gianna' } },
    { id: '3', modifiedTime: '2026-09-10T08:40:00Z', lastModifyingUser: { emailAddress: 'gianna@k.it' } },
    { id: '4', modifiedTime: '2026-09-10T15:00:00Z', lastModifyingUser: { emailAddress: 'paolo@k.it' } },
  ] } }; } } } };
  var r = await est.collectDriveActivity('2026-09-10', ['U_ADM'], { drives: drives });
  assert.equal(r.events.byEmail['gianna@k.it'].length, 2, 'Gianna ha modificato ma non è l\'ultimo autore');
  assert.equal(r.events.byEmail['paolo@k.it'].length, 1);
  assert.equal(r.byEmail['gianna@k.it'], undefined, 'la lista "documenti" resta per ultimo autore');
});

test('collectFigmaActivity: file del team modificati oggi e versioni per autore; senza token salta', async function() {
  assert.deepEqual((await est.collectFigmaActivity('2026-09-10', { env: {} })).files, []);
  var calls = [];
  var fetch = async function(url, o) {
    calls.push(url); assert.equal(o.headers['X-Figma-Token'], 'tok');
    var body = /teams\/T1\/projects/.test(url) ? { projects: [{ id: 'P1', name: 'Elios' }] }
      : /projects\/P1\/files/.test(url) ? { files: [{ key: 'K1', name: 'Landing Elios', last_modified: '2026-09-10T14:00:00Z' }, { key: 'K2', name: 'Vecchio', last_modified: '2026-09-01T14:00:00Z' }] }
      : { versions: [{ created_at: '2026-09-10T09:00:00Z', user: { handle: 'Samuele Licciardello', email: 'samuele@k.it' } }, { created_at: '2026-09-10T09:50:00Z', user: { handle: 'Samuele Licciardello' } }, { created_at: '2026-09-08T09:00:00Z', user: { handle: 'Altro' } }] };
    return { ok: true, json: async function() { return body; } };
  };
  var r = await est.collectFigmaActivity('2026-09-10', { env: { FIGMA_TOKEN: 'tok', FIGMA_TEAM_ID: 'T1' }, fetch: fetch });
  assert.equal(calls.length, 3, 'niente versioni per il file vecchio');
  assert.equal(r.files.length, 1);
  assert.equal(r.byName['samuele licciardello'].length, 1); assert.equal(r.byName['samuele licciardello'][0].link, 'https://www.figma.com/file/K1');
  assert.equal(r.events.byName['samuele licciardello'].length, 2); assert.equal(r.events.byEmail['samuele@k.it'].length, 1);
});

test('estimateDaily: sessioni da Drive+Figma+canali nel prompt, storico correzioni', async function() {
  var prompt;
  var fakeClient = { messages: { create: async function(req) { prompt = req.messages[0].content; return { content: [{ type: 'text', text: JSON.stringify({ oggi: [{ task: 'Landing Elios (Figma)', hours: 2, minutes: 0 }], domani: [], blocchi: null, confidence: 'alta', note: '' }) }] }; } } };
  var fakeDb = { getLogsForUserDate: async function() { return []; }, getProject: async function() { return null; } };
  var dayContext = {
    users: [{ id: 'U_SAM', name: 'Samuele Licciardello', email: 'samuele@k.it' }],
    slackByUser: { U_SAM: [{ channel: 'elios', text: 'landing aggiornata', files: [], at: '2026-09-10T10:05:00+02:00' }] },
    driveByEmail: {}, driveByName: {}, driveEvents: { byEmail: { 'samuele@k.it': [{ at: '2026-09-10T09:05:00+02:00', kind: 'drive', name: 'Copy landing' }] }, byName: {} },
    figmaByEmail: { 'samuele@k.it': [{ name: 'Landing Elios', project: 'Elios', type: 'figma' }] }, figmaByName: {},
    figmaEvents: { byEmail: { 'samuele@k.it': [{ at: '2026-09-10T09:30:00+02:00', kind: 'figma', name: 'Landing Elios' }, { at: '2026-09-10T10:45:00+02:00', kind: 'figma', name: 'Landing Elios' }, { at: '2026-09-10T15:00:00+02:00', kind: 'figma', name: 'Landing Elios' }] }, byName: {} },
    adminEvents: [],
  };
  var out = await est.estimateDaily('U_SAM', '2026-09-10', { client: fakeClient, db: fakeDb, app: { client: {} }, dayContext: dayContext, calibration: { n: 5, ratio: 1.6, bias: 'basso', hint: 'negli ultimi 5 daily corretti le ore stimate erano più basse del reale di circa il 60%: alza le durate dedotte di conseguenza (non quelle da calendario).' } });
  assert.match(prompt, /FILE FIGMA CON VERSIONI SALVATE OGGI[\s\S]*Landing Elios \(progetto Figma: Elios\)/);
  assert.match(prompt, /SESSIONI DI LAVORO RICOSTRUITE DAI TIMESTAMP \(totale 1h55min\):\n- 09:05–10:45 \(1h40min\): Drive "Copy landing" \(1 modifiche\); Figma "Landing Elios" \(2 versioni\); #elios \(1 messaggi\)\n- 15:00–15:00 \(15min\): Figma "Landing Elios" \(1 versioni\)/);
  assert.match(prompt, /STORICO DELLE STIME PER QUESTA PERSONA: negli ultimi 5 daily corretti/);
  assert.deepEqual(out.estimate.sources, ['documenti Drive', 'messaggi nei canali', 'file Figma', 'sessioni di lavoro'].filter(function(s) { return s !== 'documenti Drive'; }));
  assert.equal(out.estimate.sessions_minutes, 115); assert.deepEqual(out.estimate.calibration, { n: 5, ratio: 1.6 });
});

test('review Codex: bucket email e nome uniti senza doppioni; revisioni confrontate come istanti e scansione con budget di tempo', async function() {
  var fakeClient = { messages: { create: async function() { return { content: [{ type: 'text', text: JSON.stringify({ oggi: [{ task: 'x', hours: 1 }], domani: [], blocchi: null, confidence: 'media' }) }] }; } } };
  var fakeDb = { getLogsForUserDate: async function() { return []; }, getProject: async function() { return null; } };
  var same = { at: '2026-09-10T09:30:00+02:00', kind: 'figma', name: 'Landing' };
  var dayContext = { users: [{ id: 'U1', name: 'Samuele Licciardello', email: 'samuele@k.it' }], slackByUser: {}, driveByEmail: {}, driveByName: {}, driveEvents: { byEmail: {}, byName: {} },
    figmaByEmail: { 'samuele@k.it': [{ name: 'Landing', type: 'figma', modified_at: 'a' }] }, figmaByName: { 'samuele licciardello': [{ name: 'Landing', type: 'figma', modified_at: 'a' }, { name: 'Icone', type: 'figma', modified_at: 'b' }] },
    figmaEvents: { byEmail: { 'samuele@k.it': [same] }, byName: { 'samuele licciardello': [same, { at: '2026-09-10T10:00:00+02:00', kind: 'figma', name: 'Icone' }] } }, adminEvents: [] };
  var out = await est.estimateDaily('U1', '2026-09-10', { client: fakeClient, db: fakeDb, app: { client: {} }, dayContext: dayContext, calibration: null });
  assert.equal(out.estimate.sessions_minutes, 30, 'una sessione 09:30–10:00 da due bucket uniti, senza doppione');
  var drives = { U_ADM: { files: { list: async function() { return { data: { files: [{ id: 'f1', name: 'Doc', modifiedTime: '2026-09-10T15:00:00Z', lastModifyingUser: { emailAddress: 'a@k.it' } }] } }; } },
    revisions: { list: async function() { return { data: { revisions: [
      { modifiedTime: '2026-09-09T23:30:00Z', lastModifyingUser: { emailAddress: 'a@k.it' } }, { modifiedTime: '2026-09-10T22:30:00Z', lastModifyingUser: { emailAddress: 'a@k.it' } }, { modifiedTime: '2026-09-10T15:00:00Z', lastModifyingUser: { emailAddress: 'a@k.it' } },
    ] } }; } } } };
  var r = await est.collectDriveActivity('2026-09-10', ['U_ADM'], { drives: drives });
  assert.deepEqual(r.events.byEmail['a@k.it'].map(function(e) { return e.at; }), ['2026-09-09T23:30:00Z', '2026-09-10T15:00:00Z'], '23:30Z del 9 è il 10 a Roma; 22:30Z del 10 è l\'11');
  var slow = { U_ADM: { files: { list: async function() { return { data: { files: [1, 2, 3].map(function(i) { return { id: 'f' + i, name: 'Doc' + i, modifiedTime: '2026-09-10T15:00:00Z', lastModifyingUser: { emailAddress: 'a@k.it' } }; }) } }; } },
    revisions: { list: async function() { return new Promise(function(res) { setTimeout(function() { res({ data: { revisions: [{ modifiedTime: '2026-09-10T10:00:00Z', lastModifyingUser: { emailAddress: 'a@k.it' } }] } }); }, 30); }); } } } };
  var r2 = await est.collectDriveActivity('2026-09-10', ['U_ADM'], { drives: slow, revisionsBudgetMs: 0 });
  assert.equal(r2.events.byEmail['a@k.it'].length, 3, 'budget scaduto: resta la sola modifica finale per file');
  assert.ok(r2.events.byEmail['a@k.it'].every(function(e) { return e.at === '2026-09-10T15:00:00Z'; }));
});

test('registro posizioni: documenti, messaggi e file Figma portano [progetto: X] nel prompt e nelle sessioni', async function() {
  var prompt;
  var fakeClient = { messages: { create: async function(req) { prompt = req.messages[0].content; return { content: [{ type: 'text', text: JSON.stringify({ oggi: [{ task: 'Registro cassa', hours: 1, project: 'offkatania' }], domani: [], blocchi: null, confidence: 'alta' }) }] }; } } };
  var fakeDb = { getLogsForUserDate: async function() { return []; }, getProject: async function() { return null; } };
  var locSvc = require('../src/services/projectLocations');
  var locations = locSvc.index([
    { project_id: 'chan_C1', project_name: 'offkatania', kind: 'slack_channel', ref: 'C1', confidence: 'alta', source: 'channel_map' },
    { project_id: 'chan_C1', project_name: 'offkatania', kind: 'drive_folder', ref: 'F_OFF', confidence: 'alta', source: 'admin' },
    { project_id: 'attio_2', project_name: 'Elios', kind: 'figma_project', ref: '77', confidence: 'media', source: 'figma' },
  ]);
  var dayContext = {
    users: [{ id: 'U1', name: 'Peppe Rossi', email: 'peppe@k.it' }],
    slackByUser: { U1: [{ channel: 'offkatania', channel_id: 'C1', text: 'caricato', files: [], at: '2026-09-10T10:20:00+02:00' }] },
    driveByEmail: { 'peppe@k.it': [{ name: 'Registro cassa', type: 'spreadsheet', created_today: true, modified_at: '2026-09-10T08:30:00Z', folder: 'F_OFF' }] }, driveByName: {},
    driveEvents: { byEmail: { 'peppe@k.it': [{ at: '2026-09-10T10:30:00+02:00', kind: 'drive', name: 'Registro cassa', folder: 'F_OFF' }] }, byName: {} },
    figmaByEmail: { 'peppe@k.it': [{ name: 'Landing', project: 'Elios landing', figma_project_id: '77', file_key: 'K1', type: 'figma' }] }, figmaByName: {},
    figmaEvents: { byEmail: { 'peppe@k.it': [{ at: '2026-09-10T15:00:00+02:00', kind: 'figma', name: 'Landing', figma_project_id: '77', file_key: 'K1' }] }, byName: {} },
    adminEvents: [], locations: locations,
  };
  var out = await est.estimateDaily('U1', '2026-09-10', { client: fakeClient, db: fakeDb, app: { client: {} }, dayContext: dayContext, calibration: null });
  assert.ok(out);
  assert.match(prompt, /Registro cassa \(spreadsheet, creato oggi alle 08:30\) \[progetto: offkatania\]/);
  assert.match(prompt, /\[#offkatania → progetto: offkatania\] caricato/);
  assert.match(prompt, /Landing \(progetto Figma: Elios landing\) \[progetto: Elios\]/);
  assert.match(prompt, /SESSIONI DI LAVORO[\s\S]*#offkatania \(1 messaggi\) \[progetto: offkatania\]; Drive "Registro cassa" \(1 modifiche\) \[progetto: offkatania\]/);
  assert.match(prompt, /Figma "Landing" \(1 versioni\) \[progetto: Elios\]/);
});

test('calendario: riunioni senza cliente vanno alle attività trasversali, con il tag nel prompt e nelle sessioni', async function() {
  var prompt;
  var fakeClient = { messages: { create: async function(req) { prompt = req.messages[0].content; return { content: [{ type: 'text', text: JSON.stringify({ oggi: [{ task: 'Daily team', hours: 0, minutes: 15 }], domani: [], blocchi: null, confidence: 'alta' }) }] }; } } };
  var fakeDb = { getLogsForUserDate: async function() { return []; }, getProject: async function() { return null; } };
  var dayContext = { users: [{ id: 'U1', name: 'Paolo', email: 'paolo@k.it' }], slackByUser: {}, driveByEmail: {}, driveByName: {}, driveEvents: { byEmail: {}, byName: {} }, figmaByEmail: {}, figmaByName: {}, figmaEvents: { byEmail: {}, byName: {} },
    adminEvents: [{ title: 'Daily meeting team', start: '2026-09-10T09:30:00+02:00', minutes: 15, attendees: ['paolo@k.it'] }, { title: 'Meeting KatiaMP - The new dawn', start: '2026-09-10T11:00:00+02:00', minutes: 30, attendees: ['paolo@k.it'] }] };
  await est.estimateDaily('U1', '2026-09-10', { client: fakeClient, db: fakeDb, app: { client: {} }, dayContext: dayContext, calibration: null });
  assert.match(prompt, /- Daily meeting team — 15 min, 1 partecipanti \[progetto: Daily e riunioni di team\]/);
  assert.match(prompt, /- Meeting KatiaMP - The new dawn — 30 min, 1 partecipanti\n/);
  assert.match(prompt, /riunione "Daily meeting team" \[progetto: Daily e riunioni di team\]/);
});
