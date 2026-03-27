// ─── General Assistant Agent ───────────────────────────────────────────────────
// Fallback agent: full tool access. This is essentially the current askGiuno behavior,
// delegated to anthropicService.askGiuno.

'use strict';

var { askGiuno } = require('../services/anthropicService');
var db = require('../../supabase');

// Pattern for implicit action references
var IMPLICIT_REFS = /^(mandalo?|fallo?|invialo?|aggiornalo?|procedi|ok fai|sì fai|si fai|vai|conferm[oa])[\s!.]*$/i;

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

  // If message is an implicit reference, recover context from conversation history
  if (IMPLICIT_REFS.test((message || '').trim()) && ctx.threadTs) {
    var convKey = ctx.userId + ':' + ctx.threadTs;
    var convCache = db.getConvCache();
    var conv = convCache[convKey] || [];

    if (conv.length >= 2) {
      var lastAssistant = null;
      for (var i = conv.length - 1; i >= 0; i--) {
        if (conv[i].role === 'assistant') {
          lastAssistant = conv[i].content;
          break;
        }
      }
      if (lastAssistant) {
        var enrichedMessage = '[CONTESTO: nel messaggio precedente hai proposto questa azione: "' +
          String(lastAssistant).substring(0, 500) + '"]\n\n' +
          'L\'utente ora dice: "' + message + '"\n' +
          'Esegui l\'azione proposta nel contesto usando il tool appropriato (es. send_dm). NON inventare azioni non proposte.';
        return await askGiuno(ctx.userId, enrichedMessage, options);
      }
    }
  }

  return await askGiuno(ctx.userId, message, options);
}

module.exports = { run: run };
