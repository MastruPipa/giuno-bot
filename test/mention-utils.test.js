'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var mu = require('../src/utils/mentionUtils');
var { isNoReply, NO_REPLY } = require('../src/utils/noReply');

test('stripBotMention: toglie solo il bot, tiene le persone', function() {
  assert.equal(mu.stripBotMention('<@UBOT> chiedi a <@U1> il brief', 'UBOT'), 'chiedi a <@U1> il brief');
  assert.equal(mu.stripBotMention('<@UBOT> chiedi a <@U1> il brief', null), 'chiedi a il brief');
  assert.equal(mu.stripBotMention('<@UBOT|giuno> ciao', 'UBOT'), 'ciao');
});

test('mentionsUser', function() {
  assert.equal(mu.mentionsUser('ciao <@U1>', 'U1'), true);
  assert.equal(mu.mentionsUser('ciao <@U1>', 'U2'), false);
  assert.equal(mu.mentionsUser('ciao', null), false);
});

test('detectCCMention: bot in coda a un messaggio per altri → CC', function() {
  assert.equal(mu.detectCCMention('<@U1> ricordati di mandare il preventivo <@UBOT>', 'UBOT'), true);
  assert.equal(mu.detectCCMention('<@U1> ricordati di mandare il preventivo <@UBOT> fyi', 'UBOT'), true);
});

test('detectCCMention: bot destinatario → NON CC', function() {
  assert.equal(mu.detectCCMention('<@UBOT> chiedi a <@U1> il brief', 'UBOT'), false);
  assert.equal(mu.detectCCMention('<@U1> <@UBOT> puoi riassumere il thread di ieri per favore?', 'UBOT'), false);
  assert.equal(mu.detectCCMention('<@UBOT> ciao', 'UBOT'), false);
  assert.equal(mu.detectCCMention('<@U1> ricordati <@UBOT>', 'UOTHER'), false);
});

test('detectCCMention: senza id bot usa l\'euristica storica', function() {
  assert.equal(mu.detectCCMention('<@U1> ricordati di X <@UBOT>', null), true);
  assert.equal(mu.detectCCMention('<@U1> ricordati di X <@UBOT> e dimmi cosa ne pensi', null), false);
});

test('isNoReply riconosce il sentinel con o senza parentesi', function() {
  assert.equal(isNoReply(NO_REPLY), true);
  assert.equal(isNoReply(' NO_REPLY '), true);
  assert.equal(isNoReply('[no_reply]'), true);
  assert.equal(isNoReply('Ok, NO_REPLY per ora'), false);
  assert.equal(isNoReply(''), false);
});
