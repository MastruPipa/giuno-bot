// ─── Consolidamento memorie: prompt e parsing della risposta ─────────────────
// Estratto da cronHandlers.consolidaMemorie perché sia testabile. Il 17/9 la
// risposta si troncava a 800 token, il JSON restava aperto, safeParse dava
// null e il job cadeva su "reading 'delete_ids' of null" (gruppo condiviso e
// Alessandra). Ora: budget più alto, risposta chiesta corta, null gestito.
'use strict';

var { safeParse } = require('../utils/safeCall');

var MAX_TOKENS = 2500;
var MAX_NEW_MEMORIES = 5;
var MAX_CONTENT_CHARS = 300;

var SYSTEM_PROMPT =
  'Consolida queste memorie di un\'agenzia di marketing. Per ogni gruppo:\n' +
  '1. ELIMINA duplicati e info superate (tieni la più recente)\n' +
  '2. FONDI memorie episodiche simili in UNA memoria semantica completa\n' +
  '3. Esempio: 5 frammenti su "Aitho" → 1 memoria: "Aitho: cliente dal 2025, branding+social, budget €15k, contatto Marco, canale #aitho, ultimo progetto logo Q1 2026"\n' +
  '4. Per tool_result e search_pattern: elimina se >7 giorni e non utili\n\n' +
  'Rispondi CORTO e SOLO con il JSON, niente testo prima o dopo: al massimo ' + MAX_NEW_MEMORIES + ' new_memories, ogni content entro ' + MAX_CONTENT_CHARS + ' caratteri, delete_ids solo gli id necessari.\n' +
  'JSON: {"delete_ids": ["id1"], "new_memories": [{"content": "testo consolidato", "tags": ["tipo:valore"], "memory_type": "semantic"}]}\n' +
  'Se non serve: {"delete_ids": [], "new_memories": []}';

// Testo del modello → { delete_ids: [], new_memories: [] } oppure
// { error: 'motivo' } (mai null: chi chiama non deve controllare i campi).
function parseConsolidation(text, stopReason) {
  var t = String(text || '').trim();
  var truncated = stopReason === 'max_tokens' ? ' (risposta troncata a max_tokens)' : '';
  var m = t.match(/\{[\s\S]*\}/);
  if (!m) return { error: (t ? 'nessun JSON nella risposta' : 'risposta vuota') + truncated, delete_ids: [], new_memories: [] };
  var parsed = safeParse('CRON.consolidate', m[0], null);
  if (!parsed || typeof parsed !== 'object') {
    return { error: 'JSON non valido' + truncated, delete_ids: [], new_memories: [] };
  }
  return {
    delete_ids: Array.isArray(parsed.delete_ids) ? parsed.delete_ids.filter(function(x) { return typeof x === 'string' && x; }) : [],
    new_memories: Array.isArray(parsed.new_memories) ? parsed.new_memories.filter(function(x) { return x && typeof x.content === 'string' && x.content.trim(); }).slice(0, MAX_NEW_MEMORIES) : [],
  };
}

module.exports = { SYSTEM_PROMPT: SYSTEM_PROMPT, MAX_TOKENS: MAX_TOKENS, parseConsolidation: parseConsolidation };
