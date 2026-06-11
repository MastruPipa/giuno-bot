'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var { extractSearchTerms } = require('../src/utils/precallTerms');

test('titolo con deal: "Proposta per Kultura <> Katania Studio" → resta solo il cliente', function() {
  assert.deepEqual(extractSearchTerms('Proposta per Kultura <> Katania Studio'), ['Kultura']);
});

test('titolo con persona: "Katania Studio - Meli Duci" → restano nome e cognome', function() {
  assert.deepEqual(extractSearchTerms('Katania Studio - Meli Duci'), ['Meli', 'Duci']);
});

test('la x e il trattino NON vengono cancellati dentro le parole (regression)', function() {
  // La vecchia regex senza \b trasformava "Maxi" in "Mai" e spezzava i nomi col trattino
  assert.deepEqual(extractSearchTerms('Review Maxi Sport'), ['Maxi', 'Sport']);
  assert.deepEqual(extractSearchTerms('Call Coca-Cola'), ['Coca', 'Cola']);
});

test('filler di meeting e parole generiche vengono rimossi', function() {
  assert.deepEqual(extractSearchTerms('Kick-off meeting con Agromonte — preventivo'), ['Agromonte']);
  assert.deepEqual(extractSearchTerms('Weekly sync interno'), ['Weekly', 'interno']);
});
