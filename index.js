require('dotenv').config();
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const fs = require('fs');
const http = require('http');
const url = require('url');
const cron = require('node-cron');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const client = new Anthropic();

// Credenziali OAuth web (da file locale o env vars su Railway)
let webCreds = null;
try { webCreds = JSON.parse(fs.readFileSync('credentials-web.json')).web; } catch(e) {}

const GOOGLE_CLIENT_ID = (webCreds && webCreds.client_id) || process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = (webCreds && webCreds.client_secret) || process.env.GOOGLE_CLIENT_SECRET;
const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI ||
  (webCreds && webCreds.redirect_uris && webCreds.redirect_uris[0]) ||
  'http://localhost:3000/oauth/callback';

const OAUTH_PORT = process.env.OAUTH_PORT || 3000;
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.modify',
];

// Client condiviso per Drive e Docs (token del bot owner da .env)
const oAuth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URI);
oAuth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

console.log('Google client ID presente:', !!GOOGLE_CLIENT_ID);
console.log('Google refresh token presente:', !!process.env.GOOGLE_REFRESH_TOKEN);
console.log('OAuth redirect URI:', OAUTH_REDIRECT_URI);

const drive = google.drive({ version: 'v3', auth: oAuth2Client });
const docs = google.docs({ version: 'v1', auth: oAuth2Client });

// ─── Token per utente ────────────────────────────────────────────────────────

const USER_TOKENS_FILE = 'user_tokens.json';
let userTokens = {};
try { userTokens = JSON.parse(fs.readFileSync(USER_TOKENS_FILE)); } catch(e) {}

function salvaTokenUtente(slackUserId, refreshToken) {
  userTokens[slackUserId] = refreshToken;
  fs.writeFileSync(USER_TOKENS_FILE, JSON.stringify(userTokens, null, 2));
}

function generaLinkOAuth(slackUserId) {
  const authClient = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URI);
  return authClient.generateAuthUrl({
    access_type: 'offline',
    scope: GOOGLE_SCOPES,
    state: slackUserId,
    prompt: 'consent',
  });
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

// ─── Server OAuth callback ───────────────────────────────────────────────────

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
      res.end('<html><body><h2>Errore: nessun refresh token.</h2><p>Vai su <a href="https://myaccount.google.com/permissions">account Google</a>, rimuovi l\'accesso a questa app e riprova.</p></body></html>');
      return;
    }

    salvaTokenUtente(slackUserId, tokens.refresh_token);
    console.log('Token salvato per:', slackUserId);

    try {
      await app.client.chat.postMessage({
        channel: slackUserId,
        text: 'Google collegato, mbare! Da ora vedo il tuo calendario e le tue email.',
      });
    } catch(e) { console.error('Errore DM:', e.message); }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Autorizzazione completata!</h2><p>Puoi chiudere questa finestra e tornare su Slack.</p></body></html>');
  } catch(e) {
    console.error('Errore OAuth:', e.message);
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body><h2>Errore</h2><p>' + e.message + '</p></body></html>');
  }
});

// ─── Calendar tool definitions ───────────────────────────────────────────────

const tools = [
  {
    name: 'get_slack_users',
    description: 'Ottieni la lista degli utenti Slack con nome, ID e email. Usalo per trovare l\'email di un collega prima di invitarlo a un evento Calendar, o per ottenere l\'ID per taggarlo.',
    input_schema: {
      type: 'object',
      properties: {
        name_filter: { type: 'string', description: 'Filtra per nome o parte del nome (opzionale)' },
      },
    },
  },
  {
    name: 'list_events',
    description: 'Elenca gli eventi del calendario nei prossimi N giorni',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Numero di giorni da oggi (default 7)' },
      },
    },
  },
  {
    name: 'find_event',
    description: 'Cerca eventi nel calendario per titolo o in un intervallo di date. Usalo prima di update_event, add_attendees o delete_event per ottenere l\'ID.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Testo da cercare nel titolo (opzionale)' },
        date_from: { type: 'string', description: 'Inizio ricerca ISO 8601 (opzionale, default oggi)' },
        date_to: { type: 'string', description: 'Fine ricerca ISO 8601 (opzionale, default +30 giorni)' },
      },
    },
  },
  {
    name: 'create_event',
    description: 'Crea un nuovo evento nel calendario. Le date devono essere ISO 8601 con timezone (es. 2025-03-25T10:00:00+01:00).',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Titolo dell\'evento' },
        start: { type: 'string', description: 'Data e ora di inizio ISO 8601' },
        end: { type: 'string', description: 'Data e ora di fine ISO 8601' },
        description: { type: 'string', description: 'Descrizione (opzionale)' },
        location: { type: 'string', description: 'Luogo (opzionale)' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'Email degli invitati (opzionale)' },
      },
      required: ['title', 'start', 'end'],
    },
  },
  {
    name: 'update_event',
    description: 'Modifica titolo, orario, luogo o descrizione di un evento esistente. Usa find_event prima per ottenere l\'ID.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'ID dell\'evento' },
        title: { type: 'string', description: 'Nuovo titolo (opzionale)' },
        start: { type: 'string', description: 'Nuova data/ora inizio ISO 8601 (opzionale)' },
        end: { type: 'string', description: 'Nuova data/ora fine ISO 8601 (opzionale)' },
        description: { type: 'string', description: 'Nuova descrizione (opzionale)' },
        location: { type: 'string', description: 'Nuovo luogo (opzionale)' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'add_attendees',
    description: 'Aggiunge invitati a un evento e manda notifiche email. Usa find_event prima per ottenere l\'ID.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'ID dell\'evento' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'Email degli invitati da aggiungere' },
      },
      required: ['event_id', 'attendees'],
    },
  },
  {
    name: 'delete_event',
    description: 'Elimina un evento dal calendario. Usa find_event prima per ottenere l\'ID.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'ID dell\'evento da eliminare' },
      },
      required: ['event_id'],
    },
  },
];

// ─── Calendar tool execution ─────────────────────────────────────────────────

async function eseguiTool(toolName, input, userId) {
  const cal = getCalendarPerUtente(userId);
  if (!cal) {
    return { error: 'Google Calendar non collegato. Scrivi "collega il mio Google" per autorizzare.' };
  }

  try {
    if (toolName === 'list_events') {
      const giorni = input.days || 7;
      const now = new Date();
      const fine = new Date();
      fine.setDate(fine.getDate() + giorni);
      const res = await cal.events.list({
        calendarId: 'primary',
        timeMin: now.toISOString(),
        timeMax: fine.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 15,
      });
      return {
        events: (res.data.items || []).map(function(e) {
          return {
            id: e.id,
            title: e.summary,
            start: e.start.dateTime || e.start.date,
            end: e.end.dateTime || e.end.date,
            location: e.location || null,
            attendees: (e.attendees || []).map(function(a) { return a.email; }),
          };
        }),
      };
    }

    if (toolName === 'find_event') {
      const from = input.date_from ? new Date(input.date_from) : new Date();
      const to = input.date_to ? new Date(input.date_to) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const res = await cal.events.list({
        calendarId: 'primary',
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        q: input.query || undefined,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 10,
      });
      return {
        events: (res.data.items || []).map(function(e) {
          return {
            id: e.id,
            title: e.summary,
            start: e.start.dateTime || e.start.date,
            end: e.end.dateTime || e.end.date,
            location: e.location || null,
            attendees: (e.attendees || []).map(function(a) { return a.email; }),
          };
        }),
      };
    }

    if (toolName === 'create_event') {
      const event = {
        summary: input.title,
        start: { dateTime: input.start, timeZone: 'Europe/Rome' },
        end: { dateTime: input.end, timeZone: 'Europe/Rome' },
      };
      if (input.description) event.description = input.description;
      if (input.location) event.location = input.location;
      if (input.attendees && input.attendees.length > 0) {
        event.attendees = input.attendees.map(function(email) { return { email: email }; });
      }
      const res = await cal.events.insert({
        calendarId: 'primary',
        requestBody: event,
        sendUpdates: (input.attendees && input.attendees.length > 0) ? 'all' : 'none',
      });
      return { success: true, event_id: res.data.id, link: res.data.htmlLink };
    }

    if (toolName === 'update_event') {
      const existing = await cal.events.get({ calendarId: 'primary', eventId: input.event_id });
      const event = existing.data;
      if (input.title) event.summary = input.title;
      if (input.start) event.start = { dateTime: input.start, timeZone: 'Europe/Rome' };
      if (input.end) event.end = { dateTime: input.end, timeZone: 'Europe/Rome' };
      if (input.description !== undefined) event.description = input.description;
      if (input.location !== undefined) event.location = input.location;
      await cal.events.update({
        calendarId: 'primary',
        eventId: input.event_id,
        requestBody: event,
        sendUpdates: 'all',
      });
      return { success: true };
    }

    if (toolName === 'add_attendees') {
      const existing = await cal.events.get({ calendarId: 'primary', eventId: input.event_id });
      const event = existing.data;
      const currentEmails = (event.attendees || []).map(function(a) { return a.email; });
      const nuovi = input.attendees.filter(function(e) { return !currentEmails.includes(e); });
      event.attendees = (event.attendees || []).concat(nuovi.map(function(e) { return { email: e }; }));
      await cal.events.update({
        calendarId: 'primary',
        eventId: input.event_id,
        requestBody: event,
        sendUpdates: 'all',
      });
      return { success: true, added: nuovi };
    }

    if (toolName === 'delete_event') {
      await cal.events.delete({ calendarId: 'primary', eventId: input.event_id });
      return { success: true };
    }

    return { error: 'Tool sconosciuto: ' + toolName };
  } catch(e) {
    return { error: e.message };
  }
}

async function eseguiToolSlack(toolName, input) {
  try {
    if (toolName === 'get_slack_users') {
      const utenti = await getUtenti();
      let filtered = utenti;
      if (input.name_filter) {
        const filter = input.name_filter.toLowerCase();
        filtered = utenti.filter(function(u) { return u.name.toLowerCase().includes(filter); });
      }
      return { users: filtered };
    }
    return null; // non è un tool Slack
  } catch(e) {
    return { error: e.message };
  }
}

// ─── Drive / Gmail / Docs helpers ────────────────────────────────────────────

async function cercaSuDrive(query) {
  const res = await drive.files.list({
    q: "name contains '" + query + "' and trashed = false",
    fields: 'files(id, name, webViewLink, modifiedTime)',
    pageSize: 5,
  });
  return res.data.files;
}

async function leggiEmailRecenti(max, slackUserId) {
  max = max || 5;
  const userGmail = getGmailPerUtente(slackUserId);
  if (!userGmail) throw new Error('NESSUN_TOKEN');
  const res = await userGmail.users.messages.list({ userId: 'me', maxResults: max, q: 'is:unread' });
  if (!res.data.messages) return [];
  const emails = await Promise.all(res.data.messages.map(async function(m) {
    const msg = await userGmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] });
    const headers = msg.data.payload.headers;
    return {
      subject: (headers.find(function(h) { return h.name === 'Subject'; }) || {}).value,
      from: (headers.find(function(h) { return h.name === 'From'; }) || {}).value,
    };
  }));
  return emails;
}

// Espande <@USERID> nel testo con "Nome (email)" per dare contesto a Claude
async function resolveSlackMentions(text) {
  const matches = [];
  const pattern = /<@([A-Z0-9]+)>/g;
  let m;
  while ((m = pattern.exec(text)) !== null) {
    if (!matches.find(function(x) { return x === m[1]; })) matches.push(m[1]);
  }
  if (matches.length === 0) return text;
  let resolved = text;
  for (let i = 0; i < matches.length; i++) {
    const slackId = matches[i];
    try {
      const res = await app.client.users.info({ user: slackId });
      const u = res.user;
      const name = u.real_name || u.name;
      const email = (u.profile && u.profile.email) || '';
      const label = '@' + name + (email ? ' (' + email + ')' : '');
      resolved = resolved.split('<@' + slackId + '>').join(label);
    } catch(e) { /* lascia il tag originale se fallisce */ }
  }
  return resolved;
}

async function creaDocumento(titolo, contenuto) {
  const doc = await docs.documents.create({ requestBody: { title: titolo } });
  const docId = doc.data.documentId;
  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: { requests: [{ insertText: { location: { index: 1 }, text: contenuto } }] },
  });
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
    .map(function(u) {
      return {
        id: u.id,
        name: u.real_name || u.name,
        email: (u.profile && u.profile.email) || null,
      };
    });
}

// ─── Context builder (Drive, Gmail, Slack) ───────────────────────────────────
// Il Calendar è gestito interamente via tool use da Claude

async function buildContext(userMessage, userId) {
  let context = '';
  const msg = userMessage.toLowerCase();

  // Richiesta collegamento Google
  if ((msg.includes('collega') || msg.includes('connetti') || msg.includes('autorizza')) &&
      (msg.includes('calendar') || msg.includes('gmail') || msg.includes('google') || msg.includes('account') || msg.includes('email') || msg.includes('mail'))) {
    context += '\nLINK_OAUTH: ' + generaLinkOAuth(userId) + '\n';
    return context;
  }

  if (msg.includes('drive') || msg.includes('file') || msg.includes('documento') || msg.includes('cerca')) {
    try {
      const query = userMessage.replace(/cerca|drive|file|documento/gi, '').trim();
      const files = await cercaSuDrive(query);
      if (files.length > 0) {
        context += '\nFILE SU DRIVE:\n';
        files.forEach(function(f) { context += f.name + ': ' + f.webViewLink + '\n'; });
      } else {
        context += '\nNessun file trovato su Drive.\n';
      }
    } catch(e) { context += '\nErrore Drive: ' + e.message + '\n'; }
  }

  if (msg.includes('email') || msg.includes('mail') || msg.includes('posta')) {
    try {
      const emails = await leggiEmailRecenti(5, userId);
      if (emails.length > 0) {
        context += '\nEMAIL NON LETTE:\n';
        emails.forEach(function(e) { context += 'Da: ' + e.from + ' | ' + e.subject + '\n'; });
      } else {
        context += '\nNessuna email non letta.\n';
      }
    } catch(e) {
      if (e.message === 'NESSUN_TOKEN') {
        context += '\nGMAIL NON AUTORIZZATO: questo utente non ha ancora collegato il suo Gmail.\n';
      } else {
        context += '\nErrore Gmail: ' + e.message + '\n';
      }
    }
  }

  if (msg.includes('crea documento') || msg.includes('genera doc') || msg.includes('nuovo doc') || msg.includes('brief')) {
    try {
      const titolo = 'Documento Giuno - ' + new Date().toLocaleDateString('it-IT');
      const url2 = await creaDocumento(titolo, 'Documento creato da Giuno\nRichiesta: ' + userMessage + '\n\n');
      context += '\nDOCUMENTO CREATO: ' + url2 + '\n';
    } catch(e) { context += '\nErrore Docs: ' + e.message + '\n'; }
  }

  if (msg.includes('canale') || msg.includes('leggi') || msg.includes('messaggi') || msg.includes('thread')) {
    try {
      const channels = await app.client.conversations.list({ limit: 50 });
      const channelList = channels.channels || [];
      const targetChannel = channelList.find(function(c) { return msg.includes(c.name); });
      if (targetChannel) {
        const messages = await leggiCanaleSlack(targetChannel.id, 10);
        context += '\nMESSAGGI IN #' + targetChannel.name + ':\n';
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
      utenti.forEach(function(u) {
        context += u.name + ': <@' + u.id + '>' + (u.email ? ' | ' + u.email : '') + '\n';
      });
    } catch(e) { context += '\nErrore utenti: ' + e.message + '\n'; }
  }

  return context;
}

// ─── System prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = "Ti chiami Giuno.\n" +
  "Sei l'assistente interno di Katania Studio, agenzia digitale di Catania.\n" +
  "Siciliano nell'anima, non nella caricatura. Usi mbare ogni tanto.\n" +
  "Frasi corte. Zero fronzoli. Ironico e cazzone, ma concreto.\n" +
  "Zero aziendalese. Dai la risposta prima. Poi eventualmente spieghi.\n" +
  "Katania Studio: agenzia digitale a Catania, filosofia WorkInSouth.\n" +
  "Rispondi sempre in italiano. Non inventare mai dati.\n\n" +
  "REGOLE DI FORMATTAZIONE SLACK:\n" +
  "Risposte brevi e dirette. Mai paragrafi lunghi.\n" +
  "Niente trattini per le liste. Usa numeri o vai a capo semplicemente.\n" +
  "Massimo 3-4 righe per risposta salvo richieste complesse.\n" +
  "Tono conversazionale, non da report.\n" +
  "Per il grassetto usa *testo* (non **testo**). Per il corsivo usa _testo_.\n" +
  "Non usare mai markdown standard come # o ** che Slack non renderizza.\n\n" +
  "HAI ACCESSO A:\n" +
  "Google Drive: cercare file e documenti\n" +
  "Gmail: leggere email non lette dell'utente\n" +
  "Google Calendar: creare, modificare, spostare, eliminare eventi e gestire invitati (via tool)\n" +
  "Google Docs: creare documenti\n" +
  "Slack: leggere canali, taggare utenti con <@USERID>, cercare persone per nome o email\n\n" +
  "TAGGING SLACK:\n" +
  "Quando qualcuno ti menziona in un canale, rispondi sempre taggandolo con <@USERID>.\n" +
  "Per trovare l'ID o l'email di un collega usa il tool get_slack_users.\n" +
  "Quando crei o modifichi eventi Calendar con colleghi, usa get_slack_users per trovare le loro email Slack.\n\n" +
  "GESTIONE CALENDAR (tool use):\n" +
  "Usa i tool per qualsiasi operazione sul calendario. Non inventare eventi.\n" +
  "Per creare eventi chiedi data/ora se non specificate. Timezone: Europe/Rome.\n" +
  "Per modificare o eliminare, usa find_event per trovare l'ID, poi agisci.\n" +
  "Quando aggiungi invitati, usa get_slack_users per trovare l'email se l'utente indica solo il nome.\n" +
  "Se un tool risponde con errore di autenticazione, di' di scrivere 'collega il mio Google'.\n\n" +
  "GESTIONE AUTH:\n" +
  "Se nei dati vedi LINK_OAUTH, manda il link e di' di cliccare per autorizzare Giuno.\n" +
  "Se nei dati vedi GMAIL NON AUTORIZZATO, di' di scrivere 'collega il mio Google'.";

// ─── Core: askGiuno con tool use loop ────────────────────────────────────────

const conversations = {};

async function askGiuno(userId, userMessage, options) {
  options = options || {};
  if (!conversations[userId]) conversations[userId] = [];

  // Risolve <@USERID> in nomi ed email reali prima di tutto il resto
  const resolvedMessage = await resolveSlackMentions(userMessage);

  let contextData = '';
  try { contextData = await buildContext(resolvedMessage, userId); } catch(e) {
    contextData = '\nErrore: ' + e.message + '\n';
  }

  if (options.mentionedBy) {
    contextData += '\n[Sei stato menzionato da <@' + options.mentionedBy + '>. Rispondendo in canale, taggalo sempre nella risposta.]\n';
  }

  const messageWithContext = contextData
    ? resolvedMessage + '\n\n[DATI RECUPERATI:\n' + contextData + ']'
    : resolvedMessage;

  // Array messaggi per questo turno (history + messaggio corrente)
  const messages = conversations[userId].concat([{ role: 'user', content: messageWithContext }]);

  let finalReply = '';

  // Tool use loop: Claude chiama tool finché non ha la risposta finale
  while (true) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: messages,
      tools: tools,
    });

    if (response.stop_reason !== 'tool_use') {
      finalReply = response.content
        .filter(function(b) { return b.type === 'text'; })
        .map(function(b) { return b.text; })
        .join('\n');
      break;
    }

    // Aggiungi risposta assistant (con tool_use blocks) e risultati
    messages.push({ role: 'assistant', content: response.content });

    const toolResults = await Promise.all(
      response.content
        .filter(function(b) { return b.type === 'tool_use'; })
        .map(async function(toolUse) {
          const slackResult = await eseguiToolSlack(toolUse.name, toolUse.input);
          const result = slackResult !== null ? slackResult : await eseguiTool(toolUse.name, toolUse.input, userId);
          return {
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify(result),
          };
        })
    );

    messages.push({ role: 'user', content: toolResults });
  }

  // Salva nella history il messaggio con mention risolte (senza blocchi tool)
  conversations[userId].push({ role: 'user', content: messageWithContext });
  conversations[userId].push({ role: 'assistant', content: finalReply });
  if (conversations[userId].length > 20) conversations[userId] = conversations[userId].slice(-20);

  return finalReply;
}

// ─── Slack handlers ───────────────────────────────────────────────────────────

app.event('app_mention', async function(args) {
  const event = args.event;
  const say = args.say;
  try {
    const text = event.text.replace(/<@[^>]+>/g, '').trim();
    const reply = await askGiuno(event.user, text, { mentionedBy: event.user });
    await say({ text: reply, thread_ts: event.thread_ts || event.ts });
  } catch (err) {
    await say({ text: 'Errore: ' + err.message, thread_ts: event.thread_ts || event.ts });
  }
});

app.message(async function(args) {
  const message = args.message;
  const say = args.say;
  if (message.channel_type !== 'im') return;
  if (message.bot_id) return;
  try {
    const reply = await askGiuno(message.user, message.text);
    await say({ text: reply });
  } catch (err) {
    await say({ text: 'Errore: ' + err.message });
  }
});

app.command('/giuno', async function(args) {
  const command = args.command;
  const ack = args.ack;
  const respond = args.respond;
  await ack();
  try {
    const reply = await askGiuno(command.user_id, command.text);
    await respond({ text: reply, response_type: 'in_channel' });
  } catch (err) {
    await respond('Errore: ' + err.message);
  }
});

// ─── Routine giornaliera ──────────────────────────────────────────────────────

const TITOLI_RIPETITIVI = ['stand-up', 'standup', 'daily', 'sync', 'check-in', 'weekly', 'scrum'];

// Recupera dati Slack una volta sola (condivisi tra tutti gli utenti)
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

// Costruisce il briefing per un singolo utente
async function buildBriefingUtente(slackUserId, nome, canaliBriefing) {
  const parti = [];
  const oggi = new Date();
  const fineGiorno = new Date(); fineGiorno.setHours(23, 59, 59, 999);

  // 1. Agenda di oggi (senza eventi ripetitivi comuni)
  const cal = getCalendarPerUtente(slackUserId);
  if (cal) {
    try {
      const res = await cal.events.list({
        calendarId: 'primary',
        timeMin: oggi.toISOString(),
        timeMax: fineGiorno.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 20,
      });
      const eventi = (res.data.items || []).filter(function(e) {
        if (!e.recurringEventId) return true;
        const t = (e.summary || '').toLowerCase();
        return !TITOLI_RIPETITIVI.some(function(p) { return t.includes(p); });
      });
      if (eventi.length > 0) {
        let s = '*Agenda di oggi:*\n';
        eventi.forEach(function(e) {
          const ora = e.start.dateTime
            ? new Date(e.start.dateTime).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
            : 'tutto il giorno';
          s += ora + ' - ' + (e.summary || 'Senza titolo') + '\n';
        });
        parti.push(s.trim());
      } else {
        parti.push('*Agenda di oggi:* giornata libera.');
      }
    } catch(e) { parti.push('*Agenda:* errore nel recupero.'); }
  }

  // 2. Mail importanti non lette
  const gm = getGmailPerUtente(slackUserId);
  if (gm) {
    try {
      const res = await gm.users.messages.list({ userId: 'me', maxResults: 5, q: 'is:unread is:important' });
      if (res.data.messages && res.data.messages.length > 0) {
        const emails = await Promise.all(res.data.messages.map(async function(m) {
          const msg = await gm.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'Subject'] });
          const h = msg.data.payload.headers;
          return {
            subject: (h.find(function(x) { return x.name === 'Subject'; }) || {}).value || '(nessun oggetto)',
            from: (h.find(function(x) { return x.name === 'From'; }) || {}).value || '',
          };
        }));
        let s = '*Mail importanti non lette:*\n';
        emails.forEach(function(e) { s += '"' + e.subject + '" da ' + e.from + '\n'; });
        parti.push(s.trim());
      }
    } catch(e) {}
  }

  // 3. Canali Slack più attivi (top 3)
  const top = canaliBriefing.slice().sort(function(a, b) { return b.count - a.count; }).slice(0, 3);
  if (top.length > 0) {
    let s = '*Canali piu\' caldi oggi:*\n';
    top.forEach(function(c) { s += '#' + c.name + ' (' + c.count + ' messaggi)\n'; });
    parti.push(s.trim());
  }

  // 4. Thread con menzioni senza risposta
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
          const testo = msg.text.replace(/<[^>]+>/g, '').trim().substring(0, 70);
          senzaRisposta.push({ channel: canale.name, testo: testo });
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

// Invia la routine a tutti i membri del workspace
async function inviaRoutineGiornaliera() {
  console.log('[ROUTINE] Invio briefing giornaliero...');
  try {
    const canaliBriefing = await getSlackBriefingData();
    const utenti = await getUtenti();

    for (const utente of utenti) {
      try {
        const nomeBrief = utente.name.split(' ')[0];
        const parti = await buildBriefingUtente(utente.id, nomeBrief, canaliBriefing);

        let msg = 'Buongiorno ' + nomeBrief + ', mbare! Ecco cosa hai oggi:\n\n' + parti.join('\n\n');

        if (!getCalendarPerUtente(utente.id)) {
          msg += '\n\n_Collega il tuo Google scrivendo "collega il mio Google" per vedere anche agenda e mail._';
        }

        await app.client.chat.postMessage({ channel: utente.id, text: msg });
      } catch(e) {
        console.error('[ROUTINE] Errore per ' + utente.id + ':', e.message);
      }
    }
    console.log('[ROUTINE] Briefing inviato a ' + utenti.length + ' utenti.');
  } catch(e) {
    console.error('[ROUTINE] Errore generale:', e.message);
  }
}

// ─── Startup ──────────────────────────────────────────────────────────────────

(async function() {
  oauthServer.listen(OAUTH_PORT, function() {
    console.log('OAuth server in ascolto su porta ' + OAUTH_PORT);
  });
  await app.start();

  // Routine giornaliera alle 9:00 ora italiana
  cron.schedule('0 9 * * 1-5', inviaRoutineGiornaliera, { timezone: 'Europe/Rome' });
  console.log('Routine giornaliera schedulata alle 9:00 (lun-ven, Europe/Rome)');

  console.log('Giuno e online!');
})();
