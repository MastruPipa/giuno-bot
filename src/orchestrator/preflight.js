// ─── Preflight Context Check ──────────────────────────────────────────────────
// Enriches context before agent responds. Prevents stale/repetitive answers.

'use strict';

var logger = require('../utils/logger');
var db = require('../../supabase');

var ALWAYS_SEARCH_PATTERNS = [
  /stato.*(progetto|cliente|lead|trattativa)/i,
  /aggiornament[io]/i,
  /cosa.*(ha fatto|stanno facendo|sta facendo)/i,
  /settimana|questa settimana|da lunedì/i,
  /crm|pipeline|preventiv[oi]/i,
  /chi.*(sta lavorando|lavora|ha lavorato)/i,
  /daily|standup/i,
  /com'è messa|a che punto/i,
];

function preflight(message, ctx) {
  var enriched = Object.assign({}, ctx);

  try {
    var requiresFreshSearch = ALWAYS_SEARCH_PATTERNS.some(function(p) {
      return p.test(message || '');
    });
    enriched.requiresFreshSearch = requiresFreshSearch;

    if (requiresFreshSearch) {
      enriched.preflightInstruction =
        'ISTRUZIONE PRE-FLIGHT: questa domanda riguarda lo stato attuale. ' +
        'Prima di rispondere DEVI cercare dati aggiornati con i tool disponibili ' +
        '(search_leads, read_channel, search_drive, recall_memory). ' +
        'Non rispondere basandoti solo sul contesto della conversazione o sulla memoria. ' +
        'Cerca SEMPRE dati freschi.';
    }
  } catch(e) {
    logger.warn('[PREFLIGHT] pattern check fallito:', e.message);
  }

  return enriched;
}

module.exports = { preflight: preflight };
