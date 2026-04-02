// ─── Sentiment & Urgency Classifier ─────────────────────────────────────────
// Fast regex-based classification of incoming messages.
// Returns: { urgency: 'low'|'normal'|'high'|'critical', sentiment: 'positive'|'neutral'|'negative'|'frustrated', responseStyle: string }
'use strict';

var URGENCY_PATTERNS = {
  critical: [
    /urgente|urgentissimo|subito|immediatamente|ora|adesso|emergenza|asap|aiuto/i,
    /è down|non funziona|rotto|crash|bloccato|bug critico|produzione/i,
    /il cliente (è|sta) (incazzat|arrabbiat|furioso)/i,
    /scade (oggi|tra|domani|stasera|stanotte)/i,
  ],
  high: [
    /prima possibile|entro (oggi|domani|stasera)|appena (puoi|riesci)/i,
    /importante|priorit[àa]|critico|deadline/i,
    /abbiamo un problema|c'è un problema|non va|non riesco/i,
    /il cliente (chiede|vuole|aspetta|ha chiamato)/i,
  ],
  low: [
    /quando hai tempo|con calma|no fretta|senza urgenza|non è urgente/i,
    /curiosit[àa]|per sapere|mi chiedevo|domanda veloce/i,
    /un giorno|la prossima settimana|prima o poi/i,
  ],
};

var SENTIMENT_PATTERNS = {
  frustrated: [
    /che cazzo|cazzo|minchia|madonna|porco|accidenti|maledizione/i,
    /non è possibile|incredibile|assurdo|inaccettabile|vergogna/i,
    /sono stuf[oa]|mi sono rott[oa]|basta|non ne posso più/i,
    /ma come|ma perché|ma che|ancora\?|di nuovo\?/i,
    /non capisce|non ascolta|ignora|se ne frega/i,
  ],
  negative: [
    /problema|errore|sbagliato|male|preoccupat|deluso|perso|fallito/i,
    /non funziona|non va|rotto|bloccato|incompleto|manca/i,
    /ritardo|in ritardo|scadut|sfora|fuori budget/i,
  ],
  positive: [
    /perfetto|ottimo|grande|bravo|grazie|fantastico|eccellente/i,
    /funziona|risolto|completato|chiuso|fatto|figo|bello/i,
    /contento|soddisfatt|felice|entusiast/i,
  ],
};

function classify(message) {
  if (!message || message.length < 3) {
    return { urgency: 'normal', sentiment: 'neutral', responseStyle: 'standard' };
  }

  var msgLow = message.toLowerCase();

  // Urgency
  var urgency = 'normal';
  if (URGENCY_PATTERNS.critical.some(function(p) { return p.test(msgLow); })) urgency = 'critical';
  else if (URGENCY_PATTERNS.high.some(function(p) { return p.test(msgLow); })) urgency = 'high';
  else if (URGENCY_PATTERNS.low.some(function(p) { return p.test(msgLow); })) urgency = 'low';

  // Sentiment
  var sentiment = 'neutral';
  if (SENTIMENT_PATTERNS.frustrated.some(function(p) { return p.test(msgLow); })) sentiment = 'frustrated';
  else if (SENTIMENT_PATTERNS.negative.some(function(p) { return p.test(msgLow); })) sentiment = 'negative';
  else if (SENTIMENT_PATTERNS.positive.some(function(p) { return p.test(msgLow); })) sentiment = 'positive';

  // Message length signals
  var isShort = message.length < 30;
  var isLong = message.length > 300;

  // Response style
  var responseStyle = 'standard';
  if (urgency === 'critical') responseStyle = 'immediato — rispondi subito, concentrati sul problema, niente fronzoli';
  else if (sentiment === 'frustrated') responseStyle = 'empatico — riconosci la frustrazione, vai dritto al punto, niente battute';
  else if (urgency === 'high') responseStyle = 'prioritario — risposta rapida e concreta, azione immediata se possibile';
  else if (urgency === 'low') responseStyle = 'rilassato — puoi essere più discorsivo, nessuna fretta';
  else if (isShort) responseStyle = 'conciso — risposta breve, match il tono dell\'utente';
  else if (isLong) responseStyle = 'dettagliato — l\'utente ha scritto tanto, rispondi in modo strutturato';

  return { urgency: urgency, sentiment: sentiment, responseStyle: responseStyle };
}

module.exports = { classify: classify };
