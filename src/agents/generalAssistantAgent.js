// ─── General Assistant Agent ───────────────────────────────────────────────────
// Fallback agent: full tool access. Delegates to anthropicService.askGiuno,
// passing along the Slack transcript and the retrieved context built by the
// orchestrator so askGiuno doesn't have to re-fetch anything.

'use strict';

var logger = require('../utils/logger');
var { askGiuno } = require('../services/anthropicService');
var { formatContextForPrompt } = require('../orchestrator/contextBuilder');
var db = require('../../supabase');

// Conferme secche ("sì", "ok", "va bene", "procedi"...). Ancorato all'intero
// messaggio: solo conferme pure, non frasi con contenuto proprio.
var IMPLICIT_REFS = /^(s[iì]|s[iì]\s*s[iì]|s[iì]\s*(fai|dai|grazie|procedi|certo|vai)|ok|okay|va bene|vabb[eè]|d'?accordo|daccordo|certo|esatto|perfetto|confermo|conferma|confermato|procedi( pure)?|vai( pure| così)?|dai|fallo?|invialo?|mandalo?|aggiornalo?|esegui|yes|yep|sure|ci sta)[\s!.,]*$/i;

function buildOptions(ctx) {
  var retrieved = '';
  try { retrieved = formatContextForPrompt(ctx) || ''; } catch(e) { logger.debug('[GENERAL-AGENT] formatContext:', e.message); }
  return {
    threadTs:             ctx.threadTs,
    channelId:            ctx.channelId,
    channelContext:       ctx.channelContext,
    mentionedBy:          ctx.mentionedBy,
    channelType:          ctx.channelType,
    isDM:                 ctx.isDM,
    sentiment:            ctx.sentiment || null,
    preflightInstruction: ctx.preflightInstruction || null,
    transcript:           Array.isArray(ctx.conversationHistory) ? ctx.conversationHistory : null,
    retrievedContext:     retrieved,
    retrievedMemories:    (ctx.relevantMemories || []).map(function(m) { return m && m.content; }).filter(Boolean),
    allowSilence:         !!ctx.allowSilence,
    isCC:                 !!ctx.isCC,
  };
}

/**
 * run — executes the general assistant for any message.
 */
async function run(message, ctx) {
  var options = buildOptions(ctx);
  var hasTranscript = options.transcript && options.transcript.length > 0;

  // Con il thread Slack come storia, una conferma secca è già risolvibile dal
  // modello. Il recupero "manuale" serve solo quando la storia non c'è
  // (Slack non raggiungibile, slash command, primo messaggio dopo un riavvio
  // senza DB).
  if (!hasTranscript && IMPLICIT_REFS.test((message || '').trim())) {
    var convKey = require('../services/slackTranscript').conversationKey({
      userId: ctx.userId, threadTs: ctx.threadTs, channelId: ctx.channelId, isDM: ctx.isDM,
    });

    var convCache = db.getConvCache();
    var conv = convCache[convKey] || [];
    var lastAssistant = null;
    for (var i = conv.length - 1; i >= 0; i--) {
      if (conv[i].role === 'assistant') { lastAssistant = conv[i].content; break; }
    }

    if (!lastAssistant) {
      try {
        var summary = await db.getConversationSummary(convKey);
        if (summary && summary.proposed_actions && summary.proposed_actions.length > 0) {
          var lastAction = summary.proposed_actions[summary.proposed_actions.length - 1];
          options.preflightInstruction = ((options.preflightInstruction || '') +
            '\n[CONTEXT RECOVERY] L\'utente dice "' + message + '" riferendosi a questa azione proposta in precedenza: ' +
            JSON.stringify(lastAction) + (summary.summary ? '\nContesto: ' + summary.summary.substring(0, 300) : '') +
            '\nEsegui l\'azione col tool appropriato. NON inventare azioni non proposte.').trim();
          return await askGiuno(ctx.userId, message, options);
        }
      } catch(e) {
        logger.warn('[GENERAL-AGENT] context recovery fallito:', e.message);
      }
    }

    if (lastAssistant) {
      options.preflightInstruction = ((options.preflightInstruction || '') +
        '\n[CONTINUITÀ] Il tuo messaggio precedente era: "' + String(lastAssistant).substring(0, 800) + '". ' +
        'L\'utente ora conferma/risponde a quello: prosegui di conseguenza (se avevi proposto un\'azione concreta, eseguila col tool giusto). ' +
        'Non dire che manca il contesto e non inventare azioni non proposte.').trim();
      return await askGiuno(ctx.userId, message, options);
    }

    try {
      var mem = await db.searchMemories(ctx.userId, 'pending in attesa conferma da fare reminder');
      if (mem && mem.length > 0) {
        options.preflightInstruction = ((options.preflightInstruction || '') +
          '\n[CONTEXT RECOVERY] L\'utente dice "' + message + '". Possibile azione recente: "' +
          String(mem[0].content || '').substring(0, 300) + '". Se è chiaro esegui col tool corretto, altrimenti chiedi.').trim();
        return await askGiuno(ctx.userId, message, options);
      }
    } catch(e) {
      logger.warn('[GENERAL-AGENT] context recovery memory error:', e.message);
    }

    return 'Perfetto, ma mi manca il contesto: quale azione devo eseguire esattamente e per chi?';
  }

  return await askGiuno(ctx.userId, message, options);
}

module.exports = { run: run, buildOptions: buildOptions };
