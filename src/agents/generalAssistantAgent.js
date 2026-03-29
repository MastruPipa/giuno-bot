// ─── General Assistant Agent ───────────────────────────────────────────────────
// Fallback agent: full tool access. This is essentially the current askGiuno behavior,
// delegated to anthropicService.askGiuno.

'use strict';

var logger = require('../utils/logger');
var { askGiuno } = require('../services/anthropicService');
var db = require('../../supabase');

// Pattern for implicit action references
var IMPLICIT_REFS = /^(mandalo?|fallo?|invialo?|aggiornalo?|procedi|ok fai|sì fai|si fai|vai|conferm[oa]|esegui)[\s!.]*$/i;

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
    var convKey = ctx.userId + ':' + (ctx.threadTs || 'dm');

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
      var enrichedMessage = '[CONTESTO: nel messaggio precedente hai proposto questa azione: "' +
        String(lastAssistant).substring(0, 500) + '"]\n\n' +
        'L\'utente ora dice: "' + message + '"\n' +
        'Esegui l\'azione proposta nel contesto usando il tool appropriato (es. send_dm). NON inventare azioni non proposte.';
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
