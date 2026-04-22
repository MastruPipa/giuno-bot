#!/usr/bin/env node
// Backfill memories.thread_ts from tag patterns "thread:<ts>" applied by
// slackMemoryWatcher / realTimeListener on new rows. Historical rows written
// before Round 2 don't carry the tag and cannot be recovered — they'll stay
// NULL, which is fine (the thread-aware preflight just won't find them).
//
// Idempotent: re-running is safe. Usage: node scripts/backfill-thread-ts.js [--dry-run]

'use strict';

require('dotenv').config();

var { createClient } = require('@supabase/supabase-js');

var DRY_RUN = process.argv.includes('--dry-run');
var BATCH_SIZE = 500;

var url = process.env.SUPABASE_URL;
var key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY (or SUPABASE_KEY) in env.');
  process.exit(1);
}

var supabase = createClient(url, key, { auth: { persistSession: false } });

function extractThreadTs(tags) {
  if (!Array.isArray(tags)) return null;
  for (var i = 0; i < tags.length; i++) {
    var t = tags[i];
    if (typeof t !== 'string') continue;
    var m = t.match(/^thread:(\d+\.\d+)$/);
    if (m) return m[1];
  }
  return null;
}

async function backfillTable(table) {
  console.log('--- Backfilling', table, '---');
  var total = 0;
  var updated = 0;
  var skipped = 0;

  while (true) {
    var col = table === 'knowledge_base' ? 'source_thread_ts' : 'thread_ts';
    var res = await supabase.from(table)
      .select('id, tags')
      .is(col, null)
      .limit(BATCH_SIZE);

    if (res.error) {
      console.error(table, 'query error:', res.error.message);
      return;
    }
    var rows = res.data || [];
    if (rows.length === 0) break;

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      total++;
      var ts = extractThreadTs(row.tags);
      if (!ts) { skipped++; continue; }

      if (DRY_RUN) { updated++; continue; }

      var patch = {}; patch[col] = ts;
      var upd = await supabase.from(table).update(patch).eq('id', row.id);
      if (upd.error) { console.error(table, 'update error on', row.id, ':', upd.error.message); skipped++; }
      else updated++;
    }

    console.log(table, 'progress:', total, 'scanned,', updated, 'updated,', skipped, 'skipped');
    if (rows.length < BATCH_SIZE) break;
  }

  console.log(table, 'done.', DRY_RUN ? '(dry-run)' : '', 'scanned:', total, '| updated:', updated, '| skipped:', skipped);
}

async function main() {
  await backfillTable('memories');
  await backfillTable('knowledge_base');
}

main().catch(function(e) {
  console.error('Fatal:', e.stack || e.message);
  process.exit(1);
});
