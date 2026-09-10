// Accept a Promise or a lazy operation; always release the timer.
'use strict';
function withTimeout(operation, ms, toolName) {
  var timer;
  var work = Promise.resolve().then(function() {
    return typeof operation === 'function' ? operation() : operation;
  });
  var timeout = new Promise(function(_, reject) {
    timer = setTimeout(function() {
      reject(new Error(toolName + ' timeout dopo ' + ms + 'ms'));
    }, ms);
  });
  return Promise.race([work, timeout]).finally(function() { clearTimeout(timer); });
}
module.exports = { withTimeout: withTimeout };
