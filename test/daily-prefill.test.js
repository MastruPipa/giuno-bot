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

test('prefillFromEstimate: righe del modale dalla stima, ore ai quarti, progetto nel testo', function() {
  var pre = dsv2.prefillFromEstimate({
    oggi: [{ task: 'Call Aitho', hours: 1, minutes: 0 }, { task: 'Grafiche Elfo', hours: 2, minutes: 20, project: 'Elfo' }],
    domani: [{ task: 'Revisione', hours: 0, minutes: 0 }], blocchi: null,
  });
  assert.deepEqual(pre.oggi, [{ task: 'Call Aitho', hours: 1 }, { task: 'Grafiche Elfo [Elfo]', hours: 2.25 }]);
  assert.deepEqual(pre.domani, [{ task: 'Revisione', hours: 0 }]);
  assert.equal(dsv2.prefillFromEstimate(null), null);
  assert.equal(dsv2.prefillFromEstimate({ oggi: [], domani: [] }), null);
});

test('respondedFromDb: chi ha una entry vera oggi conta come presente, le stime no', async function() {
  var clientPath = require.resolve('../src/services/db/client');
  var orig = require.cache[clientPath];
  var fake = new Module(clientPath); fake.filename = clientPath; fake.loaded = true;
  fake.exports = { getClient: function() { return { from: function() { return { select: function() { return { eq: function() { return { limit: async function() { return { data: [
    { slack_user_id: 'U_GIANNA', source: 'modal' }, { slack_user_id: 'U_PAOLO', source: 'estimate' }, { slack_user_id: 'U_SAM', source: 'channel' },
  ] }; } }; } }; } }; } }; }, useSupabase: true, logErr: function() {} };
  require.cache[clientPath] = fake;
  try {
    var r = await dsv2.respondedFromDb('2026-09-10');
    assert.deepEqual(Object.keys(r).sort(), ['U_GIANNA', 'U_SAM']);
    assert.equal(r.U_GIANNA.fromDb, true);
  } finally { if (orig) require.cache[clientPath] = orig; else delete require.cache[clientPath]; }
});

test('prefillFromEstimate: il progetto sta in project_name dopo il matcher e nelle entry salvate', function() {
  var pre = dsv2.prefillFromEstimate({
    oggi: [{ task: 'Sopralluogo Elios', hours: 2, minutes: 30, project_id: 'attio_x', project_name: 'Elios Luce e Gas' },
           { task: 'Grafiche [Elfo]', hours: 1, minutes: 0, project_name: 'Elfo' }],
    domani: [],
  });
  assert.deepEqual(pre.oggi, [{ task: 'Sopralluogo Elios [Elios Luce e Gas]', hours: 2.5 }, { task: 'Grafiche [Elfo]', hours: 1 }]);
});

test('prefillForModal: proposta in sospeso prima, poi il daily di oggi salvato, altrimenti vuoto', async function() {
  var pending = { oggi: [{ task: 'Call Aitho', hours: 1, minutes: 0 }], domani: [] };
  var entry = { oggi_tasks: [{ task: 'Revisione sito', hours: 3, minutes: 0, project_name: 'Aitho' }], domani_tasks: [{ task: 'Mockup', hours: 0, minutes: 0 }], blocchi: 'testi del cliente', source: 'estimate_confirmed' };
  var calls = [];
  var deps = {
    getPendingEstimate: function() { return pending; },
    getTodayEntry: async function(userId, date) { calls.push([userId, date]); return entry; },
  };
  var a = await dsv2.prefillForModal('U1', '2026-09-22', deps);
  assert.equal(a.from, 'estimate');
  assert.deepEqual(a.prefill.oggi, [{ task: 'Call Aitho', hours: 1 }]);
  assert.equal(calls.length, 0);

  pending = null;
  var b = await dsv2.prefillForModal('U1', '2026-09-22', deps);
  assert.equal(b.from, 'entry');
  assert.deepEqual(b.prefill.oggi, [{ task: 'Revisione sito [Aitho]', hours: 3 }]);
  assert.deepEqual(b.prefill.domani, [{ task: 'Mockup', hours: 0 }]);
  assert.equal(b.prefill.blocchi, 'testi del cliente');
  assert.deepEqual(calls, [['U1', '2026-09-22']]);

  entry = null;
  var c = await dsv2.prefillForModal('U1', '2026-09-22', deps);
  assert.deepEqual(c, { prefill: null, from: null });
});

test('dailyTextModal: una sola area di testo multilinea, callback daily_text_submit', function() {
  var view = dsv2.dailyTextModal();
  assert.equal(view.type, 'modal');
  assert.equal(view.callback_id, 'daily_text_submit');
  var inputs = view.blocks.filter(function(b) { return b.type === 'input'; });
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].block_id, 'daily_text');
  assert.equal(inputs[0].element.action_id, 'daily_text_input');
  assert.equal(inputs[0].element.multiline, true);
});

test('saveFreeTextDaily: salva come daily vero (source modal_text) e restituisce com\'è stato letto', async function() {
  var seen = [];
  var res = await dsv2.saveFreeTextDaily('U1', '  call con Elios 1h e grafiche 2h  ', {
    handleDailyResponse: async function(userId, text, structured, opts) { seen.push([userId, text, structured, opts]); return true; },
    getTodayEntry: async function() { return { oggi_tasks: [{ task: 'call con Elios', hours: 1, minutes: 0 }, { task: 'grafiche', hours: 2, minutes: 0 }], domani_tasks: [], blocchi: null }; },
  });
  assert.deepEqual(seen, [['U1', 'call con Elios 1h e grafiche 2h', null, { source: 'modal_text' }]]);
  assert.equal(res.saved, true);
  assert.equal(res.structured.oggi.length, 2);

  var empty = await dsv2.saveFreeTextDaily('U1', '   ', { handleDailyResponse: async function() { throw new Error('non deve essere chiamato'); } });
  assert.deepEqual(empty, { saved: false, structured: null });

  var failed = await dsv2.saveFreeTextDaily('U1', 'testo', { handleDailyResponse: async function() { return false; }, getTodayEntry: async function() { throw new Error('non deve essere chiamato'); } });
  assert.deepEqual(failed, { saved: false, structured: null });
});

test('i DM del daily portano il bottone "Scrivo a testo libero" (proposta e modulo semplice)', function() {
  var msg = dsv2.estimateProposalMessage({ id: 'U1', name: 'Antonio Rossi' }, { oggi: [{ task: 'Call', hours: 1, minutes: 0 }], domani: [], estimate: { generated_at: 'g', sources: [] } }, { mode: 'daily' });
  var actions = msg.blocks.filter(function(b) { return b.type === 'actions'; })[0].elements.map(function(e) { return e.action_id; });
  assert.deepEqual(actions, ['daily_estimate_confirm', 'open_daily_modal', 'open_daily_modal_blank', 'open_daily_modal_text']);
});

test('getPendingEstimateFresh / prefillForModal: senza proposta in memoria la rilegge dal DB (istanza diversa o riavvio)', async function() {
  var today = dsv2.oggi();
  dsv2.clearPendingEstimate('U_FRESH');
  var reads = 0;
  var fakeDb = { loadPendingEstimateFor: async function(uid) { reads++; return uid === 'U_FRESH' ? { date: today, structured: { oggi: [{ task: 'Call Aitho', hours: 1, minutes: 0 }], domani: [] } } : null; } };
  var s = await dsv2.getPendingEstimateFresh('U_FRESH', today, { db: fakeDb });
  assert.equal(s.oggi[0].task, 'Call Aitho'); assert.equal(reads, 1);
  // ora è in memoria: niente seconda lettura
  await dsv2.getPendingEstimateFresh('U_FRESH', today, { db: fakeDb });
  assert.equal(reads, 1);
  dsv2.clearPendingEstimate('U_FRESH');
  var r = await dsv2.prefillForModal('U_FRESH', today, { db: fakeDb, getTodayEntry: async function() { throw new Error('non serve: c\'è la proposta'); } });
  assert.equal(r.from, 'estimate'); assert.deepEqual(r.prefill.oggi, [{ task: 'Call Aitho', hours: 1 }]);
  dsv2.clearPendingEstimate('U_FRESH');
  // proposta di un altro giorno nel DB: ignorata
  var old = { loadPendingEstimateFor: async function() { return { date: '2020-01-01', structured: { oggi: [{ task: 'x', hours: 1 }] } }; } };
  assert.equal(await dsv2.getPendingEstimateFresh('U_FRESH', today, { db: old }), null);
});
