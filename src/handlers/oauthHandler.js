// ─── OAuth Handler ─────────────────────────────────────────────────────────────
// HTTP server for OAuth callback and dashboard.

'use strict';

require('dotenv').config();

var http = require('http');
var url  = require('url');
var google = require('googleapis').google;
var logger = require('../utils/logger');
var { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URI, salvaTokenUtente } = require('../services/googleAuthService');

var OAUTH_PORT = process.env.OAUTH_PORT || 3000;

// Stats reference — set by app.js after slackHandlers loads
var _stats = { startedAt: new Date().toISOString(), messagesHandled: 0, toolCallsTotal: 0 };

function setStats(stats) { _stats = stats; }

// Onboarding — lazy-loaded to avoid circular dep
function inviaOnboardingPersonalizzato(slackUserId) {
  return require('./cronHandlers').inviaOnboardingPersonalizzato(slackUserId);
}

function getUserTokens() {
  return require('../services/googleAuthService').getUserTokens();
}

// ─── HTTP server ───────────────────────────────────────────────────────────────

var oauthServer = http.createServer(async function(req, res) {
  var parsed = url.parse(req.url, true);

  if (parsed.pathname === '/dashboard') {
    var connectedUsers = Object.keys(getUserTokens());
    var rows = connectedUsers.map(function(uid) {
      return '<tr><td>' + uid + '</td><td style="color:green">Collegato</td></tr>';
    }).join('');
    var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Giuno Dashboard</title>' +
      '<style>body{font-family:sans-serif;padding:32px;background:#f5f5f5}' +
      'table{border-collapse:collapse;width:100%;max-width:600px}' +
      'th,td{border:1px solid #ccc;padding:8px 16px;text-align:left}' +
      'th{background:#333;color:#fff}tr:nth-child(even){background:#eee}</style></head><body>' +
      '<h1>Giuno Dashboard</h1>' +
      '<p>Online dal: <b>' + _stats.startedAt + '</b></p>' +
      '<p>Messaggi gestiti: <b>' + _stats.messagesHandled + '</b> | Tool calls: <b>' + _stats.toolCallsTotal + '</b></p>' +
      '<h2>Google collegato (' + connectedUsers.length + ' utenti)</h2>' +
      '<table><thead><tr><th>Slack User ID</th><th>Stato</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '</body></html>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (parsed.pathname !== '/oauth/callback') { res.writeHead(404); res.end('Not found'); return; }

  var code = parsed.query.code;
  var slackUserId = parsed.query.state;
  if (!code || !slackUserId) { res.writeHead(400); res.end('Parametri mancanti.'); return; }

  try {
    var authClient = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URI);
    var tokenResponse = await authClient.getToken(code);
    var tokens = tokenResponse.tokens;

    if (!tokens.refresh_token) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body><h2>Errore: nessun refresh token.</h2><p>Vai su <a href="https://myaccount.google.com/permissions">account Google</a>, rimuovi l\'accesso e riprova.</p></body></html>');
      return;
    }

    await salvaTokenUtente(slackUserId, tokens.refresh_token);
    logger.info('Token salvato per:', slackUserId);

    inviaOnboardingPersonalizzato(slackUserId).catch(function(e) {
      logger.error('Errore onboarding post-auth:', e.message);
    });

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Autorizzazione completata!</h2><p>Puoi chiudere questa finestra e tornare su Slack.</p></body></html>');
  } catch(e) {
    logger.error('Errore OAuth callback:', e.message);
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body><h2>Errore</h2><p>' + e.message + '</p></body></html>');
  }
});

function startOAuthServer() {
  oauthServer.listen(OAUTH_PORT, function() {
    logger.info('OAuth + Dashboard server su porta ' + OAUTH_PORT);
    logger.info('Dashboard: http://localhost:' + OAUTH_PORT + '/dashboard');
  });
}

module.exports = { oauthServer: oauthServer, startOAuthServer: startOAuthServer, setStats: setStats, OAUTH_PORT: OAUTH_PORT };
