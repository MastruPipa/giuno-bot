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

  // Start Slack in Socket Mode
  await app.start();
  logger.info('Giuno Bolt app avviata in Socket Mode');
  logger.info('SLACK_USER_TOKEN presente:', !!process.env.SLACK_USER_TOKEN);
  logger.info('SLACK_BOT_TOKEN presente:', !!process.env.SLACK_BOT_TOKEN);

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
