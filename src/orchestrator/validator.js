// ─── Output Validation Layer ──────────────────────────────────────────────────
// Intercepts agent response before it reaches the user.
// Detects hallucinated actions (claims without tool calls).

'use strict';

var logger = require('../utils/logger');

var ACTION_TOOL_MAP = [
  { pattern: /ho (inviato|mandato|scritto).*(messaggio|dm|direct)/i, tools: ['send_dm'] },
  { pattern: /ho (pubblicato|postato|scritto).*(canale|#\w+)/i, tools: ['send_dm', 'chat.postMessage'] },
  { pattern: /ho (caricato|pubblicato).*(report|documento).*(canale|#\w+)/i, tools: ['send_dm', 'chat.postMessage'] },
  { pattern: /ho (aggiornato|modificato).*(crm|lead|cliente)/i, tools: ['update_lead', 'create_lead'] },
  { pattern: /ho (creato|aggiunto|inserito).*(lead|contatto|cliente)/i, tools: ['create_lead'] },
  { pattern: /ho (schedulato|programmato).*(reminder|promemoria)/i, tools: ['send_channel_reminder', 'set_reminder'] },
  { pattern: /ho (creato|aggiunto).*(evento|appuntamento|meeting)/i, tools: ['create_event'] },
  { pattern: /ho (inviato|mandato).*(email|mail)/i, tools: ['send_email', 'reply_email', 'forward_email'] },
];

var COMPLETION_PHRASES = [
  /ho (inviato|mandato|scritto|pubblicato|postato|aggiornato|creato|aggiunto|salvato|schedulato|programmato|caricato)/i,
  /messaggio inviato/i,
  /report (inviato|caricato|pubblicato)/i,
  /crm (aggiornato|modificato)/i,
  /reminder (schedulato|impostato|inviato)/i,
];

function validate(responseText, toolsCalled) {
  if (!responseText) return { valid: true, issue: null };

  var hasCompletionPhrase = COMPLETION_PHRASES.some(function(p) { return p.test(responseText); });
  if (!hasCompletionPhrase) return { valid: true, issue: null };

  for (var i = 0; i < ACTION_TOOL_MAP.length; i++) {
    var mapping = ACTION_TOOL_MAP[i];
    if (!mapping.pattern.test(responseText)) continue;

    var hasExpectedTool = mapping.tools.some(function(t) {
      return toolsCalled.some(function(called) {
        return called === t || called.includes(t) || t.includes(called);
      });
    });

    if (!hasExpectedTool && toolsCalled.length === 0) {
      return {
        valid: false,
        issue: 'Risposta dichiara azione completata ma nessun tool chiamato. Pattern: ' +
          mapping.pattern.toString() + ' | Attesi: ' + mapping.tools.join(','),
      };
    }
  }

  return { valid: true, issue: null };
}

function fallbackResponse(originalResponse, issue) {
  logger.error('[VALIDATOR] HALLUCINATION:', issue);
  logger.error('[VALIDATOR] Risposta soppressa:', originalResponse.substring(0, 200));
  return 'Non sono riuscito a completare l\'azione. Riprova o dimmi esattamente cosa devo fare.';
}

module.exports = { validate: validate, fallbackResponse: fallbackResponse };
