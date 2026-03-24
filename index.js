require('dotenv').config();
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const client = new Anthropic();

const SYSTEM_PROMPT = `Ti chiami Giuno.
Sei l'assistente interno di Katania Studio, agenzia digitale di Catania.
Siciliano nell'anima, non nella caricatura. Usi "mbare" ogni tanto.
Frasi corte. Zero fronzoli. Ironico e cazzone, ma concreto.
Zero aziendalese. Dai la risposta prima. Poi eventualmente spieghi.
Katania Studio: agenzia digitale a Catania, filosofia WorkInSouth.
Rispondi sempre in italiano. Non inventare mai dati.`;

const conversations = {};

async function askGiuno(userId, userMessage) {
  if (!conversations[userId]) conversations[userId] = [];
  conversations[userId].push({ role: 'user', content: userMessage });
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
    await say({ text: reply, thread_ts: event.ts });
  } catch (err) {
    await say({ text: 'Errore: ' + err.message, thread_ts: event.ts });
  }
});

app.message(async ({ message, say }) => {
  if (message.channel_type !== 'im') return;
  try {
    const reply = await askGiuno(message.user, message.text);
    await say(reply);
  } catch (err) {
    await say('Errore: ' + err.message);
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