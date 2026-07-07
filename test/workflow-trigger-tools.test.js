'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var workflowTools = require('../src/tools/workflowTools');

test('trigger_daily_request: negato ai non-admin', async function() {
  var res = await workflowTools.execute('trigger_daily_request', {}, 'U_MEMBER', 'member');
  assert.ok(res.error && /admin/i.test(res.error));
});

test('trigger_checkin_request: negato ai non-admin', async function() {
  var res = await workflowTools.execute('trigger_checkin_request', {}, 'U_MEMBER', 'member');
  assert.ok(res.error && /admin/i.test(res.error));
});

test('trigger senza destinatario risolvibile (chiamante system, niente user_id) → errore chiaro', async function() {
  var res = await workflowTools.execute('trigger_daily_request', {}, 'system', 'admin');
  assert.ok(res.error && /destinatario|user_id/i.test(res.error));
});

test('le definition dei trigger esistono e dichiarano quando usarle', function() {
  var names = workflowTools.definitions.map(function(d) { return d.name; });
  assert.ok(names.indexOf('trigger_daily_request') !== -1);
  assert.ok(names.indexOf('trigger_checkin_request') !== -1);
  var daily = workflowTools.definitions.find(function(d) { return d.name === 'trigger_daily_request'; });
  assert.ok(/test/i.test(daily.description), 'la description deve menzionare il caso d\'uso di test');
  assert.ok(/admin/i.test(daily.description));
});
