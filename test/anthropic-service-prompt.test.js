'use strict';

process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || 'x';
process.env.SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || 'x';
process.env.SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN || 'x';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';

var test = require('node:test');
var assert = require('node:assert/strict');

// Il costruttore di Bolt chiama auth.test al require: qui stubbiamo l'App
// così il test resta puro (niente rete, niente rejection asincrona).
var Module = require('module');
var boltPath = require.resolve('@slack/bolt');
var stubBolt = new Module(boltPath);
stubBolt.filename = boltPath;
stubBolt.loaded = true;
stubBolt.exports = { App: function StubApp() { this.client = {}; this.error = function() {}; } };
require.cache[boltPath] = stubBolt;

var svc = require('../src/services/anthropicService');
var { MODELS, PRIMARY_EFFORT } = require('../src/config/models');
var { NO_REPLY } = require('../src/utils/noReply');

test('buildPrimaryRequest: modello primario da config, effort, tool stabili', function() {
  var req = svc.buildPrimaryRequest([{ type: 'text', text: 'sys' }], [{ role: 'user', content: 'ciao' }], { tools: [{ name: 't' }] });
  assert.equal(req.model, MODELS.PRIMARY);
  assert.equal(req.max_tokens, 4096);
  assert.deepEqual(req.output_config, { effort: PRIMARY_EFFORT });
  assert.equal(req.tools.length, 1);
  assert.equal(req.thinking, undefined, 'thinking adattivo = parametro omesso');
});

test('buildPrimaryRequest: niente effort per modelli che non lo supportano', function() {
  var req = svc.buildPrimaryRequest([], [], { model: 'claude-haiku-4-5', tools: [] });
  assert.equal(req.output_config, undefined);
});

test('sanitizeStoredTurns: toglie il blob [DATI RECUPERATI] dalle conversazioni legacy', function() {
  var turns = svc.sanitizeStoredTurns([
    { role: 'user', content: 'ciao\n\n[DATI RECUPERATI:\nMEMORIA: …]' },
    { role: 'assistant', content: 'ehi' },
    { role: 'user', content: '' },
    null,
  ]);
  assert.deepEqual(turns, [{ role: 'user', content: 'ciao' }, { role: 'assistant', content: 'ehi' }]);
});

test('buildDynamicSystem: DM vieta il silenzio, thread non taggato lo consente', function() {
  var dm = svc.buildDynamicSystem({ isDM: true, userRolePrompt: 'ruolo X' });
  assert.match(dm, /MODALITÀ DM/);
  assert.match(dm, /non è ammesso/);
  assert.match(dm, /RUOLO UTENTE:\nruolo X/);

  var silent = svc.buildDynamicSystem({ isDM: false, allowSilence: true });
  assert.match(silent, /NON sei stato taggato/);
  assert.ok(silent.indexOf(NO_REPLY) !== -1);

  var tagged = svc.buildDynamicSystem({ isDM: false, allowSilence: false });
  assert.match(tagged, /Sei stato taggato: rispondi/);

  var cc = svc.buildDynamicSystem({ isDM: false, isCC: true });
  assert.match(cc, /in copia/);
});

test('buildDynamicSystem: sezioni extra e data in Europe/Rome', function() {
  var out = svc.buildDynamicSystem({ isDM: true, sections: ['SEZIONE A', null, 'SEZIONE B'] });
  assert.match(out, /DATA E ORA:/);
  assert.match(out, /SEZIONE A[\s\S]*SEZIONE B/);
});

test('SYSTEM_PROMPT: identità, sentinel e regole chiave presenti', function() {
  assert.match(svc.SYSTEM_PROMPT, /Sei Giuno/);
  assert.ok(svc.SYSTEM_PROMPT.indexOf(NO_REPLY) !== -1);
  assert.match(svc.SYSTEM_PROMPT, /Attio/);
  assert.match(svc.SYSTEM_PROMPT, /send_email, create_event, delete_event, share_file, edit_doc/);
  assert.match(svc.SYSTEM_PROMPT, /PRIVACY/);
  assert.equal(svc.PROMPT_VERSION, 'v3_slack_native_2026_09');
});

test('extractText: concatena solo i blocchi testo', function() {
  assert.equal(svc.extractText({ content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(svc.extractText(null), '');
});
