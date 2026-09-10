'use strict';

// Verifica la FORMA della richiesta che askGiuno manda ad Anthropic, con il
// client stubbato: system a due blocchi (statico cacheato + dinamico), storia
// dal transcript Slack, messaggio corrente pulito, tool stabili, NO_REPLY.

process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || 'x';
process.env.SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || 'x';
process.env.SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN || 'x';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';

var test = require('node:test');
var assert = require('node:assert/strict');

var Module = require('module');
var boltPath = require.resolve('@slack/bolt');
var stubBolt = new Module(boltPath);
stubBolt.filename = boltPath;
stubBolt.loaded = true;
stubBolt.exports = { App: function StubApp() { this.client = {}; this.error = function() {}; } };
require.cache[boltPath] = stubBolt;

var svc = require('../src/services/anthropicService');
var db = require('../supabase');
var { NO_REPLY } = require('../src/utils/noReply');
var { MODELS } = require('../src/config/models');

// Niente scritture su disco/DB durante il test.
db.saveConversation = async function() {};
db.saveConversationSummary = async function() {};
db.addMemory = async function() { return { id: 'x' }; };

var captured = [];
// autoLearn / DM summary partono in background e usano lo stesso client:
// le richieste "primarie" sono quelle con i tool.
function primaryRequests() { return captured.filter(function(p) { return Array.isArray(p.tools); }); }

function installStub(replyText) {
  captured = [];
  var fake = async function(params) {
    captured.push(params);
    return {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: replyText }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    };
  };
  svc.client.messages.create = fake;
  if (!svc.client.beta) svc.client.beta = {};
  if (!svc.client.beta.messages) svc.client.beta.messages = {};
  svc.client.beta.messages.create = fake;
}

test('askGiuno: system statico cacheato + dinamico, storia dal transcript, turno corrente pulito', async function() {
  installStub('Ciao Antonio, tutto ok.');
  var transcript = [
    { role: 'user', content: '<@U1> (Antonio): che ne pensi del brief?' },
    { role: 'assistant', content: 'Mi sembra solido.' },
    { role: 'user', content: '<@U2>: io aggiungerei il budget' },
  ];
  var reply = await svc.askGiuno('U1', 'ok procediamo?', {
    channelId: 'C1', threadTs: '1.0', isDM: false, channelType: 'public',
    transcript: transcript, retrievedContext: 'MEMORIA:\n- [salvata ieri] Brief Aitho approvato',
  });
  assert.equal(reply, 'Ciao Antonio, tutto ok.');
  var req = primaryRequests()[0];
  assert.equal(req.model, MODELS.PRIMARY);
  assert.ok(Array.isArray(req.system) && req.system.length === 2);
  assert.deepEqual(req.system[0].cache_control, { type: 'ephemeral' });
  assert.match(req.system[0].text, /^Sei Giuno/);
  assert.match(req.system[1].text, /MODALITÀ CANALE/);
  assert.match(req.system[1].text, /Brief Aitho approvato/);
  assert.ok(Array.isArray(req.tools) && req.tools.length > 10);
  // storia + turno corrente, il messaggio utente NON contiene contesto iniettato
  assert.equal(req.messages.length, 4);
  assert.equal(req.messages[0].content, transcript[0].content);
  assert.equal(req.messages[3].role, 'user');
  assert.match(req.messages[3].content, /^<@U1>(?: \([^)]*\))?: ok procediamo\?$/);
  assert.equal(req.messages[3].content.indexOf('DATI RECUPERATI'), -1);
});

test('askGiuno: in DM nessun prefisso autore e istruzione DM', async function() {
  installStub('Certo.');
  await svc.askGiuno('U1', 'mi ricordi il budget?', { channelId: 'D1', isDM: true, transcript: [] });
  var req = primaryRequests()[0];
  assert.equal(req.messages[req.messages.length - 1].content, 'mi ricordi il budget?');
  assert.match(req.system[1].text, /MODALITÀ DM/);
});

test('askGiuno: NO_REPLY viene rispettato solo quando il silenzio è ammesso', async function() {
  installStub(NO_REPLY);
  var silent = await svc.askGiuno('U9', 'grazie mille a tutti', {
    channelId: 'C1', threadTs: '2.0', isDM: false, allowSilence: true,
    transcript: [{ role: 'user', content: '<@U8>: fatto' }, { role: 'assistant', content: 'ok' }],
  });
  assert.equal(silent, NO_REPLY);

  installStub(NO_REPLY);
  var forced = await svc.askGiuno('U9', 'ehi', { channelId: 'D9', isDM: true, transcript: [] });
  assert.notEqual(forced, NO_REPLY);
  assert.ok(forced.length > 0);
});

test('askGiuno: tool_use loop esegue il tool e continua', async function() {
  captured = [];
  var calls = 0;
  var fake = async function(params) {
    captured.push(params);
    if (!Array.isArray(params.tools)) return { stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: '{"skip": true}' }] };
    calls++;
    if (calls === 1) {
      return { stop_reason: 'tool_use', usage: {}, content: [
        { type: 'text', text: 'Controllo.' },
        { type: 'tool_use', id: 'tu_1', name: 'tool_inesistente_x', input: {} },
      ] };
    }
    return { stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'Fatto.' }] };
  };
  svc.client.messages.create = fake;
  svc.client.beta.messages.create = fake;
  var reply = await svc.askGiuno('U1', 'fai una cosa', { channelId: 'D1', isDM: true, transcript: [] });
  assert.equal(reply, 'Fatto.');
  var prim = primaryRequests();
  assert.equal(prim.length, 2);
  var second = prim[1].messages;
  assert.equal(second[second.length - 2].role, 'assistant');
  assert.equal(second[second.length - 1].role, 'user');
  assert.equal(second[second.length - 1].content[0].type, 'tool_result');
  assert.equal(second[second.length - 1].content[0].tool_use_id, 'tu_1');
});
