// ─── KB Noise Cleanup Job ────────────────────────────────────────────────────
// Toglie dal retrieval il rumore accumulato in knowledge_base:
//   A. il dump grezzo del vecchio slackMemoryWatcher (rimosso a settembre 2026):
//      righe con added_by = 'slack-watcher', oppure source_type = 'slack' con
//      contenuto che inizia per "[#canale]" — testo di chat copiato pari pari;
//   B. le entry auto_learn mai usate: usage_count = 0, confidenza < 0.5, più
//      vecchie di N giorni (default 60). Se in due mesi nessuna domanda le ha
//      mai pescate, non aiutano nessuno e fanno solo rumore.
//
// Non cancella: marca validation_status = 'rejected' (searchKB le ignora) e
// aggiorna la cache in memoria. Reversibile con un UPDATE. Le entry official e
// drive_indexed non vengono mai toccate.
//
// Uso: dry-run di default (conta e mostra esempi); apply = true per eseguire.

'use strict';

var dbClient = require('../services/db/client');
var logger = require('../utils/logger');

var PROTECTED_TIERS = ['official', 'drive_indexed'];
var BATCH = 200;

function _notProtected(q) {
  return q.not('confidence_tier', 'in', '(' + PROTECTED_TIERS.map(function(t) { return '"' + t + '"'; }).join(',') + ')')
    .neq('validation_status', 'rejected');
}

async function _collectWatcherDump(supabase) {
  var byAuthor = await _notProtected(supabase.from('knowledge_base')
    .select('id, content, created_at')
    .eq('added_by', 'slack-watcher')).limit(2000);
  var byShape = await _notProtected(supabase.from('knowledge_base')
    .select('id, content, created_at')
    .eq('source_type', 'slack')
    .like('content', '[#%')).limit(2000);
  var seen = {};
  var rows = [];
  [].concat(byAuthor.data || [], byShape.data || []).forEach(function(r) {
    if (r && r.id && !seen[r.id]) { seen[r.id] = 1; rows.push(r); }
  });
  return rows;
}

async function _collectStaleAutoLearn(supabase, staleDays) {
  var cutoff = new Date(Date.now() - staleDays * 86400000).toISOString();
  var res = await _notProtected(supabase.from('knowledge_base')
    .select('id, content, created_at, confidence_score')
    .eq('confidence_tier', 'auto_learn')
    .eq('usage_count', 0)
    .lt('confidence_score', 0.5)
    .lt('created_at', cutoff)).limit(2000);
  return res.data || [];
}

async function _reject(supabase, ids) {
  var done = 0;
  for (var i = 0; i < ids.length; i += BATCH) {
    var slice = ids.slice(i, i + BATCH);
    var res = await supabase.from('knowledge_base')
      .update({ validation_status: 'rejected' })
      .in('id', slice);
    if (res.error) throw res.error;
    done += slice.length;
  }
  return done;
}

function _markCacheRejected(ids) {
  try {
    var db = require('../../supabase');
    var cache = db.getKBCache ? db.getKBCache() : [];
    var set = {};
    ids.forEach(function(id) { set[id] = 1; });
    cache.forEach(function(e) { if (e && set[e.id]) e.validation_status = 'rejected'; });
  } catch(_) {}
}

function _sample(rows, n) {
  return rows.slice(0, n).map(function(r) {
    return (r.created_at || '').substring(0, 10) + ' — ' + String(r.content || '').replace(/\s+/g, ' ').substring(0, 90);
  });
}

async function runNoiseCleanup(options) {
  options = options || {};
  var apply = !!options.apply;
  var staleDays = options.staleDays || 60;
  var supabase = dbClient.getClient();
  if (!supabase) return { error: 'Supabase non disponibile' };

  var watcher = await _collectWatcherDump(supabase);
  var stale = await _collectStaleAutoLearn(supabase, staleDays);
  var seen = {};
  var ids = [];
  [].concat(watcher, stale).forEach(function(r) { if (!seen[r.id]) { seen[r.id] = 1; ids.push(r.id); } });

  var result = {
    dry_run: !apply,
    stale_days: staleDays,
    watcher_dump: watcher.length,
    stale_auto_learn: stale.length,
    total_candidates: ids.length,
    samples: { watcher: _sample(watcher, 5), stale: _sample(stale, 5) },
    rejected: 0,
  };

  if (apply && ids.length > 0) {
    result.rejected = await _reject(supabase, ids);
    _markCacheRejected(ids);
  }
  logger.info('[KB-CLEANUP]', apply ? 'APPLY' : 'DRY-RUN', '| watcher:', watcher.length, '| stale:', stale.length,
    '| candidati:', ids.length, apply ? '| rigettati: ' + result.rejected : '');
  return result;
}

function formatReport(r) {
  if (!r) return 'Nessun risultato.';
  if (r.error) return 'Pulizia KB non eseguita: ' + r.error;
  var lines = [];
  lines.push((r.dry_run ? '*Pulizia KB — anteprima* (nulla modificato)' : '*Pulizia KB — eseguita*'));
  lines.push('• Dump grezzo del vecchio watcher: ' + r.watcher_dump);
  lines.push('• auto_learn mai usate, confidenza <0.5, più vecchie di ' + r.stale_days + ' giorni: ' + r.stale_auto_learn);
  lines.push('• Totale candidate: ' + r.total_candidates + (r.dry_run ? '' : ' → rigettate: ' + r.rejected));
  if (r.samples && r.samples.watcher.length) lines.push('_Esempi watcher:_\n' + r.samples.watcher.map(function(s) { return '  · ' + s; }).join('\n'));
  if (r.samples && r.samples.stale.length) lines.push('_Esempi auto_learn:_\n' + r.samples.stale.map(function(s) { return '  · ' + s; }).join('\n'));
  if (r.dry_run && r.total_candidates > 0) lines.push('Per applicare: `/giuno admin kb-cleanup apply`');
  return lines.join('\n');
}

module.exports = { runNoiseCleanup: runNoiseCleanup, formatReport: formatReport };
