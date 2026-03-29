'use strict';

function isCorrectionFeedback(text) {
  var t = (text || '').toLowerCase().trim();
  if (!t || t.length < 8) return false;
  return /non hai menzionato|hai confuso|stai confondendo|non è un cliente|non e un cliente|è stato chiuso|e stato chiuso|è chiuso|e chiuso|da correggere|errore di classificazione|rifai il briefing|aggiorna briefing|aggiorna il briefing/.test(t);
}

function buildCorrectionPrompt(originalText) {
  return 'Correzione esplicita dell\'utente (usa questa come fonte prioritaria): "' + (originalText || '').substring(0, 500) + '".\n' +
    'Rispondi in modo operativo: 1) riconosci l\'errore senza inventare fonti, 2) correggi il contenuto, 3) se utile proponi briefing aggiornato sintetico.';
}

module.exports = {
  isCorrectionFeedback: isCorrectionFeedback,
  buildCorrectionPrompt: buildCorrectionPrompt,
};
