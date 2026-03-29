// ─── Entity Backfill Job ─────────────────────────────────────────────────────
// Finds memories and KB entries without entity_refs, uses AI to extract entities.
// Runs weekly Sunday 4:00 AM.
'use strict';

var dbClient = require('../services/db/client');
var logger = require('../utils/logger');

async function runEntityBackfill() {
  var supabase = dbClient.getClient();
  if (!supabase) return;
  logger.info('[ENTITY-BACKFILL] Starting...');

  var stats = { processed: 0, linked: 0, newEntities: 0 };

  try {
    // Get known entities for matching
    var { data: knownEntities } = await supabase.from('kb_entities')
      .select('canonical_name, aliases').limit(200);
    var entityNames = (knownEntities || []).map(function(e) { return e.canonical_name; });
    var allNames = [];
    (knownEntities || []).forEach(function(e) {
      allNames.push(e.canonical_name.toLowerCase());
      (e.aliases || []).forEach(function(a) { allNames.push((a || '').toLowerCase()); });
    });

    // Find orphan memories (no entity_refs)
    var { data: orphans } = await supabase.from('memories')
      .select('id, content')
      .is('superseded_by', null)
      .or('entity_refs.is.null,entity_refs.eq.{}')
      .limit(50);

    if (orphans && orphans.length > 0) {
      for (var i = 0; i < orphans.length; i++) {
        var mem = orphans[i];
        var contentLow = (mem.content || '').toLowerCase();
        var found = [];

        // Direct matching against known entities
        for (var ei = 0; ei < entityNames.length; ei++) {
          if (entityNames[ei].length > 3 && contentLow.includes(entityNames[ei].toLowerCase())) {
            found.push(entityNames[ei]);
          }
        }

        if (found.length > 0) {
          await supabase.from('memories').update({ entity_refs: found }).eq('id', mem.id);
          // Add graph edges
          for (var fi = 0; fi < found.length; fi++) {
            await supabase.from('memory_graph').insert({
              from_type: 'memory', from_id: mem.id,
              relationship: 'mentions', to_type: 'entity', to_id: found[fi],
              weight: 0.7, created_by: 'backfill',
            }).catch(function() {}); // ignore dupes
          }
          stats.linked++;
        }
        stats.processed++;
      }
    }

    // Same for KB entries
    var { data: kbOrphans } = await supabase.from('knowledge_base')
      .select('id, content')
      .or('tags.is.null,tags.eq.{}')
      .limit(50);

    if (kbOrphans && kbOrphans.length > 0) {
      for (var ki = 0; ki < kbOrphans.length; ki++) {
        var kb = kbOrphans[ki];
        var kbLow = (kb.content || '').toLowerCase();
        var kbFound = [];
        for (var eki = 0; eki < entityNames.length; eki++) {
          if (entityNames[eki].length > 3 && kbLow.includes(entityNames[eki].toLowerCase())) {
            kbFound.push(entityNames[eki]);
          }
        }
        if (kbFound.length > 0) {
          await supabase.from('memory_graph').insert(kbFound.map(function(e) {
            return { from_type: 'knowledge_base', from_id: kb.id, relationship: 'mentions', to_type: 'entity', to_id: e, weight: 0.6, created_by: 'backfill' };
          })).catch(function() {});
          stats.linked++;
        }
        stats.processed++;
      }
    }
  } catch(e) {
    logger.error('[ENTITY-BACKFILL] Error:', e.message);
  }

  logger.info('[ENTITY-BACKFILL] Done. Processed:', stats.processed, '| Linked:', stats.linked);
  return stats;
}

module.exports = { runEntityBackfill: runEntityBackfill };
