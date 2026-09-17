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
var dsv2 = require('../src/handlers/dailyStandupV2');
var est = require('../src/agents/dailyEstimator');
var tracking = require('../src/config/tracking');

// Antonio (17/9): la stima arriva a tutti alle 17:30, anche a lui; poi si
// approva, si modifica (modulo o a parole) o si compila da zero.

test('orari: stima 17:30, promemoria 18:00, recap 18:30, lun-ven', function() {
  assert.deepEqual(dsv2.DAILY_TIMES, { send: '17:30', push: '18:00', recap: '18:30' });
  var jobs = [];
  dsv2.scheduleDailyJobs({ schedule: function(expr, fn, opts) { jobs.push([expr, opts.name]); } });
  assert.deepEqual(jobs, [['30 17 * * 1-5', 'daily_send'], ['0 18 * * 1-5', 'daily_push'], ['30 18 * * 1-5', 'daily_recap']]);
  assert.equal(dsv2.cronExprFor('9:05'), '5 9 * * 1-5');
});

test('Antonio è dentro al daily; le altre esclusioni restano', function() {
  assert.equal(tracking.isExcludedName('Antonio Katania'), false);
  assert.equal(tracking.isExcludedName('Gloria Rossi'), true);
  assert.equal(tracking.isExcludedName('Cellulare studio'), true);
});

test('classifyEstimateReply: approvazione a parole, modifica a parole, il resto no', function() {
  ['ok', 'Ok!', 'va bene così', 'approvo', 'confermo', 'sì', 'perfetto 👍'].forEach(function(t) { assert.equal(dsv2.classifyEstimateReply(t), 'approve', t); });
  ['aggiungi 1h di call con Elios', 'la grafica erano 3h', 'togli la revisione', 'non ho fatto la call', 'in più ho fatto 1h di preventivo Acme',
    'manca la call con Gambino 1h', 'puoi aggiungere 30 min di mail?', 'Giuno, togli la revisione'].forEach(function(t) { assert.equal(dsv2.classifyEstimateReply(t), 'amend', t); });
  // Daily intero, domande, richieste esplicite di posting: non sono risposte alla proposta.
  ['Oggi: grafiche 3h\nDomani: PED', 'quando esce il recap?', 'ciao giuno, cosa mi consigli?', 'posta il daily: oggi grafiche 3h e call 1h', ''].forEach(function(t) { assert.equal(dsv2.classifyEstimateReply(t), null, JSON.stringify(t)); });
});

test('amendEstimate: il modello applica la modifica, la stima tiene fonti e storico delle modifiche', async function() {
  var seen;
  var fakeClient = { messages: { create: async function(req) { seen = req; return { content: [{ type: 'text', text: JSON.stringify({
    oggi: [{ task: 'Grafiche Elfo', hours: 3, minutes: 0, project: 'Elfo' }, { task: 'Call con Elios', hours: 1, minutes: 0, project: 'Elios' }], domani: [{ task: 'PED', hours: 0, minutes: 0 }], blocchi: null,
  }) }] }; } } };
  var current = { oggi: [{ task: 'Grafiche Elfo', hours: 2, minutes: 0 }], domani: [{ task: 'PED', hours: 0, minutes: 0 }], blocchi: null, estimate: { sources: ['documenti Drive'], confidence: 'media', generated_at: 'g' } };
  var out = await est.amendEstimate(current, 'la grafica erano 3h e aggiungi 1h di call con Elios', { client: fakeClient, userId: 'U1', date: '2026-09-17' });
  assert.match(seen.system, /SOLO quella modifica/);
  assert.match(seen.messages[0].content, /DAILY ATTUALE:[\s\S]*Grafiche Elfo[\s\S]*MODIFICA CHIESTA DALLA PERSONA:\nla grafica erano 3h/);
  assert.equal(out.oggi.length, 2); assert.equal(out.oggi[0].hours, 3); assert.equal(out.totalOggi, 4);
  assert.deepEqual(out.estimate.sources, ['documenti Drive']); assert.equal(out.estimate.generated_at, 'g');
  assert.deepEqual(out.estimate.amendments, ['la grafica erano 3h e aggiungi 1h di call con Elios']);
  assert.equal(await est.amendEstimate(current, '', { client: fakeClient }), null);
  var broken = { messages: { create: async function() { return { content: [{ type: 'text', text: 'non so' }] }; } } };
  assert.equal(await est.amendEstimate(current, 'togli tutto', { client: broken }), null);
});

test('proposta in DM: tre bottoni (approvo, modifico nel modulo, da zero), istruzioni per scrivere, orario del recap', function() {
  var structured = { oggi: [{ task: 'Grafiche Elfo', hours: 2, minutes: 0 }], domani: [], blocchi: null, estimate: { sources: ['documenti Drive'], confidence: 'media', generated_at: 'g' } };
  var msg = dsv2.estimateProposalMessage({ id: 'U1', name: 'Paolo Spartano' }, structured, { mode: 'daily' });
  assert.equal(msg.channel, 'U1');
  assert.match(msg.blocks[0].text.text, /Ciao \*Paolo\*, è il momento del daily/);
  assert.match(msg.blocks[2].text.text, /\*Approva\* con il bottone, \*modifica\* nel modulo già compilato, oppure \*scrivimi qui\* cosa aggiungere o cambiare/);
  assert.match(msg.blocks[3].elements[0].text, /Se alle 18:30 non ho tue notizie/);
  var buttons = msg.blocks[4].elements.map(function(b) { return b.action_id + ':' + b.text.text; });
  assert.deepEqual(buttons, ['daily_estimate_confirm:✅ Approvo', 'open_daily_modal:✏️ Modifico nel modulo', 'open_daily_modal_blank:📝 Compilo da zero']);
  assert.match(dsv2.estimateProposalMessage({ id: 'U1', name: 'Paolo' }, structured, { mode: 'amended' }).blocks[0].text.text, /Ok \*Paolo\*, aggiornato così/);
});

test('amendPendingEstimate: aggiorna la stima in sospeso e rimanda la proposta; senza proposta non fa nulla', async function() {
  var today = dsv2.oggi();
  var sent = [];
  var fakeApp = { client: { chat: { postMessage: async function(m) { sent.push(m); } } } };
  var fakeEstimator = {
    amendEstimate: async function(current, instruction) { return Object.assign({}, current, { oggi: current.oggi.concat([{ task: 'Call Elios', hours: 1, minutes: 0 }]), estimate: Object.assign({}, current.estimate, { amendments: [instruction] }) }); },
    formatEstimateBody: est.formatEstimateBody, formatSourcesLine: est.formatSourcesLine,
  };
  var fakeDb = { getStandupCache: function() { return { oggi: today, stime: {} }; }, saveStandup: async function() {} };
  assert.equal(await dsv2.amendPendingEstimate('U_NOBODY', 'aggiungi 1h', { estimator: fakeEstimator, app: fakeApp, db: fakeDb, utenti: [] }), null);
  dsv2.rememberPendingEstimate('U_PAOLO', today, { oggi: [{ task: 'Grafiche', hours: 2, minutes: 0 }], domani: [], blocchi: null, estimate: { sources: ['canali'], confidence: 'media', generated_at: 'g' } });
  try {
    var out = await dsv2.amendPendingEstimate('U_PAOLO', 'aggiungi 1h di call con Elios', { estimator: fakeEstimator, app: fakeApp, db: fakeDb, utenti: [{ id: 'U_PAOLO', name: 'Paolo Spartano' }] });
    assert.equal(out.oggi.length, 2);
    assert.equal(dsv2.getPendingEstimate('U_PAOLO', today).oggi.length, 2, 'la proposta in sospeso è quella aggiornata');
    assert.equal(sent.length, 1);
    assert.match(sent[0].blocks[0].text.text, /aggiornato così/);
    assert.match(sent[0].text, /Call Elios 1h/);
  } finally { dsv2.clearPendingEstimate('U_PAOLO'); }
});
