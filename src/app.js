// ─── App Bootstrap ─────────────────────────────────────────────────────────────
// Initialises all services, registers handlers, starts listeners.

'use strict';

require('dotenv').config();

var logger       = require('./utils/logger');
var slackService = require('./services/slackService');
var googleAuth   = require('./services/googleAuthService');
var oauthHandler = require('./handlers/oauthHandler');
var cronHandlers = require('./handlers/cronHandlers');

// Importing slackHandlers registers all app.event / app.message / app.command
// handlers onto the Bolt app as a side-effect of require().
var slackHandlers = require('./handlers/slackHandlers');

async function main() {
  var app = slackService.app;

  // Inject Bolt app into googleAuthService (needed for token-expiry DMs)
  googleAuth.setSlackApp(app);

  // Wire stats object into oauthHandler dashboard
  oauthHandler.setStats(slackHandlers.stats);

  // Start Slack in Socket Mode
  await app.start();
  logger.info('Giuno Bolt app avviata in Socket Mode');

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
