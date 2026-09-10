'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');

var dbClient = require('../src/services/db/client');
dbClient.useSupabase = false;
dbClient.writeJSON = function() {};
dbClient.readJSON = function(_, def) { return def; };

var pd = require('../src/agents/projectDossier');

var PROJECT = { id: 'chan_C1', name: 'Vinokilo Swiss', client_name: 'Vinokilo', service_category: 'Adv, Social', owner_slack_id: 'U_OWNER' };

test('channelsForProject: per id chan_, per nome progetto e per cliente', function() {
  var map = {
    C1: { channel_name: 'clienti-vinokilo-svizzera', cliente: 'vinokilo', progetto: null },
    C2: { channel_name: 'generale', cliente: null, progetto: null },
    C3: { channel_name: 'swiss-tour-2026', cliente: null, progetto: 'Vinokilo Swiss' },
  };
  var out = pd.channelsForProject(PROJECT, map).map(function(c) { return c.channel_id; }).sort();
  assert.deepEqual(out, ['C1', 'C3']);
});

test('kbEntriesForProject: solo recap/kick-off taggati sul progetto o cliente, recenti', function() {
  var kb = [
    { content: 'a', tags: ['tipo:meeting_recap', 'progetto:vinokilo swiss'], created_at: '2026-09-08' },
    { content: 'b', tags: ['tipo:kickoff', 'cliente:vinokilo'], created_at: '2026-09-01' },
    { content: 'c', tags: ['tipo:meeting_recap', 'cliente:mandorle'], created_at: '2026-09-08' },
    { content: 'd', tags: ['tipo:cliente', 'progetto:vinokilo swiss'], created_at: '2026-09-08' },
    { content: 'e', tags: ['tipo:meeting_recap', 'progetto:vinokilo swiss'], created_at: '2025-01-01' },
  ];
  assert.deepEqual(pd.kbEntriesForProject(kb, PROJECT, 120).map(function(x) { return x.content; }), ['a', 'b']);
});

test('buildPrompt include le sezioni presenti; diffChanges trova le novità', function() {
  var sources = {
    kickoff: { file_name: '[KICK-OFF] Vinokilo', text: 'Obiettivo: show-up al 50%.' },
    recaps: [{ created_at: '2026-09-09', content: '[RECAP MEETING] Trinity x Vinokilo\nDecisioni: pixel TikTok' }],
    channels: [{ channel_name: 'swiss-tour-2026', digest: 'Lucerna sotto target', recent: [{ text: 'servono creatività Winterthur' }] }],
    documents: [], hours30: { total: 12.5, byPerson: { U1: 12.5 } }, allocations: [], signals: [],
  };
  var prev = { version: 1, built_at: '2026-09-01', dossier: { scadenze: [{ cosa: 'Lucerna', quando: '2026-09-19' }], rischi_blocchi: ['show-up basso'] } };
  var p = pd.buildPrompt(PROJECT, sources, prev);
  assert.match(p, /PROGETTO: Vinokilo Swiss \| cliente: Vinokilo/);
  assert.match(p, /SCHEDA PRECEDENTE \(v1, del 2026-09-01\)/);
  assert.match(p, /DOCUMENTO DI KICK-OFF/);
  assert.match(p, /CANALE SLACK #swiss-tour-2026[\s\S]*Lucerna sotto target[\s\S]*servono creatività/);
  assert.match(p, /12\.5h totali/);
  var changes = pd.diffChanges(prev.dossier, { scadenze: [{ cosa: 'Lucerna', quando: '2026-09-19' }, { cosa: 'Winterthur', quando: '2026-10-03' }], rischi_blocchi: ['show-up basso', 'pixel TikTok mancante'], prossimi_passi: [], decisioni_recenti: [] });
  assert.deepEqual(changes.map(function(c) { return c.tipo + ':' + c.testo; }), ['scadenza:Winterthur', 'rischio:pixel TikTok mancante']);
  assert.equal(changes[0].importanza, 'alta');
});

test('buildDossier: parse, versione, changelog, summary compatto; notifyChanges con throttle', async function() {
  var saved = null;
  var fakeDossiers = { getDossier: async function() { return null; }, saveDossier: async function(r) { saved = r; return r; } };
  var dossierJson = {
    stato_sintesi: 'Campagne live, Lucerna sotto target.', fase: 'in corso', obiettivi: ['show-up 50%'],
    deliverable: [{ nome: 'identità visiva', stato: 'in corso' }], scadenze: [{ cosa: 'Evento Lucerna', quando: '2026-09-19', chi: 'Peppe', stato: 'aperta' }],
    team: ['Peppe — adv'], referenti_cliente: ['Robin (founder)'], budget: '7.500€ fisso', decisioni_recenti: [], rischi_blocchi: ['pixel TikTok mancante'],
    prossimi_passi: [{ cosa: 'ottenere accesso TikTok Business Center', chi: 'Peppe', entro: null }], domande_aperte: [],
    cambiamenti: [{ tipo: 'blocco', testo: 'Accesso TikTok Business Center ancora mancante', importanza: 'alta' }],
  };
  var fakeClient = { messages: { create: async function(req) { assert.match(req.messages[0].content, /PROGETTO: Vinokilo Swiss/); return { content: [{ type: 'text', text: JSON.stringify(dossierJson) }] }; } } };
  var sources = { kickoff: { file_name: 'KO', link: 'l', text: 'testo kick-off' }, recaps: [], channels: [], documents: [], hours30: { total: 0, byPerson: {} }, allocations: [], signals: [] };
  var out = await pd.buildDossier(PROJECT, { deps: { dossiers: fakeDossiers, client: fakeClient }, sources: sources, previous: null });
  assert.equal(out.row.version, 1);
  assert.equal(out.changes.length, 0, 'prima versione: nessun cambiamento da segnalare');
  assert.equal(saved.project_id, 'chan_C1');
  assert.match(saved.summary, /\*Vinokilo Swiss\* — Vinokilo · _in corso_ · scheda v1/);
  assert.match(saved.summary, /Evento Lucerna — 2026-09-19 \(Peppe\)/);
  assert.doesNotMatch(saved.summary, /Referenti cliente/, 'compatto: senza sezioni estese');
  var full = pd.formatDossier(PROJECT, saved);
  assert.match(full, /\*Referenti cliente:\* Robin \(founder\)/);
  assert.match(full, /_Fonti: kick-off_/);

  // Seconda versione: il modello compila "cambiamenti" → changelog e avviso.
  var out2 = await pd.buildDossier(PROJECT, { deps: { dossiers: fakeDossiers, client: fakeClient }, sources: sources, previous: saved });
  assert.equal(out2.row.version, 2);
  assert.equal(out2.changes.length, 1);
  assert.equal(out2.row.changelog.length, 1);

  var posted = [];
  var gateCalls = 0;
  var fakeGate = {
    notificheEnabled: function() { return true; }, itemHash: function(t) { return 'h' + t.length; },
    followupAllowed: async function() { gateCalls++; return { allowed: gateCalls === 1, attempts: 0 }; },
    recordFollowup: async function() {},
  };
  var fakeApp = { client: { chat: { postMessage: async function(a) { posted.push(a); return { ts: '1' }; } } } };
  var n = await pd.notifyChanges(PROJECT, out2.row, out2.changes, { gate: fakeGate, supabase: {}, app: fakeApp });
  assert.equal(n, 1);
  assert.equal(posted[0].channel, 'U_OWNER');
  assert.match(posted[0].text, /Vinokilo Swiss[\s\S]*\[blocco\] Accesso TikTok/);
  var n2 = await pd.notifyChanges(PROJECT, out2.row, out2.changes, { gate: fakeGate, supabase: {}, app: fakeApp });
  assert.equal(n2, 0, 'stesso cambiamento non viene rimandato');
  assert.equal(pd.notifyChanges.length >= 3, true);
});

test('formatWeeklyBrief: una riga per progetto con prossima scadenza e rischio', function() {
  var text = pd.formatWeeklyBrief([{ project: { name: 'Mandorle' }, row: { dossier: { fase: 'in corso', stato_sintesi: 'Packaging in chiusura. Bando in preparazione.', scadenze: [{ cosa: 'Bando Fondazione Sud', quando: '2026-09-15', stato: 'aperta' }], rischi_blocchi: ['governance fondazione'] } } }]);
  assert.match(text, /\*Mandorle\* \(in corso\): Packaging in chiusura\./);
  assert.match(text, /⏰ Bando Fondazione Sud — 2026-09-15/);
  assert.match(text, /⚠️ governance fondazione/);
  assert.equal(pd.formatWeeklyBrief([]), null);
});
