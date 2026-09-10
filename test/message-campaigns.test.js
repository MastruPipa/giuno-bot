'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');

var dbClient = require('../src/services/db/client');
dbClient.useSupabase = false;
dbClient.writeJSON = function() {};
dbClient.readJSON = function(_, def) { return def; };

var mc = require('../src/agents/messageCampaigns');

test('matchReply: parola attesa contenuta, conferma secca = consumata', function() {
  assert.deepEqual(mc.matchReply('LETTO', 'LETTO'), { matched: true, consumed: true });
  assert.deepEqual(mc.matchReply('letto, grazie!', 'LETTO'), { matched: true, consumed: true });
  assert.deepEqual(mc.matchReply('Letto. Ma il planner del giovedì mi arriva anche se sono in ferie?', 'LETTO'), { matched: true, consumed: false });
  assert.deepEqual(mc.matchReply('ok ci penso', 'LETTO'), { matched: false, consumed: false });
  assert.deepEqual(mc.matchReply('ok', null), { matched: true, consumed: true });
});

function fakeWorld(nowMs) {
  var store = {};
  var posted = [];
  var db = {
    createCampaign: async function(r) { r.id = 'cmp_1'; r.status = 'active'; store[r.id] = r; return r; },
    getCampaign: async function(id) { return store[id] || null; },
    listCampaigns: async function(f) { return Object.keys(store).map(function(k) { return store[k]; }).filter(function(c) { return !f.status || c.status === f.status; }); },
    updateCampaign: async function(id, fields) { Object.assign(store[id], fields); return store[id]; },
  };
  var app = { client: {
    conversations: { open: async function(a) { return { channel: { id: 'D_' + a.users } }; } },
    chat: { postMessage: async function(a) { posted.push(a); return { ts: 't' + posted.length }; } },
  } };
  var clock = { now: nowMs };
  return { db: db, app: app, posted: posted, store: store, clock: clock, deps: { db: db, app: app, now: function() { return clock.now; } } };
}

test('campagna: invio, risposte, solleciti a intervalli, chiusura con report a chi l\'ha lanciata', async function() {
  var T0 = Date.parse('2026-09-10T08:00:00Z');
  var w = fakeWorld(T0);
  var started = await mc.startCampaign(Object.assign({ createdBy: 'U_ANT', createdByName: 'Antonio', message: 'Ciao team, rispondete LETTO', recipients: [{ id: 'U1', name: 'Paolo' }, { id: 'U2', name: 'Giusy' }, { id: 'U3', name: 'Peppe' }], expectedReply: 'LETTO', checkAfterMinutes: 60, maxPushes: 2 }, w.deps));
  var c = started.campaign;
  assert.equal(c.recipients.length, 3);
  assert.equal(w.posted.length, 3, 'tre DM iniziali');
  assert.equal(c.next_check_at, new Date(T0 + 3600000).toISOString());

  // Paolo risponde subito, Giusy con una domanda
  var r1 = await mc.registerReply('U1', 'LETTO', w.deps);
  assert.equal(r1.consumed, true);
  var r2 = await mc.registerReply('U2', 'Letto, ma una domanda: il daily vale anche il venerdì?', w.deps);
  assert.equal(r2.consumed, false, 'la domanda va al modello');
  assert.equal(await mc.registerReply('U9', 'LETTO', w.deps), null, 'non destinatario');
  assert.equal(await mc.registerReply('U1', 'LETTO', w.deps), null, 'già risposto');

  // Prima dell'ora: niente
  assert.equal(await mc.runChecks(w.deps), 0);
  // Dopo un'ora: sollecito a Peppe + report ad Antonio
  w.clock.now = T0 + 61 * 60000;
  w.posted.length = 0;
  assert.equal(await mc.runChecks(w.deps), 1);
  assert.equal(w.posted.length, 2);
  assert.equal(w.posted[0].channel, 'D_U3');
  assert.match(w.posted[0].text, /Promemoria[\s\S]*"LETTO"[\s\S]*Antonio/);
  assert.equal(w.posted[1].channel, 'U_ANT');
  assert.match(w.posted[1].text, /2\/3 hanno risposto[\s\S]*Sollecito inviato a: Peppe/);
  // Secondo giro: secondo sollecito
  w.clock.now = T0 + 122 * 60000; w.posted.length = 0;
  await mc.runChecks(w.deps);
  assert.equal(w.store.cmp_1.recipients[2].pushes, 2);
  // Terzo giro: esauriti → "tocca a te" e campagna chiusa
  w.clock.now = T0 + 183 * 60000; w.posted.length = 0;
  await mc.runChecks(w.deps);
  assert.equal(w.store.cmp_1.status, 'completed');
  var toAntonio = w.posted.filter(function(p) { return p.channel === 'U_ANT'; });
  assert.ok(toAntonio.some(function(p) { return /tocca a te/.test(p.text) && /<@U3>/.test(p.text); }));
  assert.ok(toAntonio.some(function(p) { return /Campagna chiusa/.test(p.text); }));
  assert.match(mc.formatStatus(w.store.cmp_1), /✅ Paolo, Giusy[\s\S]*❌ nessuna risposta dopo 2 solleciti: <@U3>/);
});

test('reaction sul messaggio = letto; chiusura quando tutti hanno risposto', async function() {
  var w = fakeWorld(Date.now());
  await mc.startCampaign(Object.assign({ createdBy: 'U_ANT', message: 'msg', recipients: [{ id: 'U1', name: 'Paolo' }], expectedReply: null }, w.deps));
  var ts = w.store.cmp_1.recipients[0].ts;
  assert.equal(await mc.registerReaction('U1', 'altro_ts', w.deps), null);
  var c = await mc.registerReaction('U1', ts, w.deps);
  assert.equal(c.id, 'cmp_1');
  assert.equal(w.store.cmp_1.status, 'completed');
  var cancel = await mc.cancelCampaign('cmp_1', 'U_ANT', w.deps);
  assert.match(cancel.error, /già completed/);
});
