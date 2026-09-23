'use strict';

process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || 'x';
process.env.SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || 'x';
process.env.SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN || 'x';

var test = require('node:test');
var assert = require('node:assert/strict');
var Module = require('module');
var boltPath = require.resolve('@slack/bolt');
if (!require.cache[boltPath]) {
  var stub = new Module(boltPath); stub.filename = boltPath; stub.loaded = true;
  stub.exports = { App: function StubApp() { this.client = {}; this.error = function() {}; } };
  require.cache[boltPath] = stub;
}
var est = require('../src/agents/dailyEstimator');

var fakeDb = { getLogsForUserDate: async function() { return []; }, getProject: async function() { return null; }, getKBCache: function() { return []; } };

test('blocchi di presenza: titoli e task riconosciuti, le riunioni vere no', function() {
  ['Ufficio', 'Ufficio KS', 'Smart working', 'SW', 'Focus time', 'Non disponibile', 'Ferie', 'Tempo operativo - setting', 'In sede Catania', 'Presenza in ufficio', 'Ufficio (presenza)']
    .forEach(function(t) { assert.equal(est.isPresenceTitle(t), true, t); });
  ['Weekly - Meeting Mandorle', 'Lavoro su sito Aitho', 'Presenza evento AciComics', 'Sopralluogo Elios', 'Daily meeting', 'Call con Elios', 'Office hours con il team', 'Riunione Starloom']
    .forEach(function(t) { assert.equal(est.isPresenceTitle(t), false, t); });
  ['Presenza in ufficio / gestione flussi interni', 'Attività in ufficio (presenza)', 'Tempo operativo - setting settimanale', 'Attività generiche sul progetto Elfo', 'Ufficio (presenza)', '']
    .forEach(function(t) { assert.equal(est.isPresenceTask(t), true, t); });
  ['Partecipazione evento AciComics', 'Gestione flussi interni: pagamenti INPS', 'Revisione sito Aitho', 'Daily e riunioni di team']
    .forEach(function(t) { assert.equal(est.isPresenceTask(t), false, t); });
});

test('filterCalendarEvents: via tutto-il-giorno, blocchi di presenza e blocchi lunghi soli; riunioni al massimo 4h', function() {
  var r = est.filterCalendarEvents([
    { title: 'Ufficio', start: '2026-09-22', minutes: 1440, attendees: 0 },
    { title: 'Smart working', start: '2026-09-22T09:00:00+02:00', minutes: 480, attendees: 0 },
    { title: 'Lavoro concentrato', start: '2026-09-22T09:00:00+02:00', minutes: 300, attendees: 1 },
    { title: 'Aperitivo Offline | Take a Breath', start: '2026-09-22T18:00:00+02:00', minutes: 330, attendees: 12 },
    { title: 'Daily meeting', start: '2026-09-22T09:30:00+02:00', minutes: 15, attendees: 8 },
  ]);
  assert.deepEqual(r.kept.map(function(e) { return e.title + ':' + e.minutes; }), ['Aperitivo Offline | Take a Breath:240', 'Daily meeting:15']);
  assert.equal(r.kept[0].minutes_calendar, 330);
  assert.deepEqual(r.dropped.map(function(d) { return d.why; }), ['tutto il giorno', 'blocco di presenza/disponibilità', 'blocco lungo senza partecipanti']);
});

test('appunti Gemini: inizio dal titolo, titoli simili, persona nel testo (nome intero, o solo nome se unico nel team)', function() {
  assert.equal(est.isGeminiNoteName('Weekly - Meeting Mandorle - 2026/09/22 10:03 CEST - Appunti di Gemini'), true);
  assert.equal(est.isGeminiNoteName('Brief Aitho.docx'), false);
  assert.equal(est.geminiStartFromTitle('Weekly - Meeting Mandorle - 2026/09/22 10:03 CEST - Appunti di Gemini', '2026-09-22'), '2026-09-22T10:03:00+02:00');
  assert.equal(est.titleSimilar('Weekly - Meeting Mandorle', 'Weekly Meeting Mandorle + appunti riunione'), true);
  assert.equal(est.titleSimilar('Sopralluogo Elios', 'Riunione Starloom'), false);
  var team = [{ name: 'Paolo Spartano' }, { name: 'Antonio Paratore' }, { name: 'Antonio Rossi' }];
  assert.equal(est.personInText('Partecipanti: Paolo Spartano (KataniaMP), Giuseppe Coniglio', { name: 'Paolo Spartano' }, team), true);
  assert.equal(est.personInText('Partecipanti: Paolo Spartano (KataniaMP)', { name: 'Antonio Paratore' }, team), false);
  assert.equal(est.personInText('Paolo ha proposto di…', { name: 'Paolo Spartano' }, team), true);
  assert.equal(est.personInText('Antonio ha proposto di…', { name: 'Antonio Paratore' }, team), false, 'due Antonio: il solo nome non basta');
});

test('collectMeetingRecaps: recap di oggi dalla KB e dai Doc Gemini su Drive (durata = creazione file − inizio nel titolo)', async function() {
  var kb = [
    { content: '[RECAP MEETING] Weekly - Meeting Mandorle (2026-09-22)\nPartecipanti: Paolo Spartano, Antonio Paratore\nSintesi…', tags: ['tipo:meeting_recap', 'fonte:drive'] },
    { content: '[RECAP MEETING] Vecchia riunione (2026-09-18)\nPartecipanti: Claudia Petrino', tags: ['tipo:meeting_recap'] },
    { content: 'altro', tags: ['tipo:kickoff'] },
  ];
  var docs = { U_ADM: { documents: { get: async function(p) { assert.equal(p.documentId, 'g1'); return { data: { body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Invitati: Claudia Petrino, Carla Sciuto\nRiepilogo: Claudia ha illustrato il tour.' } }] } }] } } }; } } } };
  var ctx = { driveGemini: [
    { id: 'g1', name: 'Content Creator Vinokilo - 2026/09/22 15:00 CEST - Appunti di Gemini', createdTime: '2026-09-22T13:55:00Z', link: 'https://d/g1' },
    { id: 'g2', name: 'Riunione iniziata 2026/09/21 14:49 CEST - Appunti di Gemini', createdTime: '2026-09-21T14:00:00Z' },
  ] };
  var recaps = await est.collectMeetingRecaps('2026-09-22', ctx, ['U_ADM'], { kbCache: kb, docs: docs });
  assert.equal(recaps.length, 2);
  assert.equal(recaps[0].title, 'Weekly - Meeting Mandorle'); assert.equal(recaps[0].source, 'kb'); assert.match(recaps[0].participants, /Paolo Spartano/);
  assert.equal(recaps[1].title, 'Content Creator Vinokilo'); assert.equal(recaps[1].minutes, 55); assert.match(recaps[1].participants, /Claudia Petrino, Carla Sciuto/);
});

test('verifyCalendarWithRecaps: durata effettiva dagli appunti, riunione tolta se la persona non c\'era', function() {
  var team = [{ name: 'Paolo Spartano' }, { name: 'Claudia Petrino' }];
  var recaps = [
    { title: 'Weekly - Meeting Mandorle', start: '2026-09-22T10:00:00+02:00', minutes: 75, participants: 'Paolo Spartano, Antonio Paratore', text: '' },
    { title: 'Content Creator Vinokilo', start: null, minutes: null, participants: 'Claudia Petrino, Carla Sciuto', text: '' },
  ];
  var events = [
    { title: 'Weekly Meeting Mandorle', start: '2026-09-22T10:00:00+02:00', minutes: 30, attendees: 3 },
    { title: 'Content Creator Vinokilo', start: '2026-09-22T15:00:00+02:00', minutes: 60, attendees: 2 },
    { title: 'Daily meeting', start: '2026-09-22T09:30:00+02:00', minutes: 15, attendees: 8 },
  ];
  var paolo = est.verifyCalendarWithRecaps(events, recaps, { name: 'Paolo Spartano' }, team);
  assert.deepEqual(paolo.kept.map(function(e) { return e.title + ':' + e.minutes; }), ['Weekly Meeting Mandorle:75', 'Daily meeting:15']);
  assert.equal(paolo.kept[0].minutes_calendar, 30);
  assert.equal(paolo.kept[0].recap.present, true);
  assert.deepEqual(paolo.dropped, [{ title: 'Content Creator Vinokilo', why: 'non tra i partecipanti negli appunti Gemini' }]);
  // Senza partecipanti noti nel recap non si toglie nulla
  var noNames = est.verifyCalendarWithRecaps(events.slice(0, 1), [{ title: 'Weekly - Meeting Mandorle', minutes: 60, participants: '', text: '' }], { name: 'Claudia Petrino' }, team);
  assert.equal(noNames.kept.length, 1); assert.equal(noNames.kept[0].minutes, 60); assert.equal(noNames.dropped.length, 0);
});

test('collectDriveActivity: gli appunti Gemini non sono output della persona, finiscono in geminiNotes', async function() {
  var drives = { U_ADM: { files: { list: async function() { return { data: { files: [
    { id: 'g1', name: 'Weekly - Meeting Mandorle - 2026/09/22 10:03 CEST - Appunti di Gemini', mimeType: 'application/vnd.google-apps.document', createdTime: '2026-09-22T09:10:00Z', modifiedTime: '2026-09-22T09:10:00Z', lastModifyingUser: { emailAddress: 'antonio@katania.it', displayName: 'Antonio Paratore' } },
    { id: 'f1', name: 'Brief Elfo', mimeType: 'application/vnd.google-apps.document', createdTime: '2026-09-22T09:00:00Z', modifiedTime: '2026-09-22T10:30:00Z', lastModifyingUser: { emailAddress: 'antonio@katania.it', displayName: 'Antonio Paratore' } },
  ] } }; } } } };
  var r = await est.collectDriveActivity('2026-09-22', ['U_ADM'], { drives: drives, revisionsBudgetMs: 0 });
  assert.deepEqual(r.byEmail['antonio@katania.it'].map(function(f) { return f.name; }), ['Brief Elfo']);
  assert.deepEqual(r.geminiNotes.map(function(g) { return g.id; }), ['g1']);
});

test('estimateDaily: "Ufficio" tutto il giorno fuori dal prompt e dalle sessioni; le righe di presenza del modello vengono scartate', async function() {
  var prompt;
  var fakeClient = { messages: { create: async function(req) { prompt = req.messages[0].content; return { content: [{ type: 'text', text: JSON.stringify({
    oggi: [{ task: 'Weekly Meeting Mandorle', hours: 1, minutes: 15 }, { task: 'Presenza in ufficio / gestione flussi interni', hours: 5, minutes: 0 }, { task: 'Brief Elfo (doc)', hours: 1, minutes: 0 }],
    domani: [], blocchi: null, confidence: 'media', note: '',
  }) }] }; } } };
  var dayContext = {
    users: [{ id: 'U_ANT', name: 'Antonio Paratore', email: 'antonio@katania.it' }],
    slackByUser: {}, driveByName: {}, driveEvents: { byEmail: {}, byName: {} },
    driveByEmail: { 'antonio@katania.it': [{ name: 'Brief Elfo', type: 'document', created_today: true, modified_at: '2026-09-22T10:30:00Z' }] },
    adminEvents: [
      { title: 'Weekly Meeting Mandorle', start: '2026-09-22T10:00:00+02:00', minutes: 30, attendees: ['antonio@katania.it', 'paolo@katania.it'] },
      { title: 'Ufficio', start: '2026-09-22T09:00:00+02:00', minutes: 540, attendees: ['antonio@katania.it'] },
    ],
    recaps: [{ title: 'Weekly - Meeting Mandorle', start: '2026-09-22T10:00:00+02:00', minutes: 75, participants: 'Antonio Paratore, Paolo Spartano', text: '' }],
  };
  var out = await est.estimateDaily('U_ANT', '2026-09-22', { client: fakeClient, db: fakeDb, app: { client: {} }, dayContext: dayContext, calibration: null });
  assert.match(prompt, /CALENDARIO DI OGGI[^\n]*\n- Weekly Meeting Mandorle — 75 min effettivi dagli appunti Gemini \(calendario: 30 min\)/);
  assert.match(prompt, /EVENTI DI CALENDARIO ESCLUSI[^\n]*\n- Ufficio \(blocco di presenza\/disponibilità\)/);
  assert.ok(!/SESSIONI DI LAVORO[\s\S]*Ufficio/.test(prompt), 'Ufficio non entra nelle sessioni');
  assert.deepEqual(out.oggi.map(function(t) { return t.task; }), ['Weekly Meeting Mandorle', 'Brief Elfo (doc)']);
  assert.equal(out.totalOggi, 2.25);
  assert.ok(out.estimate.sources.indexOf('appunti Gemini') !== -1);
});
