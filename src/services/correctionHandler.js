// ─── Correction Handler ─────────────────────────────────────────────────────
// Detects when a user corrects Giuno and supersedes conflicting old memories.
'use strict';

var logger = require('../utils/logger');
var db = require('../../supabase');

var CORRECTION_PATTERNS = [
  /non è (così|vero|corretto|giusto)/i,
  /sbagliato/i,
  /ti sbagli/i,
  /hai sbagliato/i,
  /non è che/i,
  /in realtà/i,
  /ti correggo/i,
  /errore/i,
  /non è più/i,
  /non lavora più/i,
  /non è il (suo|loro)/i,
  /non si chiama/i,
  /il nome giusto è/i,
  /la cifra giusta è/i,
  /il dato corretto è/i,
];

function isCorrection(message) {
  if (!message || message.length < 10) return false;
  return CORRECTION_PATTERNS.some(function(p) { return p.test(message); });
}

async function handleCorrection(userId, userMessage, botReply) {
  try {
    var dbClient = require('./db/client');
    var supabase = dbClient.getClient();
    if (!supabase) return;

    // Extract what the correction is about using keywords from the user message
    var msgLow = userMessage.toLowerCase();
    var keywords = msgLow
      .replace(/non è così|sbagliato|ti sbagli|hai sbagliato|in realtà|ti correggo|errore/gi, '')
      .trim()
      .split(/\s+/)
      .filter(function(w) { return w.length > 3; });

    if (keywords.length === 0) return;

    // Search for conflicting memories
    var searchQuery = keywords.slice(0, 5).join(' ');
    var candidates = await supabase.from('memories')
      .select('id, content, entity_refs')
      .is('superseded_by', null)
      .textSearch('content', searchQuery, { type: 'plain' })
      .limit(10);

    if (!candidates.data || candidates.data.length === 0) return;

    // Save the correction as a new memory
    var correctionContent = 'CORREZIONE: ' + userMessage.substring(0, 500);
    var newMemory = await db.addMemory(userId, correctionContent, ['correzione', 'feedback'], {
      memory_type: 'semantic',
      confidence_score: 0.9,
    });

    if (!newMemory || !newMemory.id) return;

    // Mark old conflicting memories as superseded
    var oldIds = candidates.data.map(function(m) { return m.id; });
    if (oldIds.length > 0) {
      await supabase.rpc('supersede_memories', {
        p_new_memory_id: newMemory.id,
        p_old_memory_ids: oldIds,
      });
      logger.info('[CORRECTION] Superseded', oldIds.length, 'memories for correction by', userId);
    }
  } catch(e) {
    logger.warn('[CORRECTION] Error handling correction:', e.message);
  }
}

module.exports = {
  isCorrection: isCorrection,
  handleCorrection: handleCorrection,
};
