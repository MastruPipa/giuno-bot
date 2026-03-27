// ─── Supabase shared client ─────────────────────────────────────────────────
// Single source of truth for the Supabase connection and low-level helpers.
// All db domain modules require this instead of creating their own client.

'use strict';

var fs = require('fs');
var createClient = null;
try { createClient = require('@supabase/supabase-js').createClient; } catch(e) {}

var _client = null;
var useSupabase = false;

if (createClient && process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
  _client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  useSupabase = true;
}

function getClient() { return _client; }

function readJSON(file, defaultVal) {
  try { return JSON.parse(fs.readFileSync(file)); } catch(e) { return defaultVal; }
}

function writeJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch(e) {}
}

function logErr(ctx, e) {
  process.stdout.write('[' + new Date().toISOString() + '] [ERROR] [DB/' + ctx + '] ' + (e.message || e) + '\n');
}

module.exports = { getClient: getClient, useSupabase: useSupabase, readJSON: readJSON, writeJSON: writeJSON, logErr: logErr };
