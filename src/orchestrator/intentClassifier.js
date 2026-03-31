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
  QUOTE_SUPPORT:    'QUOTE_SUPPORT',
  CRM_UPDATE:       'CRM_UPDATE',
  HISTORICAL_SCAN:  'HISTORICAL_SCAN',
  PROSPECTING:      'PROSPECTING',
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
      'cosa ho oggi', 'daily briefing', 'daily digest', 'piano del giorno',
      'cosa mi aspetta', 'mail non lette', 'impegni di oggi',
    ],
  },
  {
    intent: INTENTS.CRM_UPDATE,
    keywords: [
      'aggiorna il crm', 'aggiorna crm', 'aggiorna lead', 'aggiornare il crm',
      'modifica il crm', 'cambia status', 'cambia lo status',
      'segna come', 'metti come', 'imposta come',
      'è won', 'è lost', 'è hot', 'è cold', 'abbiamo chiuso',
      'hanno firmato', 'ha firmato', 'hanno detto no', 'hanno rifiutato',
      'aggiungi al crm', 'inserisci nel crm', 'nuovo lead', 'metti nel crm',
      'prossimo followup', 'follow-up per', 'ricontattare',
      // Fix: "modifica/aggiorna la quotazione/offerta/proposta di X" = CRM update, NOT quote generation
      'modifica la quotazione', 'modifica la proposta', 'modifica la offerta',
      'modifica l\'offerta', 'aggiorna la quotazione', 'aggiorna la proposta',
      'aggiorna l\'offerta',
    ],
    // Boost: if user provides exact amounts (€), it's a data update, not a quote request
    validate: function(msg) {
      // If message contains "modifica/aggiorna" + amount → definitely CRM update
      if (/modifica|aggiorna|cambia/i.test(msg) && /\d+\s*€|€\s*\d+|\d+\s*euro/i.test(msg)) return true;
      // If message says "sono X€" → user is giving data to save
      if (/sono\s+\d|la proposta è|abbiamo offerto|abbiamo proposto/i.test(msg)) return true;
      // Default: match on keywords alone
      return true;
    },
  },
  {
    intent: INTENTS.QUOTE_SUPPORT,
    keywords: [
      'quotare', 'quanto costerebbe', 'stima costi',
      'quanto costa fare', 'quanto quotare', 'prezzo per un',
      'budget per un',
    ],
    // Anti-noise: requires service type AND must NOT be a data update (modifica + amount)
    validate: function(msg) {
      // If user says "modifica/aggiorna" + gives amounts → NOT a quote request, it's CRM update
      if (/modifica|aggiorna|cambia|correggi/i.test(msg) && /\d+\s*€|€\s*\d+|\d+\s*euro/i.test(msg)) return false;
      // If user says "sono X€" → giving data, not asking for estimate
      if (/sono\s+\d+\s*€|sono\s+€?\s*\d+/i.test(msg)) return false;
      // If user says "la proposta/offerta è di X€" → data, not request
      if (/la (proposta|offerta|quotazione) è/i.test(msg)) return false;
      return /brand|video|social|web|sito|evento|campagna|foto|design|grafica|app|logo|content|copy|seo|adv|shoot|presentazion/i.test(msg) ||
        /settiman|mes[ei]|giorn|durata|consegna|timeline/i.test(msg) ||
        /per\s+[A-Z][a-z]/i.test(msg); // "per NomeCliente"
    },
  },
  {
    intent: INTENTS.HISTORICAL_SCAN,
    keywords: [
      'avvia scan', 'inizia scan', 'scan storico', 'scan slack', 'scan drive',
      'stato scan', 'progresso scan', 'indicizza slack', 'indicizza drive',
    ],
  },
  {
    intent: INTENTS.PROSPECTING,
    keywords: ['prospect', 'analizza azienda', 'valuta azienda', 'fit score', 'dovremmo contattare', 'vale la pena contattare', 'scheda azienda'],
  },
  {
    intent: INTENTS.CLIENT_RETRIEVAL,
    keywords: [
      'dimmi di', 'info su', 'cosa sai di',
      'lavoriamo con', 'chi è', 'storia di',
      'dossier', 'cerca tutto su',
    ],
  },
];

// ─── Classifier ───────────────────────────────────────────────────────────────

async function classifyIntent(message) {
  if (!message || typeof message !== 'string') {
    logger.warn('[INTENT] Input non-string:', typeof message);
    return INTENTS.GENERAL;
  }
  var msgLow = message.toLowerCase();

  // Keyword matching pass
  for (var i = 0; i < RULES.length; i++) {
    var rule = RULES[i];
    for (var j = 0; j < rule.keywords.length; j++) {
      if (msgLow.includes(rule.keywords[j])) {
        // Anti-noise validation if defined
        if (rule.validate && !rule.validate(msgLow)) continue;
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
        'QUOTE_SUPPORT — l\'utente CHIEDE di generare/stimare un preventivo nuovo (es. "quanto costerebbe fare X?"). NON usare se l\'utente fornisce già i numeri.\n' +
        'CRM_UPDATE — aggiornamento CRM, modifica dati lead, cambio status. INCLUDE: "modifica la quotazione/offerta di X", "sono X€ al mese", "la proposta è di X€" (= l\'utente dà dati da salvare, non chiede una stima)\n' +
        'HISTORICAL_SCAN — scan storico Slack/Drive, indicizzazione, stato scan\n' +
        'GENERAL — tutto il resto\n' +
        'ATTENZIONE: se l\'utente dice "modifica" + fornisce importi in €, è SEMPRE CRM_UPDATE, MAI QUOTE_SUPPORT.',
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
