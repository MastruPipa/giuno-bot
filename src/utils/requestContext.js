// ─── Request Context (AsyncLocalStorage) ─────────────────────────────────────

'use strict';

var AsyncLocalStorage = require('async_hooks').AsyncLocalStorage;

var storage = new AsyncLocalStorage();

function randomId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function createRequestContext(params) {
  params = params || {};
  return {
    requestId: params.requestId || randomId(),
    userId: params.userId || null,
    channelId: params.channelId || null,
    threadTs: params.threadTs || null,
    source: params.source || null,
    startedAt: new Date().toISOString(),
  };
}

function withRequestContext(ctx, fn) {
  return storage.run(ctx, fn);
}

function getRequestContext() {
  return storage.getStore() || null;
}

module.exports = {
  createRequestContext: createRequestContext,
  withRequestContext: withRequestContext,
  getRequestContext: getRequestContext,
};
