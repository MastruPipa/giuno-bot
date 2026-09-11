// ─── OAuth Handler ─────────────────────────────────────────────────────────────
// HTTP server for OAuth callback and dashboard.

'use strict';

require('dotenv').config();

var http = require('http');
var url  = require('url');
var google = require('googleapis').google;
var logger = require('../utils/logger');
var metricsService = require('../services/metricsService');
var { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URI, salvaTokenUtente } = require('../services/googleAuthService');

// Railway (e molti PaaS) iniettano la porta da usare via $PORT. Bindiamo lì
// così l'healthcheck di Railway raggiunge il server; OAUTH_PORT resta come
// override esplicito per dev locale.
// Porte in ascolto. Railway inietta PORT e l'healthcheck la usa, ma il
// dominio pubblico ha una "target port" sua: se resta sulla 3000 di quando il
// bot è nato, /oauth/callback risponde 502 anche con il bot vivo (successo a
// settembre 2026: link Google "il sito va in down"). Quindi su Railway si
// ascolta anche sulla 3000, e al boot si verifica che il dominio risponda.
function resolveListenPorts(env) {
  env = env || process.env;
  var ports = [];
  function add(p) { var n = parseInt(p, 10); if (n > 0 && ports.indexOf(n) === -1) ports.push(n); }
  add(env.PORT);
  add(env.OAUTH_PORT);
  if (ports.length === 0) add(3000);
  if (env.PORT && !env.OAUTH_PORT && (env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID)) add(3000);
  return ports;
}
var OAUTH_PORT = resolveListenPorts(process.env)[0];
var _extraServers = [];
var OAUTH_ADMIN_TOKEN = process.env.OAUTH_ADMIN_TOKEN || '';

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

function isProtectedPath(pathname) {
  return pathname === '/dashboard' || pathname === '/metrics' || pathname === '/debug/search' ||
    pathname === '/dashboard/workload' || pathname === '/export/timelogs.csv';
}

// In produzione (Railway / NODE_ENV=production) senza token le pagine admin
// restano CHIUSE: prima erano aperte a chiunque conoscesse l'URL. In locale
// senza token restano aperte per comodità di sviluppo.
function isProductionEnv() {
  return !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.NODE_ENV === 'production');
}

function isAuthorizedAdminRequest(req, parsed) {
  if (!OAUTH_ADMIN_TOKEN) return !isProductionEnv();
  var headerToken = req.headers['x-admin-token'];
  var queryToken = parsed && parsed.query ? parsed.query.token : null;
  return headerToken === OAUTH_ADMIN_TOKEN || queryToken === OAUTH_ADMIN_TOKEN;
}

// ─── HTTP server ───────────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  var parsed = url.parse(req.url, true);

  if (parsed.pathname === '/giunos' || parsed.pathname.startsWith('/giunos/')) {
    var giunos = require('../giunos/handler').createHandler({
      getClient: function() { return require('../services/db/client').getClient(); },
      authorize: function(req, parsed) {
        return require('../giunos/auth').authorize(req, parsed, process.env.GIUNOS_ACCESS_KEY, isAuthorizedAdminRequest);
      }
    });
    if (await giunos(req, res, parsed)) return;
  }

  // Liveness probe per l'healthcheck di Railway: NON protetto, risposta
  // immediata. Se l'event loop è bloccato (es. un job notturno che stalla)
  // questa smette di rispondere e Railway riavvia il container — cosa che il
  // crash-guard da solo non copre, perché il processo è "vivo" ma appeso.
  if (parsed.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'ok', uptime: Math.round(process.uptime()) }));
    return;
  }

  // ── OAuth per server MCP (Higgsfield): un solo account dello studio ─────────
  //   GET /oauth/mcp/<nome>/start?u=<slackUserId>  → 302 all'authorize del server
  //   GET /oauth/mcp/<nome>/callback?code&state   → scambio token, DM di conferma
  var mcpMatch = /^\/oauth\/mcp\/([a-z0-9_-]+)\/(start|callback)$/.exec(parsed.pathname || '');
  if (mcpMatch) {
    var mcpConnections = require('../services/mcpConnections');
    var mcpName = mcpMatch[1];
    var mcpSrv = mcpConnections.getServer(mcpName);
    if (!mcpSrv) { res.writeHead(404); res.end('Server MCP sconosciuto'); return; }
    try {
      if (mcpMatch[2] === 'start') {
        var starter = parsed.query.u;
        if (!starter) { res.writeHead(400); res.end('Manca il parametro u'); return; }
        var authUrl = await mcpConnections.startAuth(mcpName, { slackUserId: starter, googleRedirectUri: OAUTH_REDIRECT_URI });
        res.writeHead(302, { Location: authUrl });
        res.end();
        return;
      }
      if (parsed.query.error) {
        throw new Error(parsed.query.error + (parsed.query.error_description ? ': ' + parsed.query.error_description : ''));
      }
      if (!parsed.query.code || !parsed.query.state) { res.writeHead(400); res.end('Parametri mancanti.'); return; }
      var conn = await mcpConnections.handleCallback(parsed.query.code, parsed.query.state);
      logger.info('[MCP-OAUTH] ' + mcpSrv.label + ' collegato da ' + conn.connected_by);
      if (conn.connected_by) {
        try {
          var { app: slackApp } = require('../services/slackService');
          await slackApp.client.chat.postMessage({
            channel: conn.connected_by,
            text: '✅ ' + mcpSrv.label + ' collegato: da ora chi è abilitato può chiedermi di generare immagini e video direttamente da Slack (account unico dello studio).',
          });
        } catch(dmErr) { logger.warn('[MCP-OAUTH] DM di conferma fallita:', dmErr.message); }
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>' + mcpSrv.label + ' collegato a Giuno!</h2><p>Puoi chiudere questa finestra e tornare su Slack.</p></body></html>');
    } catch(e) {
      logger.error('[MCP-OAUTH] ' + mcpName + ':', e.message);
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Collegamento ' + mcpSrv.label + ' fallito</h2><p>' + String(e.message).replace(/</g, '&lt;') + '</p><p>Riprova da Slack con <code>/giuno admin ' + mcpName + '</code>.</p></body></html>');
    }
    return;
  }

  if (isProtectedPath(parsed.pathname) && !isAuthorizedAdminRequest(req, parsed)) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

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


  if (parsed.pathname === '/dashboard/workload') {
    try {
      var workloadDashboard = require('./workloadDashboard');
      var workloadHtml = await workloadDashboard.renderWorkloadPage(parsed.query);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(workloadHtml);
    } catch(e) {
      logger.error('Errore dashboard workload:', e.message);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Errore dashboard workload: ' + e.message);
    }
    return;
  }

  if (parsed.pathname === '/export/timelogs.csv') {
    try {
      var workloadDash = require('./workloadDashboard');
      var csv = await workloadDash.renderCsv(parsed.query);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="' + csv.filename + '"',
      });
      res.end(csv.content);
    } catch(e) {
      logger.error('Errore export timelogs:', e.message);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Errore export: ' + e.message);
    }
    return;
  }

  if (parsed.pathname === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      startedAt: _stats.startedAt,
      appStats: _stats,
      counters: metricsService.snapshot(),
    }, null, 2));
    return;
  }

  if (parsed.pathname === '/debug/search') {
    var results = {};
    try {
      results.slack_user_token = !!process.env.SLACK_USER_TOKEN;
      results.slack_bot_token = !!process.env.SLACK_BOT_TOKEN;

      // Test 1: try with WebClient from bolt
      try {
        var WebClient = require('@slack/bolt').WebClient;
        results.webclient_import = 'ok';
        if (process.env.SLACK_USER_TOKEN) {
          var wc = new WebClient(process.env.SLACK_USER_TOKEN);
          var sr = await wc.search.messages({ query: 'test', count: 1 });
          results.webclient_search = 'ok - ' + ((sr.messages && sr.messages.total) || 0) + ' total';
        }
      } catch(e) {
        results.webclient_error = e.message;
      }

      // Test 2: try with app.client + token param
      try {
        var { app } = require('../services/slackService');
        var sr2 = await app.client.search.messages({
          token: process.env.SLACK_USER_TOKEN || process.env.SLACK_BOT_TOKEN,
          query: 'test', count: 1,
        });
        results.appclient_search = 'ok - ' + ((sr2.messages && sr2.messages.total) || 0) + ' total';
      } catch(e) {
        results.appclient_error = e.message;
      }
    } catch(e) {
      results.general_error = e.message;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(results, null, 2));
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
}

var oauthServer = http.createServer(handleRequest);

// ─── Auto-verifica del dominio pubblico ──────────────────────────────────────
// Un minuto dopo il boot chiama <origine di OAUTH_REDIRECT_URI>/healthz: se non
// risponde 200, il collegamento Google e la dashboard sono rotti anche se il
// bot su Slack funziona. Log + DM agli admin, una volta per avvio.

var PUBLIC_SELFCHECK_DELAY_MS = 60000;

function publicOrigin(redirectUri) {
  try {
    var u = new URL(redirectUri || OAUTH_REDIRECT_URI || '');
    if (/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) return null;
    return u.origin;
  } catch(_) { return null; }
}

async function checkPublicReachability(opts) {
  opts = opts || {};
  var origin = publicOrigin(opts.redirectUri);
  if (!origin) return { skipped: true };
  var fetchFn = opts.fetch || fetch;
  var ctrl = new AbortController();
  var timer = setTimeout(function() { ctrl.abort(); }, opts.timeoutMs || 10000);
  try {
    var res = await fetchFn(origin + '/healthz', { signal: ctrl.signal });
    return { ok: res.status === 200, status: res.status, origin: origin };
  } catch(e) {
    return { ok: false, error: e.message, origin: origin };
  } finally { clearTimeout(timer); }
}

function publicUnreachableMessage(result, ports) {
  return 'Il dominio pubblico di Giuno (' + result.origin + ') non risponde (' + (result.status || result.error) + '): ' +
    'il collegamento Google (link OAuth) e la dashboard non funzionano finché non si sistema. ' +
    'Su Railway apri il servizio → Settings → Networking → Public Networking e imposta la porta del dominio su una di quelle in ascolto (' +
    ports.join(', ') + '), oppure imposta la variabile PORT=' + ports[ports.length - 1] + '. Il bot su Slack intanto funziona.';
}

function schedulePublicSelfCheck() {
  if (!publicOrigin()) return;
  var t = setTimeout(async function() {
    var result = await checkPublicReachability();
    if (result.skipped) return;
    if (result.ok) { logger.info('[HTTP] dominio pubblico raggiungibile:', result.origin); return; }
    var msg = publicUnreachableMessage(result, resolveListenPorts(process.env));
    logger.error('[HTTP] ' + msg);
    try {
      var admins = (await require('../../rbac').getAllRoles()).filter(function(r) { return r.role === 'admin'; });
      var { app } = require('../services/slackService');
      for (var i = 0; i < admins.length; i++) {
        await app.client.chat.postMessage({ channel: admins[i].slack_user_id, text: '⚠️ ' + msg });
      }
    } catch(e) { logger.warn('[HTTP] avviso admin fallito:', e.message); }
  }, PUBLIC_SELFCHECK_DELAY_MS);
  t.unref();
}

function startOAuthServer() {
  var ports = resolveListenPorts(process.env);
  ports.forEach(function(port, i) {
    var srv = i === 0 ? oauthServer : http.createServer(handleRequest);
    if (i > 0) _extraServers.push(srv);
    srv.on('error', function(e) { logger.error('[HTTP] porta ' + port + ' non disponibile:', e.message); });
    srv.listen(port, function() {
      logger.info('OAuth + Dashboard server su porta ' + port + (i > 0 ? ' (porta aggiuntiva per il dominio pubblico)' : ''));
    });
  });
  logger.info('Dashboard: http://localhost:' + OAUTH_PORT + '/dashboard');
  if (OAUTH_ADMIN_TOKEN) logger.info('Dashboard/metrics protetti da OAUTH_ADMIN_TOKEN');
  else if (isProductionEnv()) logger.warn('[ADMIN] OAUTH_ADMIN_TOKEN assente: /dashboard e /metrics rispondono 401 finché non lo imposti.');
  else logger.warn('[ADMIN] OAUTH_ADMIN_TOKEN assente: dashboard/metrics APERTI (ambiente non di produzione).');
  schedulePublicSelfCheck();
}

module.exports = {
  oauthServer: oauthServer,
  handleRequest: handleRequest,
  resolveListenPorts: resolveListenPorts,
  checkPublicReachability: checkPublicReachability,
  publicUnreachableMessage: publicUnreachableMessage,
  startOAuthServer: startOAuthServer,
  setStats: setStats,
  OAUTH_PORT: OAUTH_PORT,
  isProtectedPath: isProtectedPath,
  isAuthorizedAdminRequest: isAuthorizedAdminRequest,
};
