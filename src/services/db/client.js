// ─── Supabase shared client ─────────────────────────────────────────────────
// Single source of truth for the Supabase connection and low-level helpers.
// All db domain modules require this instead of creating their own client.

'use strict';

var fs = require('fs');
var logger = require('../../utils/logger');

var createClient = null;
try {
  createClient = require('@supabase/supabase-js').createClient;
} catch (e) {
  logger.warn('[DB-CLIENT] supabase-js non disponibile:', e.message);
}

var _client = null;
var useSupabase = false;

if (createClient && process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
  _client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  useSupabase = true;
}

function getClient() { return _client; }

function readJSON(file, defaultVal) {
  try {
    var raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    logger.warn('[DB-CLIENT] cache read fallita:', file, e.message);
    return defaultVal;
  }
}

function writeJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    logger.warn('[DB-CLIENT] cache write fallita:', file, e.message);
  }
}

function logErr(ctx, e) {
  logger.error('[DB/' + ctx + ']', e && e.message ? e.message : e);
}

module.exports = {
  getClient: getClient,
  useSupabase: useSupabase,
  readJSON: readJSON,
  writeJSON: writeJSON,
  logErr: logErr,
};
