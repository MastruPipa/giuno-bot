// ─── MCP Connections — OAuth 2.1 verso server MCP remoti ─────────────────────
// Giuno usa il connettore MCP dell'API Anthropic: dichiara il server nella
// richiesta e i suoi tool compaiono accanto a quelli interni. Il server però
// vuole un bearer token, e i server MCP moderni (Higgsfield incluso) lo danno
// solo via OAuth con login nel browser. Qui vive tutto il ciclo:
//
//   discover   → /.well-known/oauth-authorization-server del server
//   register   → registrazione dinamica del client (RFC 7591), una volta
//   startAuth  → URL di autorizzazione con PKCE S256 + state legato all'utente
//   callback   → scambio code→token, salvataggio access/refresh/expires
//   getToken   → token valido, con refresh automatico prima della scadenza
//
// Un solo account per connessione (es. il Higgsfield di Antonio per tutto il
// team). Persistenza in Supabase (tabella mcp_connections) con fallback JSON.
// Le funzioni pure (PKCE, URL, scadenza) sono testabili senza rete.

'use strict';

var crypto = require('crypto');
var logger = require('../utils/logger');

var SERVERS = {
  higgsfield: {
    name: 'higgsfield',
    label: 'Higgsfield',
    mcpUrl: process.env.HIGGSFIELD_MCP_URL || 'https://mcp.higgsfield.ai/mcp',
    scope: 'openid email offline_access',
  },
};

var _connections = {};      // name -> row
var _metadata = {};         // origin -> discovery doc
var _pendingStates = {};    // state -> { name, verifier, slackUserId, createdAt }
var STATE_TTL_MS = 10 * 60 * 1000;
var REFRESH_SKEW_MS = 60 * 1000;
var HTTP_TIMEOUT_MS = 10000;

function getServer(name) { return SERVERS[name] || null; }
function listServers() { return Object.keys(SERVERS).map(function(k) { return SERVERS[k]; }); }

// ─── Persistenza ─────────────────────────────────────────────────────────────

function _db() { return require('./db/client'); }

async function loadConnections() {
  var c = _db();
  if (!c.useSupabase) { _connections = c.readJSON('mcp_connections.json', {}); return _connections; }
  try {
    var res = await c.getClient().from('mcp_connections').select('*');
    _connections = {};
    (res.data || []).forEach(function(r) { _connections[r.name] = r; });
  } catch(e) {
    if (!/mcp_connections/i.test(String(e && e.message || ''))) logger.warn('[MCP-CONN] load fallito:', e.message);
    _connections = {};
  }
  return _connections;
}

async function _save(row) {
  row.updated_at = new Date().toISOString();
  _connections[row.name] = row;
  var c = _db();
  if (!c.useSupabase) { c.writeJSON('mcp_connections.json', _connections); return; }
  try {
    var res = await c.getClient().from('mcp_connections').upsert(row, { onConflict: 'name' });
    if (res && res.error) throw res.error;
  } catch(e) {
    // Tabella assente (migrazione non applicata): la connessione vive solo in
    // memoria e va rifatta a ogni riavvio — meglio avvisare forte.
    logger.warn('[MCP-CONN] salvataggio ' + row.name + ' fallito (esegui la migrazione mcp_connections?):', e.message);
  }
}

function getConnection(name) { return _connections[name] || null; }

// ─── Funzioni pure ───────────────────────────────────────────────────────────

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makePkce() {
  var verifier = b64url(crypto.randomBytes(48));
  var challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier: verifier, challenge: challenge };
}

function buildAuthorizeUrl(meta, params) {
  var u = new URL(meta.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', params.clientId);
  u.searchParams.set('redirect_uri', params.redirectUri);
  u.searchParams.set('scope', params.scope);
  u.searchParams.set('state', params.state);
  u.searchParams.set('code_challenge', params.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (params.resource) u.searchParams.set('resource', params.resource); // RFC 8707, richiesto dalla spec MCP
  return u.toString();
}

function isExpired(row, nowMs) {
  if (!row || !row.access_token) return true;
  if (!row.expires_at) return false;
  var t = new Date(row.expires_at).getTime();
  return isNaN(t) || (t - (nowMs || Date.now())) < REFRESH_SKEW_MS;
}

// redirect base: prende OAUTH_REDIRECT_URI di Google (…/oauth/callback) e ne
// usa l'origine, così l'endpoint MCP vive sullo stesso host.
function redirectUriFor(name, googleRedirectUri) {
  var base = googleRedirectUri || process.env.OAUTH_REDIRECT_URI || 'http://localhost:3000/oauth/callback';
  var u = new URL(base);
  return u.origin + '/oauth/mcp/' + name + '/callback';
}

// ─── Rete ────────────────────────────────────────────────────────────────────

async function _fetchJson(url, opts) {
  var ctrl = new AbortController();
  var timer = setTimeout(function() { ctrl.abort(); }, HTTP_TIMEOUT_MS);
  try {
    var res = await fetch(url, Object.assign({ signal: ctrl.signal }, opts || {}));
    var text = await res.text();
    var json = null;
    try { json = text ? JSON.parse(text) : null; } catch(_) {}
    if (!res.ok) {
      var err = new Error('HTTP ' + res.status + ' ' + (json && (json.error_description || json.error) || text.substring(0, 200)));
      err.status = res.status;
      throw err;
    }
    return json;
  } finally { clearTimeout(timer); }
}

async function discover(name) {
  var srv = getServer(name);
  if (!srv) throw new Error('Server MCP sconosciuto: ' + name);
  var origin = new URL(srv.mcpUrl).origin;
  if (_metadata[origin]) return _metadata[origin];
  var meta = await _fetchJson(origin + '/.well-known/oauth-authorization-server');
  if (!meta || !meta.authorization_endpoint || !meta.token_endpoint) throw new Error('Metadati OAuth non validi da ' + origin);
  _metadata[origin] = meta;
  return meta;
}

async function ensureClient(name, redirectUri) {
  var row = getConnection(name);
  if (row && row.client_id) return row;
  var srv = getServer(name);
  var meta = await discover(name);
  if (!meta.registration_endpoint) throw new Error('Il server ' + name + ' non supporta la registrazione dinamica del client');
  var reg = await _fetchJson(meta.registration_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Giuno (Katania Studio)',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: srv.scope,
    }),
  });
  if (!reg || !reg.client_id) throw new Error('Registrazione client fallita per ' + name);
  row = Object.assign({}, row || {}, {
    name: name, mcp_url: srv.mcpUrl, client_id: reg.client_id, client_secret: reg.client_secret || null,
    scope: srv.scope,
  });
  await _save(row);
  logger.info('[MCP-CONN] client registrato per', name);
  return row;
}

// Ritorna l'URL a cui mandare la persona. state → { name, verifier, slackUserId }.
async function startAuth(name, opts) {
  opts = opts || {};
  var srv = getServer(name);
  if (!srv) throw new Error('Server MCP sconosciuto: ' + name);
  var redirectUri = opts.redirectUri || redirectUriFor(name, opts.googleRedirectUri);
  var row = await ensureClient(name, redirectUri);
  var meta = await discover(name);
  var pkce = makePkce();
  var state = b64url(crypto.randomBytes(24));
  _pendingStates[state] = { name: name, verifier: pkce.verifier, slackUserId: opts.slackUserId || null, redirectUri: redirectUri, createdAt: Date.now() };
  _prunePending();
  return buildAuthorizeUrl(meta, {
    clientId: row.client_id, redirectUri: redirectUri, scope: srv.scope,
    state: state, challenge: pkce.challenge, resource: srv.mcpUrl,
  });
}

function _prunePending() {
  var cutoff = Date.now() - STATE_TTL_MS;
  Object.keys(_pendingStates).forEach(function(k) { if (_pendingStates[k].createdAt < cutoff) delete _pendingStates[k]; });
}

function _tokenBody(row, fields) {
  var body = new URLSearchParams(fields);
  body.set('client_id', row.client_id);
  if (row.client_secret) body.set('client_secret', row.client_secret);
  return body;
}

function _applyToken(row, tok) {
  row.access_token = tok.access_token;
  if (tok.refresh_token) row.refresh_token = tok.refresh_token;
  row.expires_at = tok.expires_in ? new Date(Date.now() + Number(tok.expires_in) * 1000).toISOString() : null;
  if (tok.scope) row.scope = tok.scope;
  return row;
}

async function handleCallback(code, state) {
  var pending = _pendingStates[state];
  if (!pending) throw new Error('State OAuth sconosciuto o scaduto: riapri il link di collegamento.');
  delete _pendingStates[state];
  var srv = getServer(pending.name);
  var row = getConnection(pending.name);
  var meta = await discover(pending.name);
  var tok = await _fetchJson(meta.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: _tokenBody(row, {
      grant_type: 'authorization_code', code: code, redirect_uri: pending.redirectUri,
      code_verifier: pending.verifier, resource: srv.mcpUrl,
    }),
  });
  if (!tok || !tok.access_token) throw new Error('Il server non ha restituito un access token');
  _applyToken(row, tok);
  row.connected_by = pending.slackUserId || row.connected_by || null;
  row.connected_at = new Date().toISOString();
  await _save(row);
  logger.info('[MCP-CONN]', pending.name, 'collegato da', row.connected_by, '| refresh:', !!row.refresh_token, '| scade:', row.expires_at || 'mai');
  return { name: pending.name, slackUserId: pending.slackUserId, label: srv.label };
}

async function refresh(name) {
  var row = getConnection(name);
  if (!row || !row.refresh_token) return null;
  var srv = getServer(name);
  var meta = await discover(name);
  try {
    var tok = await _fetchJson(meta.token_endpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: _tokenBody(row, { grant_type: 'refresh_token', refresh_token: row.refresh_token, resource: srv.mcpUrl }),
    });
    if (!tok || !tok.access_token) throw new Error('refresh senza access token');
    _applyToken(row, tok);
    await _save(row);
    logger.info('[MCP-CONN] token', name, 'rinnovato, scade', row.expires_at || 'mai');
    return row.access_token;
  } catch(e) {
    logger.warn('[MCP-CONN] refresh', name, 'fallito:', e.message);
    if (e.status === 400 || e.status === 401) {
      // Refresh token revocato/scaduto: serve un nuovo login. Teniamo il
      // client_id, buttiamo i token così getStatus dice "da ricollegare".
      row.access_token = null; row.refresh_token = null; row.expires_at = null;
      await _save(row);
    }
    return null;
  }
}

// Token valido o null (non collegato / da ricollegare).
async function getAccessToken(name) {
  var row = getConnection(name);
  if (!row || !row.access_token) return null;
  if (!isExpired(row)) return row.access_token;
  return refresh(name);
}

function getStatus(name) {
  var srv = getServer(name);
  var row = getConnection(name);
  return {
    name: name, label: srv ? srv.label : name, mcp_url: srv ? srv.mcpUrl : null,
    registered: !!(row && row.client_id),
    connected: !!(row && (row.access_token || row.refresh_token)),
    needs_reconnect: !!(row && row.client_id && !row.access_token && !row.refresh_token),
    connected_by: row ? row.connected_by : null,
    connected_at: row ? row.connected_at : null,
    expires_at: row ? row.expires_at : null,
    has_refresh: !!(row && row.refresh_token),
  };
}

async function disconnect(name) {
  var row = getConnection(name);
  if (!row) return;
  row.access_token = null; row.refresh_token = null; row.expires_at = null;
  await _save(row);
}

// Solo per i test: stato in memoria pulito e metadati preimpostati.
function _resetForTests(seed) {
  _connections = (seed && seed.connections) || {};
  _metadata = (seed && seed.metadata) || {};
  _pendingStates = {};
}

module.exports = {
  SERVERS: SERVERS,
  getServer: getServer,
  listServers: listServers,
  loadConnections: loadConnections,
  getConnection: getConnection,
  makePkce: makePkce,
  buildAuthorizeUrl: buildAuthorizeUrl,
  isExpired: isExpired,
  redirectUriFor: redirectUriFor,
  discover: discover,
  ensureClient: ensureClient,
  startAuth: startAuth,
  handleCallback: handleCallback,
  refresh: refresh,
  getAccessToken: getAccessToken,
  getStatus: getStatus,
  disconnect: disconnect,
  _pendingStates: function() { return _pendingStates; },
  _resetForTests: _resetForTests,
};
