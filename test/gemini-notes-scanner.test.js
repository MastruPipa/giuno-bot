'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');

var dbClient = require('../src/services/db/client');
dbClient.useSupabase = false;
dbClient.writeJSON = function() {};
dbClient.readJSON = function(_, def) { return def; };

var scanner = require('../src/agents/geminiNotesScanner');

test('classifyTitle / dateFromTitle / cleanTitle sui titoli reali di Gemini', function() {
  assert.equal(scanner.classifyTitle('Weekly - Meeting Mandorle - 2026/09/08 10:03 CEST - Appunti di Gemini'), 'recap');
  assert.equal(scanner.classifyTitle('Kick Off - Mbracciata - 2026/05/26 09:36 CEST - Appunti di Gemini'), 'kickoff');
  assert.equal(scanner.classifyTitle('[KICK-OFF] Vinokilo Swiss — Tour Autunno 2026'), 'kickoff');
  assert.equal(scanner.classifyTitle('Preventivo Tomarchio'), null);
  assert.equal(scanner.dateFromTitle('Weekly - Meeting Mandorle - 2026/09/08 10:03 CEST - Appunti di Gemini'), '2026-09-08');
  assert.equal(scanner.cleanTitle('Weekly - Meeting Mandorle - 2026/09/08 10:03 CEST - Appunti di Gemini'), 'Weekly - Meeting Mandorle');
  assert.equal(scanner.cleanTitle('Riunione iniziata 2026/09/07 14:49 CEST - Appunti di Gemini (italiano)'), 'Riunione iniziata 2026/09/07 14:49 CEST');
});

test('alreadyIngested: per tag KB o documento già collegato', function() {
  var kb = [{ tags: ['tipo:meeting_recap', 'drive_file_id:F1'] }];
  assert.equal(scanner.alreadyIngested('F1', kb, null), true);
  assert.equal(scanner.alreadyIngested('F2', kb, null), false);
  assert.equal(scanner.alreadyIngested('F2', kb, { id: 'x' }), true);
});

test('parseExtraction normalizza le liste; matchProject usa i candidati poi il titolo', function() {
  var ex = scanner.parseExtraction('ecco: {"tipo":"recap","titolo":"Weekly Mandorle","decisioni":["packaging bianco"],"progetto_candidati":["Mandorle"]}');
  assert.deepEqual(ex.azioni, []);
  assert.equal(ex.decisioni.length, 1);
  var matcher = require('../src/services/projectMatcher');
  var catalog = [{ id: 'chan_1', name: 'mandorle', norm: 'mandorle' }, { id: 'attio_2', name: 'Vinokilo Swiss', norm: 'vinokilo swiss' }];
  assert.equal(scanner.matchProject(matcher, catalog, ex, 'Weekly - Meeting').id, 'chan_1');
  assert.equal(scanner.matchProject(matcher, catalog, { progetto_candidati: [], cliente: null }, 'Trinity x Vinokilo Swiss').id, 'attio_2');
  assert.equal(scanner.matchProject(matcher, catalog, { progetto_candidati: [], cliente: 'Nessuno' }, 'Riunione iniziata'), null);
});

test('scanGeminiNotes: legge Drive, estrae, salva KB, collega al progetto e marca il dossier', async function() {
  var kbSaved = [], docsAdded = [], marked = [];
  var actions = [];
  var fakeDb = {
    getKBCache: function() { return [{ tags: ['tipo:meeting_recap', 'drive_file_id:OLD'] }]; },
    addKBEntry: async function(content, tags, by) { kbSaved.push({ content: content, tags: tags, by: by }); return { id: 'kb1' }; },
    findTeamMemberByName: function(n) { return /^corrado/i.test(n) ? { slack_user_id: 'U_CORRADO' } : null; },
  };
  var fakeDossiers = {
    findProjectDocumentByFile: async function() { return null; },
    addProjectDocument: async function(row) { docsAdded.push(row); return row; },
    markNeedsRefresh: async function(id, at) { marked.push({ id: id, at: at }); },
    addProjectAction: async function(row) { actions.push(row); return row; },
  };
  var matcher = require('../src/services/projectMatcher');
  var fakeMatcher = { getCatalog: async function() { return [{ id: 'chan_1', name: 'mandorle', norm: 'mandorle' }]; }, matchTaskAgainstCatalog: matcher.matchTaskAgainstCatalog };
  var files = [
    { id: 'OLD', name: 'Daily - 2026/09/01 09:00 CEST - Appunti di Gemini', modifiedTime: '2026-09-01T07:00:00Z' },
    { id: 'NEW', name: 'Weekly - Meeting Mandorle - 2026/09/08 10:03 CEST - Appunti di Gemini', modifiedTime: '2026-09-08T08:33:00Z', webViewLink: 'https://docs.google.com/document/d/NEW' },
    { id: 'PREV', name: 'Preventivo Tomarchio', modifiedTime: '2026-09-08T08:33:00Z' },
  ];
  var fakeDrive = { files: { list: async function(q) { assert.match(q.q, /Appunti di Gemini/); return { data: { files: files } }; } } };
  var fakeDocs = { documents: { get: async function(a) { return { data: { body: { content: [{ paragraph: { elements: [{ textRun: { content: ('Riepilogo della riunione Mandorle: packaging scelto bianco. Passaggi: Corrado invia documenti Caritas entro il 10/09. ' + 'x'.repeat(150)) } }] } } ] } } }; } } };
  var fakeClient = { messages: { create: async function() { return { content: [{ type: 'text', text: JSON.stringify({
    tipo: 'recap', titolo: 'Weekly Mandorle', data: '2026-09-08', cliente: 'Mandorle', progetto_candidati: ['Mandorle'],
    partecipanti: ['Antonio (KS)'], sintesi: 'Packaging: scelta la versione bianca.', decisioni: ['packaging bianco'],
    azioni: [{ chi: 'Corrado', cosa: 'inviare documenti Caritas', entro: '2026-09-10' }], scadenze: [], rischi: [],
  }) }] }; } } };
  var rep = await scanner.scanGeminiNotes({ days: 3, deps: {
    db: fakeDb, dossiers: fakeDossiers, matcher: fakeMatcher, client: fakeClient,
    tokens: { U1: 'rt' }, roles: [{ slack_user_id: 'U1', role: 'admin' }], drives: { U1: fakeDrive }, docs: { U1: fakeDocs },
  } });
  assert.equal(rep.scanned, 2, 'il preventivo non è un appunto');
  assert.equal(rep.skipped, 1, 'OLD già in KB');
  assert.equal(rep.ingested, 1);
  assert.equal(kbSaved.length, 1);
  assert.match(kbSaved[0].content, /^\[RECAP MEETING\] Weekly Mandorle \(2026-09-08\)/);
  assert.ok(kbSaved[0].tags.indexOf('drive_file_id:NEW') !== -1);
  assert.ok(kbSaved[0].tags.indexOf('progetto:mandorle') !== -1);
  assert.match(kbSaved[0].content, /Corrado → inviare documenti Caritas \(entro 2026-09-10\)/);
  assert.equal(docsAdded[0].project_id, 'chan_1');
  assert.equal(docsAdded[0].doc_role, 'recap');
  assert.deepEqual(marked, [{ id: 'chan_1', at: '2026-09-08T08:33:00Z' }]);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].assignee_slack_id, 'U_CORRADO');
  assert.equal(actions[0].due_date, '2026-09-10');
  assert.equal(actions[0].project_id, 'chan_1');
  assert.equal(rep.actions, 1);
  assert.match(scanner.formatReport(rep), /1 nuovi[\s\S]*Weekly - Meeting Mandorle → mandorle/);
});
