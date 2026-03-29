// ─── KB Quality Sweep Job ────────────────────────────────────────────────────
// Deduplicates and scores KB entries. Monthly, 1st Monday 5:00 AM.
'use strict';

var dbClient = require('../services/db/client');
var logger = require('../utils/logger');
var { safeParse } = require('../utils/safeCall');

function jaccard(a, b) {
  var setA = new Set((a || '').toLowerCase().split(/\W+/).filter(function(w) { return w.length > 3; }));
  var setB = new Set((b || '').toLowerCase().split(/\W+/).filter(function(w) { return w.length > 3; }));
  var intersection = 0;
  setA.forEach(function(w) { if (setB.has(w)) intersection++; });
  var union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

async function runQualitySweep() {
  var supabase = dbClient.getClient();
  if (!supabase) return;
  logger.info('[KB-SWEEP] Starting quality sweep...');

  var stats = { duplicates: 0, promoted: 0, archived: 0, scored: 0 };

  try {
    // Phase 1: Deduplication (Jaccard similarity >= 0.85)
    var { data: entries } = await supabase.from('knowledge_base')
      .select('id, content, source_type, confidence_score, confidence_tier')
      .neq('confidence_tier', 'official')
      .is('expires_at', null)  // only non-expiring
      .order('created_at', { ascending: false })
      .limit(500);

    if (entries && entries.length > 1) {
      var toDelete = new Set();
      for (var i = 0; i < entries.length; i++) {
        if (toDelete.has(entries[i].id)) continue;
        for (var j = i + 1; j < entries.length; j++) {
          if (toDelete.has(entries[j].id)) continue;
          var sim = jaccard(entries[i].content, entries[j].content);
          if (sim >= 0.85) {
            // Keep the one with higher confidence
            var deleteId = entries[i].confidence_score >= entries[j].confidence_score ? entries[j].id : entries[i].id;
            toDelete.add(deleteId);
            stats.duplicates++;
          }
        }
      }

      if (toDelete.size > 0) {
        var deleteIds = Array.from(toDelete);
        for (var di = 0; di < deleteIds.length; di++) {
          await supabase.from('knowledge_base').delete().eq('id', deleteIds[di]);
        }
        logger.info('[KB-SWEEP] Removed', toDelete.size, 'duplicates');
      }
    }

    // Phase 2: AI quality scoring for auto_learn entries
    var { data: autoLearn } = await supabase.from('knowledge_base')
      .select('id, content, confidence_score, confidence_tier')
      .eq('source_type', 'auto_learn')
      .neq('confidence_tier', 'official')
      .limit(50);

    if (autoLearn && autoLearn.length > 0) {
      var Anthropic = require('@anthropic-ai/sdk');
      var client = new Anthropic();

      // Batch: send 10 at a time
      for (var bi = 0; bi < autoLearn.length; bi += 10) {
        var batch = autoLearn.slice(bi, bi + 10);
        var batchText = batch.map(function(e, idx) {
          return idx + '. ' + (e.content || '').substring(0, 200);
        }).join('\n');

        try {
          var res = await client.messages.create({
            model: 'claude-haiku-4-5-20251001', max_tokens: 300,
            messages: [{ role: 'user', content:
              'Valuta queste entry di knowledge base aziendale (Katania Studio, agenzia creativa).\n' +
              'Per ognuna: score 0.0-1.0 e azione: promote (→semantic), keep, archive (inutile).\n' +
              'JSON: [{"idx":0,"score":0.7,"action":"keep"},...]  \n\n' + batchText
            }],
          });

          var match = res.content[0].text.trim().replace(/```json|```/g, '').match(/\[[\s\S]*\]/);
          if (match) {
            var scores = safeParse('KB-SWEEP', match[0], null);
            if (!scores) continue;
            for (var si = 0; si < scores.length; si++) {
              var s = scores[si];
              var entry = batch[s.idx];
              if (!entry) continue;
              stats.scored++;

              if (s.action === 'promote') {
                await supabase.from('knowledge_base').update({
                  confidence_tier: 'semantic', confidence_score: Math.max(s.score, 0.65),
                }).eq('id', entry.id);
                stats.promoted++;
              } else if (s.action === 'archive' || s.score < 0.3) {
                await supabase.from('knowledge_base').delete().eq('id', entry.id);
                stats.archived++;
              }
            }
          }
        } catch(e) { logger.warn('[KB-SWEEP] AI scoring error:', e.message); }

        await new Promise(function(r) { setTimeout(r, 200); });
      }
    }
  } catch(e) {
    logger.error('[KB-SWEEP] Fatal error:', e.message);
  }

  logger.info('[KB-SWEEP] Done. Dupes:', stats.duplicates, '| Promoted:', stats.promoted, '| Archived:', stats.archived, '| Scored:', stats.scored);
  return stats;
}

module.exports = { runQualitySweep: runQualitySweep };
