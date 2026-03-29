// ─── Memory Consolidation Job ────────────────────────────────────────────────
// Groups episodic memories by entity/tag, extracts recurring patterns,
// creates semantic/procedural memories. Runs weekly Sunday 2:00 AM.
'use strict';

var dbClient = require('../services/db/client');
var logger = require('../utils/logger');
var { safeParse } = require('../utils/safeCall');

async function runConsolidation() {
  var supabase = dbClient.getClient();
  if (!supabase) { logger.error('[CONSOLIDATE] No Supabase'); return; }
  logger.info('[CONSOLIDATE] Starting memory consolidation...');

  var stats = { clusters: 0, consolidated: 0, superseded: 0, errors: 0 };

  try {
    // Get all active episodic memories grouped by entity
    var { data: memories } = await supabase.from('memories')
      .select('id, content, memory_type, entity_refs, tags, created_at, confidence_score')
      .eq('memory_type', 'episodic')
      .is('superseded_by', null)
      .order('created_at', { ascending: false })
      .limit(200);

    if (!memories || memories.length < 5) {
      logger.info('[CONSOLIDATE] Too few episodic memories to consolidate');
      return stats;
    }

    // Group by entity
    var entityGroups = {};
    memories.forEach(function(m) {
      var refs = m.entity_refs || [];
      if (refs.length === 0) refs = ['_untagged'];
      refs.forEach(function(entity) {
        if (!entityGroups[entity]) entityGroups[entity] = [];
        entityGroups[entity].push(m);
      });
    });

    var Anthropic = require('@anthropic-ai/sdk');
    var client = new Anthropic();

    var entities = Object.keys(entityGroups);
    for (var ei = 0; ei < entities.length; ei++) {
      var entity = entities[ei];
      var group = entityGroups[entity];
      if (group.length < 3 || entity === '_untagged') continue;
      stats.clusters++;

      var memTexts = group.slice(0, 15).map(function(m) {
        return '- [' + (m.created_at || '').substring(0, 10) + '] ' + m.content;
      }).join('\n');

      try {
        var res = await client.messages.create({
          model: 'claude-haiku-4-5-20251001', max_tokens: 500,
          messages: [{ role: 'user', content:
            'Entità: ' + entity + '\nMemorie episodiche (' + group.length + '):\n' + memTexts + '\n\n' +
            'Analizza e consolida. JSON:\n' +
            '{"consolidations":[{"type":"semantic|procedural","content":"fatto consolidato","supersedes":["id1","id2"]}],"skip":false}\n' +
            'Regole: estrai solo FATTI STABILI ricorrenti. Se tutto è unico/episodico, {"skip":true}'
          }],
        });

        var match = res.content[0].text.trim().replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
        if (!match) continue;
        var result = safeParse('MEM-CONSOLIDATION', match[0], null);
        if (result.skip) continue;

        for (var ci = 0; ci < (result.consolidations || []).length; ci++) {
          var cons = result.consolidations[ci];
          if (!cons.content || cons.content.length < 10) continue;

          // Create consolidated memory
          var newId = 'cons_' + Date.now().toString(36) + '_' + ci;
          await supabase.from('memories').insert({
            id: newId, content: cons.content, memory_type: cons.type || 'semantic',
            confidence_score: 0.85, entity_refs: [entity],
            tags: ['consolidated'], created_at: new Date().toISOString(),
          });
          stats.consolidated++;

          // Supersede old memories
          if (cons.supersedes && cons.supersedes.length > 0) {
            await supabase.from('memories').update({ superseded_by: newId })
              .in('id', cons.supersedes);
            stats.superseded += cons.supersedes.length;
          }
        }
      } catch(e) {
        stats.errors++;
        logger.warn('[CONSOLIDATE] Error on entity', entity, ':', e.message);
      }

      await new Promise(function(r) { setTimeout(r, 200); });
    }
  } catch(e) {
    logger.error('[CONSOLIDATE] Fatal error:', e.message);
  }

  logger.info('[CONSOLIDATE] Done. Clusters:', stats.clusters, '| New:', stats.consolidated, '| Superseded:', stats.superseded);
  return stats;
}

module.exports = { runConsolidation: runConsolidation };
