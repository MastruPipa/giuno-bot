#!/usr/bin/env node
// Backfill content_hash on memories rows that still have NULL.
// Idempotent: re-running is safe (skips already-hashed rows).
// Usage: node scripts/backfill-content-hash.js [--dry-run]

'use strict';

require('dotenv').config();

var crypto = require('crypto');
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

function contentHash(content) {
  var normalized = String(content || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]+/gu, '')
    .trim();
  if (!normalized) return null;
  return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}

async function main() {
  var total = 0;
  var updated = 0;
  var skipped = 0;

  while (true) {
    var res = await supabase.from('memories')
      .select('id, content')
      .is('content_hash', null)
      .limit(BATCH_SIZE);

    if (res.error) {
      console.error('Query error:', res.error.message);
      process.exit(1);
    }
    var rows = res.data || [];
    if (rows.length === 0) break;

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      total++;
      var h = contentHash(row.content);
      if (!h) { skipped++; continue; }

      if (DRY_RUN) {
        updated++;
        continue;
      }

      var upd = await supabase.from('memories').update({ content_hash: h }).eq('id', row.id);
      if (upd.error) {
        console.error('Update error on', row.id, ':', upd.error.message);
        skipped++;
      } else {
        updated++;
      }
    }

    console.log('Progress:', total, 'scanned,', updated, 'hashed,', skipped, 'skipped');

    // If the batch was smaller than requested we're done (no more NULL rows).
    if (rows.length < BATCH_SIZE) break;
  }

  console.log('Done.', DRY_RUN ? '(dry-run)' : '', 'Total:', total, '| Hashed:', updated, '| Skipped:', skipped);
}

main().catch(function(e) {
  console.error('Fatal:', e.stack || e.message);
  process.exit(1);
});
