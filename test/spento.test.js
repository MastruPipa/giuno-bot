'use strict';
var test = require('node:test');
var assert = require('node:assert/strict');
var http = require('node:http');
var { spawn } = require('node:child_process');
var path = require('node:path');
var { isSpento, avviaSpento } = require('../src/spento');

test('isSpento: solo con la variabile valorizzata', function() {
  assert.equal(isSpento({}), false);
  assert.equal(isSpento({ SERVIZIO_SPENTO: '' }), false);
  assert.equal(isSpento({ SERVIZIO_SPENTO: '  ' }), false);
  assert.equal(isSpento({ SERVIZIO_SPENTO: 'duplicato' }), true);
});

test('avviaSpento: risponde 200 solo a /healthz, 503 altrove', async function() {
  var logs = [];
  var server = avviaSpento({ SERVIZIO_SPENTO: 'test', PORT: 0 }, { warn: function(m) { logs.push(m); } });
  await new Promise(function(r) { server.once('listening', r); });
  var port = server.address().port;
  function get(p) { return new Promise(function(resolve) { http.get('http://127.0.0.1:' + port + p, function(res) { var b = ''; res.on('data', function(c) { b += c; }); res.on('end', function() { resolve({ status: res.statusCode, body: b }); }); }); }); }
  var ok = await get('/healthz'); assert.equal(ok.status, 200); assert.match(ok.body, /"status":"spento"/);
  assert.equal((await get('/giunos')).status, 503);
  assert.match(logs.join(' '), /SERVIZIO_SPENTO=test/);
  server.close();
});

test('index.js con SERVIZIO_SPENTO non carica il bot', async function() {
  var out = '';
  var child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], { env: Object.assign({}, process.env, { SERVIZIO_SPENTO: 'duplicato', PORT: '0', SLACK_BOT_TOKEN: '', SLACK_APP_TOKEN: '', SLACK_SIGNING_SECRET: '' }) });
  child.stdout.on('data', function(c) { out += c; }); child.stderr.on('data', function(c) { out += c; });
  await new Promise(function(resolve) { var t = setInterval(function() { if (/\[SPENTO\]/.test(out)) { clearInterval(t); resolve(); } }, 50); setTimeout(function() { clearInterval(t); resolve(); }, 8000); });
  child.kill();
  assert.match(out, /\[SPENTO\] Servizio spento/);
  assert.ok(!/Bolt|Slack|Cron/.test(out), 'nessuna traccia di avvio del bot: ' + out.slice(0, 300));
});
