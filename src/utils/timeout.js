// ─── Timeout utility ───────────────────────────────────────────────────────────

'use strict';

function withTimeout(promise, ms, toolName) {
  var timeout = new Promise(function(_, reject) {
    setTimeout(function() {
      reject(new Error(toolName + ' timeout dopo ' + ms + 'ms'));
    }, ms);
  });
  return Promise.race([promise, timeout]);
}

module.exports = { withTimeout: withTimeout };
