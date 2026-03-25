require('dotenv').config();
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const fs = require('fs');
const http = require('http');
const url = require('url');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const client = new Anthropic();

// Credenziali OAuth web (da file locale o env vars su Railway)
let webCreds = null;
try {
  webCreds = JSON.parse(fs.readFileSync('credentials-web.json')).web;
} catch(e) {}

const GOOGLE_CLIENT_ID = (webCreds && webCreds.client_id) || process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = (webCreds && webCreds.client_secret) || process.env.GOOGLE_CLIENT_SECRET;
const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI ||
  (webCreds && webCreds.redirect_uris && webCreds.redirect_uris[0]) ||
  ('http://localhost:3000/oauth/callback');

const OAUTH_PORT = process.env.OAUTH_PORT || 3000;
const CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar'];

// Client condiviso per Drive, Gmail, Docs (token del bot owner da .env)
const oAuth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  OAUTH_REDIRECT_URI
);
oAuth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

console.log('Google client ID presente:', !!GOOGLE_CLIENT_ID);
console.log('Google refresh token presente:', !!process.env.GOOGLE_REFRESH_TOKEN);
console.log('OAuth redirect URI:', OAUTH_REDIRECT_URI);

const drive = google.drive({ version: 'v3', auth: oAuth2Client });
const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
const docs = google.docs({ version: 'v1', auth: oAuth2Client });

// Carica token per utente (mappa slackUserId -> refreshToken)
const USER_TOKENS_FILE = 'user_tokens.json';
let userTokens = {};
try {
  userTokens = JSON.parse(fs.readFileSync(USER_TOKENS_FILE));
} catch(e) {
  userTokens = {};
}

function salvaTokenUtente(slackUserId, refreshToken) {
  userTokens[slackUserId] = refreshToken;
  fs.writeFileSync(USER_TOKENS_FILE, JSON.stringify(userTokens, null, 2));
}

function generaLinkOAuth(slackUserId) {
  const authClient = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    OAUTH_REDIRECT_URI
  );
  return authClient.generateAuthUrl({
    access_type: 'offline',
    scope: CALENDAR_SCOPES,
    state: slackUserId,
    prompt: 'consent',
  });
}

function getCalendarPerUtente(slackUserId) {
  const refreshToken = userTokens[slackUserId];
  if (!refreshToken) return null;
  const auth = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    OAUTH_REDIRECT_URI
  );
  auth.setCredentials({ refresh_token: refreshToken });
  return google.calendar({ version: 'v3', auth: auth });
}

// Server HTTP per callback OAuth
const oauthServer = http.createServer(async function(req, res) {
  const parsed = url.parse(req.url, true);

  if (parsed.pathname !== '/oauth/callback') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const code = parsed.query.code;
  const slackUserId = parsed.query.state;

  if (!code || !slackUserId) {
    res.writeHead(400);
    res.end('Parametri mancanti.');
    return;
  }

  try {
    const authClient = new google.auth.OAuth2(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      OAUTH_REDIRECT_URI
    );
    const tokenResponse = await authClient.getToken(code);
    const tokens = tokenResponse.tokens;

    if (!tokens.refresh_token) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body><h2>Errore: nessun refresh token ricevuto.</h2><p>Vai su <a href="https://myaccount.google.com/permissions">account Google</a>, rimuovi l\'accesso a questa app e riprova.</p></body></html>');
      return;
    }

    salvaTokenUtente(slackUserId, tokens.refresh_token);
    console.log('Token salvato per utente Slack:', slackUserId);

    // Manda DM su Slack all'utente
    try {
      await app.client.chat.postMessage({
        channel: slackUserId,
        text: 'Google Calendar collegato, mbare! Da ora vedo i tuoi eventi.',
      });
    } catch(e) {
      console.error('Errore DM Slack post-auth:', e.message);
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Autorizzazione completata!</h2><p>Puoi chiudere questa finestra e tornare su Slack.</p></body></html>');
  } catch(e) {
    console.error('Errore OAuth callback:', e.message);
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body><h2>Errore durante l\'autorizzazione</h2><p>' + e.message + '</p></body></html>');
  }
});

async function cercaSuDrive(query) {
  const res = await drive.files.list({
    q: "name contains '" + query + "' and trashed = false",
    fields: 'files(id, name, webViewLink, modifiedTime)',
    pageSize: 5,
  });
  return res.data.files;
}

async function leggiEmailRecenti(max) {
  max = max || 5;
  const res = await gmail.users.messages.list({ userId: 'me', maxResults: max, q: 'is:unread' });
  if (!res.data.messages) return [];
  const emails = await Promise.all(res.data.messages.map(async function(m) {
    const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] });
    const headers = msg.data.payload.headers;
    return {
      subject: (headers.find(function(h) { return h.name === 'Subject'; }) || {}).value,
      from: (headers.find(function(h) { return h.name === 'From'; }) || {}).value,
    };
  }));
  return emails;
}

async function leggiCalendario(giorni, slackUserId) {
  giorni = giorni || 7;
  const userCalendar = getCalendarPerUtente(slackUserId);
  if (!userCalendar) {
    throw new Error('NESSUN_TOKEN');
  }
  const now = new Date();
  const fine = new Date();
  fine.setDate(fine.getDate() + giorni);
  const res = await userCalendar.events.list({
    calendarId: 'primary',
    timeMin: now.toISOString(),
    timeMax: fine.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 10,
  });
  return res.data.items || [];
}

async function creaDocumento(titolo, contenuto) {
  const doc = await docs.documents.create({ requestBody: { title: titolo } });
  const docId = doc.data.documentId;
  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: { requests: [{ insertText: { location: { index: 1 }, text: contenuto } }] }
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
    .filter(function(u) { return !u.is_bot && u.id !== 'USLACKBOT'; })
    .map(function(u) { return { id: u.id, name: u.real_name || u.name }; });
}

const SYSTEM_PROMPT = "Ti chiami Giuno.\nSei l'assistente interno di Katania Studio, agenzia digitale di Catania.\nSiciliano nell'anima, non nella caricatura. Usi mbare ogni tanto.\nFrasi corte. Zero fronzoli. Ironico e cazzone, ma concreto.\nZero aziendalese. Dai la risposta prima. Poi eventualmente spieghi.\nKatania Studio: agenzia digitale a Catania, filosofia WorkInSouth.\nRispondi sempre in italiano. Non inventare mai dati.\n\nREGOLE DI FORMATTAZIONE SLACK:\nRisposte brevi e dirette. Mai paragrafi lunghi.\nNiente trattini per le liste. Usa numeri o vai a capo semplicemente.\nMassimo 3-4 righe per risposta salvo richieste complesse.\nTono conversazionale, non da report.\nPer il grassetto usa *testo* (non **testo**). Per il corsivo usa _testo_.\nNon usare mai markdown standard come # o ** che Slack non renderizza.\n\nHAI ACCESSO A:\nGoogle Drive: cercare file e documenti\nGmail: leggere email non lette\nGoogle Calendar: vedere eventi del calendario dell'utente\nGoogle Docs: creare documenti\nSlack: leggere canali e taggare utenti con <@USERID>\n\nGESTIONE CALENDARIO:\nSe nei dati recuperati vedi CALENDARIO NON AUTORIZZATO, di' all'utente che non ha ancora collegato il suo Google Calendar e che puo' farlo scrivendo 'collega il mio Google Calendar'.\nSe nei dati recuperati vedi LINK_OAUTH, manda quel link all'utente e digli di cliccarlo per autorizzare Giuno ad accedere al suo calendario. Spiega che dopo il reindirizzamento tornera' su Slack con il calendario attivo.";

const conversations = {};

async function buildContext(userMessage, userId) {
  let context = '';
  const msg = userMessage.toLowerCase();

  // Richiesta di collegare Google Calendar
  if ((msg.includes('collega') || msg.includes('connetti') || msg.includes('autorizza')) &&
      (msg.includes('calendar') || msg.includes('google') || msg.includes('account'))) {
    const oauthLink = generaLinkOAuth(userId);
    context += '\nLINK_OAUTH: ' + oauthLink + '\n';
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
      const emails = await leggiEmailRecenti(5);
      if (emails.length > 0) {
        context += '\nEMAIL NON LETTE:\n';
        emails.forEach(function(e) { context += 'Da: ' + e.from + ' | ' + e.subject + '\n'; });
      } else {
        context += '\nNessuna email non letta.\n';
      }
    } catch(e) { context += '\nErrore Gmail: ' + e.message + '\n'; }
  }

  if (msg.includes('calendar') || msg.includes('calendario') || msg.includes('riunion') || msg.includes('appuntament') || msg.includes('settimana') || msg.includes('oggi') || msg.includes('domani') || msg.includes('eventi')) {
    try {
      const eventi = await leggiCalendario(7, userId);
      if (eventi.length > 0) {
        context += '\nEVENTI CALENDARIO:\n';
        eventi.forEach(function(e) {
          const data = e.start && (e.start.dateTime || e.start.date);
          context += e.summary + ' | ' + new Date(data).toLocaleString('it-IT') + '\n';
        });
      } else {
        context += '\nNessun evento nei prossimi 7 giorni.\n';
      }
    } catch(e) {
      if (e.message === 'NESSUN_TOKEN') {
        context += '\nCALENDARIO NON AUTORIZZATO: questo utente non ha ancora collegato il suo Google Calendar.\n';
      } else {
        context += '\nErrore Calendar: ' + e.message + '\n';
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
      utenti.forEach(function(u) { context += u.name + ': <@' + u.id + '>\n'; });
    } catch(e) { context += '\nErrore utenti: ' + e.message + '\n'; }
  }

  return context;
}

async function askGiuno(userId, userMessage) {
  if (!conversations[userId]) conversations[userId] = [];
  let contextData = '';
  try { contextData = await buildContext(userMessage, userId); } catch(e) {
    contextData = '\nErrore accesso Google: ' + e.message + '\n';
  }
  const messageWithContext = contextData ? userMessage + '\n\n[DATI RECUPERATI:\n' + contextData + ']' : userMessage;
  conversations[userId].push({ role: 'user', content: messageWithContext });
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: conversations[userId],
  });
  const reply = response.content.filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('\n');
  conversations[userId].push({ role: 'assistant', content: reply });
  if (conversations[userId].length > 20) conversations[userId] = conversations[userId].slice(-20);
  return reply;
}

app.event('app_mention', async function(args) {
  const event = args.event;
  const say = args.say;
  try {
    const text = event.text.replace(/<@[^>]+>/g, '').trim();
    const reply = await askGiuno(event.user, text);
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

(async function() {
  oauthServer.listen(OAUTH_PORT, function() {
    console.log('OAuth server in ascolto su porta ' + OAUTH_PORT);
  });
  await app.start();
  console.log('Giuno e online!');
})();
