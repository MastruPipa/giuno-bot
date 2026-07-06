// ─── App Bootstrap ─────────────────────────────────────────────────────────────
// Initialises all services, registers handlers, starts listeners.
// v2.2 — Runtime env validation + lazy service loading for safer startup

'use strict';

var logger = require('./utils/logger');
var runtimeConfig = require('./config/runtime');
var googleAuth = require('./services/googleAuthService');
var oauthHandler = require('./handlers/oauthHandler');
var cronHandlers = require('./handlers/cronHandlers');
var realTimeListener = require('./listeners/realTimeListener');

async function main() {
  runtimeConfig.validateEnv([
    'SLACK_BOT_TOKEN',
    'SLACK_SIGNING_SECRET',
    'SLACK_APP_TOKEN',
  ], 'APP_BOOT');

  // Importing slackHandlers registers all app.event / app.message / app.command
  // handlers onto the Bolt app as a side-effect of require().
  var slackService = require('./services/slackService');
  var slackHandlers = require('./handlers/slackHandlers');

  var db = require('../supabase');
  var app = slackService.app;

  // Load token cache from Supabase/JSON before anything else
  try {
    await db.initAll();
    logger.info('Token cache caricata');
  } catch (e) {
    logger.error('Errore caricamento cache (app parte comunque):', e.message);
  }

  // Rehydrate in-memory standup state from persisted cache. Must run AFTER
  // db.initAll() otherwise getStandupCache() returns an empty cache.
  try { slackHandlers.rehydrateStandupInAttesa(); } catch(e) { logger.warn('rehydrateStandupInAttesa:', e.message); }

  // Inject Bolt app into googleAuthService (needed for token-expiry DMs)
  googleAuth.setSlackApp(app);

  // Wire stats object into oauthHandler dashboard
  oauthHandler.setStats(slackHandlers.stats);

  // Register real-time listener BEFORE app.start()
  realTimeListener.register(app);

  // Workload & progress tracking: Weekly Planner + Daily Check-in
  require('./handlers/weeklyPlanner').register(app);
  require('./handlers/timeTracking').register(app);

  // Start Slack in Socket Mode
  await app.start();
  logger.info('Giuno Bolt app avviata in Socket Mode');

  // Se la websocket muore e non si riprende, meglio riavviare che restare zombie
  require('./utils/socketWatchdog').arm(app);

  // Shutdown rapido su SIGTERM/SIGINT: durante un redeploy Railway tiene in vita
  // il container vecchio finché il nuovo non è su — se il vecchio non esce in
  // fretta, per qualche minuto girano DUE istanze e i cron senza lock partono
  // doppi (il check-in mensile del 6/7 è arrivato due volte a mezzo team).
  ['SIGTERM', 'SIGINT'].forEach(function(sig) {
    process.on(sig, function() {
      logger.info('[SHUTDOWN] Ricevuto ' + sig + ' — chiudo Socket Mode ed esco.');
      var hardExit = setTimeout(function() { process.exit(0); }, 5000);
      if (hardExit.unref) hardExit.unref();
      Promise.resolve()
        .then(function() { return app.stop(); })
        .then(function() { process.exit(0); })
        .catch(function() { process.exit(0); });
    });
  });
  logger.info('SLACK_USER_TOKEN presente:', !!process.env.SLACK_USER_TOKEN);
  logger.info('SLACK_BOT_TOKEN presente:', !!process.env.SLACK_BOT_TOKEN);
  logger.info('ATTIO_API_KEY presente:', !!process.env.ATTIO_API_KEY,
    '— se false, il bot NON legge il CRM Attio e ripiega su memoria/leads (dati potenzialmente vecchi).');

  // Self-test Attio: "presente" non garantisce che la chiave sia valida.
  // Una query reale al boot rivela SUBITO se Attio risponde (e con quale
  // errore grezzo: 401 chiave invalida, 403 permessi, ecc.), invece di
  // lasciare che ogni chiamata fallisca in silenzio dentro safeCall.
  if (process.env.ATTIO_API_KEY) {
    (async function() {
      try {
        var attioSvc = require('./services/attioService');
        var test = await attioSvc.queryRecords('deals', null, 1);
        logger.info('[ATTIO-SELFTEST] OK — query deals riuscita,', (test || []).length, 'record');
      } catch(e) {
        logger.error('[ATTIO-SELFTEST] FALLITA — il bot NON leggerà il CRM:', (e && e.message) || e,
          '| status:', e && e.status);
      }
    })();
  }

  // Seed del roster team da Slack se vuoto ("team members = tutti"). Usa
  // getUtenti (membri attivi, non-bot, non-eliminati). Le esclusioni di
  // daily/check-in restano gestite a valle per nome, quindi qui mettiamo tutti
  // — il roster serve anche a disambiguare le persone in memoria/CRM.
  try {
    if ((db.getTeamRoster() || []).length === 0) {
      var slackUsers = await slackService.getUtenti();
      var seeded = 0;
      for (var ui = 0; ui < slackUsers.length; ui++) {
        var su = slackUsers[ui];
        if (!su.id || !su.name) continue;
        var firstName = su.name.split(' ')[0];
        var ok = await db.upsertTeamMember({
          slack_user_id: su.id,
          canonical_name: su.name,
          aliases: (firstName && firstName.toLowerCase() !== su.name.toLowerCase()) ? [firstName] : [],
          active: true,
        });
        if (ok) seeded++;
      }
      logger.info('[TEAM-ROSTER] Seed da Slack:', seeded, 'membri inseriti.');
    }
  } catch(e) { logger.warn('[TEAM-ROSTER] seed da Slack fallito:', e.message); }

  // Start OAuth + Dashboard HTTP server
  oauthHandler.startOAuthServer();

  // Schedule all cron jobs
  cronHandlers.scheduleCrons();
  logger.info('Cron jobs schedulati');
}

main().catch(function(err) {
  logger.error('Errore fatale avvio:', err);
  process.exit(1);
});
