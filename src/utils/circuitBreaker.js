// ─── Circuit Breaker (lightweight) ───────────────────────────────────────────

'use strict';

function createCircuitBreaker(name, options) {
  options = options || {};
  var failureThreshold = options.failureThreshold == null ? 3 : options.failureThreshold;
  var cooldownMs = options.cooldownMs == null ? 15000 : options.cooldownMs;

  var state = 'closed';
  var failures = 0;
  var openedAt = 0;

  function canTryNow() {
    if (state !== 'open') return true;
    if ((Date.now() - openedAt) >= cooldownMs) {
      state = 'half_open';
      return true;
    }
    return false;
  }

  async function exec(fn) {
    if (!canTryNow()) {
      var err = new Error('Circuit open: ' + name);
      err.code = 'CIRCUIT_OPEN';
      throw err;
    }

    try {
      var result = await fn();
      failures = 0;
      state = 'closed';
      return result;
    } catch (e) {
      failures++;
      if (failures >= failureThreshold) {
        state = 'open';
        openedAt = Date.now();
      } else if (state === 'half_open') {
        state = 'open';
        openedAt = Date.now();
      }
      throw e;
    }
  }

  function status() {
    return { name: name, state: state, failures: failures, openedAt: openedAt };
  }

  return { exec: exec, status: status };
}

module.exports = { createCircuitBreaker: createCircuitBreaker };
