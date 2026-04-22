// ─── PII Scrubbing ───────────────────────────────────────────────────────────
// Strip personally identifiable information before writing to long-term stores
// (memories, knowledge_base, conversation_summaries). Conservative: only
// high-precision patterns so we don't mangle legitimate content.

'use strict';

// Email — RFC-ish, conservative
var EMAIL_RE = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g;
// Italian phone numbers (+39 optional, 9-11 digits with optional spaces/dashes)
var PHONE_IT_RE = /(?:\+?39[\s.\-]?)?(?:\(?0?\d{2,4}\)?[\s.\-]?)?\d{3,4}[\s.\-]?\d{3,4}\b/g;
// IBAN (IT/EU generic — 2 letters + 2 digits + 10..30 alphanum)
var IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g;
// Codice Fiscale (6 letters + 2 digits + letter + 2 digits + letter + 3 digits + letter)
var CF_RE = /\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/g;
// Credit card (13..19 digits, optionally separated by spaces/dashes in 4-digit groups)
var CC_RE = /\b(?:\d[ \-]?){13,19}\b/g;

function scrubPII(text) {
  if (typeof text !== 'string' || !text) return text;
  var out = text;
  // Order matters: IBAN/CF have letters so they survive email substitution.
  out = out.replace(IBAN_RE, '[iban]');
  out = out.replace(CF_RE, '[cf]');
  out = out.replace(EMAIL_RE, '[email]');
  out = out.replace(CC_RE, function(match) {
    // Only treat as CC if stripped digits length looks right — avoid mangling timestamps/ids
    var digits = match.replace(/\D/g, '');
    return digits.length >= 13 && digits.length <= 19 ? '[carta]' : match;
  });
  out = out.replace(PHONE_IT_RE, function(match) {
    var digits = match.replace(/\D/g, '');
    // Only replace if it actually looks like a phone (8-12 digits, not a price/id)
    if (digits.length < 8 || digits.length > 12) return match;
    return '[telefono]';
  });
  return out;
}

function hasPII(text) {
  if (typeof text !== 'string' || !text) return false;
  return EMAIL_RE.test(text) || IBAN_RE.test(text) || CF_RE.test(text);
}

module.exports = { scrubPII: scrubPII, hasPII: hasPII };
