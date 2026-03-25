require('dotenv').config();
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const fs = require('fs');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const client = new Anthropic();

const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID || JSON.parse(fs.readFileSync('credentials.json')).installed.client_id,
  process.env.GOOGLE_CLIENT_SECRET || JSON.parse(fs.readFileSync('credentials.json')).installed.client_secret,
  'http://localhost'
);
oAuth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
});

console.log('Google refresh token presente:', !!process.env.GOOGLE_REFRESH_TOKEN);
console.log('Google client ID presente:', !!process.env.GOOGLE_CLIENT_ID);

const drive = google.drive({ version: 'v3', auth: oAuth2Client });
const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });
const docs = google.docs({ version: 'v1', auth: oAuth2Client });

async function cercaSuDrive(query) {
  const res = await drive.files.list({
    q: `name contains '${query}' and trashed = false`,
    fields: 'files(id, name, webViewLink, modifiedTime)',
    pageSize: 5,
  });
  return res.data.files;
}

async function leggiEmailRecenti(max = 5) {
  const res = await gmail.users.messages.list({ userId: 'me', maxResults: max, q: 'is:unread' });
  if (!res.data.messages) return [];
  const emails = await Promise.all(res.data.messages.map(async (m) => {
    const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] });
    const headers = msg.data.payload.headers;
    return {
      subject: headers.find(h => h.name === 'Subject')?.value,
      from: headers.find(h => h.name === 'From')?.value,
      date: headers.find(h => h.name === 'Date')?.value,
    };
  }));
  return emails;
}

async function leggiCalendario(giorni = 7) {
  const now = new Date();
  const fine = new Date();
  fine.setDate(fine.getDate() + giorni);
  const res = await calendar.events.list({
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
    requestBody: {
      requests: [{ insertText: { location: { index: 1 }, text: contenuto } }]
    }
  });
  return `https://docs.google.com/document/d/${docId}/edit`;
}

async function leggiCanaleSlack(channelId, limit = 10) {
  try {
    await app.client.conversations.join({ channel: channelId });
  } catch(e) {}
  const res = await app.client.conversations.history({
    channel: channelId,
    limit: limit,
  });
  return res.messages || [];
}

async function getUtenti() {
  const res = await app.client.users.list();
  return (res.members || [])
    .filter(u => !u.is_bot && u.id !== 'USLACKBOT')
    .map(u => ({ id: u.id, name: u.real_name || u.name }));
}

const SYSTEM_PROMPT = `Ti chiami Giuno.
Sei l'assistente interno di Katania Studio, agenzia digitale di Catania.
Siciliano nell'anima, non nella caricatura. Usi "mbare" ogni tanto.
Frasi corte. Zero fronzoli. Ironico e cazzone, ma concreto.
Zero aziendalese. Dai la risposta prima. Poi eventualmente spieghi.
Katania Studio: agenzia digitale a Catania, filosofia WorkInSouth.
Rispondi sempre in italiano. Non inventare mai dati.

REGOLE DI FORMATTAZIONE SLACK:
- Risposte brevi e dirette. Mai paragrafi lunghi.
- Niente trattini "-" per le liste. Usa numeri o vai a capo semplicemente.
- Niente incisi tra parentesi o virgole eccessive.
- Massimo 3-4 righe per risposta salvo richieste complesse.
- Tono conversazionale, non da report.

HAI ACCESSO A:
- Google Drive: cercare file e documenti
- Gmail: leggere email non lette
- Google Calendar: vedere eventi
- Google Docs: creare documenti
- Slack: leggere canali e taggare utenti con <@USERID>. Quando menzioni qualcuno usa sempre il formato <@USERID> non il nome;

const conversations = {};

async function buildContext(userMessage) {
  let context = '';
  const msg = userMessage.toLowerCase();

  if (msg.includes('drive') || msg.includes('file') || msg.includes('documento') || msg.includes('cerca')) {
    try {
      const query = userMessage.replace(/cerca|drive|file|documento/gi, '').trim();
      const files = await cercaSuDrive(query);
      if (files.length > 0) {
        context += '\nFILE SU DRIVE:\n';
        files.forEach(f => { context += `${f.name}: ${f.webViewLink}
`; });
`; });
`; });
      } else {
        context += '\nNessun file trovato su Drive.\n';
      }
    } catch(e) { context += `\nErrore Drive: ${e.message}\n`; }
  }

  if (msg.includes('email') || msg.includes('mail') || msg.includes('posta')) {
    try {
      const emails = await leggiEmailRecenti(5);
      if (emails.length > 0) {
        context += '\nEMAIL NON LETTE:\n';
        emails.forEach(e => { context += `Da: ${e.from} | ${e.subject}\n`; });
      } else {
        context += '\nNessuna email non letta.\n';
      }
    } catch(e) { context += `\nErrore Gmail: ${e.message}\n`; }
  }

  if (msg.includes('calendar') || msg.includes('calendario') || msg.includes('riunion') || msg.includes('appuntament') || msg.includes('settimana') || msg.includes('oggi') || msg.includes('domani') || msg.includes('eventi')) {
    try {
      const eventi = await leggiCalendario(7);
      if (eventi.length > 0) {
        context += '\nEVENTI CALENDARIO:\n';
        eventi.forEach(e => {
          const data = e.start?.dateTime || e.start?.date;
          context += `${e.summary} | ${new Date(data).toLocaleString('it-IT')}\n`;
        });
      } else {
        context += '\nNessun evento nei prossimi 7 giorni.\n';
      }
    } catch(e) { context += `\nErrore Calendar: ${e.message}\n`; }
  }

  if (msg.includes('crea documento') || msg.includes('genera doc') || msg.includes('nuovo doc') || msg.includes('brief')) {
    try {
      const titolo = `Documento Giuno - ${new Date().toLocaleDateString('it-IT')}`;
      const url = await creaDocumento(titolo, `Documento creato da Giuno\nRichiesta: ${userMessage}\n\n`);
      context += `\nDOCUMENTO CREATO: ${url}\n`;
    } catch(e) { context += `\nErrore Docs: ${e.message}\n`; }
  }

  if (msg.includes('canale') || msg.includes('leggi') || msg.includes('messaggi') || msg.includes('thread')) {
    try {
      const channels = await app.client.conversations.list({ limit: 50 });
      const channelList = channels.channels || [];
      const targetChannel = channelList.find(c => msg.includes(c.name));
      if (targetChannel) {
        const messages = await leggiCanaleSlack(targetChannel.id, 10);
        context += `\nMESSAGGI IN #${targetChannel.name}:\n`;
        messages.forEach(m => { if (m.text) context += `${m.text}\n`; });
      } else {
        context += `\nCanali disponibili: ${channelList.map(c => '#' + c.name).join(', ')}\n`;
      }
    } catch(e) { context += `\nErrore Slack: ${e.message}\n`; }
  }
	if (msg.includes('utenti') || msg.includes('team') || msg.includes('chi c') || msg.includes('membri')) {
  try {
    const utenti = await getUtenti();
    context += '\nMEMBRI DEL WORKSPACE:\n';
    utenti.forEach(u => { context += `${u.name}: <@${u.id}>\n`; });
  } catch(e) { context += `\nErrore utenti: ${e.message}\n`; }
}

  return context;
}

async function askGiuno(userId, userMessage) {
  if (!conversations[userId]) conversations[userId] = [];

  let contextData = '';
  try { contextData = await buildContext(userMessage); } catch(e) {
    console.error('Errore Google completo:', e.message, e.stack);
    contextData = `\nErrore accesso Google: ${e.message}\n`;
  }

  const messageWithContext = contextData
    ? `${userMessage}\n\n[DATI RECUPERATI:\n${contextData}]`
    : userMessage;

  conversations[userId].push({ role: 'user', content: messageWithContext });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: conversations[userId],
  });

  const reply = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  conversations[userId].push({ role: 'assistant', content: reply });
  if (conversations[userId].length > 20) conversations[userId] = conversations[userId].slice(-20);
  return reply;
}

app.event('app_mention', async ({ event, say }) => {
  try {
    const text = event.text.replace(/<@[^>]+>/g, '').trim();
    const reply = await askGiuno(event.user, text);
    await say({ text: reply, thread_ts: event.thread_ts || event.ts });
  } catch (err) {
    await say({ text: 'Errore: ' + err.message, thread_ts: event.thread_ts || event.ts });
  }
});

app.message(async ({ message, say }) => {
  if (message.channel_type !== 'im') return;
  if (message.bot_id) return;
  try {
    const reply = await askGiuno(message.user, message.text);
    await say({ text: reply });
  } catch (err) {
    await say({ text: 'Errore: ' + err.message });
  }
});

app.command('/giuno', async ({ command, ack, respond }) => {
  await ack();
  try {
    const reply = await askGiuno(command.user_id, command.text);
    await respond({ text: reply, response_type: 'in_channel' });
  } catch (err) {
    await respond('Errore: ' + err.message);
  }
});

(async () => {
  await app.start();
  console.log('Giuno è online!');
})();