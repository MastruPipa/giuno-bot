// ─── Intent Classifier ─────────────────────────────────────────────────────────
// Classifies user intent into one of:
//   THREAD_SUMMARY | DAILY_DIGEST | CLIENT_RETRIEVAL | GENERAL
// Uses keyword matching first, falls back to a fast LLM call if ambiguous.

'use strict';

var logger = require('../utils/logger');

var INTENTS = {
  THREAD_SUMMARY:   'THREAD_SUMMARY',
  DAILY_DIGEST:     'DAILY_DIGEST',
  CLIENT_RETRIEVAL: 'CLIENT_RETRIEVAL',
  GENERAL:          'GENERAL',
};

// ─── Keyword rules ─────────────────────────────────────────────────────────────

var RULES = [
  {
    intent: INTENTS.THREAD_SUMMARY,
    keywords: [
      'riassumi', 'riassunto', 'cosa mi sono perso', 'recap thread', 'recap canale',
      'summarize', 'summary', 'thread', 'sintetizza', 'cosa è successo in',
      'cosa hanno detto', 'riepiloga',
    ],
  },
  {
    intent: INTENTS.DAILY_DIGEST,
    keywords: [
      'briefing', 'routine mattutina', 'recap giornaliero', 'agenda di oggi',
      'cosa ho oggi', 'daily', 'piano del giorno', 'cosa mi aspetta',
      'mail non lette', 'impegni di oggi',
    ],
  },
  {
    intent: INTENTS.CLIENT_RETRIEVAL,
    keywords: [
      'dimmi di', 'info su', 'cosa sai di', 'cliente', 'progetto',
      'preventivo per', 'lavoriamo con', 'chi è', 'storia di',
      'dossier', 'cerca tutto su',
    ],
  },
];

// ─── Classifier ───────────────────────────────────────────────────────────────

async function classifyIntent(message) {
  var msgLow = (message || '').toLowerCase();

  // Keyword matching pass
  for (var i = 0; i < RULES.length; i++) {
    var rule = RULES[i];
    for (var j = 0; j < rule.keywords.length; j++) {
      if (msgLow.includes(rule.keywords[j])) {
        logger.info('[INTENT] Keyword match → ' + rule.intent);
        return rule.intent;
      }
    }
  }

  // Ambiguous → fast LLM classification
  try {
    var Anthropic = require('@anthropic-ai/sdk');
    var client = new Anthropic();
    var res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      system:
        'Classifica questa richiesta in UNA di queste categorie. Rispondi SOLO con la categoria, nessun altro testo:\n' +
        'THREAD_SUMMARY — recap/riassunto thread o canale Slack\n' +
        'DAILY_DIGEST — briefing giornaliero, agenda, mail, piano del giorno\n' +
        'CLIENT_RETRIEVAL — info su un cliente, progetto o preventivo specifico\n' +
        'GENERAL — tutto il resto',
      messages: [{ role: 'user', content: message }],
    });
    var intent = (res.content[0].text || '').trim().toUpperCase();
    if (INTENTS[intent]) {
      logger.info('[INTENT] LLM → ' + intent);
      return intent;
    }
  } catch(e) {
    logger.warn('[INTENT] LLM fallback error:', e.message);
  }

  logger.info('[INTENT] Default → GENERAL');
  return INTENTS.GENERAL;
}

module.exports = {
  INTENTS: INTENTS,
  classifyIntent: classifyIntent,
};
