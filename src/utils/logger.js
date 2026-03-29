// ─── Logger ────────────────────────────────────────────────────────────────────

'use strict';

var LEVEL_PRIORITY = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function getActiveLevel() {
  var raw = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return LEVEL_PRIORITY[raw] ? raw : 'info';
}

function shouldLog(level) {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[getActiveLevel()];
}

function formatArg(arg) {
  if (arg instanceof Error) {
    return arg.stack || arg.message || String(arg);
  }
  if (arg === undefined) return 'undefined';
  if (arg === null) return 'null';
  if (typeof arg === 'object') {
    try { return JSON.stringify(arg); } catch (e) { return '[Unserializable Object]'; }
  }
  return String(arg);
}

function log(level) {
  if (!shouldLog(level)) return;
  var args = Array.prototype.slice.call(arguments, 1).map(formatArg);
  process.stdout.write('[' + new Date().toISOString() + '] [' + level.toUpperCase() + '] ' + args.join(' ') + '\n');
}

var logger = {
  debug: function() { var a = Array.prototype.slice.call(arguments); log.apply(null, ['debug'].concat(a)); },
  info:  function() { var a = Array.prototype.slice.call(arguments); log.apply(null, ['info'].concat(a)); },
  warn:  function() { var a = Array.prototype.slice.call(arguments); log.apply(null, ['warn'].concat(a)); },
  error: function() { var a = Array.prototype.slice.call(arguments); log.apply(null, ['error'].concat(a)); },
};

module.exports = logger;
