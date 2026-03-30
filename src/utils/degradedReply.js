'use strict';

var DEGRADED_PATTERNS = [
  /momentaneamente sovraccarico/i,
  /riprova tra qualche minuto/i,
  /ci sto mettendo troppo/i,
  /problemi tecnici/i,
  /^errore[:\s]/i,
  /temporaneamente non disponibile/i,
];

function isDegradedReply(replyText) {
  var text = (replyText || '').toString().trim();
  if (!text) return false;
  return DEGRADED_PATTERNS.some(function(p) { return p.test(text); });
}

module.exports = {
  isDegradedReply: isDegradedReply,
};
