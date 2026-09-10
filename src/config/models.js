// ─── Model configuration ─────────────────────────────────────────────────────
// Unico punto in cui vivono gli ID dei modelli Anthropic usati da Giuno.
// Tre livelli, scelti per costo/qualità:
//   PRIMARY  — il "cervello" conversazionale (askGiuno, skill, agenti
//              specializzati). Deve capire il contesto Slack e usare i tool.
//   UTILITY  — riassunti, estrazione memorie, compressione conversazioni,
//              consolidamento. Qualità del ragionamento importante, ma senza
//              tool loop.
//   FAST     — classificazione intent, triage batch dei canali, scanner
//              storici: tanti call piccoli dove il costo pesa più della finezza.
// Ogni livello è sovrascrivibile da env (GIUNO_MODEL_PRIMARY, ...), così una
// ricalibrazione futura non richiede un deploy di codice.

'use strict';

var MODELS = {
  PRIMARY: process.env.GIUNO_MODEL_PRIMARY || 'claude-opus-5',
  UTILITY: process.env.GIUNO_MODEL_UTILITY || 'claude-sonnet-5',
  FAST:    process.env.GIUNO_MODEL_FAST    || 'claude-haiku-4-5',
};

// Sforzo di ragionamento del modello primario (output_config.effort).
// 'medium' è il compromesso per una chat Slack con timeout di ~55s: abbastanza
// per ragionare su un thread lungo, senza far attendere minuti. Alzare a
// 'high' per test di qualità, abbassare a 'low' se la latenza diventa un tema.
var PRIMARY_EFFORT = process.env.GIUNO_EFFORT || 'medium';

// Fallback lato server sui rifiuti dei classificatori di sicurezza (Opus 5 /
// Fable): se il modello primario rifiuta, la stessa richiesta viene rieseguita
// da Anthropic su un modello di ripiego nella stessa chiamata. Disattivabile
// con GIUNO_REFUSAL_FALLBACK=0.
var REFUSAL_FALLBACK_ENABLED = process.env.GIUNO_REFUSAL_FALLBACK !== '0';
var REFUSAL_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// Modelli che accettano output_config.effort / thinking adattivo. Quelli non
// in lista (es. Haiku 4.5) ricevono una richiesta "classica".
function supportsEffort(model) {
  return /^claude-(opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|fable|mythos)/.test(String(model || ''));
}

module.exports = {
  MODELS: MODELS,
  PRIMARY_EFFORT: PRIMARY_EFFORT,
  REFUSAL_FALLBACK_ENABLED: REFUSAL_FALLBACK_ENABLED,
  REFUSAL_FALLBACK_BETA: REFUSAL_FALLBACK_BETA,
  supportsEffort: supportsEffort,
};
