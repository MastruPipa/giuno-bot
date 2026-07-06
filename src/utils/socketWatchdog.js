// ─── Socket Mode Watchdog ──────────────────────────────────────────────────────
// Il crash-guard in index.js tiene vivo il processo anche quando qualcosa va
// storto dentro @slack/socket-mode: il risultato è uno "zombie" — i cron
// continuano a inviare messaggi via Web API (HTTPS in uscita) ma la websocket
// che RICEVE gli eventi è morta, quindi il bot non risponde più a messaggi,
// mention e bottoni. È successo la mattina del 6/7: daily brief e richieste
// standup inviati regolarmente, ma nessuna risposta agli utenti per ~50 minuti.
//
// Qui la strategia è l'inverso del crash-guard: se la connessione Socket Mode
// resta giù oltre il periodo di grazia, uscire con exit(1) è la cosa GIUSTA —
// Railway (restartPolicyType ALWAYS) riavvia il processo e la connessione
// riparte pulita. Meglio 30 secondi di riavvio che ore di zombie.
'use strict';

var logger = require('./logger');

var GRACE_MS = parseInt(process.env.SOCKET_WATCHDOG_GRACE_MS, 10) || 3 * 60 * 1000;

// app.receiver.client è il SocketModeClient di Bolt (emette 'connected' /
// 'disconnected' a ogni ciclo di vita della websocket, riconnessioni comprese).
function arm(app) {
  var client = app && app.receiver && app.receiver.client;
  if (!client || typeof client.on !== 'function') {
    logger.warn('[SOCKET-WATCHDOG] SocketModeClient non trovato — watchdog NON attivo.');
    return;
  }

  var exitTimer = null;

  // 'reconnecting' incluso: un loop di riconnessioni che falliscono all'infinito
  // non passa mai dallo stato 'disconnected' — senza questo il watchdog non
  // scatterebbe proprio nel caso che deve coprire.
  function onDown(stato) {
    if (exitTimer) return;
    logger.warn('[SOCKET-WATCHDOG] Socket Mode ' + stato + ' — se non recupera entro',
      Math.round(GRACE_MS / 60000), 'minuti riavvio il processo.');
    exitTimer = setTimeout(function() {
      logger.error('[SOCKET-WATCHDOG] Socket Mode giù da', Math.round(GRACE_MS / 60000),
        'minuti senza riconnessione — exit(1) per farmi riavviare da Railway.');
      process.exit(1);
    }, GRACE_MS);
  }

  client.on('disconnected', function() { onDown('disconnesso'); });
  client.on('reconnecting', function() { onDown('in riconnessione'); });

  client.on('connected', function() {
    if (!exitTimer) return;
    clearTimeout(exitTimer);
    exitTimer = null;
    logger.info('[SOCKET-WATCHDOG] Socket Mode riconnesso, watchdog rientrato.');
  });

  logger.info('[SOCKET-WATCHDOG] Attivo — grazia', Math.round(GRACE_MS / 60000), 'minuti.');
}

module.exports = { arm: arm };
