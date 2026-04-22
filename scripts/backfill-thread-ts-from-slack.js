#!/usr/bin/env node
// Backfill memories.thread_ts (and knowledge_base.source_thread_ts) by
// cross-referencing Slack conversations.history + conversations.replies.
// Strategy:
//   1. For each active channel, fetch history (last 90 days by default) and
//      build a map: channel_id -> { message_ts -> thread_ts }.
//   2. Walk memories/knowledge_base rows with NULL thread/source_thread_ts and
//      a source_channel_id we know about; if any of the text fragments we
//      stored can be matched to a specific message ts we inherit its thread.
//
// Cheap heuristic (no text match): any row whose tags contain a plain Slack
// message_ts (shape "\d+\.\d+") gets that value promoted. This catches rows
// written by older tool flows before we added the thread_ts column.
//
// Usage: node scripts/backfill-thread-ts-from-slack.js [--dry-run] [--days=90]

'use strict';

require('dotenv').config();

var { createClient } = require('@supabase/supabase-js');
var { WebClient } = require('@slack/web-api');

var args = process.argv.slice(2);
var DRY_RUN = args.includes('--dry-run');
var DAYS = Number((args.find(function(a) { return a.startsWith('--days='); }) || '').split('=')[1]) || 90;

var supabaseUrl = process.env.SUPABASE_URL;
var supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
var slackToken  = process.env.SLACK_BOT_TOKEN;

if (!supabaseUrl || !supabaseKey || !slackToken) {
  console.error('Missing env: need SUPABASE_URL, SUPABASE_SERVICE_KEY (or SUPABASE_KEY), SLACK_BOT_TOKEN.');
  process.exit(1);
}

var supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
var slack = new WebClient(slackToken);

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function listRelevantChannelIds() {
  // Pull channel_ids referenced in memories/knowledge_base to avoid scanning
  // the whole workspace. A channel referenced nowhere would produce no matches anyway.
  var seen = {};
  async function collect(table, col) {
    var page = 0;
    while (true) {
      var r = await supabase.from(table)
        .select(col)
        .not(col, 'is', null)
        .range(page * 1000, page * 1000 + 999);
      if (r.error) throw r.error;
      var rows = r.data || [];
      rows.forEach(function(x) { if (x[col]) seen[x[col]] = true; });
      if (rows.length < 1000) break;
      page++;
    }
  }
  await collect('memories', 'source_channel_id');
  await collect('knowledge_base', 'source_channel_id');
  return Object.keys(seen);
}

async function buildTsMap(channelId, oldest) {
  var tsToThread = {};
  var cursor = undefined;
  var pages = 0;
  while (true) {
    var res;
    try {
      res = await slack.conversations.history({ channel: channelId, oldest: oldest, limit: 200, cursor: cursor });
    } catch(e) {
      // not_in_channel / missing_scope / etc — skip silently
      return tsToThread;
    }
    var msgs = res.messages || [];
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (!m.ts) continue;
      var thread = m.thread_ts || m.ts; // top-level message's thread_ts is itself
      tsToThread[m.ts] = thread;
      // If this message is a thread parent and has replies, pull the replies too
      if (m.thread_ts && m.thread_ts === m.ts && m.reply_count && m.reply_count > 0) {
        try {
          var rep = await slack.conversations.replies({ channel: channelId, ts: m.ts, limit: 200 });
          (rep.messages || []).forEach(function(rm) { if (rm.ts) tsToThread[rm.ts] = m.ts; });
          await sleep(50); // be polite with Slack rate limits
        } catch(e) { /* ignore */ }
      }
    }
    if (!res.has_more) break;
    cursor = res.response_metadata && res.response_metadata.next_cursor;
    if (!cursor) break;
    pages++;
    if (pages > 30) break; // safety: cap at ~6000 messages per channel
    await sleep(100);
  }
  return tsToThread;
}

// Extract any Slack-style ts (\d+\.\d+) from the rows' tags array.
function tagTs(row) {
  var tags = Array.isArray(row.tags) ? row.tags : [];
  for (var i = 0; i < tags.length; i++) {
    var t = String(tags[i] || '');
    var m = t.match(/(\d{10}\.\d{3,6})/);
    if (m) return m[1];
  }
  return null;
}

async function backfillTable(table, tsMapByChannel) {
  var col = table === 'knowledge_base' ? 'source_thread_ts' : 'thread_ts';
  var total = 0, updated = 0, noMatch = 0;
  var offset = 0;
  while (true) {
    var r = await supabase.from(table)
      .select('id, source_channel_id, tags')
      .is(col, null)
      .not('source_channel_id', 'is', null)
      .range(offset, offset + 499);
    if (r.error) { console.error(table, 'read error:', r.error.message); break; }
    var rows = r.data || [];
    if (rows.length === 0) break;

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      total++;
      var map = tsMapByChannel[row.source_channel_id];
      if (!map) { noMatch++; continue; }
      var maybeTs = tagTs(row);
      if (!maybeTs || !map[maybeTs]) { noMatch++; continue; }

      if (DRY_RUN) { updated++; continue; }
      var patch = {}; patch[col] = map[maybeTs];
      var upd = await supabase.from(table).update(patch).eq('id', row.id);
      if (upd.error) { console.error(table, 'update error on', row.id, ':', upd.error.message); noMatch++; }
      else updated++;
    }
    console.log(table, 'page offset', offset, ':', 'scanned', rows.length, 'updated so far', updated);
    if (rows.length < 500) break;
    offset += 500;
  }
  console.log(table, 'done', DRY_RUN ? '(dry-run)' : '', '- total:', total, 'updated:', updated, 'no-match:', noMatch);
}

async function main() {
  var oldest = String(Math.floor((Date.now() - DAYS * 86400000) / 1000));
  var channelIds = await listRelevantChannelIds();
  console.log('Channels to scan:', channelIds.length, '| window:', DAYS, 'days');

  var tsMapByChannel = {};
  for (var i = 0; i < channelIds.length; i++) {
    var cid = channelIds[i];
    console.log('[' + (i + 1) + '/' + channelIds.length + '] scanning', cid);
    tsMapByChannel[cid] = await buildTsMap(cid, oldest);
    console.log('  messages indexed:', Object.keys(tsMapByChannel[cid]).length);
  }

  await backfillTable('memories', tsMapByChannel);
  await backfillTable('knowledge_base', tsMapByChannel);
}

main().catch(function(e) {
  console.error('Fatal:', e.stack || e.message);
  process.exit(1);
});
