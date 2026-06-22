// ─── General Assistant Agent ───────────────────────────────────────────────────
// Fallback agent: full tool access. This is essentially the current askGiuno behavior,
// delegated to anthropicService.askGiuno.

'use strict';

var logger = require('../utils/logger');
var { askGiuno } = require('../services/anthropicService');
var db = require('../../supabase');

// Pattern for implicit action references / conferme secche ("sì", "ok", "va
// bene", "procedi"...). Ancorato all'intero messaggio: solo conferme pure,
// non frasi con contenuto proprio ("sì ma aspetta" non matcha).
var IMPLICIT_REFS = /^(s[iì]|s[iì]\s*s[iì]|s[iì]\s*(fai|dai|grazie|procedi|certo|vai)|ok|okay|va bene|vabb[eè]|d'?accordo|daccordo|certo|esatto|perfetto|confermo|conferma|confermato|procedi( pure)?|vai( pure| così)?|dai|fallo?|invialo?|mandalo?|aggiornalo?|esegui|yes|yep|sure|ci sta)[\s!.,]*$/i;

/**
 * run — executes the general assistant for any message.
 */
async function run(message, ctx) {
  var options = {
    threadTs:             ctx.threadTs,
    channelId:            ctx.channelId,
    channelContext:       ctx.channelContext,
    mentionedBy:          ctx.mentionedBy,
    channelType:          ctx.channelType,
    isDM:                 ctx.isDM,
    preflightInstruction: ctx.preflightInstruction || null,
  };

  // If message is an implicit reference, recover context
  if (IMPLICIT_REFS.test((message || '').trim())) {
    // Chiave coerente con askGiuno/router: DM senza thread → userId (NON
    // userId:dm, che era il bug per cui il recupero non trovava mai nulla).
    var convKey = ctx.threadTs ? ctx.userId + ':' + ctx.threadTs : ctx.userId;

    // 1. Try in-memory conversation cache first
    var convCache = db.getConvCache();
    var conv = convCache[convKey] || [];
    var lastAssistant = null;

    if (conv.length >= 2) {
      for (var i = conv.length - 1; i >= 0; i--) {
        if (conv[i].role === 'assistant') {
          lastAssistant = conv[i].content;
          break;
        }
      }
    }

    // 2. Fallback: check conversation_summaries for proposed_actions
    if (!lastAssistant) {
      try {
        var summary = await db.getConversationSummary(convKey);
        if (summary && summary.proposed_actions && summary.proposed_actions.length > 0) {
          var lastAction = summary.proposed_actions[summary.proposed_actions.length - 1];
          var enriched = '[CONTEXT RECOVERY da conversation_summaries]\n' +
            'L\'utente dice "' + message + '" riferendosi a questa azione proposta:\n' +
            JSON.stringify(lastAction) + '\n' +
            (summary.summary ? 'Contesto: ' + summary.summary.substring(0, 300) + '\n' : '') +
            'Esegui l\'azione usando il tool appropriato. NON inventare azioni non proposte.';
          return await askGiuno(ctx.userId, enriched, options);
        }
      } catch(e) {
        logger.warn('[GENERAL-AGENT] context recovery fallito:', e.message);
      }
    }

    if (lastAssistant) {
      var enrichedMessage = '[CONTINUITÀ CONVERSAZIONE] Nel tuo messaggio precedente avevi detto/proposto:\n"' +
        String(lastAssistant).substring(0, 800) + '"\n\n' +
        'Ora l\'utente risponde: "' + message + '" — è una conferma/risposta a quanto sopra, NON un messaggio nuovo.\n' +
        'Prosegui di conseguenza: se avevi proposto un\'azione concreta eseguila col tool giusto; altrimenti continua sul tema di prima. ' +
        'NON dire che manca il contesto o che non vedi una domanda, e NON inventare azioni non proposte.';
      return await askGiuno(ctx.userId, enrichedMessage, options);
    }

    // 3. Fallback: recover from recent intent-like memories
    try {
      var mem = await db.searchMemories(ctx.userId, 'pending in attesa conferma da fare reminder');
      if (mem && mem.length > 0) {
        var memHint = '[CONTEXT RECOVERY da memoria]\n' +
          'L\'utente dice "' + message + '".\n' +
          'Possibile azione recente: "' + String(mem[0].content || '').substring(0, 300) + '".\n' +
          'Se il contesto è sufficientemente chiaro, esegui col tool corretto; altrimenti chiedi chiarimento.';
        return await askGiuno(ctx.userId, memHint, options);
      }
    } catch(e) {
      logger.warn('[GENERAL-AGENT] context recovery memory error:', e.message);
    }

    // 4. No recoverable context — ask explicitly
    return 'Perfetto, ma mi manca il contesto: quale azione devo eseguire esattamente e per chi?';
  }

  return await askGiuno(ctx.userId, message, options);
}

module.exports = { run: run };
