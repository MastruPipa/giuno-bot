// ─── Retry + Timeout Policy ──────────────────────────────────────────────────

'use strict';

var { TimeoutError, isTransientError } = require('../errors');

function wait(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

async function withTimeout(promiseOrFactory, timeoutMs, timeoutLabel) {
  timeoutMs = timeoutMs || 8000;
  timeoutLabel = timeoutLabel || 'operation';

  var factory = (typeof promiseOrFactory === 'function') ? promiseOrFactory : function() { return promiseOrFactory; };

  var timeoutId;
  var timeoutPromise = new Promise(function(_, reject) {
    timeoutId = setTimeout(function() {
      reject(new TimeoutError('Timeout ' + timeoutLabel + ' dopo ' + timeoutMs + 'ms', { label: timeoutLabel, timeoutMs: timeoutMs }));
    }, timeoutMs);
  });

  try {
    return await Promise.race([factory(), timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function withRetry(operation, options) {
  options = options || {};
  var retries = options.retries == null ? 2 : options.retries;
  var baseDelayMs = options.baseDelayMs == null ? 150 : options.baseDelayMs;
  var maxDelayMs = options.maxDelayMs == null ? 1200 : options.maxDelayMs;
  var shouldRetry = options.shouldRetry || function(e) { return isTransientError(e); };

  var attempt = 0;
  while (true) {
    try {
      return await operation(attempt);
    } catch (e) {
      if (attempt >= retries || !shouldRetry(e, attempt)) throw e;
      var exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
      var jitter = Math.floor(Math.random() * 30);
      await wait(exp + jitter);
      attempt++;
    }
  }
}

module.exports = {
  withTimeout: withTimeout,
  withRetry: withRetry,
};
