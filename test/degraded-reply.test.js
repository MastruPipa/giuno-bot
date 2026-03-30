'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var { isDegradedReply } = require('../src/utils/degradedReply');

test('isDegradedReply detects known degraded/system-failure messages', function() {
  assert.equal(isDegradedReply('Claude è momentaneamente sovraccarico. Riprova tra qualche minuto.'), true);
  assert.equal(isDegradedReply('Ci sto mettendo troppo. Riprova con una richiesta più specifica.'), true);
  assert.equal(isDegradedReply('Errore: servizio temporaneamente non disponibile'), true);
});

test('isDegradedReply ignores normal assistant responses', function() {
  assert.equal(isDegradedReply('Ecco il briefing operativo di oggi.'), false);
  assert.equal(isDegradedReply('Perfetto, procedo con il recap.'), false);
});
