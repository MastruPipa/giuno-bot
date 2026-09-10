'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');

var dbClient = require('../src/services/db/client');
dbClient.useSupabase = false;
dbClient.writeJSON = function() {};

var mcp = require('../src/services/mcpConnections');
var ts = require('../src/services/mcpToolsets');

test('isGenerationRequest: riconosce richieste di immagini/video e i seguiti', function() {
  assert.equal(ts.isGenerationRequest('Giuno generami un\'immagine di un tramonto sull\'Etna'), true);
  assert.equal(ts.isGenerationRequest('fammi un video di 5 secondi del logo che ruota'), true);
  assert.equal(ts.isGenerationRequest('crea 3 foto per il post di Tomarchio'), true);
  assert.equal(ts.isGenerationRequest('quanti crediti abbiamo su higgsfield?'), true);
  assert.equal(ts.isGenerationRequest('che ne pensi del brief?'), false);
  assert.equal(ts.isGenerationRequest('crea un evento domani alle 10'), false);
  assert.equal(ts.isGenerationRequest('più scuro', [{ role: 'user', content: 'genera un\'immagine' }, { role: 'assistant', content: 'Ecco l\'immagine generata: https://x/y.png' }]), true);
  assert.equal(ts.isGenerationRequest('più scuro', [{ role: 'assistant', content: 'Ok, ci sentiamo domani.' }]), false);
});

test('userCanGenerate: lista esplicita oppure tutti tranne restricted', function() {
  assert.equal(ts.userCanGenerate('U1', 'member', ''), true);
  assert.equal(ts.userCanGenerate('U1', 'restricted', ''), false);
  assert.equal(ts.userCanGenerate('U1', 'admin', 'U2, U3'), false);
  assert.equal(ts.userCanGenerate('U3', 'restricted', 'U2, U3'), true);
});

test('buildAttachment: null se non è generazione, sezione se non collegato, server+toolset se collegato', async function() {
  assert.equal(await ts.buildAttachment({ message: 'ciao', userId: 'U1', userRole: 'member' }), null);

  mcp._resetForTests({});
  var off = await ts.buildAttachment({ message: 'generami un video', userId: 'U1', userRole: 'member', isAdmin: false });
  assert.ok(off && !off.mcp_servers);
  assert.match(off.section, /NON COLLEGATO/);

  mcp._resetForTests({ connections: { higgsfield: { name: 'higgsfield', client_id: 'c', access_token: 'TOK', refresh_token: 'R' } } });
  delete process.env.HIGGSFIELD_ALLOWED_USERS;
  var on = await ts.buildAttachment({ message: 'generami un video', userId: 'U1', userRole: 'member' });
  assert.equal(on.mcp_servers.length, 1);
  assert.equal(on.mcp_servers[0].type, 'url');
  assert.equal(on.mcp_servers[0].name, 'higgsfield');
  assert.equal(on.mcp_servers[0].authorization_token, 'TOK');
  assert.ok(on.mcp_servers[0].tool_configuration.allowed_tools.indexOf('generate_video') !== -1);
  assert.ok(on.mcp_servers[0].tool_configuration.allowed_tools.indexOf('create_website') === -1);
  assert.deepEqual(on.tools, [{ type: 'mcp_toolset', mcp_server_name: 'higgsfield' }]);
  assert.deepEqual(on.betas, ['mcp-client-2025-11-20']);
  assert.match(on.section, /jobs_wait/);

  var denied = await ts.buildAttachment({ message: 'generami un video', userId: 'U1', userRole: 'restricted' });
  assert.ok(!denied.mcp_servers);
  assert.match(denied.section, /NON è abilitata/);
});
