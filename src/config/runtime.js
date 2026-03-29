// ─── Runtime configuration guard ─────────────────────────────────────────────

'use strict';

require('dotenv').config();

var logger = require('../utils/logger');

function getMissingEnv(requiredKeys) {
  return (requiredKeys || []).filter(function(key) {
    var value = process.env[key];
    return !value || !String(value).trim();
  });
}

function validateEnv(requiredKeys, scope) {
  var missing = getMissingEnv(requiredKeys);
  if (missing.length === 0) return;

  var where = scope ? '[' + scope + '] ' : '';
  var message = where + 'Variabili ambiente mancanti: ' + missing.join(', ');
  logger.error(message);
  throw new Error(message);
}

module.exports = {
  validateEnv: validateEnv,
  getMissingEnv: getMissingEnv,
};
