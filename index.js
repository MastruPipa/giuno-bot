require('dotenv').config();
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const fs = require('fs');
const http = require('http');
const url = require('url');
const cron = require('node-cron');
const db = require('./supabase');
const { getUserRole, checkPermission, filterQuoteData, getRoleSystemPrompt, invalidateRoleCache, getAccessDeniedMessage, setUserRole, getAllRoles } = require('./rbac');

// ─── Logger ───────────────────────────────────────────────────────────────────

function log(level, ...args) {
  process.stdout.write('[' + new Date().toISOString() + '] [' + level + '] ' + args.join(' ') + '\n');
}
const logger = {
  info:  function(...a) { log('INFO ', ...a); },
  warn:  function(...a) { log('WARN ', ...a); },
  error: function(...a) { log('ERROR', ...a); },
};

// ─── Formattazione Slack ──────────────────────────────────────────────────────

const SLACK_FORMAT_RULES =
  'Formattazione Slack: *grassetto* con singolo asterisco, _corsivo_, ' +
  '`codice`. MAI ** o ##. Liste con • o numeri. Risposte concise.';

function formatPerSlack(text) {
  if (!text) return text;
  return text
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*([^*]+)\*\*/g, '*$1*')
    .replace(/^[ \t]*-\s+/gm, '• ')
    .replace(/^[ \t]*\*\s+(?!\*)/gm, '• ')
    .replace(/```[a-zA-Z]+\n/g, '```\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── Azioni critiche: conferma obbligatoria ──────────────────────────────────

const AZIONI_CRITICHE = ['send_email', 'reply_email', 'forward_email', 'create_event', 'delete_event', 'share_file'];
const confermeInAttesa = new Map(); // convKey -> { toolName, input, toolUseId }
const catalogaConfirm = new Map(); // cataloga_confirm_userId -> { files, userId, channelId, rateCard }

// ─── Slack + Anthropic ────────────────────────────────────────────────────────

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const client = new Anthropic();

// ─── Gemini ──────────────────────────────────────────────────────────────────

let GoogleGenerativeAI = null;
try { GoogleGenerativeAI = require('@google/generative-ai').GoogleGenerativeAI; } catch(e) {
  logger.warn('Modulo @google/generative-ai non installato. Esegui: npm install @google/generative-ai');
}
let gemini = null;
let geminiModel = null;
if (GoogleGenerativeAI && process.env.GEMINI_API_KEY) {
  gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  geminiModel = gemini.getGenerativeModel({ model: 'gemini-2.0-flash' });
  logger.info('Gemini configurato (gemini-2.0-flash)');
} else if (!process.env.GEMINI_API_KEY) {
  logger.warn('GEMINI_API_KEY non presente. Funzioni Gemini disabilitate.');
}

async function askGemini(prompt, systemInstruction) {
  if (!geminiModel) return { error: 'Gemini non configurato. Aggiungi GEMINI_API_KEY al .env.' };
  try {
    var model = systemInstruction
      ? gemini.getGenerativeModel({ model: 'gemini-2.0-flash', systemInstruction: systemInstruction })
      : geminiModel;
    var result = await model.generateContent(prompt);
    return { response: result.response.text() };
  } catch(e) {
    logger.error('Errore Gemini:', e.message);
    return { error: 'Errore Gemini: ' + e.message };
  }
}

// ─── Google OAuth config ──────────────────────────────────────────────────────

let webCreds = null;
try { webCreds = JSON.parse(fs.readFileSync('credentials-web.json')).web; } catch(e) {}

const GOOGLE_CLIENT_ID     = (webCreds && webCreds.client_id)     || process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = (webCreds && webCreds.client_secret) || process.env.GOOGLE_CLIENT_SECRET;
const OAUTH_REDIRECT_URI   = process.env.OAUTH_REDIRECT_URI ||
  (webCreds && webCreds.redirect_uris && webCreds.redirect_uris[0]) ||
  'http://localhost:3000/oauth/callback';
const OAUTH_PORT = process.env.OAUTH_PORT || 3000;

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
];

const oAuth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URI);
oAuth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

logger.info('Google client ID presente:', !!GOOGLE_CLIENT_ID);
logger.info('Google refresh token presente:', !!process.env.GOOGLE_REFRESH_TOKEN);
logger.info('OAuth redirect URI:', OAUTH_REDIRECT_URI);

const drive = google.drive({ version: 'v3', auth: oAuth2Client });
const docs  = google.docs({ version: 'v1', auth: oAuth2Client });

// ─── Token per utente (Supabase) ──────────────────────────────────────────────

function getUserTokens() { return db.getTokenCache(); }

function salvaTokenUtente(slackUserId, refreshToken) {
  db.saveToken(slackUserId, refreshToken);
}

function rimuoviTokenUtente(slackUserId) {
  db.removeToken(slackUserId);
  logger.warn('Token rimosso per utente:', slackUserId);
}

function generaLinkOAuth(slackUserId) {
  const authClient = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URI);
  return authClient.generateAuthUrl({ access_type: 'offline', scope: GOOGLE_SCOPES, state: slackUserId, prompt: 'consent' });
}

function getAuthPerUtente(slackUserId) {
  const refreshToken = getUserTokens()[slackUserId];
  if (!refreshToken) return null;
  const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URI);
  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}

function getCalendarPerUtente(slackUserId) {
  const auth = getAuthPerUtente(slackUserId);
  return auth ? google.calendar({ version: 'v3', auth: auth }) : null;
}

function getGmailPerUtente(slackUserId) {
  const auth = getAuthPerUtente(slackUserId);
  return auth ? google.gmail({ version: 'v1', auth: auth }) : null;
}

function getDrivePerUtente(slackUserId) {
  const auth = getAuthPerUtente(slackUserId);
  return auth ? google.drive({ version: 'v3', auth: auth }) : null;
}

function getDocsPerUtente(slackUserId) {
  const auth = getAuthPerUtente(slackUserId);
  return auth ? google.docs({ version: 'v1', auth: auth }) : null;
}

function getSheetPerUtente(slackUserId) {
  const auth = getAuthPerUtente(slackUserId);
  return auth ? google.sheets({ version: 'v4', auth: auth }) : null;
}

// Gestione token scaduto: rimuove il token e avvisa l'utente via DM
async function handleTokenScaduto(slackUserId, err) {
  const msg = (err.message || '') + (err.code || '');
  const scaduto = msg.includes('invalid_grant') || msg.includes('Token has been expired') ||
    msg.includes('invalid_rapt') || String(err.code) === '401';
  if (!scaduto) return false;
  rimuoviTokenUtente(slackUserId);
  try {
    await app.client.chat.postMessage({
      channel: slackUserId,
      text: 'Il tuo token Google è scaduto. Scrivi "collega il mio Google" per riautenticarti.',
    });
  } catch(e) { logger.error('Errore DM token scaduto:', e.message); }
  return true;
}

// ─── Preferenze utente (Supabase) ─────────────────────────────────────────────

function getPrefs(userId) {
  return Object.assign({ routine_enabled: true, notifiche_enabled: true, standup_enabled: true }, db.getPrefsCache()[userId] || {});
}

function setPrefs(userId, prefs) {
  var merged = Object.assign(getPrefs(userId), prefs);
  db.savePrefs(userId, merged);
}

// ─── Rate limiting ────────────────────────────────────────────────────────────

const rateLimits = new Map();
const RATE_LIMIT  = 20;
const RATE_WINDOW = 60 * 1000;

function checkRateLimit(userId) {
  const now   = Date.now();
  const entry = rateLimits.get(userId);
  if (!entry || now > entry.resetAt) {
    rateLimits.set(userId, { count: 1, resetAt: now + RATE_WINDOW });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

// ─── Persistenza conversazioni (Supabase) ─────────────────────────────────────

function getConversations() { return db.getConvCache(); }

// ─── Memoria persistente (Supabase) ──────────────────────────────────────────

function addMemory(userId, content, tags) {
  db.addMemory(userId, content, tags);
}

function searchMemories(userId, query) {
  return db.searchMemories(userId, query);
}

function deleteMemory(userId, memoryId) {
  return db.deleteMemory(userId, memoryId);
}

// ─── Profili utente (Supabase) ───────────────────────────────────────────────

function getProfile(userId) {
  var profiles = db.getProfileCache();
  if (!profiles[userId]) {
    profiles[userId] = {
      ruolo: null,
      progetti: [],
      clienti: [],
      competenze: [],
      stile_comunicativo: null,
      note: [],
      ultimo_aggiornamento: null,
    };
  }
  return profiles[userId];
}

function updateProfile(userId, updates) {
  var profile = getProfile(userId);
  if (updates.ruolo) profile.ruolo = updates.ruolo;
  if (updates.progetto && !profile.progetti.includes(updates.progetto)) profile.progetti.push(updates.progetto);
  if (updates.cliente && !profile.clienti.includes(updates.cliente)) profile.clienti.push(updates.cliente);
  if (updates.competenza && !profile.competenze.includes(updates.competenza)) profile.competenze.push(updates.competenza);
  if (updates.stile_comunicativo) profile.stile_comunicativo = updates.stile_comunicativo;
  if (updates.nota) profile.note.push(updates.nota);
  if (profile.note.length > 20) profile.note = profile.note.slice(-20);
  profile.ultimo_aggiornamento = new Date().toISOString();
  db.saveProfile(userId, profile);
}

// ─── Knowledge base aziendale (Supabase) ────────────────────────────────────

function addKBEntry(content, tags, addedBy) {
  db.addKBEntry(content, tags, addedBy);
}

function searchKB(query) {
  return db.searchKB(query);
}

function deleteKBEntry(entryId) {
  return db.deleteKBEntry(entryId);
}

// ─── Standup asincrono (Supabase) ─────────────────────────────────────────────

function getStandupData() { return db.getStandupCache(); }
function salvaStandup() { db.saveStandup(db.getStandupCache()); }

const STANDUP_CHANNEL = process.env.STANDUP_CHANNEL || 'daily';
const standupInAttesa = new Set();

// ─── Server OAuth callback ────────────────────────────────────────────────────

// ─── Stats e feedback ─────────────────────────────────────────────────────────

const stats = { startedAt: new Date().toISOString(), messagesHandled: 0, toolCallsTotal: 0 };
const botMessages = new Map(); // ts -> { userId, text }

// ─── OAuth + Dashboard server ─────────────────────────────────────────────────

const oauthServer = http.createServer(async function(req, res) {
  const parsed = url.parse(req.url, true);

  // Dashboard
  if (parsed.pathname === '/dashboard') {
    const connectedUsers = Object.keys(getUserTokens());
    let rows = connectedUsers.map(function(uid) {
      return '<tr><td>' + uid + '</td><td style="color:green">Collegato</td></tr>';
    }).join('');
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Giuno Dashboard</title>' +
      '<style>body{font-family:sans-serif;padding:32px;background:#f5f5f5}' +
      'table{border-collapse:collapse;width:100%;max-width:600px}' +
      'th,td{border:1px solid #ccc;padding:8px 16px;text-align:left}' +
      'th{background:#333;color:#fff}tr:nth-child(even){background:#eee}</style></head><body>' +
      '<h1>Giuno Dashboard</h1>' +
      '<p>Online dal: <b>' + stats.startedAt + '</b></p>' +
      '<p>Messaggi gestiti: <b>' + stats.messagesHandled + '</b> | Tool calls: <b>' + stats.toolCallsTotal + '</b></p>' +
      '<h2>Google collegato (' + connectedUsers.length + ' utenti)</h2>' +
      '<table><thead><tr><th>Slack User ID</th><th>Stato</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '</body></html>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (parsed.pathname !== '/oauth/callback') { res.writeHead(404); res.end('Not found'); return; }

  const code = parsed.query.code;
  const slackUserId = parsed.query.state;
  if (!code || !slackUserId) { res.writeHead(400); res.end('Parametri mancanti.'); return; }

  try {
    const authClient = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URI);
    const tokenResponse = await authClient.getToken(code);
    const tokens = tokenResponse.tokens;

    if (!tokens.refresh_token) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body><h2>Errore: nessun refresh token.</h2><p>Vai su <a href="https://myaccount.google.com/permissions">account Google</a>, rimuovi l\'accesso e riprova.</p></body></html>');
      return;
    }

    salvaTokenUtente(slackUserId, tokens.refresh_token);
    logger.info('Token salvato per:', slackUserId);

    try {
      await app.client.chat.postMessage({
        channel: slackUserId,
        text: 'Google collegato, mbare! Da ora vedo il tuo calendario e le tue email.',
      });
    } catch(e) { logger.error('Errore DM post-auth:', e.message); }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Autorizzazione completata!</h2><p>Puoi chiudere questa finestra e tornare su Slack.</p></body></html>');
  } catch(e) {
    logger.error('Errore OAuth callback:', e.message);
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body><h2>Errore</h2><p>' + e.message + '</p></body></html>');
  }
});

// ─── Tool definitions ─────────────────────────────────────────────────────────

const tools = [
  // Slack
  {
    name: 'get_slack_users',
    description: 'Ottieni utenti Slack con nome, ID e email. Usalo per trovare email di colleghi o ID per taggarli.',
    input_schema: {
      type: 'object',
      properties: {
        name_filter: { type: 'string', description: 'Filtra per nome (opzionale)' },
      },
    },
  },
  // Preferenze utente
  {
    name: 'set_user_prefs',
    description: 'Aggiorna le preferenze dell\'utente per Giuno (routine mattutina, notifiche proattive, standup).',
    input_schema: {
      type: 'object',
      properties: {
        routine_enabled:    { type: 'boolean', description: 'Abilita/disabilita la routine del mattino' },
        notifiche_enabled:  { type: 'boolean', description: 'Abilita/disabilita le notifiche proattive (riunioni imminenti, mail urgenti)' },
        standup_enabled:    { type: 'boolean', description: 'Abilita/disabilita la domanda standup giornaliera' },
      },
    },
  },
  // Calendar
  {
    name: 'list_events',
    description: 'Elenca gli eventi del calendario nei prossimi N giorni.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Giorni da oggi (default 7)' },
      },
    },
  },
  {
    name: 'find_event',
    description: 'Cerca eventi nel calendario per titolo o intervallo di date. Usalo prima di update/delete per trovare l\'ID.',
    input_schema: {
      type: 'object',
      properties: {
        query:     { type: 'string', description: 'Testo nel titolo (opzionale)' },
        date_from: { type: 'string', description: 'Inizio ricerca ISO 8601 (opzionale)' },
        date_to:   { type: 'string', description: 'Fine ricerca ISO 8601 (opzionale)' },
      },
    },
  },
  {
    name: 'create_event',
    description: 'Crea un nuovo evento nel calendario. Date in ISO 8601 con timezone (es. 2025-03-25T10:00:00+01:00).',
    input_schema: {
      type: 'object',
      properties: {
        title:       { type: 'string', description: 'Titolo' },
        start:       { type: 'string', description: 'Inizio ISO 8601' },
        end:         { type: 'string', description: 'Fine ISO 8601' },
        description: { type: 'string', description: 'Descrizione (opzionale)' },
        location:    { type: 'string', description: 'Luogo (opzionale)' },
        attendees:   { type: 'array', items: { type: 'string' }, description: 'Email invitati (opzionale)' },
        force:       { type: 'boolean', description: 'Se true, crea anche se ci sono conflitti di orario' },
      },
      required: ['title', 'start', 'end'],
    },
  },
  {
    name: 'update_event',
    description: 'Modifica titolo, orario, luogo o descrizione di un evento. Usa find_event prima per l\'ID.',
    input_schema: {
      type: 'object',
      properties: {
        event_id:    { type: 'string', description: 'ID evento' },
        title:       { type: 'string', description: 'Nuovo titolo (opzionale)' },
        start:       { type: 'string', description: 'Nuovo inizio ISO 8601 (opzionale)' },
        end:         { type: 'string', description: 'Nuova fine ISO 8601 (opzionale)' },
        description: { type: 'string', description: 'Nuova descrizione (opzionale)' },
        location:    { type: 'string', description: 'Nuovo luogo (opzionale)' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'add_attendees',
    description: 'Aggiunge invitati a un evento e manda notifiche email. Usa find_event prima per l\'ID.',
    input_schema: {
      type: 'object',
      properties: {
        event_id:  { type: 'string', description: 'ID evento' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'Email da aggiungere' },
      },
      required: ['event_id', 'attendees'],
    },
  },
  {
    name: 'delete_event',
    description: 'Elimina un evento. Usa find_event prima per l\'ID.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'ID evento da eliminare' },
      },
      required: ['event_id'],
    },
  },
  // Gmail
  {
    name: 'find_emails',
    description: 'Cerca email nella casella Gmail dell\'utente con una query.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Query Gmail (es. "from:mario is:unread", "subject:preventivo")' },
        max:   { type: 'number', description: 'Numero massimo risultati (default 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_email',
    description: 'Legge il contenuto completo di un\'email dato l\'ID. Usalo prima di reply_email.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'ID del messaggio Gmail' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'reply_email',
    description: 'Risponde a un\'email. Usa read_email prima per leggere il contesto.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'ID del messaggio a cui rispondere' },
        body:       { type: 'string', description: 'Testo della risposta' },
      },
      required: ['message_id', 'body'],
    },
  },
  {
    name: 'send_email',
    description: 'Invia una nuova email. Usa get_slack_users per trovare l\'email del destinatario se serve.',
    input_schema: {
      type: 'object',
      properties: {
        to:      { type: 'string', description: 'Email destinatario' },
        subject: { type: 'string', description: 'Oggetto' },
        body:    { type: 'string', description: 'Testo dell\'email' },
        cc:      { type: 'string', description: 'Email CC (opzionale, separate da virgola)' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'forward_email',
    description: 'Inoltra un\'email a un altro destinatario. Usa read_email prima per leggere il contenuto e get_slack_users per l\'email.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'ID del messaggio da inoltrare' },
        to:         { type: 'string', description: 'Email destinatario a cui inoltrare' },
        note:       { type: 'string', description: 'Nota aggiuntiva in cima all\'email inoltrata (opzionale)' },
      },
      required: ['message_id', 'to'],
    },
  },
  // Memoria
  {
    name: 'save_memory',
    description: 'Salva un\'informazione importante nella memoria permanente dell\'utente. Usalo PROATTIVAMENTE quando l\'utente dice qualcosa che vale la pena ricordare: preferenze clienti, decisioni prese, info di progetto, contatti, procedure.',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Informazione da ricordare' },
        tags:    { type: 'array', items: { type: 'string' }, description: 'Tag per categorizzare (es. "cliente", "progetto-x", "procedura", "contatto")' },
      },
      required: ['content'],
    },
  },
  {
    name: 'recall_memory',
    description: 'Cerca nella memoria permanente dell\'utente. Usalo SEMPRE prima di rispondere a domande su clienti, progetti, procedure, decisioni passate.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Testo o tag da cercare nella memoria' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_memories',
    description: 'Elenca tutte le memorie dell\'utente, opzionalmente filtrate per tag.',
    input_schema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Filtra per tag specifico (opzionale)' },
      },
    },
  },
  {
    name: 'delete_memory',
    description: 'Cancella una memoria specifica per ID.',
    input_schema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: 'ID della memoria da cancellare' },
      },
      required: ['memory_id'],
    },
  },
  // Google Drive
  {
    name: 'search_drive',
    description: 'Cerca file su Google Drive. Supporta ricerca full-text (dentro i documenti), per nome, per tipo, per cartella e per data.',
    input_schema: {
      type: 'object',
      properties: {
        query:       { type: 'string', description: 'Testo da cercare (cerca nel nome E nel contenuto dei file)' },
        name_only:   { type: 'boolean', description: 'Se true, cerca solo nel nome del file (default: false, cerca anche nel contenuto)' },
        mime_type:   { type: 'string', description: 'Filtra per tipo: "document" (Google Docs), "spreadsheet" (Sheets), "presentation" (Slides), "pdf", "image", "folder", oppure MIME completo' },
        folder_name: { type: 'string', description: 'Cerca solo dentro questa cartella (nome cartella)' },
        modified_after:  { type: 'string', description: 'Solo file modificati dopo questa data ISO 8601 (es. "2025-01-01")' },
        modified_before: { type: 'string', description: 'Solo file modificati prima di questa data ISO 8601' },
        shared_with: { type: 'string', description: 'Filtra file condivisi con questa email' },
        max:         { type: 'number', description: 'Numero massimo risultati (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'create_doc',
    description: 'Crea un nuovo Google Doc con titolo e contenuto. Restituisce il link al documento.',
    input_schema: {
      type: 'object',
      properties: {
        title:   { type: 'string', description: 'Titolo del documento' },
        content: { type: 'string', description: 'Contenuto testuale del documento' },
      },
      required: ['title'],
    },
  },
  {
    name: 'share_file',
    description: 'Condivide un file Google Drive con un utente. Usa search_drive prima per trovare l\'ID del file e get_slack_users per l\'email.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'ID del file su Drive' },
        email:   { type: 'string', description: 'Email dell\'utente con cui condividere' },
        role:    { type: 'string', description: 'Ruolo: "reader", "commenter" o "writer" (default "reader")' },
      },
      required: ['file_id', 'email'],
    },
  },
  {
    name: 'read_doc',
    description: 'Legge il contenuto testuale di un Google Doc. Usa search_drive prima per trovare l\'ID del documento.',
    input_schema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', description: 'ID del Google Doc (dalla URL o da search_drive)' },
      },
      required: ['doc_id'],
    },
  },
  // Slack search
  {
    name: 'search_slack_messages',
    description: 'Cerca messaggi nei canali Slack. Utile per ritrovare decisioni, link, o conversazioni passate.',
    input_schema: {
      type: 'object',
      properties: {
        query:   { type: 'string', description: 'Testo da cercare (supporta operatori Slack: in:#canale, from:@utente, before:, after:, has:link)' },
        max:     { type: 'number', description: 'Numero massimo risultati (default 10)' },
      },
      required: ['query'],
    },
  },
  // Profilo utente
  {
    name: 'update_user_profile',
    description: 'Aggiorna il profilo di un utente. Usalo PROATTIVAMENTE quando scopri info su ruolo, progetti, clienti, competenze di un collega.',
    input_schema: {
      type: 'object',
      properties: {
        ruolo:              { type: 'string', description: 'Ruolo dell\'utente (es. "developer", "project manager", "designer")' },
        progetto:           { type: 'string', description: 'Progetto su cui lavora (aggiunge alla lista)' },
        cliente:            { type: 'string', description: 'Cliente che segue (aggiunge alla lista)' },
        competenza:         { type: 'string', description: 'Competenza specifica (es. "React", "SEO", "branding")' },
        stile_comunicativo: { type: 'string', description: 'Descrizione dello stile comunicativo preferito' },
        nota:               { type: 'string', description: 'Nota libera sul profilo' },
      },
    },
  },
  {
    name: 'get_user_profile',
    description: 'Legge il profilo di un utente: ruolo, progetti, clienti, competenze, stile.',
    input_schema: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'ID Slack dell\'utente (opzionale, default utente corrente)' },
      },
    },
  },
  // Knowledge base aziendale
  {
    name: 'add_to_kb',
    description: 'Aggiunge un\'informazione alla knowledge base aziendale condivisa. Usalo per procedure, info clienti, decisioni aziendali che valgono per TUTTI, non per un singolo utente.',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Informazione da salvare' },
        tags:    { type: 'array', items: { type: 'string' }, description: 'Tag (es. "procedura", "cliente-rossi", "hosting", "contratto")' },
      },
      required: ['content'],
    },
  },
  {
    name: 'search_kb',
    description: 'Cerca nella knowledge base aziendale condivisa. Usalo SEMPRE prima di rispondere su procedure aziendali, info clienti condivise, decisioni del team.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Testo da cercare' },
      },
      required: ['query'],
    },
  },
  {
    name: 'delete_from_kb',
    description: 'Cancella un\'informazione dalla knowledge base. Solo su richiesta esplicita.',
    input_schema: {
      type: 'object',
      properties: {
        entry_id: { type: 'string', description: 'ID dell\'entry da cancellare' },
      },
      required: ['entry_id'],
    },
  },
  // Gemini (dual-brain)
  {
    name: 'ask_gemini',
    description: 'Chiedi un parere a Gemini (Google AI). Usalo per avere un secondo punto di vista, cross-check informazioni, o quando serve competenza specifica Google.',
    input_schema: {
      type: 'object',
      properties: {
        prompt:  { type: 'string', description: 'Domanda o richiesta per Gemini' },
        context: { type: 'string', description: 'Contesto aggiuntivo (opzionale)' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'review_content',
    description: 'Gemini rivede un testo/copy e da\' feedback su grammatica, tono, chiarezza, SEO e brand voice. Perfetto per contenuti siti, social, presentazioni.',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Testo da rivedere' },
        type:    { type: 'string', description: 'Tipo di contenuto: "web" (sito), "social" (post social), "email" (email professionale), "presentation" (slide), "generic" (default)' },
        brand_voice: { type: 'string', description: 'Descrizione del tono di voce del brand (opzionale)' },
        language: { type: 'string', description: 'Lingua del contenuto (default "italiano")' },
      },
      required: ['content'],
    },
  },
  {
    name: 'review_email_draft',
    description: 'Gemini rivede una bozza email prima dell\'invio: controlla tono, completezza, errori, suggerisce miglioramenti. Usalo SEMPRE prima di send_email o reply_email quando il contenuto e\' importante.',
    input_schema: {
      type: 'object',
      properties: {
        to:      { type: 'string', description: 'Destinatario' },
        subject: { type: 'string', description: 'Oggetto' },
        body:    { type: 'string', description: 'Corpo dell\'email da rivedere' },
        context: { type: 'string', description: 'Contesto: a chi scrivi, perche\', tono desiderato (opzionale)' },
      },
      required: ['body'],
    },
  },
  // Ricerca globale
  {
    name: 'search_everywhere',
    description: 'Cerca contemporaneamente su Drive, Slack, Gmail e nella memoria. Usalo quando l\'utente chiede informazioni generiche su un cliente, progetto o argomento.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Testo da cercare ovunque' },
        sources: { type: 'array', items: { type: 'string', enum: ['drive', 'slack', 'email', 'memory'] }, description: 'Dove cercare (default: tutte le fonti)' },
      },
      required: ['query'],
    },
  },
  // Summarize
  {
    name: 'summarize_channel',
    description: 'Riassume cosa e\' successo in un canale Slack nelle ultime ore/giorni. Perfetto per "cosa mi sono perso in #canale?".',
    input_schema: {
      type: 'object',
      properties: {
        channel_name: { type: 'string', description: 'Nome del canale (senza #)' },
        hours:        { type: 'number', description: 'Quante ore indietro guardare (default 24)' },
      },
      required: ['channel_name'],
    },
  },
  {
    name: 'summarize_thread',
    description: 'Riassume un thread Slack lungo. Serve il channel ID e il timestamp del thread.',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'ID del canale' },
        thread_ts:  { type: 'string', description: 'Timestamp del messaggio parent del thread' },
      },
      required: ['channel_id', 'thread_ts'],
    },
  },
  {
    name: 'summarize_doc',
    description: 'Legge un Google Doc, lo riassume con AI e salva il riassunto in memoria per le prossime volte. Usa search_drive prima per trovare l\'ID.',
    input_schema: {
      type: 'object',
      properties: {
        doc_id:     { type: 'string', description: 'ID del Google Doc' },
        save_to_memory: { type: 'boolean', description: 'Salva il riassunto in memoria per richiamare dopo (default true)' },
      },
      required: ['doc_id'],
    },
  },
  // Calendar avanzato
  {
    name: 'find_free_slots',
    description: 'Trova slot liberi comuni per piu\' persone usando la FreeBusy API. Usalo per organizzare meeting o rispondere a "quando siamo liberi?".',
    input_schema: {
      type: 'object',
      properties: {
        emails:    { type: 'array', items: { type: 'string' }, description: 'Email delle persone da controllare' },
        date_from: { type: 'string', description: 'Inizio ricerca ISO 8601' },
        date_to:   { type: 'string', description: 'Fine ricerca ISO 8601' },
        duration:  { type: 'number', description: 'Durata slot in minuti (default 60)' },
      },
      required: ['emails', 'date_from', 'date_to'],
    },
  },
  // Gmail avanzato
  {
    name: 'read_thread',
    description: 'Legge l\'intero thread Gmail dato il threadId. Utile per avere il contesto completo di una conversazione.',
    input_schema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string', description: 'ID del thread Gmail (da read_email o find_emails)' },
      },
      required: ['thread_id'],
    },
  },
  {
    name: 'draft_email',
    description: 'Crea una bozza Gmail senza inviarla. Usa send_draft dopo per inviarla.',
    input_schema: {
      type: 'object',
      properties: {
        to:      { type: 'string', description: 'Email destinatario' },
        subject: { type: 'string', description: 'Oggetto' },
        body:    { type: 'string', description: 'Corpo del messaggio' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'send_draft',
    description: 'Invia una bozza Gmail creata con draft_email.',
    input_schema: {
      type: 'object',
      properties: {
        draft_id: { type: 'string', description: 'ID della bozza da inviare (da draft_email)' },
      },
      required: ['draft_id'],
    },
  },
  // Slack avanzato
  {
    name: 'create_poll',
    description: 'Posta un sondaggio in un canale Slack con emoji come opzioni di voto.',
    input_schema: {
      type: 'object',
      properties: {
        channel:  { type: 'string', description: 'Nome o ID del canale (es. "generale" o "C012AB3CD")' },
        question: { type: 'string', description: 'Domanda del sondaggio' },
        options:  { type: 'array', items: { type: 'string' }, description: 'Lista di opzioni (max 10)' },
      },
      required: ['channel', 'question', 'options'],
    },
  },
  // Google Sheets
  {
    name: 'read_sheet',
    description: 'Legge il contenuto di un Google Sheet. Restituisce righe e colonne come array di array. Usa search_drive prima per trovare il file ID.',
    input_schema: {
      type: 'object',
      properties: {
        sheet_id:   { type: 'string', description: 'ID del Google Sheet (dalla URL o da search_drive)' },
        range:      { type: 'string', description: 'Range da leggere, es. "A1:Z100" (default "A1:Z100")' },
        sheet_name: { type: 'string', description: 'Nome del foglio specifico (opzionale, default primo foglio)' },
      },
      required: ['sheet_id'],
    },
  },
  // Preventivi (quotes)
  {
    name: 'search_quotes',
    description: 'Cerca preventivi nel database. Filtra per cliente, progetto, anno, trimestre, stato, categoria. RBAC: admin/finance vedono tutto, manager vede prezzi ma non margini, member/restricted non vedono importi.',
    input_schema: {
      type: 'object',
      properties: {
        client_name:      { type: 'string', description: 'Nome cliente (ricerca parziale)' },
        project_name:     { type: 'string', description: 'Nome progetto (ricerca parziale)' },
        status:           { type: 'string', description: 'Stato: draft, sent, approved, rejected, expired' },
        service_category: { type: 'string', description: 'Categoria servizio (ricerca parziale)' },
        year:             { type: 'integer', description: 'Anno del preventivo' },
        quarter:          { type: 'string', description: 'Trimestre: Q1, Q2, Q3, Q4' },
        limit:            { type: 'integer', description: 'Max risultati (default 20)' },
      },
    },
  },
  {
    name: 'get_rate_card',
    description: 'Recupera la rate card (listino prezzi interni). Solo admin e finance possono accedere. Opzionalmente specifica una versione, altrimenti ritorna l\'ultima.',
    input_schema: {
      type: 'object',
      properties: {
        version: { type: 'string', description: 'Versione specifica (opzionale, default: ultima)' },
      },
    },
  },
  // Catalogazione preventivi
  {
    name: 'cataloga_preventivi',
    description: 'Scansiona Google Drive per trovare preventivi, economics e proposte commerciali e li salva nel database Supabase. ' +
      'Usalo quando qualcuno chiede di catalogare i preventivi, vuole sapere quanti preventivi ci sono, cerca statistiche sui progetti passati, o chiede benchmark sui prezzi storici. ' +
      'Richiede ruolo admin o finance.',
    input_schema: {
      type: 'object',
      properties: {
        max_files: { type: 'number', description: 'Numero massimo di file da processare (default 50)' },
        confirm:   { type: 'boolean', description: 'Se true, procede senza chiedere conferma (default false)' },
      },
    },
  },
  // Conferma azione critica
  {
    name: 'confirm_action',
    description: 'Esegue un\'azione precedentemente in attesa di conferma. Usalo SOLO dopo che l\'utente ha detto esplicitamente "sì", "ok", "manda", "procedi", "confermo". MAI usarlo senza conferma esplicita dell\'utente.',
    input_schema: {
      type: 'object',
      properties: {
        action_id: { type: 'string', description: 'ID dell\'azione da confermare (ricevuto dal risultato precedente)' },
      },
      required: ['action_id'],
    },
  },
];

// ─── Tool execution ───────────────────────────────────────────────────────────

async function eseguiTool(toolName, input, userId, userRole) {
  userRole = userRole || 'member';

  // ─── RBAC: controllo accesso tool sensibili ─────────────────────────
  if (toolName === 'search_drive' || toolName === 'read_doc') {
    var queryLow = ((input.query || '') + ' ' + (input.folder || '')).toLowerCase();
    if ((queryLow.includes('finance') || queryLow.includes('finanz') || queryLow.includes('cassa') || queryLow.includes('fattur')) && !checkPermission(userRole, 'view_drive_finance')) {
      return { error: getAccessDeniedMessage(userRole) };
    }
    if ((queryLow.includes('contratt') || queryLow.includes('contract')) && !checkPermission(userRole, 'view_drive_contracts')) {
      return { error: getAccessDeniedMessage(userRole) };
    }
  }

  // ─── RBAC: restricted → solo OffKatania e funzioni base ─────────────
  if (userRole === 'restricted') {
    var RESTRICTED_ALLOWED = ['list_events', 'find_event', 'recall_memory', 'save_memory', 'list_memories',
      'search_slack_messages', 'summarize_channel', 'summarize_thread', 'get_slack_users',
      'set_user_prefs', 'confirm_action', 'search_kb', 'ask_gemini'];
    if (!RESTRICTED_ALLOWED.includes(toolName)) {
      return { error: getAccessDeniedMessage('restricted') };
    }
  }

  // ─── Conferma azione critica ─────────────────────────────────────────
  if (toolName === 'confirm_action') {
    var actionId = input.action_id;
    var pending = confermeInAttesa.get(actionId);
    if (!pending) return { error: 'Nessuna azione in attesa con questo ID. L\'azione potrebbe essere scaduta.' };
    confermeInAttesa.delete(actionId);
    logger.info('[CONFIRM]', pending.toolName, 'confermato da', userId);
    return await eseguiTool(pending.toolName, pending.input, userId);
  }

  // ─── Intercetta azioni critiche: richiedi conferma ───────────────────
  if (AZIONI_CRITICHE.includes(toolName)) {
    var actionId = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    confermeInAttesa.set(actionId, { toolName: toolName, input: input, userId: userId, created: Date.now() });
    // Pulisci conferme vecchie (>10 min)
    var now = Date.now();
    confermeInAttesa.forEach(function(v, k) { if (now - v.created > 600000) confermeInAttesa.delete(k); });

    var preview = { requires_confirmation: true, action_id: actionId, action: toolName };
    if (toolName === 'send_email') {
      preview.preview = 'INVIO EMAIL:\nA: ' + input.to + (input.cc ? '\nCc: ' + input.cc : '') + '\nOggetto: ' + input.subject + '\n\n' + (input.body || '').substring(0, 500);
    } else if (toolName === 'reply_email') {
      preview.preview = 'RISPOSTA EMAIL:\nID messaggio: ' + input.message_id + '\n\n' + (input.body || '').substring(0, 500);
    } else if (toolName === 'forward_email') {
      preview.preview = 'INOLTRO EMAIL:\nA: ' + input.to + '\nNota: ' + (input.note || 'nessuna');
    } else if (toolName === 'create_event') {
      preview.preview = 'CREAZIONE EVENTO:\nTitolo: ' + input.summary + '\nInizio: ' + input.start + '\nFine: ' + input.end + (input.attendees ? '\nPartecipanti: ' + input.attendees : '');
    } else if (toolName === 'delete_event') {
      preview.preview = 'ELIMINAZIONE EVENTO:\nID: ' + input.event_id;
    } else if (toolName === 'share_file') {
      preview.preview = 'CONDIVISIONE FILE:\nFile: ' + input.file_id + '\nCon: ' + input.email + '\nRuolo: ' + (input.role || 'reader');
    }
    return preview;
  }

  // Tool Slack (non richiedono auth Google)
  if (toolName === 'get_slack_users') {
    try {
      const utenti = await getUtenti();
      let filtered = utenti;
      if (input.name_filter) {
        const f = input.name_filter.toLowerCase();
        filtered = utenti.filter(function(u) { return u.name.toLowerCase().includes(f); });
      }
      return { users: filtered };
    } catch(e) { return { error: e.message }; }
  }

  if (toolName === 'set_user_prefs') {
    setPrefs(userId, input);
    const prefs = getPrefs(userId);
    return {
      success: true,
      routine_enabled:   prefs.routine_enabled,
      notifiche_enabled: prefs.notifiche_enabled,
      standup_enabled:   prefs.standup_enabled,
    };
  }

  // Tool Memoria
  if (toolName === 'save_memory') {
    addMemory(userId, input.content, input.tags || []);
    return { success: true, message: 'Memorizzato.' };
  }

  if (toolName === 'recall_memory') {
    // RBAC: admin/finance vedono tutte le memorie, altri solo le proprie
    if (checkPermission(userRole, 'view_all_memories') && input.user_id) {
      var results = searchMemories(input.user_id, input.query);
      return { memories: results, count: results.length };
    }
    var results = searchMemories(userId, input.query);
    if (userRole === 'restricted') {
      results = results.filter(function(m) {
        return m.tags.some(function(t) { return (t || '').toLowerCase().includes('offkatania'); });
      });
    }
    return { memories: results, count: results.length };
  }

  if (toolName === 'list_memories') {
    var targetId = userId;
    if (checkPermission(userRole, 'view_all_memories') && input.user_id) {
      targetId = input.user_id;
    }
    const userMems = db.getMemCache()[targetId] || [];
    var filtered = input.tag
      ? userMems.filter(function(m) { return m.tags.some(function(t) { return t.toLowerCase().includes(input.tag.toLowerCase()); }); })
      : userMems;
    if (userRole === 'restricted') {
      filtered = filtered.filter(function(m) {
        return m.tags.some(function(t) { return (t || '').toLowerCase().includes('offkatania'); });
      });
    }
    return { memories: filtered, count: filtered.length };
  }

  if (toolName === 'delete_memory') {
    const deleted = deleteMemory(userId, input.memory_id);
    return deleted ? { success: true } : { error: 'Memoria non trovata.' };
  }

  // Tool Calendar
  const CALENDAR_TOOLS = ['list_events', 'find_event', 'create_event', 'update_event', 'add_attendees', 'delete_event'];
  if (CALENDAR_TOOLS.includes(toolName)) {
    const cal = getCalendarPerUtente(userId);
    if (!cal) return { error: 'Google Calendar non collegato. Scrivi "collega il mio Google".' };
    try {
      if (toolName === 'list_events') {
        const giorni = input.days || 7;
        const now = new Date(); const fine = new Date();
        fine.setDate(fine.getDate() + giorni);
        const res = await cal.events.list({ calendarId: 'primary', timeMin: now.toISOString(), timeMax: fine.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 15 });
        return { events: (res.data.items || []).map(mapEvent) };
      }

      if (toolName === 'find_event') {
        const from = input.date_from ? new Date(input.date_from) : new Date();
        const to   = input.date_to   ? new Date(input.date_to)   : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        const res  = await cal.events.list({ calendarId: 'primary', timeMin: from.toISOString(), timeMax: to.toISOString(), q: input.query || undefined, singleEvents: true, orderBy: 'startTime', maxResults: 10 });
        return { events: (res.data.items || []).map(mapEvent) };
      }

      if (toolName === 'create_event') {
        // Conflict detection (skip if force:true)
        if (!input.force) {
          const conflictCheck = await cal.events.list({
            calendarId: 'primary',
            timeMin: new Date(input.start).toISOString(),
            timeMax: new Date(input.end).toISOString(),
            singleEvents: true,
            maxResults: 5,
          });
          const conflicts = (conflictCheck.data.items || []).filter(function(e) { return e.status !== 'cancelled'; });
          if (conflicts.length > 0) {
            const titles = conflicts.map(function(e) { return e.summary || 'Senza titolo'; }).join(', ');
            return { conflict: true, message: 'Hai gia\' eventi in questo orario (' + titles + '). Usa force:true per creare comunque.', conflicting_events: conflicts.map(mapEvent) };
          }
        }
        const event = {
          summary: input.title,
          start: { dateTime: input.start, timeZone: 'Europe/Rome' },
          end:   { dateTime: input.end,   timeZone: 'Europe/Rome' },
          conferenceData: { createRequest: { requestId: 'giuno-' + Date.now(), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
        };
        if (input.description) event.description = input.description;
        if (input.location)    event.location    = input.location;
        if (input.attendees && input.attendees.length > 0) {
          event.attendees = input.attendees.map(function(e) { return { email: e }; });
        }
        const res = await cal.events.insert({
          calendarId: 'primary',
          requestBody: event,
          conferenceDataVersion: 1,
          sendUpdates: (input.attendees && input.attendees.length > 0) ? 'all' : 'none',
        });
        const entryPoints = res.data.conferenceData && res.data.conferenceData.entryPoints;
        const meetLink = entryPoints && entryPoints[0] ? entryPoints[0].uri : null;
        return { success: true, event_id: res.data.id, link: res.data.htmlLink, meet_link: meetLink };
      }

      if (toolName === 'update_event') {
        const existing = await cal.events.get({ calendarId: 'primary', eventId: input.event_id });
        const event = existing.data;
        if (input.title)                 event.summary     = input.title;
        if (input.start)                 event.start       = { dateTime: input.start, timeZone: 'Europe/Rome' };
        if (input.end)                   event.end         = { dateTime: input.end,   timeZone: 'Europe/Rome' };
        if (input.description !== undefined) event.description = input.description;
        if (input.location    !== undefined) event.location    = input.location;
        await cal.events.update({ calendarId: 'primary', eventId: input.event_id, requestBody: event, sendUpdates: 'all' });
        return { success: true };
      }

      if (toolName === 'add_attendees') {
        const existing = await cal.events.get({ calendarId: 'primary', eventId: input.event_id });
        const event = existing.data;
        const currentEmails = (event.attendees || []).map(function(a) { return a.email; });
        const nuovi = input.attendees.filter(function(e) { return !currentEmails.includes(e); });
        event.attendees = (event.attendees || []).concat(nuovi.map(function(e) { return { email: e }; }));
        await cal.events.update({ calendarId: 'primary', eventId: input.event_id, requestBody: event, sendUpdates: 'all' });
        return { success: true, added: nuovi };
      }

      if (toolName === 'delete_event') {
        await cal.events.delete({ calendarId: 'primary', eventId: input.event_id });
        return { success: true };
      }
    } catch(e) {
      if (await handleTokenScaduto(userId, e)) return { error: 'Token scaduto. Utente notificato per riautenticarsi.' };
      return { error: e.message };
    }
  }

  // Tool Gmail
  const GMAIL_TOOLS = ['find_emails', 'read_email', 'reply_email', 'send_email', 'forward_email'];
  if (GMAIL_TOOLS.includes(toolName)) {
    const gm = getGmailPerUtente(userId);
    if (!gm) return { error: 'Gmail non collegato. Scrivi "collega il mio Google".' };
    try {
      if (toolName === 'find_emails') {
        const max = input.max || 5;
        const res = await gm.users.messages.list({ userId: 'me', maxResults: max, q: input.query });
        if (!res.data.messages) return { emails: [] };
        const emails = await Promise.all(res.data.messages.map(async function(m) {
          const msg = await gm.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] });
          const h = msg.data.payload.headers;
          return { id: m.id, subject: getHeader(h, 'Subject'), from: getHeader(h, 'From'), to: getHeader(h, 'To'), date: getHeader(h, 'Date') };
        }));
        return { emails: emails };
      }

      if (toolName === 'read_email') {
        const msg = await gm.users.messages.get({ userId: 'me', id: input.message_id, format: 'full' });
        const h = msg.data.payload.headers;
        let body = '';
        function extractText(part) {
          if (part.mimeType === 'text/plain' && part.body && part.body.data) {
            body += Buffer.from(part.body.data, 'base64').toString('utf-8');
          }
          if (part.parts) part.parts.forEach(extractText);
        }
        extractText(msg.data.payload);
        return {
          id: msg.data.id,
          thread_id: msg.data.threadId,
          subject: getHeader(h, 'Subject'),
          from:    getHeader(h, 'From'),
          to:      getHeader(h, 'To'),
          date:    getHeader(h, 'Date'),
          body:    body.substring(0, 2000),
        };
      }

      if (toolName === 'reply_email') {
        const orig = await gm.users.messages.get({ userId: 'me', id: input.message_id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Message-Id', 'References'] });
        const h = orig.data.payload.headers;
        const origFrom      = getHeader(h, 'From');
        const origSubject   = getHeader(h, 'Subject');
        const origMessageId = getHeader(h, 'Message-Id');
        const origRefs      = getHeader(h, 'References');
        const replySubject  = origSubject.startsWith('Re:') ? origSubject : 'Re: ' + origSubject;

        // Auto-review Gemini (se disponibile)
        var replyGeminiReview = null;
        if (geminiModel) {
          try {
            replyGeminiReview = await askGemini(
              'Risposta a: ' + origFrom + '\nOggetto: ' + replySubject + '\n\nBOZZA RISPOSTA:\n' + input.body,
              'Rivedi questa bozza di risposta email in italiano. Se ci sono errori gravi (grammatica, tono sbagliato, info mancanti), segnalali brevemente. Se va bene, rispondi solo "OK". Max 3 righe.'
            );
          } catch(e) { logger.error('Gemini reply review error:', e.message); }
        }

        const raw = [
          'To: ' + origFrom,
          'Subject: ' + replySubject,
          'In-Reply-To: ' + origMessageId,
          'References: ' + (origRefs ? origRefs + ' ' : '') + origMessageId,
          'Content-Type: text/plain; charset=utf-8',
          'MIME-Version: 1.0',
          '',
          input.body,
        ].join('\r\n');
        const encoded = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        await gm.users.messages.send({ userId: 'me', requestBody: { raw: encoded, threadId: orig.data.threadId } });
        var replyResult = { success: true };
        if (replyGeminiReview && replyGeminiReview.response && replyGeminiReview.response !== 'OK') {
          replyResult.gemini_note = replyGeminiReview.response;
        }
        return replyResult;
      }

      if (toolName === 'send_email') {
        // Auto-review Gemini (se disponibile)
        var geminiReview = null;
        if (geminiModel) {
          try {
            geminiReview = await askGemini(
              'Destinatario: ' + input.to + '\nOggetto: ' + input.subject + '\n\nBOZZA:\n' + input.body,
              'Rivedi questa bozza email in italiano. Se ci sono errori gravi (grammatica, tono sbagliato, info mancanti), segnalali brevemente. Se va bene, rispondi solo "OK". Max 3 righe.'
            );
          } catch(e) { logger.error('Gemini auto-review error:', e.message); }
        }

        const headers = [
          'To: ' + input.to,
          'Subject: ' + input.subject,
          'Content-Type: text/plain; charset=utf-8',
          'MIME-Version: 1.0',
        ];
        if (input.cc) headers.splice(1, 0, 'Cc: ' + input.cc);
        const raw = headers.concat(['', input.body]).join('\r\n');
        const encoded = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        await gm.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
        var result = { success: true, to: input.to, subject: input.subject };
        if (geminiReview && geminiReview.response && geminiReview.response !== 'OK') {
          result.gemini_note = geminiReview.response;
        }
        return result;
      }

      if (toolName === 'forward_email') {
        const orig = await gm.users.messages.get({ userId: 'me', id: input.message_id, format: 'full' });
        const h = orig.data.payload.headers;
        const origSubject = getHeader(h, 'Subject');
        const origFrom    = getHeader(h, 'From');
        const origDate    = getHeader(h, 'Date');
        let origBody = '';
        function extractFwdText(part) {
          if (part.mimeType === 'text/plain' && part.body && part.body.data) {
            origBody += Buffer.from(part.body.data, 'base64').toString('utf-8');
          }
          if (part.parts) part.parts.forEach(extractFwdText);
        }
        extractFwdText(orig.data.payload);
        const fwdSubject = origSubject.startsWith('Fwd:') ? origSubject : 'Fwd: ' + origSubject;
        const body = (input.note ? input.note + '\n\n' : '') +
          '---------- Forwarded message ----------\n' +
          'Da: ' + origFrom + '\n' +
          'Data: ' + origDate + '\n' +
          'Oggetto: ' + origSubject + '\n\n' +
          origBody.substring(0, 3000);
        const raw = [
          'To: ' + input.to,
          'Subject: ' + fwdSubject,
          'Content-Type: text/plain; charset=utf-8',
          'MIME-Version: 1.0',
          '',
          body,
        ].join('\r\n');
        const encoded = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        await gm.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
        return { success: true, forwarded_to: input.to, subject: fwdSubject };
      }
    } catch(e) {
      if (await handleTokenScaduto(userId, e)) return { error: 'Token scaduto. Utente notificato per riautenticarsi.' };
      return { error: e.message };
    }
  }

  // Tool Google Drive
  const DRIVE_TOOLS = ['search_drive', 'create_doc', 'share_file', 'read_doc'];
  if (DRIVE_TOOLS.includes(toolName)) {
    const drv = getDrivePerUtente(userId);
    if (!drv && toolName !== 'create_doc') return { error: 'Google Drive non collegato. Scrivi "collega il mio Google".' };
    try {
      if (toolName === 'search_drive') {
        const max = input.max || 10;
        const escaped = input.query.replace(/'/g, "\\'");
        var qParts = [];

        // Full-text vs name-only search
        if (input.name_only) {
          qParts.push("name contains '" + escaped + "'");
        } else {
          qParts.push("fullText contains '" + escaped + "'");
        }
        qParts.push("trashed = false");

        // MIME type shortcuts
        if (input.mime_type) {
          var mimeMap = {
            'document': 'application/vnd.google-apps.document',
            'spreadsheet': 'application/vnd.google-apps.spreadsheet',
            'presentation': 'application/vnd.google-apps.presentation',
            'pdf': 'application/pdf',
            'image': 'application/vnd.google-apps.photo',
            'folder': 'application/vnd.google-apps.folder',
          };
          var resolvedMime = mimeMap[input.mime_type] || input.mime_type;
          if (input.mime_type === 'image') {
            qParts.push("(mimeType contains 'image/')");
          } else {
            qParts.push("mimeType = '" + resolvedMime + "'");
          }
        }

        // Date filters
        if (input.modified_after) {
          qParts.push("modifiedTime > '" + new Date(input.modified_after).toISOString() + "'");
        }
        if (input.modified_before) {
          qParts.push("modifiedTime < '" + new Date(input.modified_before).toISOString() + "'");
        }

        // Shared with filter
        if (input.shared_with) {
          qParts.push("'" + input.shared_with + "' in readers or '" + input.shared_with + "' in writers");
        }

        var q = qParts.join(' and ');

        // Folder search: first find folder ID, then search inside it
        if (input.folder_name) {
          try {
            var folderRes = await drv.files.list({
              q: "name = '" + input.folder_name.replace(/'/g, "\\'") + "' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
              fields: 'files(id)',
              pageSize: 1,
            });
            if (folderRes.data.files && folderRes.data.files.length > 0) {
              q += " and '" + folderRes.data.files[0].id + "' in parents";
            }
          } catch(e) { logger.error('Drive folder search error:', e.message); }
        }

        const res = await drv.files.list({
          q: q,
          fields: 'files(id, name, mimeType, webViewLink, modifiedTime, owners, parents, description)',
          pageSize: max,
          orderBy: 'modifiedTime desc',
        });
        return {
          files: (res.data.files || []).map(function(f) {
            return {
              id: f.id,
              name: f.name,
              type: f.mimeType,
              link: f.webViewLink,
              modified: f.modifiedTime,
              owner: (f.owners && f.owners[0]) ? f.owners[0].emailAddress : null,
              description: f.description || null,
            };
          }),
        };
      }

      if (toolName === 'create_doc') {
        const docsApi = getDocsPerUtente(userId);
        if (!docsApi) return { error: 'Google Docs non collegato. Scrivi "collega il mio Google".' };
        const doc = await docsApi.documents.create({ requestBody: { title: input.title } });
        const docId = doc.data.documentId;
        if (input.content) {
          await docsApi.documents.batchUpdate({ documentId: docId, requestBody: { requests: [{ insertText: { location: { index: 1 }, text: input.content } }] } });
        }
        return { success: true, doc_id: docId, link: 'https://docs.google.com/document/d/' + docId + '/edit' };
      }

      if (toolName === 'share_file') {
        const role = input.role || 'reader';
        await drv.permissions.create({
          fileId: input.file_id,
          requestBody: { type: 'user', role: role, emailAddress: input.email },
          sendNotificationEmail: true,
        });
        return { success: true, shared_with: input.email, role: role };
      }

      if (toolName === 'read_doc') {
        const docsApi = getDocsPerUtente(userId);
        if (!docsApi) return { error: 'Google Docs non collegato. Scrivi "collega il mio Google".' };
        const doc = await docsApi.documents.get({ documentId: input.doc_id });
        let text = '';
        function extractDocText(elements) {
          if (!elements) return;
          elements.forEach(function(el) {
            if (el.paragraph && el.paragraph.elements) {
              el.paragraph.elements.forEach(function(pe) {
                if (pe.textRun && pe.textRun.content) text += pe.textRun.content;
              });
            }
            if (el.table) {
              (el.table.tableRows || []).forEach(function(row) {
                (row.tableCells || []).forEach(function(cell) {
                  extractDocText(cell.content);
                  text += '\t';
                });
                text += '\n';
              });
            }
          });
        }
        extractDocText(doc.data.body.content);
        return { title: doc.data.title, content: text.substring(0, 4000) };
      }
    } catch(e) {
      if (await handleTokenScaduto(userId, e)) return { error: 'Token scaduto. Utente notificato per riautenticarsi.' };
      return { error: e.message };
    }
  }

  // Tool Google Sheets
  if (toolName === 'read_sheet') {
    var sheets = getSheetPerUtente(userId);
    if (!sheets) return { error: 'Google Sheets non collegato. Scrivi "collega il mio Google".' };
    try {
      var range = input.sheet_name
        ? input.sheet_name + '!' + (input.range || 'A1:Z100')
        : (input.range || 'A1:Z100');
      var sheetRes = await sheets.spreadsheets.values.get({
        spreadsheetId: input.sheet_id,
        range: range,
      });
      var rows = sheetRes.data.values || [];
      return {
        sheet_id: input.sheet_id,
        range: range,
        rows: rows,
        row_count: rows.length,
        preview: rows.slice(0, 5),
      };
    } catch(e) {
      if (await handleTokenScaduto(userId, e)) return { error: 'Token scaduto.' };
      return { error: e.message };
    }
  }

  // Tool Slack search
  if (toolName === 'search_slack_messages') {
    try {
      const max = input.max || 10;
      const res = await app.client.search.messages({ token: process.env.SLACK_USER_TOKEN || process.env.SLACK_BOT_TOKEN, query: input.query, count: max, sort: 'timestamp', sort_dir: 'desc' });
      const matches = (res.messages && res.messages.matches) || [];
      return {
        results: matches.map(function(m) {
          return {
            text: (m.text || '').substring(0, 300),
            user: m.user || m.username,
            channel: m.channel ? m.channel.name : null,
            timestamp: m.ts,
            permalink: m.permalink,
          };
        }),
        total: (res.messages && res.messages.total) || 0,
      };
    } catch(e) { return { error: 'Errore ricerca Slack: ' + e.message + '. Nota: potrebbe servire un SLACK_USER_TOKEN con scope search:read.' }; }
  }

  // Tool Profilo utente
  if (toolName === 'update_user_profile') {
    updateProfile(userId, input);
    return { success: true, profile: getProfile(userId) };
  }

  if (toolName === 'get_user_profile') {
    var targetId = input.user_id || userId;
    var profile = getProfile(targetId);
    return { profile: profile };
  }

  // Tool Knowledge base
  if (toolName === 'add_to_kb') {
    addKBEntry(input.content, input.tags || [], userId);
    return { success: true, message: 'Aggiunto alla knowledge base aziendale.' };
  }

  if (toolName === 'search_kb') {
    var kbResults = searchKB(input.query);
    return { entries: kbResults, count: kbResults.length };
  }

  if (toolName === 'delete_from_kb') {
    var kbDeleted = deleteKBEntry(input.entry_id);
    return kbDeleted ? { success: true } : { error: 'Entry non trovata.' };
  }

  // Tool Preventivi (quotes) — RBAC
  if (toolName === 'search_quotes') {
    if (!checkPermission(userRole, 'view_quote_price') && userRole !== 'member') {
      return { error: getAccessDeniedMessage(userRole) };
    }
    try {
      var quotes = await db.searchQuotes(input);
      // Filtra dati in base al ruolo
      quotes = quotes.map(function(q) { return filterQuoteData(q, userRole); });
      return { quotes: quotes, count: quotes.length };
    } catch(e) { return { error: e.message }; }
  }

  if (toolName === 'get_rate_card') {
    if (!checkPermission(userRole, 'view_rate_card')) {
      return { error: getAccessDeniedMessage(userRole) };
    }
    try {
      if (input.version === 'list') {
        var cards = await db.listRateCards();
        return { rate_cards: cards, count: cards.length };
      }
      var card = await db.getRateCard(input.version);
      return card ? { rate_card: card } : { error: 'Nessuna rate card trovata.' };
    } catch(e) { return { error: e.message }; }
  }

  // Tool cataloga_preventivi
  if (toolName === 'cataloga_preventivi') {
    if (!checkPermission(userRole, 'view_financials')) {
      return { error: getAccessDeniedMessage(userRole) };
    }
    var catChannel = userId; // DM all'utente se non c'è channelId
    catalogaPreventivi(userId, catChannel, input.max_files || 50, input.confirm || false)
      .catch(function(e) { logger.error('[CATALOGA] Errore:', e.message); });
    return { success: true, message: 'Scansione preventivi avviata. Ti avviso su Slack quando ho finito.' };
  }

  // Tool Gemini (dual-brain)
  if (toolName === 'ask_gemini') {
    var prompt = input.prompt;
    if (input.context) prompt = 'Contesto: ' + input.context + '\n\n' + prompt;
    var gemResult = await askGemini(prompt, 'Sei un assistente AI che collabora con un altro AI (Claude). Rispondi in italiano, in modo conciso e utile. Se ti viene chiesto un parere, sii onesto e costruttivo.');
    return gemResult;
  }

  if (toolName === 'review_content') {
    var contentType = input.type || 'generic';
    var lang = input.language || 'italiano';
    var typeInstructions = {
      'web': 'Rivedi questo testo per un sito web. Controlla: SEO (keyword, meta description), leggibilità, CTA, struttura H1/H2, lunghezza paragrafi.',
      'social': 'Rivedi questo post per i social. Controlla: engagement, lunghezza, hashtag, CTA, tono, emoji se appropriate.',
      'email': 'Rivedi questa email professionale. Controlla: tono, chiarezza, call to action, lunghezza, errori.',
      'presentation': 'Rivedi questo testo per una presentazione. Controlla: chiarezza, concisione, impatto visivo del testo, punti chiave evidenziati.',
      'generic': 'Rivedi questo testo. Controlla: grammatica, chiarezza, tono, struttura, errori.',
    };
    var instruction = typeInstructions[contentType] || typeInstructions['generic'];
    if (input.brand_voice) instruction += '\nBrand voice richiesta: ' + input.brand_voice;

    var reviewPrompt = instruction + '\nLingua: ' + lang + '\n\nTESTO DA RIVEDERE:\n' + input.content;
    var reviewResult = await askGemini(reviewPrompt,
      'Sei un copywriter e editor professionista. Dai feedback strutturato in italiano:\n' +
      '1. VALUTAZIONE GENERALE (1 riga)\n' +
      '2. PROBLEMI TROVATI (lista breve)\n' +
      '3. TESTO MIGLIORATO (versione corretta completa)\n' +
      SLACK_FORMAT_RULES
    );
    return reviewResult;
  }

  if (toolName === 'review_email_draft') {
    var emailContext = '';
    if (input.to) emailContext += 'Destinatario: ' + input.to + '\n';
    if (input.subject) emailContext += 'Oggetto: ' + input.subject + '\n';
    if (input.context) emailContext += 'Contesto: ' + input.context + '\n';
    emailContext += '\nBOZZA EMAIL:\n' + input.body;

    var emailReviewResult = await askGemini(emailContext,
      'Sei un assistente che rivede bozze email professionali in italiano. Analizza:\n' +
      '1. *Tono*: appropriato per il destinatario?\n' +
      '2. *Completezza*: manca qualcosa di importante?\n' +
      '3. *Errori*: grammatica, battitura, formattazione\n' +
      '4. *Chiarezza*: il messaggio e\' chiaro?\n' +
      '5. *Suggerimenti*: cosa migliorare\n\n' +
      'Se la bozza va bene, dillo. Se va migliorata, proponi la versione corretta.\n' +
      SLACK_FORMAT_RULES
    );
    return emailReviewResult;
  }

  // search_everywhere: ricerca cross-source
  if (toolName === 'search_everywhere') {
    var sources = input.sources || ['drive', 'slack', 'email', 'memory'];
    var results = {};

    // Memoria
    if (sources.includes('memory')) {
      var mems = searchMemories(userId, input.query);
      if (mems.length > 0) {
        results.memory = mems.slice(0, 5).map(function(m) {
          return { content: m.content, tags: m.tags, created: m.created };
        });
      }
    }

    // Drive index locale (veloce, senza API call)
    if (sources.includes('drive') && getDriveIndex()[userId]) {
      var queryLower = (input.query || '').toLowerCase();
      var indexed = Object.values(getDriveIndex()[userId]).filter(function(f) {
        return f.name.toLowerCase().includes(queryLower) || (f.description && f.description.toLowerCase().includes(queryLower));
      }).slice(0, 3);
      if (indexed.length > 0) {
        results.drive_index = indexed.map(function(f) {
          return { name: f.name, type: f.type, link: f.link, modified: f.modified };
        });
      }
    }

    // Drive
    if (sources.includes('drive')) {
      var drv = getDrivePerUtente(userId);
      if (drv) {
        try {
          var escaped = input.query.replace(/'/g, "\\'");
          var drvRes = await drv.files.list({
            q: "fullText contains '" + escaped + "' and trashed = false",
            fields: 'files(id, name, mimeType, webViewLink, modifiedTime)',
            pageSize: 5,
            orderBy: 'modifiedTime desc',
          });
          if (drvRes.data.files && drvRes.data.files.length > 0) {
            results.drive = drvRes.data.files.map(function(f) {
              return { name: f.name, type: f.mimeType, link: f.webViewLink, modified: f.modifiedTime };
            });
          }
        } catch(e) { if (await handleTokenScaduto(userId, e)) results.drive_error = 'Token scaduto'; }
      }
    }

    // Gmail
    if (sources.includes('email')) {
      var gm = getGmailPerUtente(userId);
      if (gm) {
        try {
          var gmRes = await gm.users.messages.list({ userId: 'me', maxResults: 5, q: input.query });
          if (gmRes.data.messages && gmRes.data.messages.length > 0) {
            var emails = await Promise.all(gmRes.data.messages.map(async function(m) {
              var msg = await gm.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] });
              var h = msg.data.payload.headers;
              return { id: m.id, subject: getHeader(h, 'Subject'), from: getHeader(h, 'From'), date: getHeader(h, 'Date') };
            }));
            results.email = emails;
          }
        } catch(e) { if (await handleTokenScaduto(userId, e)) results.email_error = 'Token scaduto'; }
      }
    }

    // Slack
    if (sources.includes('slack')) {
      try {
        var slkRes = await app.client.search.messages({ token: process.env.SLACK_USER_TOKEN || process.env.SLACK_BOT_TOKEN, query: input.query, count: 5, sort: 'timestamp', sort_dir: 'desc' });
        var matches = (slkRes.messages && slkRes.messages.matches) || [];
        if (matches.length > 0) {
          results.slack = matches.map(function(m) {
            return { text: (m.text || '').substring(0, 200), channel: m.channel ? m.channel.name : null, permalink: m.permalink };
          });
        }
      } catch(e) {}
    }

    return results;
  }

  // summarize_channel
  if (toolName === 'summarize_channel') {
    try {
      var hours = input.hours || 24;
      var oldest = String(Math.floor((Date.now() - hours * 60 * 60 * 1000) / 1000));
      var channelsRes = await app.client.conversations.list({ limit: 200, types: 'public_channel,private_channel' });
      var target = (channelsRes.channels || []).find(function(c) { return c.name === input.channel_name; });
      if (!target) return { error: 'Canale #' + input.channel_name + ' non trovato.' };
      try { await app.client.conversations.join({ channel: target.id }); } catch(e) {}
      var hist = await app.client.conversations.history({ channel: target.id, oldest: oldest, limit: 100 });
      var msgs = (hist.messages || []).filter(function(m) { return !m.bot_id && m.type === 'message' && m.text; });
      if (msgs.length === 0) return { summary: 'Nessun messaggio nelle ultime ' + hours + ' ore in #' + input.channel_name + '.' };

      // Risolvi nomi utenti nei messaggi
      var userCache = {};
      var messagesText = '';
      for (var i = msgs.length - 1; i >= 0; i--) {
        var m = msgs[i];
        var userName = m.user;
        if (!userCache[m.user]) {
          try {
            var uRes = await app.client.users.info({ user: m.user });
            userCache[m.user] = uRes.user.real_name || uRes.user.name;
          } catch(e) { userCache[m.user] = m.user; }
        }
        userName = userCache[m.user];
        messagesText += userName + ': ' + m.text + '\n';
      }

      // Usa Claude per riassumere
      var summaryRes = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        system: 'Sei un assistente che riassume conversazioni Slack in italiano. Fai un riassunto breve e strutturato: argomenti principali, decisioni prese, azioni da fare. Max 10 righe. ' + SLACK_FORMAT_RULES,
        messages: [{ role: 'user', content: 'Riassumi questa conversazione dal canale #' + input.channel_name + ' (ultime ' + hours + ' ore):\n\n' + messagesText.substring(0, 6000) }],
      });
      var summary = summaryRes.content[0].text;
      return { channel: input.channel_name, hours: hours, messages_count: msgs.length, summary: summary };
    } catch(e) { return { error: 'Errore: ' + e.message }; }
  }

  // summarize_thread
  if (toolName === 'summarize_thread') {
    try {
      var threadRes = await app.client.conversations.replies({ channel: input.channel_id, ts: input.thread_ts, limit: 100 });
      var threadMsgs = (threadRes.messages || []).filter(function(m) { return m.text; });
      if (threadMsgs.length === 0) return { summary: 'Thread vuoto.' };

      var threadUserCache = {};
      var threadText = '';
      for (var j = 0; j < threadMsgs.length; j++) {
        var tm = threadMsgs[j];
        if (!threadUserCache[tm.user]) {
          try {
            var tuRes = await app.client.users.info({ user: tm.user });
            threadUserCache[tm.user] = tuRes.user.real_name || tuRes.user.name;
          } catch(e) { threadUserCache[tm.user] = tm.user; }
        }
        threadText += threadUserCache[tm.user] + ': ' + tm.text + '\n';
      }

      var threadSummaryRes = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 400,
        system: 'Sei un assistente che riassume thread Slack in italiano. Riassunto breve: contesto, punti chiave, conclusione/decisione. Max 8 righe. ' + SLACK_FORMAT_RULES,
        messages: [{ role: 'user', content: 'Riassumi questo thread Slack:\n\n' + threadText.substring(0, 6000) }],
      });
      return { messages_count: threadMsgs.length, summary: threadSummaryRes.content[0].text };
    } catch(e) { return { error: 'Errore: ' + e.message }; }
  }

  // summarize_doc
  if (toolName === 'summarize_doc') {
    var docsApi = getDocsPerUtente(userId);
    if (!docsApi) return { error: 'Google Docs non collegato. Scrivi "collega il mio Google".' };
    try {
      var doc = await docsApi.documents.get({ documentId: input.doc_id });
      var docText = '';
      function extractSumText(elements) {
        if (!elements) return;
        elements.forEach(function(el) {
          if (el.paragraph && el.paragraph.elements) {
            el.paragraph.elements.forEach(function(pe) {
              if (pe.textRun && pe.textRun.content) docText += pe.textRun.content;
            });
          }
          if (el.table) {
            (el.table.tableRows || []).forEach(function(row) {
              (row.tableCells || []).forEach(function(cell) {
                extractSumText(cell.content);
                docText += '\t';
              });
              docText += '\n';
            });
          }
        });
      }
      extractSumText(doc.data.body.content);

      var docTitle = doc.data.title;
      var docSummaryRes = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        system: 'Sei un assistente che riassume documenti in italiano. Fai un riassunto strutturato: scopo del documento, punti chiave, conclusioni. Max 12 righe. ' + SLACK_FORMAT_RULES,
        messages: [{ role: 'user', content: 'Riassumi questo documento "' + docTitle + '":\n\n' + docText.substring(0, 8000) }],
      });
      var docSummary = docSummaryRes.content[0].text;

      // Salva in memoria se richiesto
      var saveToMemory = input.save_to_memory !== false;
      if (saveToMemory) {
        addMemory(userId, 'Riassunto doc "' + docTitle + '": ' + docSummary, ['documento', 'riassunto', (docTitle || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')]);
      }

      return { title: docTitle, summary: docSummary, saved_to_memory: saveToMemory };
    } catch(e) {
      if (await handleTokenScaduto(userId, e)) return { error: 'Token scaduto.' };
      return { error: e.message };
    }
  }

  // Tool Calendar: find_free_slots
  if (toolName === 'find_free_slots') {
    const cal = getCalendarPerUtente(userId);
    if (!cal) return { error: 'Google Calendar non collegato. Scrivi "collega il mio Google".' };
    try {
      const duration = (input.duration || 60) * 60 * 1000;
      const res = await cal.freebusy.query({
        requestBody: {
          timeMin: new Date(input.date_from).toISOString(),
          timeMax: new Date(input.date_to).toISOString(),
          timeZone: 'Europe/Rome',
          items: input.emails.map(function(e) { return { id: e }; }),
        },
      });
      const busyByUser = res.data.calendars;
      const allBusy = [];
      input.emails.forEach(function(email) {
        const userCal = busyByUser[email];
        if (userCal && userCal.busy) allBusy.push.apply(allBusy, userCal.busy);
      });
      allBusy.sort(function(a, b) { return new Date(a.start) - new Date(b.start); });
      const slots = [];
      let cursor = new Date(input.date_from);
      const endTime = new Date(input.date_to);
      while (cursor.getTime() + duration <= endTime.getTime() && slots.length < 5) {
        const h = cursor.getHours();
        if (h < 9) { cursor.setHours(9, 0, 0, 0); continue; }
        if (h >= 18) { cursor.setDate(cursor.getDate() + 1); cursor.setHours(9, 0, 0, 0); continue; }
        const slotEnd = new Date(cursor.getTime() + duration);
        const overlap = allBusy.some(function(b) {
          return new Date(b.start) < slotEnd && new Date(b.end) > cursor;
        });
        if (!overlap) {
          slots.push({ start: cursor.toISOString(), end: slotEnd.toISOString() });
          cursor = new Date(slotEnd);
        } else {
          const nextBusy = allBusy.find(function(b) { return new Date(b.end) > cursor; });
          if (nextBusy) cursor = new Date(nextBusy.end);
          else break;
        }
      }
      return { free_slots: slots };
    } catch(e) {
      if (await handleTokenScaduto(userId, e)) return { error: 'Token scaduto.' };
      return { error: e.message };
    }
  }

  // Tool Gmail avanzati: read_thread, draft_email, send_draft
  if (toolName === 'read_thread') {
    const gm = getGmailPerUtente(userId);
    if (!gm) return { error: 'Gmail non collegato. Scrivi "collega il mio Google".' };
    try {
      const res = await gm.users.threads.get({ userId: 'me', id: input.thread_id, format: 'full' });
      const messages = (res.data.messages || []).map(function(msg) {
        const h = msg.payload.headers;
        let body = '';
        function extractText(part) {
          if (part.mimeType === 'text/plain' && part.body && part.body.data) {
            body += Buffer.from(part.body.data, 'base64').toString('utf-8');
          }
          if (part.parts) part.parts.forEach(extractText);
        }
        extractText(msg.payload);
        return { id: msg.id, from: getHeader(h, 'From'), date: getHeader(h, 'Date'), body: body.substring(0, 1000) };
      });
      return { thread_id: input.thread_id, messages: messages };
    } catch(e) {
      if (await handleTokenScaduto(userId, e)) return { error: 'Token scaduto.' };
      return { error: e.message };
    }
  }

  if (toolName === 'draft_email') {
    const gm = getGmailPerUtente(userId);
    if (!gm) return { error: 'Gmail non collegato. Scrivi "collega il mio Google".' };
    try {
      const raw = [
        'To: ' + input.to,
        'Subject: ' + input.subject,
        'Content-Type: text/plain; charset=utf-8',
        'MIME-Version: 1.0',
        '',
        input.body,
      ].join('\r\n');
      const encoded = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const res = await gm.users.drafts.create({ userId: 'me', requestBody: { message: { raw: encoded } } });
      return { success: true, draft_id: res.data.id };
    } catch(e) {
      if (await handleTokenScaduto(userId, e)) return { error: 'Token scaduto.' };
      return { error: e.message };
    }
  }

  if (toolName === 'send_draft') {
    const gm = getGmailPerUtente(userId);
    if (!gm) return { error: 'Gmail non collegato. Scrivi "collega il mio Google".' };
    try {
      await gm.users.drafts.send({ userId: 'me', requestBody: { id: input.draft_id } });
      return { success: true };
    } catch(e) {
      if (await handleTokenScaduto(userId, e)) return { error: 'Token scaduto.' };
      return { error: e.message };
    }
  }

  // Tool Slack: create_poll
  if (toolName === 'create_poll') {
    try {
      const POLL_EMOJIS = [':one:', ':two:', ':three:', ':four:', ':five:', ':six:', ':seven:', ':eight:', ':nine:', ':keycap_ten:'];
      const EMOJI_NAMES = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'keycap_ten'];
      const options = (input.options || []).slice(0, 10);
      let text = '*' + input.question + '*\n\n';
      options.forEach(function(opt, i) { text += POLL_EMOJIS[i] + ' ' + opt + '\n'; });
      let channelId = input.channel;
      if (!input.channel.match(/^[CG]/)) {
        const chanName = input.channel.replace(/^#/, '');
        try {
          const list = await app.client.conversations.list({ limit: 200 });
          const found = (list.channels || []).find(function(c) { return c.name === chanName; });
          if (found) channelId = found.id;
        } catch(e) {}
      }
      const posted = await app.client.chat.postMessage({ channel: channelId, text: text });
      for (let i = 0; i < options.length; i++) {
        try { await app.client.reactions.add({ channel: channelId, timestamp: posted.ts, name: EMOJI_NAMES[i] }); } catch(e) {}
      }
      return { success: true, ts: posted.ts };
    } catch(e) { return { error: e.message }; }
  }

  return { error: 'Tool sconosciuto: ' + toolName };
}

// Helper
function mapEvent(e) {
  return { id: e.id, title: e.summary, start: e.start.dateTime || e.start.date, end: e.end.dateTime || e.end.date, location: e.location || null, attendees: (e.attendees || []).map(function(a) { return a.email; }) };
}
function getHeader(headers, name) {
  return (headers.find(function(h) { return h.name === name; }) || {}).value || '';
}

// ─── Drive / Docs / Slack helpers ─────────────────────────────────────────────

async function cercaSuDrive(query, slackUserId) {
  var drv = getDrivePerUtente(slackUserId);
  if (!drv) throw new Error('NESSUN_TOKEN');
  var res = await drv.files.list({ q: "name contains '" + query + "' and trashed = false", fields: 'files(id, name, webViewLink, modifiedTime)', pageSize: 5 });
  return res.data.files;
}

async function leggiEmailRecenti(max, slackUserId) {
  max = max || 5;
  const userGmail = getGmailPerUtente(slackUserId);
  if (!userGmail) throw new Error('NESSUN_TOKEN');
  const res = await userGmail.users.messages.list({ userId: 'me', maxResults: max, q: 'is:unread' });
  if (!res.data.messages) return [];
  return Promise.all(res.data.messages.map(async function(m) {
    const msg = await userGmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] });
    const h = msg.data.payload.headers;
    return { subject: getHeader(h, 'Subject'), from: getHeader(h, 'From') };
  }));
}

async function creaDocumento(titolo, contenuto, slackUserId) {
  var userDocs = getDocsPerUtente(slackUserId);
  if (!userDocs) throw new Error('NESSUN_TOKEN');
  var doc = await userDocs.documents.create({ requestBody: { title: titolo } });
  var docId = doc.data.documentId;
  await userDocs.documents.batchUpdate({ documentId: docId, requestBody: { requests: [{ insertText: { location: { index: 1 }, text: contenuto } }] } });
  return 'https://docs.google.com/document/d/' + docId + '/edit';
}

async function leggiCanaleSlack(channelId, limit) {
  limit = limit || 10;
  try { await app.client.conversations.join({ channel: channelId }); } catch(e) {}
  const res = await app.client.conversations.history({ channel: channelId, limit: limit });
  return res.messages || [];
}

async function getUtenti() {
  const res = await app.client.users.list();
  return (res.members || [])
    .filter(function(u) { return !u.is_bot && u.id !== 'USLACKBOT' && !u.deleted; })
    .map(function(u) { return { id: u.id, name: u.real_name || u.name, email: (u.profile && u.profile.email) || null }; });
}

async function resolveSlackMentions(text) {
  const pattern = /<@([A-Z0-9]+)>/g;
  const ids = [];
  let m;
  while ((m = pattern.exec(text)) !== null) {
    if (!ids.includes(m[1])) ids.push(m[1]);
  }
  if (ids.length === 0) return text;
  let resolved = text;
  for (const slackId of ids) {
    try {
      const res = await app.client.users.info({ user: slackId });
      const u = res.user;
      const name  = u.real_name || u.name;
      const email = (u.profile && u.profile.email) || '';
      resolved = resolved.split('<@' + slackId + '>').join('@' + name + (email ? ' (' + email + ')' : ''));
    } catch(e) {}
  }
  return resolved;
}

// ─── Context builder ──────────────────────────────────────────────────────────

async function buildContext(userMessage, userId) {
  let context = '';
  const msg = (userMessage || '').toLowerCase();

  if ((msg.includes('collega') || msg.includes('connetti') || msg.includes('autorizza')) &&
      (msg.includes('calendar') || msg.includes('gmail') || msg.includes('google') || msg.includes('account') || msg.includes('email') || msg.includes('mail'))) {
    return '\nLINK_OAUTH: ' + generaLinkOAuth(userId) + '\n';
  }

  if (msg.includes('drive') || msg.includes('file') || msg.includes('documento') || msg.includes('cerca')) {
    try {
      const query = userMessage.replace(/cerca|drive|file|documento/gi, '').trim();
      const files = await cercaSuDrive(query, userId);
      if (files.length > 0) {
        context += '\nFILE SU DRIVE:\n';
        files.forEach(function(f) { context += f.name + ': ' + f.webViewLink + '\n'; });
      } else { context += '\nNessun file trovato su Drive.\n'; }
    } catch(e) { context += '\nErrore Drive: ' + e.message + '\n'; }
  }

  if (msg.includes('email') || msg.includes('mail') || msg.includes('posta')) {
    try {
      const emails = await leggiEmailRecenti(5, userId);
      if (emails.length > 0) {
        context += '\nEMAIL NON LETTE:\n';
        emails.forEach(function(e) { context += 'Da: ' + e.from + ' | ' + e.subject + '\n'; });
      } else { context += '\nNessuna email non letta.\n'; }
    } catch(e) {
      context += (e.message === 'NESSUN_TOKEN')
        ? '\nGMAIL NON AUTORIZZATO: utente non autenticato.\n'
        : '\nErrore Gmail: ' + e.message + '\n';
    }
  }

  if (msg.includes('crea documento') || msg.includes('genera doc') || msg.includes('nuovo doc') || msg.includes('brief')) {
    try {
      const titolo = 'Documento Giuno - ' + new Date().toLocaleDateString('it-IT');
      const docUrl = await creaDocumento(titolo, 'Documento creato da Giuno\nRichiesta: ' + userMessage + '\n\n', userId);
      context += '\nDOCUMENTO CREATO: ' + docUrl + '\n';
    } catch(e) { context += '\nErrore Docs: ' + e.message + '\n'; }
  }

  if (msg.includes('canale') || msg.includes('leggi') || msg.includes('messaggi') || msg.includes('thread')) {
    try {
      const channels  = await app.client.conversations.list({ limit: 50 });
      const channelList = channels.channels || [];
      const target    = channelList.find(function(c) { return msg.includes(c.name); });
      if (target) {
        const messages = await leggiCanaleSlack(target.id, 10);
        context += '\nMESSAGGI IN #' + target.name + ':\n';
        messages.forEach(function(m) { if (m.text) context += m.text + '\n'; });
      } else {
        context += '\nCanali disponibili: ' + channelList.map(function(c) { return '#' + c.name; }).join(', ') + '\n';
      }
    } catch(e) { context += '\nErrore Slack: ' + e.message + '\n'; }
  }

  if (msg.includes('utenti') || msg.includes('team') || msg.includes('chi c') || msg.includes('membri')) {
    try {
      const utenti = await getUtenti();
      context += '\nMEMBRI DEL WORKSPACE:\n';
      utenti.forEach(function(u) { context += u.name + ': <@' + u.id + '>' + (u.email ? ' | ' + u.email : '') + '\n'; });
    } catch(e) { context += '\nErrore utenti: ' + e.message + '\n'; }
  }

  return context;
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "Ti chiami Giuno.\n" +
  "Sei l'assistente interno di Katania Studio, agenzia digitale di Catania.\n" +
  "Siciliano nell'anima, non nella caricatura. Usi mbare ogni tanto.\n" +
  "Frasi corte. Zero fronzoli. Ironico e cazzone, ma concreto.\n" +
  "Zero aziendalese. Dai la risposta prima. Poi eventualmente spieghi.\n" +
  "Katania Studio: agenzia digitale a Catania, filosofia WorkInSouth.\n" +
  "Rispondi sempre in italiano. Non inventare mai dati.\n\n" +
  "SLACK FORMATTING — REGOLE ASSOLUTE:\n" +
  "Usa *testo* per grassetto (un asterisco). MAI **doppio**.\n" +
  "Usa _testo_ per corsivo. Usa `testo` per codice inline.\n" +
  "Per liste usa • oppure numeri (1. 2. 3.). MAI trattini come bullet.\n" +
  "MAI usare # ## ### per titoli. MAI usare ** o __.\n" +
  "Risposte brevi. Max 4-5 righe salvo richieste complesse.\n\n" +
  "CONFERMA OBBLIGATORIA — REGOLA CRITICA:\n" +
  "Quando usi send_email, reply_email, forward_email, create_event, delete_event o share_file,\n" +
  "il sistema restituisce un'anteprima con requires_confirmation: true.\n" +
  "DEVI mostrare l'anteprima all'utente e chiedere conferma ESPLICITA.\n" +
  "Solo quando l'utente dice 'sì', 'ok', 'manda', 'procedi', 'confermo' puoi usare confirm_action.\n" +
  "MAI chiamare confirm_action senza conferma esplicita dell'utente. MAI.\n" +
  "Se l'utente chiede modifiche, prepara di nuovo l'azione con i parametri corretti.\n\n" +
  "DATI SENSIBILI:\n" +
  "MAI condividere in output: password, token, chiavi API, numeri di carta, IBAN completi.\n" +
  "Per email e documenti, mostra solo oggetto/titolo e mittente, mai il corpo intero a meno che l'utente non lo chieda esplicitamente.\n\n" +
  "HAI ACCESSO A:\n" +
  "Memoria permanente, Gemini (secondo cervello AI per review e cross-check), Google Drive (ricerca full-text), Gmail (tutte le operazioni + auto-review Gemini), Google Calendar, Google Docs, Slack (messaggi, ricerca, riassunti canali/thread), Preventivi (search_quotes), Rate Card (get_rate_card)\n\n" +
  "PREVENTIVI E RATE CARD:\n" +
  "- search_quotes: cerca preventivi per cliente, progetto, anno, stato. I dati visibili dipendono dal ruolo utente.\n" +
  "- get_rate_card: recupera il listino prezzi interni (solo admin/finance).\n" +
  "- RISPETTA SEMPRE le restrizioni del ruolo indicate in RUOLO UTENTE. Non mostrare dati che il ruolo non permette.\n\n" +
  "CONTESTO CANALE:\n" +
  "Quando vieni menzionato in un canale, ricevi automaticamente: nome canale, topic, messaggi recenti e membri presenti.\n" +
  "LEGGI SEMPRE la conversazione recente prima di rispondere. Capisci di cosa si sta parlando, quale progetto/cliente e' in discussione, chi ha detto cosa.\n" +
  "Rispondi nel contesto della discussione in corso, come un collega che segue la conversazione.\n" +
  "Non chiedere info che sono gia' visibili nei messaggi recenti del canale.\n\n" +
  "TAGGING SLACK — REGOLE:\n" +
  "1. Tagga SEMPRE chi ti ha scritto: <@USERID> all'inizio della risposta.\n" +
  "2. Tagga le persone COINVOLTE nell'azione: se si parla di un task per Paolo, tagga anche Paolo.\n" +
  "   Se serve coordinamento tra piu' persone, taggale tutte.\n" +
  "   Usa i MEMBRI PRESENTI NEL CANALE e la CONVERSAZIONE RECENTE per capire chi coinvolgere.\n" +
  "3. Se ci sono INFO BLOCCANTI, DECISIONI IMPORTANTI o PROBLEMI CRITICI,\n" +
  "   aggiungi in fondo al messaggio una riga 'cc <@manager1> <@manager2>' per dare visibilita' ai responsabili.\n" +
  "   Usa il profilo utente e la knowledge base per capire chi sono i manager/responsabili.\n" +
  "   Il cc NON e' obbligatorio: usalo solo quando serve davvero (blocchi, decisioni, escalation).\n" +
  "4. Per trovare ID o email di un collega usa get_slack_users.\n" +
  "5. MAI taggare persone a caso. Tagga solo chi e' rilevante per la conversazione.\n\n" +
  "GEMINI (dual-brain):\n" +
  "Hai un secondo cervello AI (Gemini) a disposizione:\n" +
  "- ask_gemini: per avere un secondo parere, cross-check info, brainstorming\n" +
  "- review_content: per rivedere copy/testi (web, social, email, presentazioni). Gemini controlla grammatica, tono, SEO, brand voice\n" +
  "- review_email_draft: per rivedere bozze email prima dell'invio\n" +
  "Le email inviate con send_email e reply_email vengono automaticamente riviste da Gemini.\n" +
  "Se Gemini trova problemi, li segnali all'utente. Usa Gemini quando serve qualita' extra, non per ogni messaggio.\n\n" +
  "GMAIL (tool use):\n" +
  "Per cercare email usa find_emails con query Gmail. Per leggere il testo usa read_email. Per rispondere usa reply_email.\n" +
  "Per inviare una nuova email usa send_email. Per inoltrare usa forward_email.\n" +
  "Prima di rispondere o inoltrare, leggila sempre con read_email per avere il contesto.\n" +
  "Le email vengono auto-riviste da Gemini. Se gemini_note e' presente nel risultato, comunicala all'utente.\n\n" +
  "CALENDAR (tool use):\n" +
  "Per qualsiasi operazione usa i tool. Timezone: Europe/Rome.\n" +
  "Per modificare/eliminare usa prima find_event per l'ID.\n" +
  "Per invitare qualcuno per nome, usa get_slack_users per trovare l'email.\n\n" +
  "MEMORIA (tool use):\n" +
  "Hai una memoria permanente per ogni utente. DEVI usarla:\n" +
  "- save_memory: salva PROATTIVAMENTE info importanti (preferenze clienti, decisioni, procedure). Non chiedere, salva e basta.\n" +
  "- recall_memory: SEMPRE prima di rispondere su clienti, progetti, procedure.\n" +
  "- list_memories / delete_memory: per gestire le memorie.\n" +
  "Sii proattivo: se l'utente dice 'il cliente Rossi vuole il sito in blu', salva subito senza chiedere.\n\n" +
  "PROFILO UTENTE:\n" +
  "Ogni utente ha un profilo che si arricchisce nel tempo: ruolo, progetti, clienti, competenze, stile comunicativo.\n" +
  "- update_user_profile: aggiorna PROATTIVAMENTE quando scopri info sul ruolo, progetti, clienti, competenze di chi ti parla.\n" +
  "- get_user_profile: per consultare il profilo di un collega.\n" +
  "Il profilo viene iniettato automaticamente nel contesto di ogni conversazione.\n\n" +
  "KNOWLEDGE BASE AZIENDALE:\n" +
  "Esiste una memoria condivisa per tutta l'azienda (procedure, info clienti, decisioni team).\n" +
  "- add_to_kb: salva info che valgono per TUTTI (es. 'L'hosting di ClienteX scade il 15 maggio').\n" +
  "- search_kb: cerca SEMPRE nella KB prima di rispondere su procedure o info aziendali.\n" +
  "La KB viene iniettata automaticamente nel contesto quando rilevante.\n" +
  "NON duplicare: se un'info e' personale usa save_memory, se e' aziendale usa add_to_kb.\n\n" +
  "AUTO-APPRENDIMENTO:\n" +
  "Dopo ogni conversazione, il sistema analizza automaticamente se ci sono info utili da salvare.\n" +
  "Questo avviene in background. Tu comunque usa save_memory e update_user_profile proattivamente quando e' ovvio.\n\n" +
  "GOOGLE DRIVE (tool use):\n" +
  "search_drive ora cerca full-text DENTRO i documenti, non solo nel nome.\n" +
  "Filtri disponibili: mime_type (document/spreadsheet/pdf/image), folder_name, modified_after, modified_before, shared_with.\n" +
  "Usa name_only: true solo se cerchi per nome file esatto.\n" +
  "Per leggere un Google Doc usa read_doc. Per creare documenti usa create_doc. Per condividere file usa share_file.\n\n" +
  "SLACK SEARCH (tool use):\n" +
  "Per cercare messaggi nei canali usa search_slack_messages. Supporta operatori Slack (in:#canale, from:@utente, has:link, before:, after:).\n\n" +
  "RICERCA GLOBALE:\n" +
  "search_everywhere cerca in Drive, Slack, Gmail e memoria contemporaneamente. Usalo quando l'utente chiede info generiche su un argomento/cliente/progetto.\n\n" +
  "RIASSUNTI:\n" +
  "summarize_channel: riassume cosa e' successo in un canale ('cosa mi sono perso in #canale?').\n" +
  "summarize_thread: riassume un thread lungo.\n" +
  "summarize_doc: legge un Google Doc, lo riassume e lo salva in memoria per dopo.\n" +
  "Usali PROATTIVAMENTE quando l'utente chiede recap, riassunti, o 'cosa mi sono perso'.\n\n" +
  "PREFERENZE:\n" +
  "Se l'utente chiede di disabilitare/abilitare routine, notifiche o standup, usa set_user_prefs.\n" +
  "Standup asincrono: ogni mattina alle 9:15 mando una domanda via DM, alle 10:00 pubblico il recap nel canale.\n\n" +
  "AUTH:\n" +
  "Se nei dati vedi LINK_OAUTH, manda il link per autorizzare.\n" +
  "Se vedi GMAIL NON AUTORIZZATO o un tool risponde con errore auth, di' di scrivere 'collega il mio Google'.";

// ─── askGiuno ─────────────────────────────────────────────────────────────────

function conversationKey(userId, threadTs) {
  return threadTs ? userId + ':' + threadTs : userId;
}

async function askGiuno(userId, userMessage, options) {
  options = options || {};

  if (!checkRateLimit(userId)) {
    return 'Piano piano, mbare. Troppe richieste. Aspetta un minuto.';
  }

  // RBAC: carica ruolo utente
  var userRole = await getUserRole(userId);

  const convKey = conversationKey(userId, options.threadTs);
  var convCache = getConversations();
  if (!convCache[convKey]) convCache[convKey] = [];

  const resolvedMessage = await resolveSlackMentions(userMessage);

  let contextData = '';
  try { contextData = await buildContext(resolvedMessage, userId); } catch(e) {
    contextData = '\nErrore: ' + e.message + '\n';
  }

  if (options.mentionedBy) {
    contextData += '\n[Sei stato menzionato da <@' + options.mentionedBy + '>. Taggalo nella risposta.]\n';
  }

  // Contesto canale (nome, topic, messaggi recenti, membri)
  if (options.channelContext) {
    contextData += '\n' + options.channelContext + '\n';
    // Inietta mapping canale → cliente/progetto se disponibile
    if (options.channelId) {
      var chMap = getChannelMap()[options.channelId];
      if (chMap) {
        if (chMap.cliente) contextData += 'CLIENTE CANALE: ' + chMap.cliente + '\n';
        if (chMap.progetto) contextData += 'PROGETTO CANALE: ' + chMap.progetto + '\n';
        if (chMap.tags && chMap.tags.length > 0) contextData += 'TAG CANALE: ' + chMap.tags.join(', ') + '\n';
      }
    }
  }

  // Inietta profilo utente
  var profile = getProfile(userId);
  if (profile.ruolo || profile.progetti.length > 0 || profile.clienti.length > 0) {
    contextData += '\nPROFILO UTENTE:\n';
    if (profile.ruolo) contextData += 'Ruolo: ' + profile.ruolo + '\n';
    if (profile.progetti.length > 0) contextData += 'Progetti: ' + profile.progetti.join(', ') + '\n';
    if (profile.clienti.length > 0) contextData += 'Clienti: ' + profile.clienti.join(', ') + '\n';
    if (profile.competenze.length > 0) contextData += 'Competenze: ' + profile.competenze.join(', ') + '\n';
    if (profile.stile_comunicativo) contextData += 'Stile: ' + profile.stile_comunicativo + '\n';
  }

  // Inietta memorie rilevanti automaticamente
  var relevantMemories = searchMemories(userId, resolvedMessage);
  if (relevantMemories.length > 0) {
    contextData += '\nMEMORIE RILEVANTI:\n';
    relevantMemories.slice(0, 5).forEach(function(m) {
      contextData += '[' + m.tags.join(', ') + '] ' + m.content + '\n';
    });
  }

  // Inietta knowledge base rilevante
  var kbResults = searchKB(resolvedMessage);
  if (kbResults.length > 0) {
    contextData += '\nKNOWLEDGE BASE AZIENDALE:\n';
    kbResults.slice(0, 3).forEach(function(entry) {
      contextData += '[' + entry.tags.join(', ') + '] ' + entry.content + '\n';
    });
  }

  const messageWithContext = contextData
    ? resolvedMessage + '\n\n[DATI RECUPERATI:\n' + contextData + ']'
    : resolvedMessage;

  const messages = convCache[convKey].concat([{ role: 'user', content: messageWithContext }]);

  let finalReply = '';
  var retryCount = 0;

  while (true) {
    var response;
    try {
      response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: SYSTEM_PROMPT + '\n\nRUOLO UTENTE:\n' + getRoleSystemPrompt(userRole),
        messages: messages,
        tools: tools,
      });
    } catch(apiErr) {
      if (apiErr.status === 429 && retryCount < 2) {
        retryCount++;
        var waitSec = retryCount * 5;
        logger.warn('[RATE-LIMIT] 429, attendo ' + waitSec + 's (tentativo ' + retryCount + '/2)');
        await new Promise(function(r) { setTimeout(r, waitSec * 1000); });
        continue;
      }
      if (apiErr.status === 429) {
        return 'Sto ricevendo troppe richieste in questo momento, mbare. Riprova tra un minuto.';
      }
      throw apiErr;
    }

    if (response.stop_reason !== 'tool_use') {
      finalReply = response.content.filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('\n');
      break;
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolResults = await Promise.all(
      response.content.filter(function(b) { return b.type === 'tool_use'; }).map(async function(tu) {
        const result = await eseguiTool(tu.name, tu.input, userId, userRole);
        logger.info('Tool:', tu.name, '| User:', userId, '| Result:', JSON.stringify(result).substring(0, 80));
        return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) };
      })
    );

    messages.push({ role: 'user', content: toolResults });
  }

  convCache[convKey].push({ role: 'user', content: messageWithContext });
  convCache[convKey].push({ role: 'assistant', content: finalReply });
  if (convCache[convKey].length > 20) convCache[convKey] = convCache[convKey].slice(-20);
  db.saveConversation(convKey, convCache[convKey]);

  // Auto-learn in background: analizza la conversazione e salva info utili
  autoLearn(userId, resolvedMessage, finalReply).catch(function(e) {
    logger.error('Auto-learn error:', e.message);
  });

  return finalReply;
}

// ─── Auto-learn ──────────────────────────────────────────────────────────────

async function autoLearn(userId, userMessage, botReply) {
  // Evita di analizzare messaggi troppo corti o comandi
  if (!userMessage || userMessage.length < 20) return;
  var msgLower = userMessage.toLowerCase();
  if (msgLower.startsWith('collega') || msgLower.startsWith('/')) return;

  try {
    var analysisRes = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: 'Analizzi conversazioni per estrarre informazioni utili da ricordare.\n' +
        'Rispondi SOLO in formato JSON valido. Se non c\'e\' nulla di utile rispondi: {"skip": true}\n' +
        'Altrimenti rispondi con:\n' +
        '{\n' +
        '  "memories": [{"content": "info da ricordare", "tags": ["tipo:valore"]}],\n' +
        '  "profile": {"ruolo": null, "progetto": null, "cliente": null, "competenza": null, "nota": null},\n' +
        '  "kb": [{"content": "info aziendale condivisa", "tags": ["tipo:valore"]}]\n' +
        '}\n' +
        'Regole:\n' +
        '- I TAG devono essere SEMPRE nel formato tipo:valore. Tipi validi: cliente, progetto, area, tipo, persona, tool, processo\n' +
        '  Esempi: "cliente:elfo", "progetto:videoclip", "area:sviluppo", "tipo:procedura", "persona:antonio", "tool:figma"\n' +
        '- memories: info personali dell\'utente (preferenze, abitudini, contesti)\n' +
        '- profile: aggiornamenti al profilo professionale (ruolo, progetti, clienti, competenze)\n' +
        '- kb: SOLO info che valgono per tutta l\'azienda (procedure, info clienti condivise, decisioni team)\n' +
        '- NON salvare conversazioni banali, saluti, domande generiche\n' +
        '- NON duplicare info gia\' ovvie dal contesto\n' +
        '- Sii selettivo: salva SOLO cose che vale la pena ricordare tra settimane',
      messages: [{ role: 'user', content: 'UTENTE: ' + userMessage + '\n\nBOT: ' + botReply }],
    });

    var analysisText = analysisRes.content[0].text.trim();
    // Estrai JSON anche se wrapped in ```json
    var jsonMatch = analysisText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    var analysis = JSON.parse(jsonMatch[0]);
    if (analysis.skip) return;

    // Salva memorie personali
    if (analysis.memories && analysis.memories.length > 0) {
      analysis.memories.forEach(function(m) {
        if (m.content && m.content.length > 5) {
          addMemory(userId, m.content, m.tags || []);
          logger.info('[AUTO-LEARN] Memoria salvata per', userId + ':', m.content.substring(0, 60));
        }
      });
    }

    // Aggiorna profilo
    if (analysis.profile) {
      var p = analysis.profile;
      var hasUpdate = p.ruolo || p.progetto || p.cliente || p.competenza || p.nota;
      if (hasUpdate) {
        updateProfile(userId, p);
        logger.info('[AUTO-LEARN] Profilo aggiornato per', userId);
      }
    }

    // Salva nella knowledge base
    if (analysis.kb && analysis.kb.length > 0) {
      analysis.kb.forEach(function(entry) {
        if (entry.content && entry.content.length > 5) {
          addKBEntry(entry.content, entry.tags || [], userId);
          logger.info('[AUTO-LEARN] KB aggiornata:', entry.content.substring(0, 60));
        }
      });
    }
  } catch(e) {
    // JSON parse error o API error, ignora silenziosamente
    if (e.name !== 'SyntaxError') logger.error('[AUTO-LEARN] Errore:', e.message);
  }
}

// ─── Admin command ────────────────────────────────────────────────────────────

async function handleAdmin(command, respond) {
  var callerRole = await getUserRole(command.user_id);

  const args = command.text.replace(/^admin\s*/, '').trim().split(/\s+/);
  const sub  = args[0];

  // /giuno admin list — mostra utenti e token (solo admin)
  if (sub === 'list') {
    if (callerRole !== 'admin') {
      await respond({ text: 'Solo Antonio e Corrado possono usare questo comando.', response_type: 'ephemeral' });
      return;
    }
    const utenti = await getUtenti();
    let msg = '*Utenti e token Google:*\n';
    utenti.forEach(function(u) {
      msg += (getUserTokens()[u.id] ? '✅' : '❌') + ' ' + u.name + ' (<@' + u.id + '>)\n';
    });
    await respond({ text: msg, response_type: 'ephemeral' });
    return;
  }

  // /giuno admin revoke @utente — revoca token (solo admin)
  if (sub === 'revoke' && args[1]) {
    if (callerRole !== 'admin') {
      await respond({ text: 'Solo Antonio e Corrado possono usare questo comando.', response_type: 'ephemeral' });
      return;
    }
    const targetId = args[1].replace(/<@|>/g, '').split('|')[0];
    if (!getUserTokens()[targetId]) { await respond({ text: 'Nessun token trovato per quell\'utente.', response_type: 'ephemeral' }); return; }
    rimuoviTokenUtente(targetId);
    await respond({ text: 'Token revocato per <@' + targetId + '>.', response_type: 'ephemeral' });
    return;
  }

  // /giuno admin ruolo @nome livello — cambia ruolo (solo admin)
  if (sub === 'ruolo' && args[1]) {
    if (callerRole !== 'admin') {
      await respond({ text: 'Solo Antonio e Corrado possono modificare i ruoli.', response_type: 'ephemeral' });
      return;
    }
    var targetId = args[1].replace(/<@|>/g, '').split('|')[0];
    var newRole = (args[2] || '').toLowerCase();
    var validRoles = ['admin', 'finance', 'manager', 'member', 'restricted'];
    if (!validRoles.includes(newRole)) {
      await respond({ text: 'Ruolo non valido. Usa: ' + validRoles.join(', '), response_type: 'ephemeral' });
      return;
    }
    // Trova il nome display
    var utenti = await getUtenti();
    var targetUser = utenti.find(function(u) { return u.id === targetId; });
    var displayName = targetUser ? targetUser.name : null;

    var success = await setUserRole(targetId, newRole, displayName, command.user_id);
    if (success) {
      await respond({ text: '<@' + targetId + '> ora ha accesso livello *' + newRole + '*\nModificato da <@' + command.user_id + '>', response_type: 'ephemeral' });
    } else {
      await respond({ text: 'Errore nel salvataggio del ruolo. Riprova.', response_type: 'ephemeral' });
    }
    return;
  }

  // /giuno admin roles — mostra tutti i ruoli
  if (sub === 'roles') {
    if (callerRole !== 'admin') {
      await respond({ text: 'Solo Antonio e Corrado possono vedere i ruoli.', response_type: 'ephemeral' });
      return;
    }
    var roles = await getAllRoles();
    if (roles.length === 0) {
      await respond({ text: 'Nessun ruolo configurato.', response_type: 'ephemeral' });
      return;
    }
    var msg = '*Ruoli team:*\n';
    var order = { admin: 1, finance: 2, manager: 3, member: 4, restricted: 5 };
    roles.sort(function(a, b) { return (order[a.role] || 9) - (order[b.role] || 9); });
    roles.forEach(function(r) {
      msg += '*' + r.role.toUpperCase() + '* — ' + (r.display_name || r.slack_user_id) + ' (<@' + r.slack_user_id + '>)\n';
    });
    await respond({ text: msg, response_type: 'ephemeral' });
    return;
  }

  await respond({ text: 'Comandi admin:\n• `admin list` — utenti e token Google\n• `admin roles` — mostra ruoli team\n• `admin ruolo @nome livello` — cambia ruolo\n• `admin revoke @utente` — revoca token Google\n\nLivelli: admin, finance, manager, member, restricted', response_type: 'ephemeral' });
}

// ─── Slack handlers ───────────────────────────────────────────────────────────

app.event('app_mention', async function(args) {
  const event = args.event;
  const threadTs = event.thread_ts || event.ts;
  stats.messagesHandled++;
  try {
    const text  = event.text.replace(/<@[^>]+>/g, '').trim();

    // Raccogli contesto del canale: info, messaggi recenti, partecipanti
    var channelContext = '';
    try {
      var chInfo = await app.client.conversations.info({ channel: event.channel });
      var ch = chInfo.channel || {};
      channelContext += 'CANALE: #' + (ch.name || 'sconosciuto');
      if (ch.topic && ch.topic.value) channelContext += '\nTopic: ' + ch.topic.value;
      if (ch.purpose && ch.purpose.value) channelContext += '\nDescrizione: ' + ch.purpose.value;
      channelContext += '\n';
    } catch(e) {}

    // Messaggi recenti nel thread (se in thread) o nel canale
    try {
      var recentMsgs;
      if (event.thread_ts) {
        var threadRes = await app.client.conversations.replies({ channel: event.channel, ts: event.thread_ts, limit: 15 });
        recentMsgs = (threadRes.messages || []).slice(-15);
      } else {
        var histRes = await app.client.conversations.history({ channel: event.channel, limit: 10 });
        recentMsgs = (histRes.messages || []).reverse();
      }
      if (recentMsgs.length > 0) {
        channelContext += '\nCONVERSAZIONE RECENTE NEL CANALE:\n';
        for (var rm of recentMsgs) {
          if (rm.ts === event.ts) continue; // salta il messaggio corrente
          var who = rm.user ? '<@' + rm.user + '>' : 'bot';
          channelContext += who + ': ' + (rm.text || '').substring(0, 300) + '\n';
        }
      }
    } catch(e) {}

    // Membri del canale
    try {
      var membersRes = await app.client.conversations.members({ channel: event.channel, limit: 50 });
      var memberIds = (membersRes.members || []).filter(function(id) { return id !== event.user; });
      if (memberIds.length > 0) {
        channelContext += '\nMEMBRI PRESENTI NEL CANALE: ' + memberIds.map(function(id) { return '<@' + id + '>'; }).join(', ') + '\n';
      }
    } catch(e) {}

    const reply = await askGiuno(event.user, text, { mentionedBy: event.user, threadTs: threadTs, channelContext: channelContext, channelId: ch ? ch.id : null });
    const formatted = formatPerSlack(reply);
    const posted = await app.client.chat.postMessage({ channel: event.channel, text: formatted, thread_ts: threadTs });
    if (posted && posted.ts) botMessages.set(posted.ts, { userId: event.user, text: formatted });
  } catch(err) {
    await app.client.chat.postMessage({ channel: event.channel, text: 'Errore: ' + err.message, thread_ts: threadTs });
  }
});

app.message(async function(args) {
  const message = args.message;
  if (message.channel_type !== 'im' || message.bot_id) return;

  // Intercetta risposte standup
  if (standupInAttesa.has(message.user)) {
    standupInAttesa.delete(message.user);
    const oggi = new Date().toISOString().slice(0, 10);
    var sd = getStandupData();
    if (sd.oggi === oggi) {
      sd.risposte[message.user] = {
        testo: message.text,
        timestamp: Date.now(),
      };
      salvaStandup();
      await app.client.chat.postMessage({ channel: message.channel, text: 'Registrato, mbare! Il recap uscira\' alle 10:00 nel canale.' });
      logger.info('[STANDUP] Risposta ricevuta da:', message.user);
      return;
    }
  }

  // Conferma /giuno cataloga
  var catConfirmKey = 'cataloga_confirm_' + message.user;
  if (catalogaConfirm.has(catConfirmKey)) {
    var catTesto = (message.text || '').toLowerCase().trim();
    if (catTesto === 'sì' || catTesto === 'si' || catTesto === 'ok' || catTesto === 'yes' || catTesto === 'procedi') {
      var catPending = catalogaConfirm.get(catConfirmKey);
      catalogaConfirm.delete(catConfirmKey);
      elaboraPreventivi(catPending.userId, catPending.channelId, catPending.files, catPending.rateCard)
        .catch(function(e) { logger.error('[CATALOGA] Errore elaborazione:', e.message); });
      await app.client.chat.postMessage({
        channel: message.channel,
        text: 'Perfetto! Elaboro ' + catPending.files.length + ' file in background. Ti avviso quando ho finito.',
      });
      return;
    } else if (catTesto === 'no' || catTesto === 'annulla' || catTesto === 'stop') {
      catalogaConfirm.delete(catConfirmKey);
      await app.client.chat.postMessage({ channel: message.channel, text: 'Catalogazione annullata.' });
      return;
    }
  }

  stats.messagesHandled++;
  const threadTs = message.thread_ts || null;
  try {
    const reply = await askGiuno(message.user, message.text, { threadTs: threadTs });
    const formatted = formatPerSlack(reply);
    const posted = await app.client.chat.postMessage({
      channel: message.channel,
      text: formatted,
      thread_ts: threadTs || undefined,
    });
    if (posted && posted.ts) botMessages.set(posted.ts, { userId: message.user, text: formatted });
  } catch(err) { await app.client.chat.postMessage({ channel: message.channel, text: 'Errore: ' + err.message }); }
});

app.command('/giuno', async function(args) {
  const command = args.command, ack = args.ack, respond = args.respond;
  await ack();
  const text = command.text.trim();

  if (text.startsWith('admin')) {
    await handleAdmin(command, respond);
    return;
  }

  // /giuno chi sono — mostra info utente e livello accesso
  if (text === 'chi sono' || text === 'chisono') {
    try {
      var myRole = await getUserRole(command.user_id);
      var roleDesc = getRoleSystemPrompt(myRole).split('\n').slice(0, 3).join('\n');
      var utenti = await getUtenti();
      var me = utenti.find(function(u) { return u.id === command.user_id; });
      var myName = me ? me.name : 'Utente';
      await respond({
        text: 'Ciao ' + myName + '!\n• Slack ID: `' + command.user_id + '`\n• Livello di accesso: *' + myRole.toUpperCase() + '*\n• ' + roleDesc,
        response_type: 'ephemeral',
      });
    } catch(err) { await respond({ text: 'Errore: ' + err.message, response_type: 'ephemeral' }); }
    return;
  }

  // Slash command routing
  if (text === 'recap' || text.startsWith('recap ')) {
    try {
      const canaliBriefing = await getSlackBriefingData();
      const parti = await buildBriefingUtente(command.user_id, canaliBriefing);
      await respond({ text: formatPerSlack(parti.join('\n\n')) || 'Niente di nuovo, mbare.', response_type: 'ephemeral' });
    } catch(err) { await respond({ text: 'Errore recap: ' + err.message, response_type: 'ephemeral' }); }
    return;
  }

  if (text === 'libero' || text.startsWith('libero ')) {
    try {
      const datePart = text.replace(/^libero\s*/, '').trim();
      const prompt = 'Mostrami gli slot liberi nel mio calendario' + (datePart ? ' per il giorno ' + datePart : ' oggi');
      const reply = await askGiuno(command.user_id, prompt);
      await respond({ text: formatPerSlack(reply), response_type: 'ephemeral' });
    } catch(err) { await respond({ text: 'Errore: ' + err.message, response_type: 'ephemeral' }); }
    return;
  }

  if (text === 'email' || text.startsWith('email ')) {
    try {
      const query = text.replace(/^email\s*/, '').trim() || 'is:unread is:important';
      const reply = await askGiuno(command.user_id, 'Mostrami le email: ' + query);
      await respond({ text: formatPerSlack(reply), response_type: 'ephemeral' });
    } catch(err) { await respond({ text: 'Errore: ' + err.message, response_type: 'ephemeral' }); }
    return;
  }

  if (text === 'cataloga' || text.startsWith('cataloga ')) {
    var catRole = await getUserRole(command.user_id);
    if (!checkPermission(catRole, 'view_financials')) {
      await respond({ text: getAccessDeniedMessage(catRole), response_type: 'ephemeral' });
      return;
    }
    try {
      await respond({ text: 'Avvio scansione preventivi su Drive... dammi un momento.', response_type: 'ephemeral' });
      await catalogaPreventivi(command.user_id, command.channel_id);
    } catch(err) { await respond({ text: 'Errore cataloga: ' + err.message, response_type: 'ephemeral' }); }
    return;
  }

  try {
    const reply = await askGiuno(command.user_id, text);
    await respond({ text: formatPerSlack(reply), response_type: 'in_channel' });
  } catch(err) { await respond('Errore: ' + err.message); }
});

// ─── Onboarding e feedback ────────────────────────────────────────────────────

app.event('team_join', async function(args) {
  const user = args.event.user;
  if (!user || user.is_bot) return;
  const name = (user.real_name || user.name || '').split(' ')[0] || 'nuovo membro';
  try {
    await app.client.chat.postMessage({
      channel: user.id,
      text: 'Benvenuto in Katania Studio, ' + name + '! Sono Giuno, il tuo assistente interno.\n\n' +
        'Posso aiutarti con:\n' +
        '• Calendario (eventi, Meet automatico, slot liberi)\n' +
        '• Gmail (leggi, rispondi, bozze, thread completi)\n' +
        '• Google Drive (cerca file, crea doc, condividi)\n' +
        '• Sondaggi Slack, standup, briefing giornaliero\n' +
        '• Ricerca globale su Drive, Gmail, Slack e memoria\n\n' +
        'Per collegare il tuo Google, scrivi: *collega il mio Google*\n' +
        'Sono disponibile in DM o taggami con @Giuno in qualsiasi canale.',
    });
    logger.info('[ONBOARDING] Benvenuto inviato a', user.id, name);
  } catch(e) { logger.error('[ONBOARDING]', e.message); }
});

app.event('reaction_added', async function(args) {
  const event = args.event;
  if (event.reaction !== '+1' && event.reaction !== '-1') return;
  if (!event.item || event.item.type !== 'message') return;
  const botMsg = botMessages.get(event.item.ts);
  if (!botMsg) return;
  const feedback = event.reaction === '+1' ? 'positivo' : 'negativo';
  logger.info('[FEEDBACK]', feedback, '| user:', event.user, '| text:', (botMsg.text || '').substring(0, 80));
  try {
    db.saveFeedback(event.item.ts, event.user, feedback, (botMsg.text || '').substring(0, 200));
  } catch(e) { logger.error('[FEEDBACK]', e.message); }
});

// ─── Routine giornaliera ──────────────────────────────────────────────────────

const TITOLI_RIPETITIVI = ['stand-up', 'standup', 'daily', 'sync', 'check-in', 'weekly', 'scrum'];

async function getSlackBriefingData() {
  const ieri = String(Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000));
  const channelsRes = await app.client.conversations.list({ limit: 100, types: 'public_channel,private_channel' });
  const channels = (channelsRes.channels || []).filter(function(c) { return !c.is_archived; });
  const risultati = [];
  for (const ch of channels) {
    try {
      const hist = await app.client.conversations.history({ channel: ch.id, oldest: ieri, limit: 30 });
      const msgs = (hist.messages || []).filter(function(m) { return !m.bot_id && m.type === 'message'; });
      if (msgs.length > 0) risultati.push({ id: ch.id, name: ch.name, messages: msgs, count: msgs.length });
    } catch(e) {}
  }
  return risultati;
}

async function buildBriefingUtente(slackUserId, canaliBriefing) {
  const parti = [];
  const oggi = new Date(); const fineGiorno = new Date(); fineGiorno.setHours(23, 59, 59, 999);

  const cal = getCalendarPerUtente(slackUserId);
  if (cal) {
    try {
      const res = await cal.events.list({ calendarId: 'primary', timeMin: oggi.toISOString(), timeMax: fineGiorno.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 20 });
      const eventi = (res.data.items || []).filter(function(e) {
        if (!e.recurringEventId) return true;
        const t = (e.summary || '').toLowerCase();
        return !TITOLI_RIPETITIVI.some(function(p) { return t.includes(p); });
      });
      if (eventi.length > 0) {
        let s = '*Agenda di oggi:*\n';
        eventi.forEach(function(e) {
          const ora = e.start.dateTime ? new Date(e.start.dateTime).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : 'tutto il giorno';
          s += ora + ' - ' + (e.summary || 'Senza titolo') + '\n';
        });
        parti.push(s.trim());
      } else { parti.push('*Agenda di oggi:* giornata libera.'); }
    } catch(e) { logger.error('Briefing calendar error:', e.message); }
  }

  const gm = getGmailPerUtente(slackUserId);
  if (gm) {
    try {
      const res = await gm.users.messages.list({ userId: 'me', maxResults: 5, q: 'is:unread is:important' });
      if (res.data.messages && res.data.messages.length > 0) {
        const emails = await Promise.all(res.data.messages.map(async function(m) {
          const msg = await gm.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'Subject'] });
          const h = msg.data.payload.headers;
          return { subject: getHeader(h, 'Subject'), from: getHeader(h, 'From') };
        }));
        let s = '*Mail importanti non lette:*\n';
        emails.forEach(function(e) { s += '"' + e.subject + '" da ' + e.from + '\n'; });
        parti.push(s.trim());
      }
    } catch(e) { logger.error('Briefing gmail error:', e.message); }
  }

  const top = canaliBriefing.slice().sort(function(a, b) { return b.count - a.count; }).slice(0, 3);
  if (top.length > 0) {
    let s = '*Canali piu\' caldi oggi:*\n';
    top.forEach(function(c) { s += '#' + c.name + ' (' + c.count + ' messaggi)\n'; });
    parti.push(s.trim());
  }

  const senzaRisposta = [];
  for (const canale of canaliBriefing) {
    if (senzaRisposta.length >= 5) break;
    for (const msg of canale.messages) {
      if (!msg.text || !msg.text.includes('<@' + slackUserId + '>')) continue;
      const threadTs = msg.thread_ts || msg.ts;
      try {
        const thread = await app.client.conversations.replies({ channel: canale.id, ts: threadTs, limit: 50 });
        const haiRisposto = (thread.messages || []).some(function(m) { return m.user === slackUserId; });
        if (!haiRisposto) {
          senzaRisposta.push({ channel: canale.name, testo: msg.text.replace(/<[^>]+>/g, '').trim().substring(0, 70) });
        }
      } catch(e) {}
    }
  }
  if (senzaRisposta.length > 0) {
    let s = '*Thread senza risposta:*\n';
    senzaRisposta.slice(0, 3).forEach(function(t) { s += '#' + t.channel + ': ' + t.testo + '...\n'; });
    parti.push(s.trim());
  }

  return parti;
}

async function inviaRoutineGiornaliera() {
  logger.info('[ROUTINE] Avvio briefing giornaliero...');
  try {
    const canaliBriefing = await getSlackBriefingData();
    const utenti = await getUtenti();
    for (const utente of utenti) {
      if (!getPrefs(utente.id).routine_enabled) continue;
      try {
        const parti = await buildBriefingUtente(utente.id, canaliBriefing);
        let msg = 'Buongiorno ' + utente.name.split(' ')[0] + ', mbare! Ecco cosa hai oggi:\n\n' + parti.join('\n\n');
        if (!getCalendarPerUtente(utente.id)) {
          msg += '\n\n_Collega il tuo Google scrivendo "collega il mio Google" per vedere anche agenda e mail._';
        }
        await app.client.chat.postMessage({ channel: utente.id, text: formatPerSlack(msg) });
      } catch(e) { logger.error('[ROUTINE] Errore per', utente.id + ':', e.message); }
    }
    logger.info('[ROUTINE] Briefing inviato a', utenti.length, 'utenti.');
  } catch(e) { logger.error('[ROUTINE] Errore generale:', e.message); }
}

// ─── Standup asincrono ───────────────────────────────────────────────────────

async function inviaStandupDomande() {
  const oggi = new Date().toISOString().slice(0, 10);
  logger.info('[STANDUP] Invio domande standup per', oggi);

  // Reset dati se è un nuovo giorno
  var sd = getStandupData();
  sd.oggi = oggi;
  sd.risposte = {};
  salvaStandup();

  const utenti = await getUtenti();
  let inviati = 0;
  for (const utente of utenti) {
    if (!getPrefs(utente.id).standup_enabled) continue;
    try {
      standupInAttesa.add(utente.id);
      await app.client.chat.postMessage({
        channel: utente.id,
        text: 'Buongiorno ' + utente.name.split(' ')[0] + '! Standup time.\n\n' +
          'Rispondi a questo messaggio con:\n' +
          '1. Su cosa lavori oggi?\n' +
          '2. Hai blocchi o serve aiuto?\n\n' +
          '_Scrivi tutto in un unico messaggio, il recap uscira\' alle 10:00._',
      });
      inviati++;
    } catch(e) { logger.error('[STANDUP] Errore invio a', utente.id + ':', e.message); }
  }
  logger.info('[STANDUP] Domande inviate a', inviati, 'utenti.');
}

async function pubblicaRecapStandup() {
  const oggi = new Date().toISOString().slice(0, 10);
  var sd = getStandupData();
  if (sd.oggi !== oggi) {
    logger.info('[STANDUP] Nessun dato standup per oggi, skip recap.');
    return;
  }

  const risposte = sd.risposte;
  const userIds = Object.keys(risposte);
  if (userIds.length === 0) {
    logger.info('[STANDUP] Nessuna risposta standup ricevuta, skip recap.');
    return;
  }

  // Pulisci gli utenti rimasti in attesa
  standupInAttesa.clear();

  let msg = '*Standup ' + oggi + '*\n\n';
  for (const userId of userIds) {
    const r = risposte[userId];
    msg += '<@' + userId + '>:\n' + r.testo + '\n\n';
  }

  // Trova il canale
  try {
    const channelsRes = await app.client.conversations.list({ limit: 200, types: 'public_channel,private_channel' });
    const target = (channelsRes.channels || []).find(function(c) {
      return c.name === STANDUP_CHANNEL || c.id === STANDUP_CHANNEL;
    });
    if (!target) {
      logger.error('[STANDUP] Canale "' + STANDUP_CHANNEL + '" non trovato.');
      return;
    }
    try { await app.client.conversations.join({ channel: target.id }); } catch(e) {}
    await app.client.chat.postMessage({ channel: target.id, text: formatPerSlack(msg) });
    logger.info('[STANDUP] Recap pubblicato in #' + target.name + ' con', userIds.length, 'risposte.');
  } catch(e) { logger.error('[STANDUP] Errore pubblicazione recap:', e.message); }
}

// ─── Riassunto settimanale ────────────────────────────────────────────────────

async function getSlackWeekData() {
  const unaSettimanaFa = String(Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000));
  const channelsRes = await app.client.conversations.list({ limit: 100, types: 'public_channel,private_channel' });
  const channels = (channelsRes.channels || []).filter(function(c) { return !c.is_archived; });
  const risultati = [];
  for (const ch of channels) {
    try {
      const hist = await app.client.conversations.history({ channel: ch.id, oldest: unaSettimanaFa, limit: 200 });
      const msgs = (hist.messages || []).filter(function(m) { return !m.bot_id && m.type === 'message'; });
      if (msgs.length > 0) risultati.push({ id: ch.id, name: ch.name, count: msgs.length });
    } catch(e) {}
  }
  return risultati;
}

async function buildRecapSettimanale(slackUserId, canaliSettimana) {
  const parti = [];
  const oggi = new Date();
  const unaSettimanaFa = new Date(oggi.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Eventi della settimana
  const cal = getCalendarPerUtente(slackUserId);
  if (cal) {
    try {
      const res = await cal.events.list({
        calendarId: 'primary',
        timeMin: unaSettimanaFa.toISOString(),
        timeMax: oggi.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 30,
      });
      const eventi = (res.data.items || []).filter(function(e) {
        if (!e.recurringEventId) return true;
        const t = (e.summary || '').toLowerCase();
        return !TITOLI_RIPETITIVI.some(function(p) { return t.includes(p); });
      });
      if (eventi.length > 0) {
        let s = '*Riunioni della settimana:* ' + eventi.length + ' eventi\n';
        eventi.slice(0, 8).forEach(function(e) {
          const giorno = e.start.dateTime
            ? new Date(e.start.dateTime).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' })
            : new Date(e.start.date).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
          s += giorno + ' — ' + (e.summary || 'Senza titolo') + '\n';
        });
        if (eventi.length > 8) s += '...e altri ' + (eventi.length - 8) + ' eventi\n';
        parti.push(s.trim());
      } else {
        parti.push('*Riunioni della settimana:* nessuna, settimana tranquilla.');
      }
    } catch(e) { logger.error('Recap calendar error:', e.message); }
  }

  // Email ricevute nella settimana
  const gm = getGmailPerUtente(slackUserId);
  if (gm) {
    try {
      const afterTs = Math.floor(unaSettimanaFa.getTime() / 1000);
      const res = await gm.users.messages.list({ userId: 'me', maxResults: 1, q: 'after:' + afterTs });
      const totale = res.data.resultSizeEstimate || 0;
      const unreadRes = await gm.users.messages.list({ userId: 'me', maxResults: 1, q: 'is:unread after:' + afterTs });
      const nonLette = unreadRes.data.resultSizeEstimate || 0;
      let s = '*Email della settimana:* ~' + totale + ' ricevute';
      if (nonLette > 0) s += ', ' + nonLette + ' ancora non lette';
      parti.push(s);
    } catch(e) { logger.error('Recap gmail error:', e.message); }
  }

  // Top canali Slack
  const top = canaliSettimana.slice().sort(function(a, b) { return b.count - a.count; }).slice(0, 5);
  if (top.length > 0) {
    let s = '*Canali piu\' attivi della settimana:*\n';
    top.forEach(function(c) { s += '#' + c.name + ' (' + c.count + ' messaggi)\n'; });
    parti.push(s.trim());
  }

  // Eventi settimana prossima
  if (cal) {
    try {
      const lunProssimo = new Date(oggi);
      lunProssimo.setDate(lunProssimo.getDate() + (8 - lunProssimo.getDay()) % 7);
      lunProssimo.setHours(0, 0, 0, 0);
      const venProssimo = new Date(lunProssimo);
      venProssimo.setDate(venProssimo.getDate() + 5);
      const res = await cal.events.list({
        calendarId: 'primary',
        timeMin: lunProssimo.toISOString(),
        timeMax: venProssimo.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 15,
      });
      const prossimi = (res.data.items || []).filter(function(e) {
        if (!e.recurringEventId) return true;
        const t = (e.summary || '').toLowerCase();
        return !TITOLI_RIPETITIVI.some(function(p) { return t.includes(p); });
      });
      if (prossimi.length > 0) {
        let s = '*Anteprima settimana prossima:* ' + prossimi.length + ' eventi\n';
        prossimi.slice(0, 5).forEach(function(e) {
          const giorno = e.start.dateTime
            ? new Date(e.start.dateTime).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' })
            : new Date(e.start.date).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
          s += giorno + ' — ' + (e.summary || 'Senza titolo') + '\n';
        });
        parti.push(s.trim());
      }
    } catch(e) { logger.error('Recap next week error:', e.message); }
  }

  return parti;
}

async function inviaRecapSettimanale() {
  logger.info('[RECAP] Avvio recap settimanale...');
  try {
    const canaliSettimana = await getSlackWeekData();
    const utenti = await getUtenti();
    for (const utente of utenti) {
      if (!getPrefs(utente.id).routine_enabled) continue;
      try {
        const parti = await buildRecapSettimanale(utente.id, canaliSettimana);
        let msg = 'Buon fine settimana ' + utente.name.split(' ')[0] + ', mbare! Ecco il recap della settimana:\n\n' + parti.join('\n\n');
        if (!getCalendarPerUtente(utente.id)) {
          msg += '\n\n_Collega il tuo Google per avere il recap completo con agenda e mail._';
        }
        await app.client.chat.postMessage({ channel: utente.id, text: formatPerSlack(msg) });
      } catch(e) { logger.error('[RECAP] Errore per', utente.id + ':', e.message); }
    }
    logger.info('[RECAP] Recap inviato a', utenti.length, 'utenti.');
  } catch(e) { logger.error('[RECAP] Errore generale:', e.message); }
}

// ─── Auto-index Drive (Supabase) ─────────────────────────────────────────────

function getDriveIndex() { return db.getDriveCache(); }

async function indicizzaDriveUtente(slackUserId) {
  var drv = getDrivePerUtente(slackUserId);
  if (!drv) return 0;

  var dueOreFa = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  try {
    var res = await drv.files.list({
      q: "modifiedTime > '" + dueOreFa + "' and trashed = false",
      fields: 'files(id, name, mimeType, webViewLink, modifiedTime, owners, description)',
      pageSize: 20,
      orderBy: 'modifiedTime desc',
    });
    var files = res.data.files || [];
    if (files.length === 0) return 0;

    db.saveDriveFiles(slackUserId, files);
    return files.length;
  } catch(e) {
    await handleTokenScaduto(slackUserId, e);
    return 0;
  }
}

async function indicizzaDriveTutti() {
  logger.info('[DRIVE-INDEX] Avvio indicizzazione...');
  var totale = 0;
  for (var uid of Object.keys(getUserTokens())) {
    var n = await indicizzaDriveUtente(uid);
    totale += n;
  }
  logger.info('[DRIVE-INDEX] Indicizzati', totale, 'file.');
}

// ─── Catalogazione preventivi ─────────────────────────────────────────────────

async function catalogaPreventivi(userId, channelId, maxFiles, skipConfirm) {
  maxFiles = maxFiles || 50;
  skipConfirm = skipConfirm || false;
  var drv = getDrivePerUtente(userId);
  var sheets = getSheetPerUtente(userId);
  if (!drv || !sheets) {
    await app.client.chat.postMessage({
      channel: channelId,
      text: 'Google non collegato. Scrivi "collega il mio Google" prima.',
    });
    return;
  }

  // STEP A: Trova rate card
  var rateCard = null;
  try {
    var rcRes = await drv.files.list({
      q: "fullText contains 'rate card' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
      fields: 'files(id, name)',
      pageSize: 5,
      orderBy: 'modifiedTime desc',
    });
    if (rcRes.data.files && rcRes.data.files.length > 0) {
      var rcFile = rcRes.data.files[0];
      var rcData = await sheets.spreadsheets.values.get({
        spreadsheetId: rcFile.id,
        range: 'A1:Z50',
      });
      var rcExtract = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: 'Estrai la rate card da questo foglio. Rispondi SOLO in JSON valido:\n' +
          '{"version":"current","effective_from":null,"resources":[{"person":null,"role":"nome ruolo","day_rate":null,"hour_rate":null,"notes":null}]}\n' +
          'Se non riesci a estrarre nulla di utile rispondi: {"skip":true}',
        messages: [{ role: 'user', content: 'Rate card dal file "' + rcFile.name + '":\n' + JSON.stringify(rcData.data.values || []).substring(0, 3000) }],
      });
      var rcText = rcExtract.content[0].text.trim();
      var rcJson = rcText.match(/\{[\s\S]*\}/);
      if (rcJson) {
        var parsed = JSON.parse(rcJson[0]);
        if (!parsed.skip) {
          rateCard = parsed;
          rateCard.source_doc_id = rcFile.id;
          await db.saveRateCard({
            version: 'current',
            effective_from: null,
            resources: rateCard.resources,
            source_doc_id: rcFile.id,
            notes: 'Estratto automaticamente da /giuno cataloga',
          });
          logger.info('[CATALOGA] Rate card trovata e salvata:', rcFile.name);
        }
      }
    }
  } catch(e) {
    logger.error('[CATALOGA] Errore rate card:', e.message);
  }

  // STEP B: Discovery preventivi
  var searchTerms = ['economics', 'preventivo', 'proposta', 'quotation', 'offerta', 'katania studio'];
  var searchMimes = [
    'application/vnd.google-apps.spreadsheet',
    'application/vnd.google-apps.document',
  ];
  var foundFiles = new Map();

  for (var i = 0; i < searchTerms.length; i++) {
    for (var mi = 0; mi < searchMimes.length; mi++) {
      try {
        var sRes = await drv.files.list({
          q: "fullText contains '" + searchTerms[i] + "' and mimeType = '" + searchMimes[mi] + "' and trashed = false",
          fields: 'files(id, name, modifiedTime, mimeType)',
          pageSize: 20,
          orderBy: 'modifiedTime desc',
        });
        (sRes.data.files || []).forEach(function(f) {
          if (!foundFiles.has(f.id)) foundFiles.set(f.id, f);
        });
      } catch(e) {
        logger.error('[CATALOGA] Errore search "' + searchTerms[i] + '":', e.message);
      }
    }
  }

  var files = Array.from(foundFiles.values()).slice(0, maxFiles);

  if (files.length === 0) {
    await app.client.chat.postMessage({
      channel: channelId,
      text: 'Nessun file preventivo trovato su Drive. Assicurati che i file contengano le parole chiave: economics, preventivo, proposta, quotation, offerta.',
    });
    return;
  }

  // Se skipConfirm, procedi direttamente
  if (skipConfirm) {
    elaboraPreventivi(userId, channelId, files, rateCard)
      .catch(function(e) { logger.error('[CATALOGA] Errore:', e.message); });
    return;
  }

  // Chiedi conferma
  await app.client.chat.postMessage({
    channel: channelId,
    text: formatPerSlack('*Trovati ' + files.length + ' file* da analizzare:\n' +
      files.slice(0, 8).map(function(f) { return '• ' + f.name; }).join('\n') +
      (files.length > 8 ? '\n...e altri ' + (files.length - 8) : '') +
      (rateCard ? '\n\n_Rate card trovata_' : '') +
      '\n\nRispondi *si* per procedere o *no* per annullare.'),
  });

  var confirmKey = 'cataloga_confirm_' + userId;
  catalogaConfirm.set(confirmKey, {
    files: files,
    userId: userId,
    channelId: channelId,
    rateCard: rateCard,
    created: Date.now(),
  });

  // Pulizia conferme vecchie (>15 min)
  setTimeout(function() { catalogaConfirm.delete(confirmKey); }, 15 * 60 * 1000);
}

async function elaboraPreventivi(userId, channelId, files, rateCard) {
  var sheets = getSheetPerUtente(userId);

  var results = {
    catalogati: 0,
    saltati: 0,
    da_rivedere: [],
    per_era: { 'pre-ratecard': 0, 'ratecard-v1': 0, 'ratecard-v2': 0, 'unknown': 0 },
    per_categoria: {},
    per_stato: { accepted: 0, rejected: 0, draft: 0, unknown: 0 },
    valori: [],
  };

  var toProcess = files.slice(0, 50);

  for (var i = 0; i < toProcess.length; i++) {
    var file = toProcess[i];
    try {
      // Controlla se gia' catalogato
      var exists = await db.quoteExistsByDocId(file.id);
      if (exists) {
        results.saltati++;
        continue;
      }

      // Leggi contenuto (Sheet o Doc)
      var fileContent = '';
      var isSheet = (file.mimeType || '').includes('spreadsheet');
      if (isSheet) {
        var sheetData = await sheets.spreadsheets.values.get({
          spreadsheetId: file.id,
          range: 'A1:Z100',
        });
        var rows = sheetData.data.values || [];
        if (rows.length === 0) { results.saltati++; continue; }
        fileContent = JSON.stringify(rows).substring(0, 4000);
      } else {
        // Google Doc
        var docs = getDocsPerUtente(userId);
        if (!docs) { results.saltati++; continue; }
        var doc = await docs.documents.get({ documentId: file.id });
        var text = '';
        var extractText = function(elements) {
          if (!elements) return;
          elements.forEach(function(el) {
            if (el.paragraph && el.paragraph.elements) {
              el.paragraph.elements.forEach(function(pe) {
                if (pe.textRun) text += pe.textRun.content;
              });
            }
            if (el.table) {
              (el.table.tableRows || []).forEach(function(row) {
                (row.tableCells || []).forEach(function(cell) {
                  extractText(cell.content);
                  text += '\t';
                });
                text += '\n';
              });
            }
          });
        };
        extractText(doc.data.body.content);
        if (text.trim().length < 20) { results.saltati++; continue; }
        fileContent = text.substring(0, 4000);
      }

      // Estrai dati con Claude
      var extraction = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system: 'Estrai dati da un preventivo/economics di agenzia digitale.\n' +
          'Rispondi SOLO in JSON valido, nessun testo prima o dopo:\n' +
          '{"client_name":"string o null","project_name":"string o null",' +
          '"service_category":"branding|content|performance|video|web|event|altro",' +
          '"service_tags":["array"],"deliverables":["array"],' +
          '"resources":[{"person":"string","days":0,"hours":0,"day_rate":0,"hour_rate":0,"subtotal":0}],' +
          '"total_days":0,"total_cost_interno":0,"price_quoted":0,"markup_pct":0,' +
          '"status":"accepted|rejected|draft|unknown","date":"YYYY-MM-DD o null",' +
          '"confidence":"high|medium|low","notes":"string o null"}',
        messages: [{
          role: 'user',
          content: 'File: "' + file.name + '" (' + (isSheet ? 'Sheet' : 'Doc') + ')\n\nContenuto:\n' +
            fileContent +
            (rateCard ? '\n\nRate card corrente:\n' + JSON.stringify(rateCard.resources).substring(0, 1000) : ''),
        }],
      });

      var extText = extraction.content[0].text.trim();
      var extJson = extText.match(/\{[\s\S]*\}/);
      if (!extJson) {
        results.da_rivedere.push(file.name + ' (parsing fallito)');
        continue;
      }

      var data = JSON.parse(extJson[0]);

      // Calcola pricing_era
      var pricing_era = 'unknown';
      if (data.date) {
        var d = new Date(data.date);
        if (d < new Date('2024-01-01')) pricing_era = 'pre-ratecard';
        else if (d < new Date('2025-06-01')) pricing_era = 'ratecard-v1';
        else pricing_era = 'ratecard-v2';
      }

      // Calcola markup se manca
      if (!data.markup_pct && data.price_quoted && data.total_cost_interno) {
        data.markup_pct = Math.round(
          (data.price_quoted - data.total_cost_interno) / data.total_cost_interno * 100
        );
      }

      var needs_review = data.confidence === 'low' || !data.client_name || !data.price_quoted;

      // Salva in Supabase
      await db.saveQuote({
        client_name: data.client_name,
        project_name: data.project_name,
        service_category: data.service_category,
        service_tags: data.service_tags || [],
        deliverables: data.deliverables || [],
        resources: data.resources || [],
        total_days: data.total_days,
        total_cost_interno: data.total_cost_interno,
        price_quoted: data.price_quoted,
        markup_pct: data.markup_pct,
        status: data.status || 'unknown',
        date: data.date || null,
        quote_year: data.date ? new Date(data.date).getFullYear() : null,
        quote_quarter: data.date
          ? 'Q' + Math.ceil((new Date(data.date).getMonth() + 1) / 3) + ' ' + new Date(data.date).getFullYear()
          : null,
        pricing_era: pricing_era,
        source_doc_id: file.id,
        source_doc_name: file.name,
        needs_review: needs_review,
        confidence: data.confidence,
        notes: data.notes,
        cataloged_at: new Date().toISOString(),
      });

      // Aggiorna contatori
      results.catalogati++;
      results.per_era[pricing_era] = (results.per_era[pricing_era] || 0) + 1;
      if (data.service_category) {
        results.per_categoria[data.service_category] = (results.per_categoria[data.service_category] || 0) + 1;
      }
      results.per_stato[data.status || 'unknown']++;
      if (data.price_quoted && data.status === 'accepted') {
        results.valori.push(data.price_quoted);
      }
      if (needs_review) results.da_rivedere.push(file.name);

      // Pausa per non bucare quota API
      await new Promise(function(r) { setTimeout(r, 500); });

    } catch(e) {
      logger.error('[CATALOGA] Errore file ' + file.name + ':', e.message);
      results.da_rivedere.push(file.name + ' (errore: ' + e.message.substring(0, 50) + ')');
    }
  }

  // STEP D: Report finale
  var totaleValore = results.valori.reduce(function(a, b) { return a + b; }, 0);

  var report = '*Scansione preventivi completata*\n\n';
  report += '*Trovati:* ' + files.length + ' file analizzati\n';
  report += '*Catalogati:* ' + results.catalogati + ' nuovi';
  if (results.saltati > 0) report += ' | *Gia\' presenti:* ' + results.saltati;
  report += '\n\n';

  report += '*Per era:*\n';
  report += '• Pre-ratecard (< 2024): ' + results.per_era['pre-ratecard'] + '\n';
  report += '• Ratecard v1 (2024-mid2025): ' + results.per_era['ratecard-v1'] + '\n';
  report += '• Ratecard v2 (2025-oggi): ' + results.per_era['ratecard-v2'] + '\n\n';

  if (Object.keys(results.per_categoria).length > 0) {
    report += '*Per categoria:*\n';
    Object.keys(results.per_categoria).forEach(function(k) {
      report += '• ' + k + ': ' + results.per_categoria[k] + '\n';
    });
    report += '\n';
  }

  report += '*Per stato:*\n';
  report += '• Accettati: ' + results.per_stato.accepted;
  if (totaleValore > 0) report += ' (tot. ' + totaleValore.toLocaleString('it-IT') + ')';
  report += '\n';
  report += '• Rifiutati: ' + results.per_stato.rejected + '\n';
  report += '• Bozze/sconosciuto: ' + (results.per_stato.draft + results.per_stato.unknown) + '\n';

  if (results.da_rivedere.length > 0) {
    report += '\n*Da revisionare manualmente:* ' + results.da_rivedere.length + ' file\n';
    results.da_rivedere.slice(0, 5).forEach(function(n) { report += '• ' + n + '\n'; });
    if (results.da_rivedere.length > 5) {
      report += '...e altri ' + (results.da_rivedere.length - 5) + '\n';
    }
  }

  if (rateCard) report += '\n_Rate card trovata e salvata_';

  await app.client.chat.postMessage({
    channel: channelId,
    text: formatPerSlack(report),
  });
}

// ─── Channel Map e Auto-learn canali ──────────────────────────────────────────

function getChannelMap() { return db.getChannelMapCache(); }
function getChannelDigests() { return db.getChannelDigestCache(); }

// Mappa automatica: deduce cliente/progetto dal nome e topic del canale
async function autoMapChannel(channelId) {
  try {
    var info = await app.client.conversations.info({ channel: channelId });
    var ch = info.channel || {};
    if (!ch.name) return null;

    var existing = getChannelMap()[channelId];
    if (existing && existing.cliente) return existing; // già mappato

    // Chiedi a Claude di dedurre cliente/progetto da nome e topic
    var chContext = 'Nome canale: #' + ch.name;
    if (ch.topic && ch.topic.value) chContext += '\nTopic: ' + ch.topic.value;
    if (ch.purpose && ch.purpose.value) chContext += '\nDescrizione: ' + ch.purpose.value;

    var res = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      system: 'Analizzi nomi e descrizioni di canali Slack aziendali.\n' +
        'Rispondi SOLO in JSON: {"cliente": "nome o null", "progetto": "nome o null", "tags": ["tag1"]}\n' +
        'Se il canale e\' generico (es. #general, #random, #dev) rispondi: {"cliente": null, "progetto": null, "tags": ["interno"]}\n' +
        'I tag devono essere nel formato: tipo:valore (es. "cliente:elfo", "area:sviluppo", "tipo:marketing")',
      messages: [{ role: 'user', content: chContext }],
    });

    var text = res.content[0].text.trim();
    var jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    var parsed = JSON.parse(jsonMatch[0]);
    var mapping = {
      channel_name: ch.name,
      cliente: parsed.cliente || null,
      progetto: parsed.progetto || null,
      tags: parsed.tags || [],
      note: ch.topic ? ch.topic.value : null,
    };
    db.saveChannelMapping(channelId, mapping);
    logger.info('[CHANNEL-MAP] #' + ch.name + ' → cliente:', mapping.cliente, '| progetto:', mapping.progetto);
    return mapping;
  } catch(e) {
    logger.error('[CHANNEL-MAP] Errore:', e.message);
    return null;
  }
}

// Ogni 4 ore: osserva i canali attivi e impara dalle conversazioni
async function digerisciCanali() {
  logger.info('[CHANNEL-DIGEST] Avvio digestione canali...');
  try {
    var channelsRes = await app.client.conversations.list({ limit: 100, types: 'public_channel,private_channel' });
    var channels = (channelsRes.channels || []).filter(function(c) { return !c.is_archived; });
    var digested = 0;

    for (var ch of channels) {
      try {
        // Mappa il canale se non già fatto
        await autoMapChannel(ch.id);

        var digests = getChannelDigests();
        var lastTs = (digests[ch.id] && digests[ch.id].last_ts) || String(Math.floor((Date.now() - 4 * 60 * 60 * 1000) / 1000));

        // Leggi messaggi recenti (dalle ultime 4 ore o dall'ultimo digest)
        var hist = await app.client.conversations.history({ channel: ch.id, oldest: lastTs, limit: 50 });
        var msgs = (hist.messages || []).filter(function(m) { return !m.bot_id && m.type === 'message' && m.text; });
        if (msgs.length < 3) continue; // troppo pochi messaggi, salta

        var newestTs = msgs[0].ts; // messages are newest first
        var msgText = msgs.reverse().map(function(m) {
          return (m.user ? '<@' + m.user + '>' : 'unknown') + ': ' + (m.text || '').substring(0, 200);
        }).join('\n');

        // Chiedi a Claude di estrarre info utili
        var channelMapping = getChannelMap()[ch.id] || {};
        var analysisRes = await client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 500,
          system: 'Analizzi conversazioni di canali Slack di un\'agenzia digitale.\n' +
            'Canale: #' + ch.name + (channelMapping.cliente ? ' (cliente: ' + channelMapping.cliente + ')' : '') +
            (channelMapping.progetto ? ' (progetto: ' + channelMapping.progetto + ')' : '') + '\n' +
            'Rispondi SOLO in JSON:\n' +
            '{"skip": true} se non c\'e\' nulla di utile.\n' +
            'Altrimenti:\n' +
            '{\n' +
            '  "digest": "riassunto breve di cosa si e\' discusso (max 3 righe)",\n' +
            '  "kb": [{"content": "info aziendale importante", "tags": ["tipo:valore"]}],\n' +
            '  "channel_update": {"cliente": "nome o null", "progetto": "nome o null"}\n' +
            '}\n' +
            'Regole:\n' +
            '- kb: solo decisioni, scadenze, info clienti, procedure — NON chiacchiere\n' +
            '- Tags strutturati: cliente:nome, progetto:nome, area:dev/design/marketing, tipo:decisione/scadenza/procedura\n' +
            '- channel_update: aggiorna solo se hai info piu\' precise sul cliente/progetto del canale',
          messages: [{ role: 'user', content: msgText }],
        });

        var analysisText = analysisRes.content[0].text.trim();
        var jsonMatch = analysisText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) continue;

        var analysis = JSON.parse(jsonMatch[0]);
        if (analysis.skip) { db.saveChannelDigest(ch.id, 'nessuna novita', newestTs); continue; }

        // Salva digest
        if (analysis.digest) {
          db.saveChannelDigest(ch.id, analysis.digest, newestTs);
        }

        // Salva KB entries con tag strutturati
        if (analysis.kb && analysis.kb.length > 0) {
          analysis.kb.forEach(function(entry) {
            if (entry.content && entry.content.length > 5) {
              var tags = (entry.tags || []);
              // Aggiungi tag canale automaticamente
              if (channelMapping.cliente) tags.push('cliente:' + channelMapping.cliente.toLowerCase());
              if (channelMapping.progetto) tags.push('progetto:' + channelMapping.progetto.toLowerCase());
              tags.push('canale:' + ch.name);
              addKBEntry(entry.content, tags, 'channel-digest');
              logger.info('[CHANNEL-DIGEST] KB da #' + ch.name + ':', entry.content.substring(0, 60));
            }
          });
        }

        // Aggiorna mapping canale se Claude ha info migliori
        if (analysis.channel_update) {
          var cu = analysis.channel_update;
          if (cu.cliente || cu.progetto) {
            var current = getChannelMap()[ch.id] || { channel_name: ch.name, tags: [] };
            if (cu.cliente) current.cliente = cu.cliente;
            if (cu.progetto) current.progetto = cu.progetto;
            db.saveChannelMapping(ch.id, current);
          }
        }

        digested++;
      } catch(e) {
        if (e.status !== 429) logger.error('[CHANNEL-DIGEST] Errore #' + ch.name + ':', e.message);
      }
    }
    logger.info('[CHANNEL-DIGEST] Digeriti', digested, 'canali.');
  } catch(e) { logger.error('[CHANNEL-DIGEST] Errore generale:', e.message); }
}

// ─── Notifiche proattive (disabilitate) ───────────────────────────────────────
// Reminder calendario e push email rimossi per evitare spam.

// ─── Startup ──────────────────────────────────────────────────────────────────

(async function() {
  // Carica tutti i dati da Supabase (o JSON fallback) prima di avviare
  await db.initAll();
  logger.info('Persistenza inizializzata:', db.isSupabase() ? 'Supabase' : 'JSON locale (fallback)');

  oauthServer.listen(OAUTH_PORT, function() {
    logger.info('OAuth + Dashboard server su porta ' + OAUTH_PORT);
    logger.info('Dashboard: http://localhost:' + OAUTH_PORT + '/dashboard');
  });
  await app.start();

  cron.schedule('45 8 * * 1-5', inviaRoutineGiornaliera, { timezone: 'Europe/Rome' });
  cron.schedule('5 9 * * 1-5', inviaStandupDomande, { timezone: 'Europe/Rome' });
  cron.schedule('0 10 * * 1-5', pubblicaRecapStandup, { timezone: 'Europe/Rome' });
  cron.schedule('0 17 * * 5', inviaRecapSettimanale, { timezone: 'Europe/Rome' });
  cron.schedule('0 */2 * * *', indicizzaDriveTutti, { timezone: 'Europe/Rome' });
  cron.schedule('0 */4 * * *', digerisciCanali, { timezone: 'Europe/Rome' });
  logger.info('Routine schedulata: lun-ven alle 8:45 Europe/Rome');
  logger.info('Standup asincrono: domande 9:05, recap 10:00 lun-ven in #' + STANDUP_CHANNEL);
  logger.info('Recap settimanale: venerdi\' alle 17:00 Europe/Rome');
  logger.info('Drive auto-index: ogni 2 ore');
  logger.info('Channel digest: ogni 4 ore');
  // Indicizza Drive subito all'avvio
  indicizzaDriveTutti().catch(function(e) { logger.error('Drive index startup error:', e.message); });
  logger.info('Giuno e online!');
})();
