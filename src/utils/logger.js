// ─── Logger ────────────────────────────────────────────────────────────────────

'use strict';

function log(level) {
  var args = Array.prototype.slice.call(arguments, 1);
  process.stdout.write('[' + new Date().toISOString() + '] [' + level + '] ' + args.join(' ') + '\n');
}

var logger = {
  info:  function() { var a = Array.prototype.slice.call(arguments); log.apply(null, ['INFO '].concat(a)); },
  warn:  function() { var a = Array.prototype.slice.call(arguments); log.apply(null, ['WARN '].concat(a)); },
  error: function() { var a = Array.prototype.slice.call(arguments); log.apply(null, ['ERROR'].concat(a)); },
};

module.exports = logger;
