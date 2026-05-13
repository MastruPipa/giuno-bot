// ─── Correction Handler ─────────────────────────────────────────────────────
// Detects when a user corrects Giuno and supersedes conflicting old memories.
// Also handles implicit corrections (rephrase_detected) and degrades the KB
// entries that likely fed the wrong answer.
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
  /dove (l'?hai|hai) (letto|preso|trovato)/i,
  /chi (te|ti) (l'?ha|ha) detto/i,
  /ma (è|sono) chius/i,
];

function isCorrection(message) {
  if (!message || message.length < 10) return false;
  return CORRECTION_PATTERNS.some(function(p) { return p.test(message); });
}

function extractKeywords(message) {
  var msgLow = (message || '').toLowerCase();
  return msgLow
    .replace(/non è così|sbagliato|ti sbagli|hai sbagliato|in realtà|ti correggo|errore|dove l'?hai|dove hai|chi te l'?ha|chi ti ha|letto|preso|trovato|detto/gi, '')
    .replace(/[.,;:!?()"'—–\-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(function(w) { return w.length > 3 && !/^(che|come|cosa|quel|quei|quella|quelle|nella|negli|delle|della|dei|sul|sui|sulla|alla|alle|allo|per|con|una|uno|sono|sei|sia|siamo|siete|siano|hanno|abbiamo|avete|stanno|stiamo|state|stato|stata|stati|essere|avere|fare|dire|stare|vedere|venire|andare|sapere|tutto|tutti|tutta|tutte|niente|nulla|nessuno|qualche|alcuni|alcune|molto|molti|molta|molte|tanto|tanti|tanta|tante|poco|pochi|poca|poche)$/.test(w); });
}

async function _supersedeMemories(supabase, userId, keywords, correctionContent) {
  if (keywords.length === 0) return 0;
  var searchQuery = keywords.slice(0, 5).join(' ');
  var candidates = await supabase.from('memories')
    .select('id, content, entity_refs')
    .is('superseded_by', null)
    .textSearch('content', searchQuery, { type: 'plain' })
    .limit(10);

  if (!candidates.data || candidates.data.length === 0) return 0;

  var newMemory = await db.addMemory(userId, correctionContent, ['correzione', 'feedback'], {
    memory_type: 'semantic',
    confidence_score: 0.9,
  });
  if (!newMemory || !newMemory.id) return 0;

  var oldIds = candidates.data.map(function(m) { return m.id; });
  await supabase.rpc('supersede_memories', {
    p_new_memory_id: newMemory.id,
    p_old_memory_ids: oldIds,
  });
  return oldIds.length;
}

// Degrade KB auto_learn entries that match the correction keywords. We only
// touch auto_learn / slack_* tiers — never `official` or `drive_indexed`,
// which are sources of truth and shouldn't be invalidated by a user comment.
async function _degradeKB(supabase, keywords) {
  if (keywords.length === 0) return 0;
  var searchQuery = keywords.slice(0, 5).join(' ');
  try {
    var matches = await supabase.from('knowledge_base')
      .select('id, content, confidence_tier')
      .in('confidence_tier', ['auto_learn', 'slack_public', 'slack_private'])
      .neq('validation_status', 'rejected')
      .textSearch('content', searchQuery, { type: 'plain' })
      .limit(10);
    if (!matches.data || matches.data.length === 0) return 0;
    var ids = matches.data.map(function(r) { return r.id; });
    await supabase.from('knowledge_base')
      .update({ validation_status: 'rejected', confidence_score: 0.1 })
      .in('id', ids);
    return ids.length;
  } catch(e) {
    logger.warn('[CORRECTION] KB degrade failed:', e.message);
    return 0;
  }
}

async function handleCorrection(userId, userMessage, botReply) {
  try {
    var dbClient = require('./db/client');
    var supabase = dbClient.getClient();
    if (!supabase) return;
    var keywords = extractKeywords(userMessage);
    if (keywords.length === 0) return;
    var correctionContent = 'CORREZIONE: ' + userMessage.substring(0, 500);
    var memN = await _supersedeMemories(supabase, userId, keywords, correctionContent);
    var kbN = await _degradeKB(supabase, keywords);
    if (memN + kbN > 0) {
      logger.info('[CORRECTION] Superseded', memN, 'mems +', kbN, 'KB rows for', userId);
    }
  } catch(e) {
    logger.warn('[CORRECTION] Error handling correction:', e.message);
  }
}

// Implicit correction: user rephrased the same question, signaling the
// previous answer was wrong. We don't have an explicit "this is wrong"
// statement, so we're more conservative: only degrade KB, don't write a
// CORREZIONE memory (the user didn't actually state the truth).
async function handleRephrase(userId, prevUserMsg, botReply) {
  try {
    var dbClient = require('./db/client');
    var supabase = dbClient.getClient();
    if (!supabase) return;
    var keywords = extractKeywords(prevUserMsg);
    if (keywords.length === 0) return;
    var n = await _degradeKB(supabase, keywords);
    if (n > 0) logger.info('[CORRECTION] Rephrase → degraded', n, 'KB rows for', userId);
  } catch(e) {
    logger.warn('[CORRECTION] Error handling rephrase:', e.message);
  }
}

module.exports = {
  isCorrection: isCorrection,
  handleCorrection: handleCorrection,
  handleRephrase: handleRephrase,
  _extractKeywords: extractKeywords,
};
