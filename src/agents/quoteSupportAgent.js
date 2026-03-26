// ─── Quote Support Agent ───────────────────────────────────────────────────────
// Generates pricing proposals based on rate card, historical quotes, and KB data.
// Triggered by QUOTE_SUPPORT intent or /giuno preventivo.

'use strict';

var logger = require('../utils/logger');
var { checkPermission, getAccessDeniedMessage } = require('../../rbac');

async function run(message, ctx) {
  // RBAC check
  if (!checkPermission(ctx.userRole, 'view_quote_price')) {
    return getAccessDeniedMessage(ctx.userRole);
  }

  logger.info('[QUOTE-SUPPORT] Richiesta da', ctx.userId);

  // TODO: Fase 4 — logica pricing completa
  return 'Quote Support Agent attivo. Logica pricing in arrivo.';
}

module.exports = { run: run };
