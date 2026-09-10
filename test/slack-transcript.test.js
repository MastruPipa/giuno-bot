'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var t = require('../src/services/slackTranscript');

test('conversationKey: DM senza thread resta userId (compatibile)', function() {
  assert.equal(t.conversationKey({ userId: 'U1', channelId: 'D123' }), 'U1');
  assert.equal(t.conversationKey({ userId: 'U1', channelId: 'D123', isDM: true }), 'U1');
  assert.equal(t.conversationKey({ userId: 'U1' }), 'U1');
});

test('conversationKey: DM con thread → userId:threadTs', function() {
  assert.equal(t.conversationKey({ userId: 'U1', channelId: 'D123', threadTs: '1.2' }), 'U1:1.2');
});

test('conversationKey: thread in canale è condiviso tra utenti', function() {
  var a = t.conversationKey({ userId: 'U1', channelId: 'C9', threadTs: '7.1' });
  var b = t.conversationKey({ userId: 'U2', channelId: 'C9', threadTs: '7.1' });
  assert.equal(a, b);
  assert.equal(a, 'thread:C9:7.1');
  assert.equal(t.legacyConversationKey({ userId: 'U1', threadTs: '7.1' }), 'U1:7.1');
});

test('messagesToTurns: mappa bot→assistant, umani→user con autore, esclude il corrente', function() {
  var msgs = [
    { ts: '1', user: 'U1', text: 'ciao <@UBOT> che ne pensi?' },
    { ts: '2', user: 'UBOT', bot_id: 'B1', text: 'Dipende dal budget.' },
    { ts: '3', user: 'U2', text: 'budget 5k' },
    { ts: '4', user: 'U1', text: 'ok procediamo' },
  ];
  var turns = t.messagesToTurns(msgs, {
    botUserId: 'UBOT', excludeTs: '4', labelAuthors: true,
    resolveName: function(u) { return u === 'U1' ? 'Antonio' : null; },
  });
  assert.deepEqual(turns, [
    { role: 'user', content: '<@U1> (Antonio): ciao <@UBOT> che ne pensi?' },
    { role: 'assistant', content: 'Dipende dal budget.' },
    { role: 'user', content: '<@U2>: budget 5k' },
  ]);
});

test('messagesToTurns: unisce turni consecutivi e forza il primo turno user', function() {
  var msgs = [
    { ts: '1', user: 'UBOT', bot_id: 'B1', text: 'Recap di oggi' },
    { ts: '2', user: 'U1', text: 'grazie' },
    { ts: '3', user: 'U1', text: 'e domani?' },
  ];
  var turns = t.messagesToTurns(msgs, { botUserId: 'UBOT', labelAuthors: false });
  assert.equal(turns[0].role, 'user');
  assert.equal(turns[1].role, 'assistant');
  assert.equal(turns[2].role, 'user');
  assert.equal(turns[2].content, 'grazie\ne domani?');
});

test('messagesToTurns: ignora sottotipi di sistema, tiene file e altri bot', function() {
  var msgs = [
    { ts: '1', user: 'U1', subtype: 'channel_join', text: 'U1 è entrato' },
    { ts: '2', user: 'U1', files: [{ name: 'brief.pdf' }], text: '' },
    { ts: '3', bot_id: 'B9', username: 'Reminder', text: 'Ricorda la call' },
  ];
  var turns = t.messagesToTurns(msgs, { botUserId: 'UBOT', labelAuthors: true });
  assert.equal(turns.length, 1);
  assert.match(turns[0].content, /<@U1>: \[file: brief\.pdf\]/);
  assert.match(turns[0].content, /\[bot Reminder\]: Ricorda la call/);
});

test('messagesToTurns: rispetta il budget caratteri tenendo la coda', function() {
  var msgs = [];
  for (var i = 0; i < 20; i++) {
    msgs.push({ ts: String(i), user: i % 2 ? 'UBOT' : 'U1', bot_id: i % 2 ? 'B1' : undefined, text: 'messaggio numero ' + i + ' ' + 'x'.repeat(200) });
  }
  var turns = t.messagesToTurns(msgs, { botUserId: 'UBOT', maxChars: 1000 });
  assert.ok(turns.length < 20);
  assert.equal(turns[0].role, 'user');
  assert.match(turns[turns.length - 1].content, /numero 19/);
});

test('fetchTranscript: senza app o canale ritorna vuoto', async function() {
  var r = await t.fetchTranscript(null, { channelId: 'C1', threadTs: '1' });
  assert.deepEqual(r.turns, []);
  var r2 = await t.fetchTranscript({ client: {} }, {});
  assert.deepEqual(r2.turns, []);
});

test('fetchTranscript: thread via conversations.replies, DM via history', async function() {
  t.setBotUserIdForTests('UBOT');
  var calls = [];
  var app = { client: {
    auth: { test: async function() { return { user_id: 'UBOT' }; } },
    conversations: {
      replies: async function(p) { calls.push(['replies', p]); return { messages: [
        { ts: '1', user: 'U1', text: 'domanda' }, { ts: '2', user: 'UBOT', bot_id: 'B', text: 'risposta' }, { ts: '3', user: 'U2', text: 'corrente' },
      ] }; },
      history: async function(p) { calls.push(['history', p]); return { messages: [
        { ts: '3', user: 'U1', text: 'corrente' }, { ts: '2', user: 'UBOT', bot_id: 'B', text: 'ok' }, { ts: '1', user: 'U1', text: 'ciao' },
      ] }; },
    },
  } };
  var th = await t.fetchTranscript(app, { channelId: 'C1', threadTs: '1', excludeTs: '3' });
  assert.equal(th.source, 'thread');
  assert.equal(th.turns.length, 2);
  assert.match(th.turns[0].content, /^<@U1>/);
  var dm = await t.fetchTranscript(app, { channelId: 'D1', excludeTs: '3' });
  assert.equal(dm.source, 'dm');
  assert.deepEqual(dm.turns, [{ role: 'user', content: 'ciao' }, { role: 'assistant', content: 'ok' }]);
  assert.equal(calls[0][0], 'replies');
  assert.equal(calls[1][0], 'history');
});
