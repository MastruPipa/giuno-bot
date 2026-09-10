'use strict';

process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || 'x';
process.env.SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || 'x';
process.env.SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN || 'x';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';

var test = require('node:test');
var assert = require('node:assert/strict');

var Module = require('module');
var boltPath = require.resolve('@slack/bolt');
var stubBolt = new Module(boltPath);
stubBolt.filename = boltPath; stubBolt.loaded = true;
stubBolt.exports = { App: function StubApp() { this.client = {}; this.error = function() {}; } };
require.cache[boltPath] = stubBolt;

var packs = require('../src/tools/toolPacks');
var registry = require('../src/tools/registry');
var all = registry.getAllTools();
var names = new Set(all.map(function(t) { return t.name; }));

test('ogni tool del nucleo e dei pacchetti esiste; ogni tool del registro è nel nucleo o in un pacchetto', function() {
  var unknown = packs.CORE.filter(function(n) { return !names.has(n); });
  packs.PACKS.forEach(function(p) { p.tools.forEach(function(n) { if (!names.has(n)) unknown.push(p.name + ':' + n); }); });
  assert.deepEqual(unknown, [], 'nomi inesistenti');
  var covered = new Set(packs.CORE);
  packs.PACKS.forEach(function(p) { p.tools.forEach(function(n) { covered.add(n); }); });
  var uncovered = all.map(function(t) { return t.name; }).filter(function(n) { return !covered.has(n); });
  assert.deepEqual(uncovered, [], 'tool non raggiungibili');
  var dup = packs.CORE.filter(function(n, i, a) { return a.indexOf(n) !== i; });
  assert.deepEqual(dup, []);
});

test('selectForTurn: nucleo cacheato + pacchetti dal testo + more_tools; peso ben sotto il totale', function() {
  var base = packs.selectForTurn(all, 'che ne pensi del brief?', []);
  assert.equal(base.packs.length, 0);
  assert.equal(base.tools[base.core - 1].cache_control.type, 'ephemeral');
  assert.equal(base.tools[base.tools.length - 1].name, 'more_tools');
  var baseTok = JSON.stringify(base.tools).length / 3.6;
  var allTok = JSON.stringify(all).length / 3.6;
  assert.ok(baseTok < allTok * 0.5, 'nucleo ' + Math.round(baseTok) + ' vs tutti ' + Math.round(allTok));

  var mail = packs.selectForTurn(all, 'rispondi alla mail di Robin dicendo che ci siamo', []);
  assert.ok(mail.packs.indexOf('email_write') !== -1);
  assert.ok(mail.tools.some(function(t) { return t.name === 'reply_email'; }));
  assert.ok(!mail.tools.some(function(t) { return t.name === 'create_event'; }));

  var fromHistory = packs.selectForTurn(all, 'sì vai', [{ role: 'user', content: 'crea un evento domani alle 10 con Gianna' }, { role: 'assistant', content: 'Confermi la creazione dell\'evento?' }]);
  assert.ok(fromHistory.packs.indexOf('calendar_write') !== -1, 'il seguito eredita il pacchetto dalle ultime battute');

  var team = packs.selectForTurn(all, 'Nicolò è andato via dal team', []);
  assert.ok(team.tools.some(function(t) { return t.name === 'team_member_left'; }));
});

test('addPack: more_tools carica il pacchetto una volta sola', function() {
  var sel = packs.selectForTurn(all, 'ciao', []);
  var added = packs.addPack(all, sel, 'drive_write');
  assert.ok(added.loaded.indexOf('create_doc') !== -1);
  assert.ok(added.selection.tools.some(function(t) { return t.name === 'create_doc'; }));
  var again = packs.addPack(all, added.selection, 'drive_write');
  assert.equal(again.note, 'già caricato');
  assert.match(packs.addPack(all, sel, 'boh').error, /sconosciuto/);
  assert.equal(added.selection.tools[added.selection.core - 1].cache_control.type, 'ephemeral', 'il breakpoint resta sul nucleo');
});

test('GIUNO_TOOL_PACKS=off ripristina tutti i tool', function() {
  process.env.GIUNO_TOOL_PACKS = 'off';
  try { assert.equal(packs.selectForTurn(all, 'ciao', []).tools.length, all.length); } finally { delete process.env.GIUNO_TOOL_PACKS; }
});
