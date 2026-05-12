'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var {
  ROUTINE_TITLE_RX,
  isSkipResponse,
  alreadySaved,
  extractClientTag,
} = require('../src/utils/recapHelpers');

test('isSkipResponse tolerates markdown wrappers and whitespace', function() {
  assert.equal(isSkipResponse('SKIP'), true);
  assert.equal(isSkipResponse('**SKIP**'), true);
  assert.equal(isSkipResponse('**SKIP** Il documento non è un vero recap'), true);
  assert.equal(isSkipResponse('  *SKIP*  '), true);
  assert.equal(isSkipResponse('_SKIP_'), true);
  assert.equal(isSkipResponse('Partecipanti: ...'), false);
  assert.equal(isSkipResponse(''), true);
});

test('extractClientTag respects word boundaries and rejects stopwords', function() {
  assert.equal(extractClientTag('Container shipment'), null);
  assert.equal(extractClientTag('Call con Gambino'), 'cliente:gambino');
  assert.equal(extractClientTag('Meeting per Codex'), 'cliente:codex');
  assert.equal(extractClientTag('Call x Aitho'), 'cliente:aitho');
  assert.equal(extractClientTag('Recap con call'), null);
  assert.equal(extractClientTag('SAL OffKatania'), null);
});

test('alreadySaved matches exact tag in cache', function() {
  var cache = [
    { tags: ['tipo:meeting_recap', 'gmail_id:abc123', 'fonte:gmail'] },
    { tags: ['tipo:meeting_recap', 'cal_event_id:xyz', 'fonte:calendar'] },
  ];
  assert.equal(alreadySaved(cache, 'gmail_id:abc123'), true);
  assert.equal(alreadySaved(cache, 'gmail_id:nope'), false);
  assert.equal(alreadySaved(cache, 'cal_event_id:xyz'), true);
  assert.equal(alreadySaved([], 'gmail_id:abc'), false);
});

test('ROUTINE_TITLE_RX filters daily/standup/1:1 routines', function() {
  assert.equal(ROUTINE_TITLE_RX.test('DAILY MEETING'), true);
  assert.equal(ROUTINE_TITLE_RX.test('Weekly sync KS'), true);
  assert.equal(ROUTINE_TITLE_RX.test('1:1 con Antonio'), true);
  assert.equal(ROUTINE_TITLE_RX.test('Pranzo team'), true);
  assert.equal(ROUTINE_TITLE_RX.test('Call Gambino Vini'), false);
});
