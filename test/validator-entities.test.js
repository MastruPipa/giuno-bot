'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var { extractNamedEntities, findUngroundedEntities } = require('../src/orchestrator/validator');

test('extractNamedEntities captures capitalized tokens and skips common words', function() {
  var names = extractNamedEntities('Ho parlato con Antonio di Aitho e Fantacalcio. Ieri era martedì.');
  assert.ok(names.indexOf('Antonio') !== -1);
  assert.ok(names.indexOf('Aitho') !== -1);
  assert.ok(names.indexOf('Fantacalcio') !== -1);
  // Common Italian words (giorni, mesi) must be skipped
  assert.equal(names.indexOf('Ieri'), -1);
  assert.equal(names.indexOf('Martedì'), -1);
});

test('findUngroundedEntities only flags names missing from evidence', function() {
  var reply = 'Ho visto con Antonio un problema su Aitho.';
  var evidence = ['Dimmi di Aitho'];
  var ungrounded = findUngroundedEntities(reply, evidence);
  assert.ok(ungrounded.indexOf('Antonio') !== -1, 'Antonio not in evidence → flagged');
  assert.equal(ungrounded.indexOf('Aitho'), -1, 'Aitho grounded in evidence');
});

test('findUngroundedEntities returns empty list when everything is grounded', function() {
  var reply = 'Aitho è un cliente attivo.';
  var evidence = ['Mi parli di Aitho?'];
  assert.deepEqual(findUngroundedEntities(reply, evidence), []);
});

// ─── Regressioni dai falsi positivi reali (error_patterns giugno/luglio) ─────

test('parole comuni maiuscole a inizio frase NON sono entità', function() {
  // Casi reali flaggati: "Buona", "Ecco", "Comunque", "Tranquilla", "Dimmi", "Hai"
  var reply = 'Registrato il tuo daily. Buona giornata 👊\n\nEcco il riepilogo. Comunque tutto ok.\nTranquilla, ci penso io. Dimmi pure. Hai altro?';
  assert.deepEqual(extractNamedEntities(reply), []);
});

test('inizio frase dopo punteggiatura, elenchi e grassetto Slack non conta', function() {
  var reply = '*Priorità di oggi*\n• Montaggio video! Consegna entro sera.\n_Verifica_ finale: Controllo copy.';
  assert.deepEqual(extractNamedEntities(reply), []);
});

test('intestazioni tutte maiuscole non sono entità', function() {
  var reply = 'ecco i DATI RECUPERATI dal CANALE per il daily';
  assert.deepEqual(extractNamedEntities(reply), []);
});

test('nomi propri a metà frase restano rilevati', function() {
  var reply = 'Ho allineato con Gianna il progetto Tomarchio e sentito Loredana Pappalardo.';
  var names = extractNamedEntities(reply);
  assert.ok(names.indexOf('Gianna') !== -1);
  assert.ok(names.indexOf('Tomarchio') !== -1);
  assert.ok(names.indexOf('Loredana Pappalardo') !== -1);
});

test('nomi dopo virgola contano (elenco di persone)', function() {
  var names = extractNamedEntities('Ci lavorano con Antonio, Gianna e Paolo di sicuro.');
  assert.ok(names.indexOf('Gianna') !== -1);
  assert.ok(names.indexOf('Paolo') !== -1);
});

test('i nomi letti dai tool (documenti) risultano ancorati se nell\'evidenza', function() {
  // Caso Nicolò 9/6: il bot leggeva un documento via tool ma i nomi del
  // documento non erano nell'evidenza → risposta soppressa 3 volte di fila.
  var reply = 'Nel documento ci sono gli script per Bagno Maria: servono i props di scena.';
  var toolResult = JSON.stringify({ doc: 'Script Bagno Maria — PROPS: costumi, teli...' });
  assert.deepEqual(findUngroundedEntities(reply, ['leggi il documento', toolResult]), []);
});
