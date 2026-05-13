// ─── Ordinal Reference Resolver ─────────────────────────────────────────────
// When the user replies to a numbered/bulleted list from the bot with a
// shorthand like "1. persa" or "il secondo è won", we need to resolve the
// reference to the actual entity before classification + retrieval. Otherwise
// the intent classifier sees "persa" in isolation and routes to a useless
// search agent that hunts the keyword across Drive/KB.
//
// Scope: deliberately simple. We only resolve when the previous bot reply
// contains a numbered list (1./2./3. or 1)/2)/3)) and the user's message
// starts with a matching number or an Italian ordinal pronoun.

'use strict';

var ORDINAL_WORDS = {
  'primo': 1, 'prima': 1,
  'secondo': 2, 'seconda': 2,
  'terzo': 3, 'terza': 3,
  'quarto': 4, 'quarta': 4,
  'quinto': 5, 'quinta': 5,
  'sesto': 6, 'sesta': 6,
  'settimo': 7, 'settima': 7,
  'ottavo': 8, 'ottava': 8,
  'nono': 9, 'nona': 9,
  'decimo': 10, 'decima': 10,
};

// Parse "1. **Unimed** (31/03) - Performance Marketing..." into
// { 1: 'Unimed', 2: 'Tarocco/Pacman', ... }
function parseNumberedList(text) {
  if (!text || typeof text !== 'string') return null;
  var items = {};
  // Two passes — markdown-bolded names first ("**Name**"), then plain
  // fallback. Bold capture is more reliable because dashes inside names
  // ("SHUT UP S.R.L.S. - L'Elfo") don't trip the terminator.
  var boldRx = /^\s*(\d{1,2})[\.\)]\s+\*\*([^*\n]{1,80}?)\*\*/gm;
  var m;
  while ((m = boldRx.exec(text)) !== null) {
    var n = parseInt(m[1], 10);
    var name = m[2].trim();
    if (n > 0 && n <= 20 && name) items[n] = name;
  }
  var plainRx = /^\s*(\d{1,2})[\.\)]\s+([A-Za-zÀ-ÿ][\wÀ-ÿ\s.'\/]{1,60}?)\s*(?:\(|—|:|,| - |$)/gm;
  while ((m = plainRx.exec(text)) !== null) {
    var n2 = parseInt(m[1], 10);
    if (items[n2]) continue;
    var nm = m[2].trim();
    if (n2 > 0 && n2 <= 20 && nm) items[n2] = nm;
  }
  return Object.keys(items).length > 0 ? items : null;
}

// Detect a short follow-up referencing a list item.
// Returns { index: N, payload: 'rest of message' } or null.
function parseOrdinalReference(message) {
  if (!message || typeof message !== 'string') return null;
  var trimmed = message.trim();
  if (trimmed.length > 120) return null; // too long to be a shorthand reference
  // "1. persa" / "1) won" / "1 - chiuso" / "1: persa"
  var numRx = /^(\d{1,2})\s*[\.\)\-\:]\s*(.*)$/;
  var m = trimmed.match(numRx);
  if (m) return { index: parseInt(m[1], 10), payload: (m[2] || '').trim() };
  // "il primo è persa" / "la seconda è chiusa"
  var wordRx = /^(?:il|la|lo)?\s*(primo|prima|secondo|seconda|terzo|terza|quarto|quarta|quinto|quinta|sesto|sesta|settimo|settima|ottavo|ottava|nono|nona|decimo|decima)\b[,\s]*(?:è|=|->|→)?\s*(.*)$/i;
  m = trimmed.match(wordRx);
  if (m) {
    var idx = ORDINAL_WORDS[m[1].toLowerCase()];
    if (idx) return { index: idx, payload: (m[2] || '').trim() };
  }
  return null;
}

// Main entry: given the user message and the conversation history, return
// either { rewritten, entity, index } or null if no resolution applies.
function resolveOrdinalReference(message, conversationHistory) {
  var ref = parseOrdinalReference(message);
  if (!ref) return null;
  if (!Array.isArray(conversationHistory) || conversationHistory.length === 0) return null;
  // Find the most recent assistant reply.
  var lastBot = null;
  for (var i = conversationHistory.length - 1; i >= 0; i--) {
    var entry = conversationHistory[i];
    if (entry && entry.role === 'assistant' && typeof entry.content === 'string') {
      lastBot = entry.content;
      break;
    }
  }
  if (!lastBot) return null;
  var items = parseNumberedList(lastBot);
  if (!items || !items[ref.index]) return null;
  var entity = items[ref.index];
  var payload = ref.payload || '';
  // Rewrite into a natural, classifier-friendly sentence. We keep the original
  // shorthand visible too so the LLM has full context downstream.
  var rewritten = entity + (payload ? ' è ' + payload : '') +
    ' [riferimento all\'elemento ' + ref.index + ' della lista precedente; testo originale: "' + message.trim() + '"]';
  return { rewritten: rewritten, entity: entity, index: ref.index, payload: payload };
}

module.exports = {
  parseNumberedList: parseNumberedList,
  parseOrdinalReference: parseOrdinalReference,
  resolveOrdinalReference: resolveOrdinalReference,
};
