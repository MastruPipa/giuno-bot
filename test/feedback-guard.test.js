'use strict';

// Standalone replica of the guard logic so we can unit-test it without
// loading the whole slackHandlers module (which requires Slack/Supabase).
function looksLikeNewRequest(text) {
  var low = (text || '').toLowerCase();
  var mentionsBot = /(@?giuno|<@[a-z0-9]+>)/i.test(text);
  var hasActionVerb = /\b(leggi|cerca|cercami|trova|trovami|mandami|manda|invia|scrivi|fammi|fai|crea|aggiorna|aggiungi|cancella|rimuovi|controlla|verifica|guarda|dimmi|spiegami|aiutami|mostra|mostrami|elenca|riassumi)\b/i.test(low);
  var refsTool = /\b(mail|email|drive|canale|canali|cliente|clienti|progetto|progetti|kb|knowledge|preventiv|crm|calendar|calendario|reminder|slack|thread|recap|brief|standup)\b/i.test(low);
  var isInterrogative = /\b(chi|cosa|come|quando|dove|perché|quanto|quale|quali)\b/i.test(low) && /\?\s*$/.test(text);
  return mentionsBot || isInterrogative || hasActionVerb || (refsTool && /\?/.test(text));
}

var test = require('node:test');
var assert = require('node:assert/strict');

test('Cocco-style action requests bypass the feedback flow', function() {
  assert.equal(looksLikeNewRequest('Leggi le mie mail @Giuno novità sui preventivi packaging ?'), true);
  assert.equal(looksLikeNewRequest('Cercami nel drive il file del cliente'), true);
  assert.equal(looksLikeNewRequest('@Giuno mandami il recap di ieri'), true);
  assert.equal(looksLikeNewRequest('Chi sta lavorando su Imperfecto?'), true);
  assert.equal(looksLikeNewRequest('Quando scade il preventivo di Aitho?'), true);
});

test('Genuine feedback answers do NOT bypass the flow', function() {
  assert.equal(looksLikeNewRequest('Le riunioni inutili'), false);
  assert.equal(looksLikeNewRequest('I file vecchi sparsi nelle cartelle'), false);
  assert.equal(looksLikeNewRequest('Direi le approvazioni che non arrivano'), false);
  assert.equal(looksLikeNewRequest('boh non saprei'), false);
});

test('Edge cases: short questions without intent stay in feedback', function() {
  assert.equal(looksLikeNewRequest('davvero?'), false);
  assert.equal(looksLikeNewRequest('in che senso?'), false);
});
