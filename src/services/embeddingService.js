// ─── Embedding Service ───────────────────────────────────────────────────────
// Semantic search via pgvector. Supports Voyage AI or OpenAI embeddings.
// Falls back gracefully if no API key is set.
'use strict';

var logger = require('../utils/logger');
var dbClient = require('./db/client');

var VOYAGE_KEY = process.env.VOYAGE_API_KEY;
var OPENAI_KEY = process.env.OPENAI_API_KEY;

function getProvider() {
  // OpenAI preferred (text-embedding-3-small, 1536 dim, compatible with pgvector)
  if (OPENAI_KEY) return 'openai';
  if (VOYAGE_KEY) return 'voyage';
  return null;
}

async function generateEmbedding(text) {
  var provider = getProvider();
  if (!provider) return null;

  try {
    if (provider === 'voyage') {
      var fetch = require('node-fetch');
      var res = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + VOYAGE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'voyage-3-lite', input: [text.substring(0, 2000)] }),
      });
      var data = await res.json();
      return data.data && data.data[0] ? data.data[0].embedding : null;
    }

    if (provider === 'openai') {
      var fetch = require('node-fetch');
      var res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + OPENAI_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: text.substring(0, 2000) }),
      });
      var data = await res.json();
      return data.data && data.data[0] ? data.data[0].embedding : null;
    }
  } catch(e) {
    logger.warn('[EMBEDDING] Error:', e.message);
    return null;
  }
}

async function semanticSearch(query, options) {
  options = options || {};
  var supabase = dbClient.getClient();
  if (!supabase || !getProvider()) return [];

  var embedding = await generateEmbedding(query);
  if (!embedding) return [];

  try {
    var { data } = await supabase.rpc('semantic_search_kb', {
      query_embedding: embedding,
      match_threshold: options.threshold || 0.3,
      match_count: options.limit || 5,
    });
    return data || [];
  } catch(e) {
    logger.warn('[EMBEDDING] Semantic search error:', e.message);
    return [];
  }
}

async function semanticSearchMemories(query, userId, options) {
  options = options || {};
  var supabase = dbClient.getClient();
  if (!supabase || !getProvider()) return [];

  var embedding = await generateEmbedding(query);
  if (!embedding) return [];

  try {
    var { data } = await supabase.rpc('semantic_search_memories', {
      query_embedding: embedding,
      p_user_id: userId || null,
      match_threshold: options.threshold || 0.3,
      match_count: options.limit || 5,
    });
    return data || [];
  } catch(e) {
    logger.warn('[EMBEDDING] Memory semantic search error:', e.message);
    return [];
  }
}

async function backfillEmbeddings() {
  var supabase = dbClient.getClient();
  if (!supabase || !getProvider()) { logger.warn('[EMBEDDING] No provider configured'); return; }

  logger.info('[EMBEDDING] Starting backfill...');
  var processed = 0;

  // KB entries without embeddings
  var { data: kbEntries } = await supabase.from('knowledge_base')
    .select('id, content').is('embedding', null).limit(100);

  for (var i = 0; i < (kbEntries || []).length; i++) {
    var emb = await generateEmbedding(kbEntries[i].content);
    if (emb) {
      await supabase.from('knowledge_base').update({ embedding: emb }).eq('id', kbEntries[i].id);
      processed++;
    }
    await new Promise(function(r) { setTimeout(r, 100); });
  }

  // Memories without embeddings
  var { data: memEntries } = await supabase.from('memories')
    .select('id, content').is('embedding', null).is('superseded_by', null).limit(100);

  for (var j = 0; j < (memEntries || []).length; j++) {
    var emb2 = await generateEmbedding(memEntries[j].content);
    if (emb2) {
      await supabase.from('memories').update({ embedding: emb2 }).eq('id', memEntries[j].id);
      processed++;
    }
    await new Promise(function(r) { setTimeout(r, 100); });
  }

  logger.info('[EMBEDDING] Backfill done. Processed:', processed);
  return processed;
}

module.exports = { getProvider: getProvider, generateEmbedding: generateEmbedding, semanticSearch: semanticSearch, semanticSearchMemories: semanticSearchMemories, backfillEmbeddings: backfillEmbeddings };
