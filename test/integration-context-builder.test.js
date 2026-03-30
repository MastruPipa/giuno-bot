'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var { buildContext } = require('../src/orchestrator/contextBuilder');

test('integration: trivial message skips heavy context and returns base fields', async function() {
  var ctx = await buildContext({
    userId: 'U_TEST',
    message: 'ok',
    intent: 'GENERAL',
    options: { channelType: 'dm' },
  });

  assert.equal(ctx.userId, 'U_TEST');
  assert.equal(Array.isArray(ctx.relevantMemories), true);
  assert.equal(Array.isArray(ctx.kbResults), true);
  assert.equal(Array.isArray(ctx.relevantEntities), true);
  assert.equal(Array.isArray(ctx.driveContext), true);
});

test('integration: oauth hint is generated on google connect intent', async function() {
  var ctx = await buildContext({
    userId: 'U_TEST',
    message: 'voglio collegare google calendar',
    intent: 'GENERAL',
    options: { channelType: 'dm' },
  });

  assert.equal(typeof ctx.oauthLink, 'string');
  assert.equal(ctx.oauthLink.includes('Collega il tuo Google'), true);
});
