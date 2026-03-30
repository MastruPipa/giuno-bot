'use strict';

var INTERNAL_PATTERNS = [
  /\binterno\b/i,
  /\bprogetto interno\b/i,
  /\bventure\b/i,
  /\bpartnership\b/i,
  /\bimperfecto\b/i,
  /\boffkatania\b/i,
  /\bkatania studio\b/i,
];

var STALE_EVENT_PATTERNS = [
  /\bfriends?\s+of\s+figma\b/i,
  /\bscorso anno\b/i,
  /\bevento chiuso\b/i,
  /\bgià chiuso\b/i,
];

function normalizeText(v) {
  return (v || '').toString().toLowerCase().trim();
}

function isInternalProjectText(text) {
  var t = normalizeText(text);
  if (!t) return false;
  return INTERNAL_PATTERNS.some(function(p) { return p.test(t); });
}

function isLikelyStaleEvent(text) {
  var t = normalizeText(text);
  if (!t) return false;
  return STALE_EVENT_PATTERNS.some(function(p) { return p.test(t); });
}

function extractExcludedPhrases(corrections) {
  var phrases = [];
  (corrections || []).forEach(function(c) {
    var txt = normalizeText(c && c.content ? c.content : c);
    if (!txt) return;
    var re = /(non menzionare|non citare|rimuovere|rimuovi|elimina)\s+([^.!;\n]{3,120})/g;
    var m;
    while ((m = re.exec(txt)) !== null) {
      var phrase = (m[2] || '').replace(/\b(dalle memories|dalla memoria|dal briefing|nel briefing)\b/g, '').trim();
      if (phrase.length >= 4) phrases.push(phrase);
    }
  });
  return Array.from(new Set(phrases)).slice(0, 20);
}

function shouldExcludeText(text, excludedPhrases) {
  var t = normalizeText(text);
  if (!t) return false;
  return (excludedPhrases || []).some(function(p) { return p && t.includes(normalizeText(p)); });
}

module.exports = {
  isInternalProjectText: isInternalProjectText,
  isLikelyStaleEvent: isLikelyStaleEvent,
  extractExcludedPhrases: extractExcludedPhrases,
  shouldExcludeText: shouldExcludeText,
};
