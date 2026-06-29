'use strict';
// Entry point — all logic lives in src/

// ─── Global crash safety net ───────────────────────────────────────────────────
// Installato PRIMA di require('./src/app.js') così è attivo prima che i require
// avviino timer, socket e cron (i loro side-effect partono al caricamento).
//
// Perché serve: su Node 15+ una singola promise rifiutata e non gestita
// (una `.then()` senza `.catch()`, un async lanciato da una callback non
// awaited, un errore che sfugge da un listener Slack/Bolt) TERMINA il processo.
// I batch più pesanti girano di notte (storico 01:00, knowledge engine +
// consolidamento 02:00, graph/KB 03:00, decay/backfill 04:00-04:30, sweep
// 05:00) contro servizi esterni: è lì che capita, e senza supervisor il bot
// resta giù fino al mattino. Qui logghiamo e restiamo vivi invece di morire:
// per un bot long-running sopravvivere e loggare è meglio del crash silenzioso.
var logger = require('./src/utils/logger');

process.on('unhandledRejection', function (reason) {
  logger.error('[FATAL-GUARD] unhandledRejection — il bot resta vivo:',
    (reason && reason.stack) || (reason && reason.message) || reason);
});

process.on('uncaughtException', function (err) {
  logger.error('[FATAL-GUARD] uncaughtException — il bot resta vivo:',
    (err && err.stack) || (err && err.message) || err);
});

require('./src/app.js');
