'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var gate = require('../src/utils/proactiveGate');

test('itemHash: stabile rispetto a maiuscole e spazi, diverso per contenuti diversi', function() {
  var a = gate.itemHash('Aggiornare il CRM  per Aitho');
  var b = gate.itemHash('aggiornare il crm per aitho');
  var c = gate.itemHash('aggiornare il crm per dicar');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{16}$/);
});

test('notificheEnabled: default true, false solo con opt-out esplicito', function() {
  // senza Supabase la cache prefs è vuota → default abilitato
  assert.equal(gate.notificheEnabled('U_SCONOSCIUTO'), true);
});

function fakeSupabase(logRow) {
  return {
    from: function() {
      return {
        select: function() { return this; },
        eq: function() { return this; },
        maybeSingle: function() { return Promise.resolve({ data: logRow }); },
      };
    },
  };
}

test('followupAllowed: nessun log precedente → consentito', async function() {
  var res = await gate.followupAllowed(fakeSupabase(null), 'U1', 'hash1');
  assert.equal(res.allowed, true);
  assert.equal(res.attempts, 0);
});

test('followupAllowed: inviato ieri → bloccato dal cooldown di 3 giorni', async function() {
  var res = await gate.followupAllowed(fakeSupabase({
    sent_at: new Date(Date.now() - 1 * 86400000).toISOString(), attempts: 1,
  }), 'U1', 'hash1');
  assert.equal(res.allowed, false);
});

test('followupAllowed: inviato 4 giorni fa con 1 tentativo → consentito', async function() {
  var res = await gate.followupAllowed(fakeSupabase({
    sent_at: new Date(Date.now() - 4 * 86400000).toISOString(), attempts: 1,
  }), 'U1', 'hash1');
  assert.equal(res.allowed, true);
  assert.equal(res.attempts, 1);
});

test('followupAllowed: 3 tentativi raggiunti → bloccato per sempre', async function() {
  var res = await gate.followupAllowed(fakeSupabase({
    sent_at: new Date(Date.now() - 30 * 86400000).toISOString(), attempts: 3,
  }), 'U1', 'hash1');
  assert.equal(res.allowed, false);
});

test('followupAllowed: errore DB → bloccato (in dubbio non spammare)', async function() {
  var broken = { from: function() { throw new Error('db giù'); } };
  var res = await gate.followupAllowed(broken, 'U1', 'hash1');
  assert.equal(res.allowed, false);
});
