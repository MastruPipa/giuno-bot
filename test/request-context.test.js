'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var ctx = require('../src/utils/requestContext');

test('createRequestContext sets defaults', function() {
  var c = ctx.createRequestContext({ userId: 'U1', channelId: 'C1' });
  assert.equal(c.userId, 'U1');
  assert.equal(c.channelId, 'C1');
  assert.equal(typeof c.requestId, 'string');
  assert.ok(c.requestId.length > 0);
});

test('withRequestContext exposes context inside callback', async function() {
  var c = ctx.createRequestContext({ userId: 'U2' });
  await ctx.withRequestContext(c, async function() {
    var read = ctx.getRequestContext();
    assert.equal(read.requestId, c.requestId);
    assert.equal(read.userId, 'U2');
  });
  assert.equal(ctx.getRequestContext(), null);
});
