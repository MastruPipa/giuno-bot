require('dotenv').config();
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const fs = require('fs');
const http = require('http');
const url = require('url');
const cron = require('node-cron');

// ─── Logger ───────────────────────────────────────────────────────────────────

function log(level, ...args) {
  process.stdout.write('[' + new Date().toISOString() + '] [' + level + '] ' + args.join(' ') + '\n');
}
const logger = {
  info:  function(...a) { log('INFO ', ...a); },
  warn:  function(...a) { log('WARN ', ...a); },
  error: function(...a) { log('ERROR', ...a); },
};

// ─── Slack + Anthropic ────────────────────────────────────────────────────────

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const client = new Anthropic();

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
];

const oAuth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URI);
oAuth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

logger.info('Google client ID presente:', !!GOOGLE_CLIENT_ID);
logger.info('Google refresh token presente:', !!process.env.GOOGLE_REFRESH_TOKEN);
logger.info('OAuth redirect URI:', OAUTH_REDIRECT_URI);

const drive = google.drive({ version: 'v3', auth: oAuth2Client });
const docs  = google.docs({ version: 'v1', auth: oAuth2Client });

// ─── Token per utente ─────────────────────────────────────────────────────────

const USER_TOKENS_FILE = 'user_tokens.json';
let userTokens = {};
try { userTokens = JSON.parse(fs.readFileSync(USER_TOKENS_FILE)); } catch(e) {}

function salvaTokenUtente(slackUserId, refreshToken) {
  userTokens[slackUserId] = refreshToken;
  fs.writeFileSync(USER_TOKENS_FILE, JSON.stringify(userTokens, null, 2));
}

function rimuoviTokenUtente(slackUserId) {
  delete userTokens[slackUserId];
  fs.writeFileSync(USER_TOKENS_FILE, JSON.stringify(userTokens, null, 2));
  logger.warn('Token rimosso per utente:', slackUserId);
}

function generaLinkOAuth(slackUserId) {
  const authClient = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URI);
  return authClient.generateAuthUrl({ access_type: 'offline', scope: GOOGLE_SCOPES, state: slackUserId, prompt: 'consent' });
}

function getAuthPerUtente(slackUserId) {
  const refreshToken = userTokens[slackUserId];
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

// ─── Preferenze utente ────────────────────────────────────────────────────────

const USER_PREFS_FILE = 'user_prefs.json';
let userPrefs = {};
try { userPrefs = JSON.parse(fs.readFileSync(USER_PREFS_FILE)); } catch(e) {}

function salvaPrefs() {
  try { fs.writeFileSync(USER_PREFS_FILE, JSON.stringify(userPrefs, null, 2)); } catch(e) {}
}

function getPrefs(userId) {
  return Object.assign({ routine_enabled: true, notifiche_enabled: true }, userPrefs[userId] || {});
}

function setPrefs(userId, prefs) {
  userPrefs[userId] = Object.assign(getPrefs(userId), prefs);
  salvaPrefs();
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

// ─── Persistenza conversazioni ────────────────────────────────────────────────

const CONVERSATIONS_FILE = 'conversations.json';
let conversations = {};
try { conversations = JSON.parse(fs.readFileSync(CONVERSATIONS_FILE)); } catch(e) {}

function salvaConversazioni() {
  try { fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify(conversations)); } catch(e) {}
}

// ─── Server OAuth callback ────────────────────────────────────────────────────

const oauthServer = http.createServer(async function(req, res) {
  const parsed = url.parse(req.url, true);
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
    description: 'Aggiorna le preferenze dell\'utente per Giuno (routine mattutina, notifiche proattive).',
    input_schema: {
      type: 'object',
      properties: {
        routine_enabled:    { type: 'boolean', description: 'Abilita/disabilita la routine del mattino' },
        notifiche_enabled:  { type: 'boolean', description: 'Abilita/disabilita le notifiche proattive (riunioni imminenti, mail urgenti)' },
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
  // Google Drive
  {
    name: 'search_drive',
    description: 'Cerca file su Google Drive dell\'utente per nome o contenuto.',
    input_schema: {
      type: 'object',
      properties: {
        query:     { type: 'string', description: 'Testo da cercare nel nome o contenuto dei file' },
        mime_type: { type: 'string', description: 'Filtra per tipo MIME (es. "application/vnd.google-apps.document", "application/pdf"). Opzionale.' },
        max:       { type: 'number', description: 'Numero massimo risultati (default 10)' },
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
];

// ─── Tool execution ───────────────────────────────────────────────────────────

async function eseguiTool(toolName, input, userId) {
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
    };
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
        const event = {
          summary: input.title,
          start: { dateTime: input.start, timeZone: 'Europe/Rome' },
          end:   { dateTime: input.end,   timeZone: 'Europe/Rome' },
        };
        if (input.description) event.description = input.description;
        if (input.location)    event.location    = input.location;
        if (input.attendees && input.attendees.length > 0) {
          event.attendees = input.attendees.map(function(e) { return { email: e }; });
        }
        const res = await cal.events.insert({ calendarId: 'primary', requestBody: event, sendUpdates: (input.attendees && input.attendees.length > 0) ? 'all' : 'none' });
        return { success: true, event_id: res.data.id, link: res.data.htmlLink };
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
        return { success: true };
      }

      if (toolName === 'send_email') {
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
        return { success: true, to: input.to, subject: input.subject };
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
        let q = "name contains '" + input.query.replace(/'/g, "\\'") + "' and trashed = false";
        if (input.mime_type) q += " and mimeType = '" + input.mime_type + "'";
        const res = await drv.files.list({ q: q, fields: 'files(id, name, mimeType, webViewLink, modifiedTime, owners)', pageSize: max, orderBy: 'modifiedTime desc' });
        return {
          files: (res.data.files || []).map(function(f) {
            return { id: f.id, name: f.name, type: f.mimeType, link: f.webViewLink, modified: f.modifiedTime, owner: (f.owners && f.owners[0]) ? f.owners[0].emailAddress : null };
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

async function cercaSuDrive(query) {
  const res = await drive.files.list({ q: "name contains '" + query + "' and trashed = false", fields: 'files(id, name, webViewLink, modifiedTime)', pageSize: 5 });
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

async function creaDocumento(titolo, contenuto) {
  const doc = await docs.documents.create({ requestBody: { title: titolo } });
  const docId = doc.data.documentId;
  await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests: [{ insertText: { location: { index: 1 }, text: contenuto } }] } });
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
  const msg = userMessage.toLowerCase();

  if ((msg.includes('collega') || msg.includes('connetti') || msg.includes('autorizza')) &&
      (msg.includes('calendar') || msg.includes('gmail') || msg.includes('google') || msg.includes('account') || msg.includes('email') || msg.includes('mail'))) {
    return '\nLINK_OAUTH: ' + generaLinkOAuth(userId) + '\n';
  }

  if (msg.includes('drive') || msg.includes('file') || msg.includes('documento') || msg.includes('cerca')) {
    try {
      const query = userMessage.replace(/cerca|drive|file|documento/gi, '').trim();
      const files = await cercaSuDrive(query);
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
      const docUrl = await creaDocumento(titolo, 'Documento creato da Giuno\nRichiesta: ' + userMessage + '\n\n');
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
  "FORMATTAZIONE SLACK:\n" +
  "Risposte brevi e dirette. Mai paragrafi lunghi.\n" +
  "Niente trattini per le liste. Usa numeri o vai a capo.\n" +
  "Massimo 3-4 righe salvo richieste complesse.\n" +
  "Per il grassetto usa *testo* (mai **testo**). Per il corsivo usa _testo_.\n" +
  "Non usare # o ** che Slack non renderizza.\n\n" +
  "HAI ACCESSO A:\n" +
  "Google Drive (cercare file, leggere docs, condividere), Gmail (leggere, cercare, rispondere, inviare, inoltrare), Google Calendar (tutte le operazioni), Google Docs (creare e leggere documenti), Slack (cercare messaggi, utenti)\n\n" +
  "TAGGING SLACK:\n" +
  "Quando qualcuno ti menziona in canale, rispondi sempre taggandolo con <@USERID>.\n" +
  "Per trovare ID o email di un collega usa get_slack_users.\n\n" +
  "GMAIL (tool use):\n" +
  "Per cercare email usa find_emails con query Gmail. Per leggere il testo usa read_email. Per rispondere usa reply_email.\n" +
  "Per inviare una nuova email usa send_email. Per inoltrare usa forward_email.\n" +
  "Prima di rispondere o inoltrare, leggila sempre con read_email per avere il contesto.\n\n" +
  "CALENDAR (tool use):\n" +
  "Per qualsiasi operazione usa i tool. Timezone: Europe/Rome.\n" +
  "Per modificare/eliminare usa prima find_event per l'ID.\n" +
  "Per invitare qualcuno per nome, usa get_slack_users per trovare l'email.\n\n" +
  "GOOGLE DRIVE (tool use):\n" +
  "Per cercare file usa search_drive. Per leggere un Google Doc usa read_doc. Per creare documenti usa create_doc. Per condividere file usa share_file (serve l'ID file da search_drive e l'email da get_slack_users).\n\n" +
  "SLACK SEARCH (tool use):\n" +
  "Per cercare messaggi nei canali usa search_slack_messages. Supporta operatori Slack (in:#canale, from:@utente, has:link, before:, after:).\n\n" +
  "PREFERENZE:\n" +
  "Se l'utente chiede di disabilitare/abilitare routine o notifiche, usa set_user_prefs.\n\n" +
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

  const convKey = conversationKey(userId, options.threadTs);
  if (!conversations[convKey]) conversations[convKey] = [];

  const resolvedMessage = await resolveSlackMentions(userMessage);

  let contextData = '';
  try { contextData = await buildContext(resolvedMessage, userId); } catch(e) {
    contextData = '\nErrore: ' + e.message + '\n';
  }

  if (options.mentionedBy) {
    contextData += '\n[Sei stato menzionato da <@' + options.mentionedBy + '>. Taggalo nella risposta.]\n';
  }

  const messageWithContext = contextData
    ? resolvedMessage + '\n\n[DATI RECUPERATI:\n' + contextData + ']'
    : resolvedMessage;

  const messages = conversations[convKey].concat([{ role: 'user', content: messageWithContext }]);

  let finalReply = '';

  while (true) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: messages,
      tools: tools,
    });

    if (response.stop_reason !== 'tool_use') {
      finalReply = response.content.filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('\n');
      break;
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolResults = await Promise.all(
      response.content.filter(function(b) { return b.type === 'tool_use'; }).map(async function(tu) {
        const result = await eseguiTool(tu.name, tu.input, userId);
        logger.info('Tool:', tu.name, '| User:', userId, '| Result:', JSON.stringify(result).substring(0, 80));
        return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) };
      })
    );

    messages.push({ role: 'user', content: toolResults });
  }

  conversations[convKey].push({ role: 'user', content: messageWithContext });
  conversations[convKey].push({ role: 'assistant', content: finalReply });
  if (conversations[convKey].length > 20) conversations[convKey] = conversations[convKey].slice(-20);
  salvaConversazioni();

  return finalReply;
}

// ─── Admin command ────────────────────────────────────────────────────────────

async function handleAdmin(command, respond) {
  const adminId = process.env.ADMIN_USER_ID;
  if (!adminId || command.user_id !== adminId) {
    await respond({ text: 'Non sei autorizzato, mbare.', response_type: 'ephemeral' });
    return;
  }

  const args = command.text.replace(/^admin\s*/, '').trim().split(/\s+/);
  const sub  = args[0];

  if (sub === 'list') {
    const utenti = await getUtenti();
    let msg = '*Utenti e token Google:*\n';
    utenti.forEach(function(u) {
      msg += (userTokens[u.id] ? '✅' : '❌') + ' ' + u.name + ' (<@' + u.id + '>)\n';
    });
    await respond({ text: msg, response_type: 'ephemeral' });
    return;
  }

  if (sub === 'revoke' && args[1]) {
    const targetId = args[1].replace(/<@|>/g, '').split('|')[0];
    if (!userTokens[targetId]) { await respond({ text: 'Nessun token trovato per quell\'utente.', response_type: 'ephemeral' }); return; }
    rimuoviTokenUtente(targetId);
    await respond({ text: 'Token revocato per <@' + targetId + '>.', response_type: 'ephemeral' });
    return;
  }

  await respond({ text: 'Comandi: `admin list` | `admin revoke @utente`', response_type: 'ephemeral' });
}

// ─── Slack handlers ───────────────────────────────────────────────────────────

app.event('app_mention', async function(args) {
  const event = args.event, say = args.say;
  const threadTs = event.thread_ts || event.ts;
  try {
    const text  = event.text.replace(/<@[^>]+>/g, '').trim();
    const reply = await askGiuno(event.user, text, { mentionedBy: event.user, threadTs: threadTs });
    await say({ text: reply, thread_ts: threadTs });
  } catch(err) {
    await say({ text: 'Errore: ' + err.message, thread_ts: threadTs });
  }
});

app.message(async function(args) {
  const message = args.message, say = args.say;
  if (message.channel_type !== 'im' || message.bot_id) return;
  const threadTs = message.thread_ts || null;
  try {
    const reply = await askGiuno(message.user, message.text, { threadTs: threadTs });
    if (threadTs) {
      await say({ text: reply, thread_ts: threadTs });
    } else {
      await say({ text: reply });
    }
  } catch(err) { await say({ text: 'Errore: ' + err.message }); }
});

app.command('/giuno', async function(args) {
  const command = args.command, ack = args.ack, respond = args.respond;
  await ack();
  if (command.text.trim().startsWith('admin')) {
    await handleAdmin(command, respond);
    return;
  }
  try {
    const reply = await askGiuno(command.user_id, command.text);
    await respond({ text: reply, response_type: 'in_channel' });
  } catch(err) { await respond('Errore: ' + err.message); }
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
        await app.client.chat.postMessage({ channel: utente.id, text: msg });
      } catch(e) { logger.error('[ROUTINE] Errore per', utente.id + ':', e.message); }
    }
    logger.info('[ROUTINE] Briefing inviato a', utenti.length, 'utenti.');
  } catch(e) { logger.error('[ROUTINE] Errore generale:', e.message); }
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
        await app.client.chat.postMessage({ channel: utente.id, text: msg });
      } catch(e) { logger.error('[RECAP] Errore per', utente.id + ':', e.message); }
    }
    logger.info('[RECAP] Recap inviato a', utenti.length, 'utenti.');
  } catch(e) { logger.error('[RECAP] Errore generale:', e.message); }
}

// ─── Notifiche proattive ──────────────────────────────────────────────────────

const notificheRiunioniInviate = new Set();
const ultimaVerificaEmail = new Map();

// Ogni 2 minuti: avvisa per riunioni imminenti (15 min prima)
cron.schedule('*/2 * * * *', async function() {
  const now = new Date();
  const fra15 = new Date(now.getTime() + 15 * 60 * 1000);
  for (const slackUserId of Object.keys(userTokens)) {
    if (!getPrefs(slackUserId).notifiche_enabled) continue;
    const cal = getCalendarPerUtente(slackUserId);
    if (!cal) continue;
    try {
      const res = await cal.events.list({ calendarId: 'primary', timeMin: now.toISOString(), timeMax: fra15.toISOString(), singleEvents: true, maxResults: 5 });
      for (const evento of (res.data.items || [])) {
        const key = slackUserId + '_' + evento.id + '_' + (evento.start.dateTime || evento.start.date);
        if (notificheRiunioniInviate.has(key)) continue;
        notificheRiunioniInviate.add(key);
        const oraInizio = new Date(evento.start.dateTime || evento.start.date);
        const minuti = Math.round((oraInizio - now) / 60000);
        const testo = 'Tra ' + minuti + ' min: *' + (evento.summary || 'Evento') + '*' + (evento.location ? ' — ' + evento.location : '');
        await app.client.chat.postMessage({ channel: slackUserId, text: testo });
      }
    } catch(e) { await handleTokenScaduto(slackUserId, e); }
  }
}, { timezone: 'Europe/Rome' });

// Ogni ora: pulisce le notifiche riunioni vecchie
cron.schedule('0 * * * *', function() { notificheRiunioniInviate.clear(); });

// Ogni 10 minuti: avvisa per nuove email importanti
cron.schedule('*/10 * * * *', async function() {
  for (const slackUserId of Object.keys(userTokens)) {
    if (!getPrefs(slackUserId).notifiche_enabled) continue;
    const gm = getGmailPerUtente(slackUserId);
    if (!gm) continue;
    try {
      const ultima = ultimaVerificaEmail.get(slackUserId) || Math.floor((Date.now() - 10 * 60 * 1000) / 1000);
      ultimaVerificaEmail.set(slackUserId, Math.floor(Date.now() / 1000));
      const res = await gm.users.messages.list({ userId: 'me', maxResults: 3, q: 'is:unread is:important after:' + ultima });
      if (!res.data.messages || res.data.messages.length === 0) continue;
      const emails = await Promise.all(res.data.messages.map(async function(m) {
        const msg = await gm.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'Subject'] });
        const h = msg.data.payload.headers;
        return { subject: getHeader(h, 'Subject'), from: getHeader(h, 'From') };
      }));
      let testo = 'Mail importante' + (emails.length > 1 ? 'i' : '') + ' ricevut' + (emails.length > 1 ? 'e' : 'a') + ':\n';
      emails.forEach(function(e) { testo += '"' + e.subject + '" da ' + e.from + '\n'; });
      await app.client.chat.postMessage({ channel: slackUserId, text: testo });
    } catch(e) { await handleTokenScaduto(slackUserId, e); }
  }
});

// ─── Startup ──────────────────────────────────────────────────────────────────

(async function() {
  oauthServer.listen(OAUTH_PORT, function() {
    logger.info('OAuth server in ascolto su porta ' + OAUTH_PORT);
  });
  await app.start();

  cron.schedule('0 9 * * 1-5', inviaRoutineGiornaliera, { timezone: 'Europe/Rome' });
  cron.schedule('0 17 * * 5', inviaRecapSettimanale, { timezone: 'Europe/Rome' });
  logger.info('Routine schedulata: lun-ven alle 9:00 Europe/Rome');
  logger.info('Recap settimanale: venerdi\' alle 17:00 Europe/Rome');
  logger.info('Notifiche riunioni: ogni 2 min | Notifiche email: ogni 10 min');
  logger.info('Giuno e online!');
})();
