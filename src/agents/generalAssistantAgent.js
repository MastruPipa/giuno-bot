// ─── General Assistant Agent ───────────────────────────────────────────────────
// Fallback agent: full tool access. This is essentially the current askGiuno behavior,
// delegated to anthropicService.askGiuno.

'use strict';

var { askGiuno } = require('../services/anthropicService');

/**
 * run — executes the general assistant for any message.
 *
 * @param {string} message
 * @param {object} ctx  — built by contextBuilder
 * @returns {Promise<string>}
 */
async function run(message, ctx) {
  return await askGiuno(ctx.userId, message, {
    threadTs:       ctx.threadTs,
    channelId:      ctx.channelId,
    channelContext: ctx.channelContext,
    mentionedBy:    ctx.mentionedBy,
  });
}

module.exports = { run: run };
