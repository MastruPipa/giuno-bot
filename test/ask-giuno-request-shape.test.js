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

test('askGiuno: richiesta di generazione con Higgsfield collegato → mcp_servers + mcp_toolset + beta, tool MCP contati', async function() {
  var mcp = require('../src/services/mcpConnections');
  var dbClient = require('../src/services/db/client');
  dbClient.useSupabase = false;
  dbClient.writeJSON = function() {};
  mcp._resetForTests({ connections: { higgsfield: { name: 'higgsfield', client_id: 'c', access_token: 'TOK', refresh_token: 'R' } } });
  delete process.env.HIGGSFIELD_ALLOWED_USERS;

  captured = [];
  var fake = async function(params) {
    captured.push(params);
    return {
      stop_reason: 'end_turn',
      content: [
        { type: 'mcp_tool_use', id: 'm1', name: 'generate_image', server_name: 'higgsfield', input: { prompt: 'tramonto' } },
        { type: 'mcp_tool_result', tool_use_id: 'm1', is_error: false, content: [{ type: 'text', text: 'https://cdn.higgsfield.ai/out/abc.png' }] },
        { type: 'text', text: 'Ecco l\'immagine: https://cdn.higgsfield.ai/out/abc.png' },
      ],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    };
  };
  var betaCalls = 0;
  svc.client.messages.create = fake;
  svc.client.beta = { messages: { create: async function(p) { betaCalls++; return fake(p); } } };

  var reply = await svc.askGiuno('U1', 'generami un\'immagine di un tramonto sull\'Etna', { isDM: true, channelId: 'D1' });
  assert.match(reply, /abc\.png/);
  var req = primaryRequests()[0];
  assert.ok(req, 'richiesta primaria catturata');
  assert.equal(req.mcp_servers.length, 1);
  assert.equal(req.mcp_servers[0].authorization_token, 'TOK');
  assert.ok(req.tools.some(function(t) { return t.type === 'mcp_toolset' && t.mcp_server_name === 'higgsfield'; }));
  assert.equal(req.tools[req.tools.length - 1].type, 'mcp_toolset', 'il toolset MCP va in coda ai tool stabili');
  assert.ok(req.betas.indexOf('mcp-client-2025-11-20') !== -1);
  assert.ok(betaCalls >= 1, 'passa dall\'endpoint beta');
  assert.match(req.system[1].text, /GENERAZIONE IMMAGINI\/VIDEO/);

  // Senza generazione: nessun server MCP allegato (prefisso cacheato stabile).
  installStub('Ciao.');
  await svc.askGiuno('U1', 'che ne pensi del brief?', { isDM: true, channelId: 'D1' });
  assert.equal(primaryRequests()[0].mcp_servers, undefined);
  mcp._resetForTests({});
});

test('askGiuno: risposta troncata (max_tokens) con tool_use completi → esegue i tool e continua', async function() {
  var registry = require('../src/tools/registry');
  var origExec = registry.executeToolCall;
  var executed = [];
  registry.executeToolCall = async function(name, input) { executed.push({ name: name, input: input }); return { success: true, sent: [{ target: 'U2' }] }; };

  captured = [];
  var calls = 0;
  var fake = async function(params) {
    captured.push(params);
    calls++;
    if (calls === 1) {
      return {
        stop_reason: 'max_tokens',
        content: [
          { type: 'text', text: '' },
          { type: 'tool_use', id: 't1', name: 'send_dm', input: { target_user_ids: ['U2', 'U3'], message: 'Ciao a tutti' } },
        ],
        usage: { input_tokens: 10, output_tokens: 4096 },
      };
    }
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Mandato a 2 persone.' }], usage: { input_tokens: 10, output_tokens: 5 } };
  };
  svc.client.messages.create = fake;
  svc.client.beta = { messages: { create: fake } };

  try {
    var reply = await svc.askGiuno('U1', 'manda', { isDM: true, channelId: 'D1' });
    assert.equal(reply, 'Mandato a 2 persone.');
    assert.equal(executed.length, 1, 'il tool completo viene eseguito nonostante il troncamento');
    var second = primaryRequests()[1];
    var lastUser = second.messages[second.messages.length - 1];
    assert.equal(lastUser.role, 'user');
    assert.equal(lastUser.content[0].type, 'tool_result');
    assert.match(lastUser.content[lastUser.content.length - 1].text, /troncata/);
    var assistantTurn = second.messages[second.messages.length - 2];
    assert.ok(assistantTurn.content.every(function(b) { return b.type !== 'text' || b.text.trim(); }), 'nessun blocco di testo vuoto nel turno assistant');
  } finally { registry.executeToolCall = origExec; }
});

test('askGiuno: risposta senza testo → un retry, poi fallback leggibile (mai silenzio in DM)', async function() {
  captured = [];
  var fake = async function(params) {
    captured.push(params);
    return { stop_reason: 'end_turn', content: [], usage: { input_tokens: 10, output_tokens: 0 } };
  };
  svc.client.messages.create = fake;
  svc.client.beta = { messages: { create: fake } };
  var reply = await svc.askGiuno('U1', 'hai mandato il messaggio?', { isDM: true, channelId: 'D1' });
  assert.equal(reply, svc.EMPTY_REPLY_FALLBACK);
  assert.equal(primaryRequests().length, 2, 'esattamente un retry');
  var retry = primaryRequests()[1];
  assert.match(retry.messages[retry.messages.length - 1].content, /senza testo/);
});

test('askGiuno: manda il nucleo di tool (non tutti) e more_tools carica un pacchetto nel round successivo', async function() {
  var registry = require('../src/tools/registry');
  var all = registry.getAllTools().length;
  var origExec = registry.executeToolCall;
  registry.executeToolCall = async function(name) { return { success: true, name: name }; };
  captured = [];
  var calls = 0;
  var fake = async function(params) {
    captured.push(params);
    calls++;
    if (calls === 1) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'more_tools', input: { pack: 'drive_write' } }], usage: {} };
    if (calls === 2) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't2', name: 'create_doc', input: { title: 'x' } }], usage: {} };
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Documento creato.' }], usage: {} };
  };
  svc.client.messages.create = fake;
  svc.client.beta = { messages: { create: fake } };
  try {
    var reply = await svc.askGiuno('U1', 'che ne pensi del brief?', { isDM: true, channelId: 'D1' });
    assert.equal(reply, 'Documento creato.');
    var reqs = primaryRequests();
    assert.ok(reqs[0].tools.length < all * 0.5, 'nucleo: ' + reqs[0].tools.length + ' su ' + all);
    assert.ok(!reqs[0].tools.some(function(t) { return t.name === 'create_doc'; }));
    assert.ok(reqs.slice(1).some(function(r) { return r.tools.some(function(t) { return t.name === 'create_doc'; }); }), 'dopo more_tools il pacchetto è disponibile');
    // messages è lo stesso array (mutato) in tutte le richieste: cerco il
    // tool_result di more_tools ovunque nella storia dell'ultima richiesta.
    var last = reqs[reqs.length - 1];
    assert.ok(last.messages.some(function(m) {
      return Array.isArray(m.content) && m.content.some(function(b) { return b.type === 'tool_result' && /Strumenti caricati/.test(String(b.content)); });
    }), 'il risultato di more_tools torna al modello');
  } finally { registry.executeToolCall = origExec; }
});
