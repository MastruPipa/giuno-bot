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
var standupTools = require('../src/tools/standupTools');

// Il caso di Antonio (17/9): il daily scritto a mano in DM con "postalo" in
// testa o in coda. classifyDailyText lo vedeva come richiesta e il modello
// non aveva modo di pubblicarlo.
test('extractDailyFromRequest: richiesta in testa, con due punti o a capo', function() {
  assert.equal(
    dsv2.extractDailyFromRequest('Giuno, posta questo daily: oggi ho fatto grafiche Elfo 3h e call Aitho 1h. Domani revisione PED.'),
    'oggi ho fatto grafiche Elfo 3h e call Aitho 1h. Domani revisione PED.');
  assert.equal(
    dsv2.extractDailyFromRequest('Ciao Giuno, puoi pubblicare il mio daily di oggi in <#C05846AEV6D|daily>?\nOggi: grafiche Elfo 3h, call Aitho 1h\nDomani: revisione PED\nBlocchi: nessuno'),
    'Oggi: grafiche Elfo 3h, call Aitho 1h\nDomani: revisione PED\nBlocchi: nessuno');
  assert.equal(
    dsv2.extractDailyFromRequest('Registra il mio daily:\n- Aitho documento strategico 4h\n- call Elfo 1h\nDomani: PED settembre'),
    '- Aitho documento strategico 4h\n- call Elfo 1h\nDomani: PED settembre');
});

test('extractDailyFromRequest: richiesta in coda (ultima riga)', function() {
  assert.equal(
    dsv2.extractDailyFromRequest('Oggi ho fatto grafiche Elfo 3h e call Aitho 1h.\nDomani revisione PED.\nPostalo come daily per favore'),
    'Oggi ho fatto grafiche Elfo 3h e call Aitho 1h.\nDomani revisione PED.');
});

test('extractDailyFromRequest: niente falsi positivi', function() {
  // Daily puro senza richiesta: lo gestisce la strada già esistente.
  assert.equal(dsv2.extractDailyFromRequest('Oggi ho fatto grafiche Elfo 3h e call Aitho 1h. Domani revisione PED.'), null);
  // Domanda sul daily, non un daily.
  assert.equal(dsv2.extractDailyFromRequest('Hai postato il mio daily di ieri?'), null);
  // Richiesta di mandare il daily a un altro (trigger_daily_request).
  assert.equal(dsv2.extractDailyFromRequest('Manda il daily a Marco: deve compilarlo oggi'), null);
  // Corpo troppo corto o che non sembra un daily.
  assert.equal(dsv2.extractDailyFromRequest('posta il daily: ciao'), null);
  assert.equal(dsv2.extractDailyFromRequest('posta il daily: quando esce il recap?'), null);
  assert.equal(dsv2.extractDailyFromRequest(''), null);
  assert.equal(dsv2.extractDailyFromRequest(null), null);
});

test('post_daily: registra a nome di chi scrive tramite handleDailyResponse', async function() {
  var calls = [];
  var orig = dsv2.handleDailyResponse;
  dsv2.handleDailyResponse = async function(userId, text) { calls.push([userId, text]); return true; };
  try {
    var res = await standupTools.execute('post_daily', { text: '  Oggi grafiche Elfo 3h, call Aitho 1h. Domani PED.  ' }, 'U_ANTONIO', 'admin');
    assert.equal(res.success, true);
    assert.equal(res.user_id, 'U_ANTONIO');
    assert.deepEqual(calls, [['U_ANTONIO', 'Oggi grafiche Elfo 3h, call Aitho 1h. Domani PED.']]);
    assert.match(res.message, /#daily/);
  } finally { dsv2.handleDailyResponse = orig; }
});

test('post_daily: user_id altrui solo per admin; testo mancante → errore', async function() {
  var calls = [];
  var orig = dsv2.handleDailyResponse;
  dsv2.handleDailyResponse = async function(userId, text) { calls.push(userId); return true; };
  try {
    var denied = await standupTools.execute('post_daily', { text: 'Oggi grafiche Elfo 3h, call Aitho 1h.', user_id: 'U_ALTRO' }, 'U_MEMBER', 'member');
    assert.match(denied.error, /admin/);
    assert.deepEqual(calls, []);
    var ok = await standupTools.execute('post_daily', { text: 'Oggi grafiche Elfo 3h, call Aitho 1h.', user_id: 'U_ALTRO' }, 'U_ANTONIO', 'admin');
    assert.equal(ok.success, true);
    assert.deepEqual(calls, ['U_ALTRO']);
    var short = await standupTools.execute('post_daily', { text: 'ciao' }, 'U_ANTONIO', 'admin');
    assert.match(short.error, /daily/);
    var nobody = await standupTools.execute('post_daily', { text: 'Oggi grafiche Elfo 3h, call Aitho 1h.' }, 'system', 'admin');
    assert.match(nobody.error, /user_id/);
  } finally { dsv2.handleDailyResponse = orig; }
});

test('post_daily: se il salvataggio fallisce il tool lo dice, non finge', async function() {
  var orig = dsv2.handleDailyResponse;
  dsv2.handleDailyResponse = async function() { return false; };
  try {
    var res = await standupTools.execute('post_daily', { text: 'Oggi grafiche Elfo 3h, call Aitho 1h.' }, 'U_ANTONIO', 'member');
    assert.ok(res.error && !res.success);
  } finally { dsv2.handleDailyResponse = orig; }
});
