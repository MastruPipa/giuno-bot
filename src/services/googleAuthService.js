// ─── Google Auth Service ───────────────────────────────────────────────────────
// All Google OAuth logic: token management, per-user API client factories,
// OAuth URL generation, token expiry handling.

'use strict';

require('dotenv').config();

var fs = require('fs');
var google = require('googleapis').google;
var db = require('../../supabase');
var logger = require('../utils/logger');

// ─── Load credentials ──────────────────────────────────────────────────────────

var webCreds = null;
try { webCreds = JSON.parse(fs.readFileSync('credentials-web.json')).web; } catch(e) {}

var GOOGLE_CLIENT_ID     = (webCreds && webCreds.client_id)     || process.env.GOOGLE_CLIENT_ID;
var GOOGLE_CLIENT_SECRET = (webCreds && webCreds.client_secret) || process.env.GOOGLE_CLIENT_SECRET;
var OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI;
if (!OAUTH_REDIRECT_URI) {
  // Fallback a credentials-web.json solo se non è n8n
  var credsUri = webCreds && webCreds.redirect_uris && webCreds.redirect_uris[0];
  if (credsUri && !credsUri.includes('n8n')) {
    OAUTH_REDIRECT_URI = credsUri;
  } else {
    OAUTH_REDIRECT_URI = 'http://localhost:3000/oauth/callback';
  }
}

var GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/presentations.readonly',
];

// Default shared OAuth2 client (for service-level Drive/Docs)
var oAuth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URI);
oAuth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

logger.info('Google client ID presente:', !!GOOGLE_CLIENT_ID);
logger.info('Google refresh token presente:', !!process.env.GOOGLE_REFRESH_TOKEN);
logger.info('OAuth redirect URI:', OAUTH_REDIRECT_URI);

// ─── Token store (thin wrappers over db) ──────────────────────────────────────

function getUserTokens() { return db.getTokenCache(); }

function salvaTokenUtente(slackUserId, refreshToken) {
  db.saveToken(slackUserId, refreshToken);
}

function rimuoviTokenUtente(slackUserId) {
  db.removeToken(slackUserId);
  logger.warn('Token rimosso per utente:', slackUserId);
}

// ─── OAuth URL generation ─────────────────────────────────────────────────────

function generaLinkOAuth(slackUserId) {
  var authClient = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URI);
  return authClient.generateAuthUrl({
    access_type: 'offline',
    scope: GOOGLE_SCOPES,
    state: slackUserId,
    prompt: 'consent',
  });
}

// ─── Per-user API client factories ────────────────────────────────────────────

function getAuthPerUtente(slackUserId) {
  var refreshToken = getUserTokens()[slackUserId];
  if (!refreshToken) return null;
  var auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URI);
  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}

function getCalendarPerUtente(slackUserId) {
  var auth = getAuthPerUtente(slackUserId);
  return auth ? google.calendar({ version: 'v3', auth: auth }) : null;
}

function getGmailPerUtente(slackUserId) {
  var auth = getAuthPerUtente(slackUserId);
  return auth ? google.gmail({ version: 'v1', auth: auth }) : null;
}

function getDrivePerUtente(slackUserId) {
  var auth = getAuthPerUtente(slackUserId);
  return auth ? google.drive({ version: 'v3', auth: auth }) : null;
}

function getDocsPerUtente(slackUserId) {
  var auth = getAuthPerUtente(slackUserId);
  return auth ? google.docs({ version: 'v1', auth: auth }) : null;
}

function getSheetPerUtente(slackUserId) {
  var auth = getAuthPerUtente(slackUserId);
  return auth ? google.sheets({ version: 'v4', auth: auth }) : null;
}

function getSlidesPerUtente(slackUserId) {
  var auth = getAuthPerUtente(slackUserId);
  return auth ? google.slides({ version: 'v1', auth: auth }) : null;
}

// ─── Token expiry handler ─────────────────────────────────────────────────────
// Requires Slack app client injected to avoid circular deps.
// Call setSlackApp(app) from app.js after Slack is initialised.

var _slackApp = null;

function setSlackApp(app) {
  _slackApp = app;
}

async function handleTokenScaduto(slackUserId, err) {
  var msg = (err.message || '') + (err.code || '');
  var scaduto = msg.includes('invalid_grant') || msg.includes('Token has been expired') ||
    msg.includes('invalid_rapt') || String(err.code) === '401';
  if (!scaduto) return false;
  rimuoviTokenUtente(slackUserId);
  if (_slackApp) {
    try {
      await _slackApp.client.chat.postMessage({
        channel: slackUserId,
        text: 'Il tuo token Google è scaduto. Scrivi "collega il mio Google" per riautenticarti.',
      });
    } catch(e) { logger.error('Errore DM token scaduto:', e.message); }
  }
  return true;
}

module.exports = {
  GOOGLE_SCOPES: GOOGLE_SCOPES,
  GOOGLE_CLIENT_ID: GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: GOOGLE_CLIENT_SECRET,
  OAUTH_REDIRECT_URI: OAUTH_REDIRECT_URI,
  oAuth2Client: oAuth2Client,
  getUserTokens: getUserTokens,
  salvaTokenUtente: salvaTokenUtente,
  rimuoviTokenUtente: rimuoviTokenUtente,
  generaLinkOAuth: generaLinkOAuth,
  getAuthPerUtente: getAuthPerUtente,
  getCalendarPerUtente: getCalendarPerUtente,
  getGmailPerUtente: getGmailPerUtente,
  getDrivePerUtente: getDrivePerUtente,
  getDocsPerUtente: getDocsPerUtente,
  getSheetPerUtente: getSheetPerUtente,
  getSlidesPerUtente: getSlidesPerUtente,
  handleTokenScaduto: handleTokenScaduto,
  setSlackApp: setSlackApp,
};
