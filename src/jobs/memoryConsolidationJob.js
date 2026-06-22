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
    // Episodici da comprimere + fatti stabili (semantic/procedural) già
    // esistenti: così il consolidamento può anche FONDERE gli stabili
    // ridondanti per la stessa entità, non solo comprimere gli episodici.
    var episRes = await supabase.from('memories')
      .select('id, content, memory_type, entity_refs, tags, created_at, confidence_score')
      .eq('memory_type', 'episodic')
      .is('superseded_by', null)
      .order('created_at', { ascending: false })
      .limit(200);
    var episodic = episRes.data || [];

    var stableRes = await supabase.from('memories')
      .select('id, content, memory_type, entity_refs, created_at')
      .in('memory_type', ['semantic', 'procedural'])
      .is('superseded_by', null)
      .order('created_at', { ascending: false })
      .limit(200);
    var stable = stableRes.data || [];

    if (episodic.length < 5 && stable.length < 2) {
      logger.info('[CONSOLIDATE] Troppe poche memorie da consolidare');
      return stats;
    }

    // Raggruppa episodici e stabili per entità
    var groups = {};
    function addToGroup(m, bucket) {
      var refs = (m.entity_refs && m.entity_refs.length) ? m.entity_refs : ['_untagged'];
      refs.forEach(function(entity) {
        if (!groups[entity]) groups[entity] = { episodic: [], stable: [] };
        groups[entity][bucket].push(m);
      });
    }
    episodic.forEach(function(m) { addToGroup(m, 'episodic'); });
    stable.forEach(function(m) { addToGroup(m, 'stable'); });

    var Anthropic = require('@anthropic-ai/sdk');
    var client = new Anthropic();

    var entities = Object.keys(groups);
    for (var ei = 0; ei < entities.length; ei++) {
      var entity = entities[ei];
      if (entity === '_untagged') continue;
      var g = groups[entity];
      // Processa se ci sono abbastanza episodici da comprimere OPPURE più fatti
      // stabili che potrebbero essere ridondanti tra loro.
      if (g.episodic.length < 3 && g.stable.length < 2) continue;
      stats.clusters++;

      var epiTexts = g.episodic.slice(0, 15).map(function(m) {
        return '- [' + (m.created_at || '').substring(0, 10) + '] (' + m.id + ') ' + m.content;
      }).join('\n') || '(nessuna)';
      var stableTexts = g.stable.slice(0, 15).map(function(m) {
        return '- (' + m.id + ') [' + m.memory_type + '] ' + m.content;
      }).join('\n') || '(nessuno)';

      try {
        var res = await client.messages.create({
          model: 'claude-haiku-4-5-20251001', max_tokens: 600,
          messages: [{ role: 'user', content:
            'Entità: ' + entity + '\n\n' +
            'Memorie episodiche (' + g.episodic.length + '):\n' + epiTexts + '\n\n' +
            'Fatti stabili già esistenti (' + g.stable.length + '):\n' + stableTexts + '\n\n' +
            'Compito: (1) estrai fatti STABILI ricorrenti dagli episodici; (2) fondi i fatti ' +
            'stabili ridondanti o sovrapposti in uno solo. In "supersedes" elenca gli id ' +
            '(episodici e/o stabili) resi obsoleti dal fatto consolidato.\n' +
            'JSON: {"consolidations":[{"type":"semantic|procedural","content":"fatto consolidato","supersedes":["id1","id2"]}],"skip":false}\n' +
            'Se non c\'è nulla da consolidare o fondere, {"skip":true}'
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
