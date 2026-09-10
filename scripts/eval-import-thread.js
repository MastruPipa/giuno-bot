#!/usr/bin/env node
// ─── Eval: importa un thread Slack come caso di valutazione ─────────────────
// Prende un thread reale (canale + ts del messaggio radice) e produce lo
// scheletro di un caso in eval/cases/: la storia diventa `transcript`, l'ultimo
// messaggio umano diventa `message`, `expect` resta da compilare a mano.
//
// Uso:
//   node scripts/eval-import-thread.js C0123ABC 1725960000.123456 [--id=nome-caso] [--anon] [--dm]
//
// --anon  sostituisce gli id Slack con U1, U2… e rimuove i nomi tra parentesi,
//         per casi condivisibili fuori dal team.
// --dm    tratta il canale come DM (conversations.history invece di replies).
// Richiede SLACK_BOT_TOKEN nel .env (stesso scope della produzione).

'use strict';

require('dotenv').config();

var fs = require('fs');
var path = require('path');
var { WebClient } = require('@slack/web-api');
var { messagesToTurns } = require('../src/services/slackTranscript');

var args = process.argv.slice(2);
var positional = args.filter(function(a) { return !a.startsWith('--'); });
function flag(name) { return args.indexOf('--' + name) !== -1; }
function opt(name) { var a = args.find(function(x) { return x.startsWith('--' + name + '='); }); return a ? a.split('=').slice(1).join('=') : null; }

var channelId = positional[0];
var threadTs = positional[1];
if (!channelId || (!threadTs && !flag('dm'))) {
  console.error('Uso: node scripts/eval-import-thread.js <channelId> <threadTs> [--id=nome] [--anon] [--dm]');
  process.exit(1);
}
if (!process.env.SLACK_BOT_TOKEN) { console.error('SLACK_BOT_TOKEN mancante nel .env'); process.exit(1); }

function anonymize(turns) {
  var map = {};
  var n = 0;
  var sub = function(text) {
    return String(text)
      .replace(/<@([A-Z0-9]+)>(\s*\([^)]*\))?/g, function(_, id) {
        if (!map[id]) map[id] = 'U' + (++n);
        return '<@' + map[id] + '>';
      });
  };
  return turns.map(function(t) { return { role: t.role, content: sub(t.content) }; });
}

async function main() {
  var web = new WebClient(process.env.SLACK_BOT_TOKEN);
  var me = await web.auth.test();
  var botUserId = me.user_id;
  var isDM = flag('dm');

  var messages;
  if (isDM) {
    var hist = await web.conversations.history({ channel: channelId, limit: 40 });
    messages = (hist.messages || []).slice().reverse();
  } else {
    var rep = await web.conversations.replies({ channel: channelId, ts: threadTs, limit: 100 });
    messages = rep.messages || [];
  }

  var names = {};
  var ids = {};
  messages.forEach(function(m) { if (m.user && m.user !== botUserId) ids[m.user] = 1; });
  for (var uid in ids) {
    try { var u = await web.users.info({ user: uid }); names[uid] = (u.user.real_name || u.user.name || '').split(' ')[0]; } catch(_) {}
  }

  var turns = messagesToTurns(messages, {
    botUserId: botUserId, labelAuthors: !isDM,
    resolveName: function(uid) { return names[uid] || null; },
    maxChars: 30000,
  });
  if (turns.length === 0) { console.error('Nessun messaggio utile nel thread.'); process.exit(1); }

  // L'ultimo turno umano è il messaggio da valutare; quello che c'è dopo (una
  // risposta reale di Giuno) diventa `reference_reply` per la rubrica.
  var lastUserIdx = -1;
  for (var i = turns.length - 1; i >= 0; i--) { if (turns[i].role === 'user') { lastUserIdx = i; break; } }
  var transcript = turns.slice(0, lastUserIdx);
  var message = turns[lastUserIdx].content.replace(/^<@[A-Z0-9]+>(\s*\([^)]*\))?:\s*/, '');
  var reference = turns.slice(lastUserIdx + 1).map(function(t) { return t.content; }).join('\n') || null;
  var lastUserMatch = turns[lastUserIdx].content.match(/^<@([A-Z0-9]+)>/);
  var userId = lastUserMatch ? lastUserMatch[1] : 'U_EVAL';

  if (flag('anon')) {
    var all = anonymize(transcript.concat([{ role: 'user', content: '<@' + userId + '> x' }]));
    transcript = all.slice(0, -1);
    userId = (all[all.length - 1].content.match(/^<@([A-Z0-9]+)>/) || [])[1] || 'U1';
  }

  var id = opt('id') || (isDM ? 'dm' : 'thread') + '-' + String(threadTs || Date.now()).replace(/\./g, '-');
  var caseDef = {
    id: id,
    description: 'DA COMPILARE: cosa deve capire/fare Giuno in questo caso',
    mode: isDM ? 'dm' : 'thread',
    userId: userId,
    channelId: flag('anon') ? (isDM ? 'D_EVAL' : 'C_EVAL') : channelId,
    threadTs: isDM ? null : threadTs,
    allowSilence: false,
    transcript: transcript,
    message: message,
    reference_reply: reference,
    expect: {
      no_reply: false,
      must_include: [],
      must_not_include: [],
      max_lines: null,
      rubric: 'DA COMPILARE: cosa rende buona una risposta qui (fatti da citare, cosa non inventare, tono, lunghezza).',
    },
  };

  var outDir = path.join(__dirname, '..', 'eval', 'cases');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  var outFile = path.join(outDir, id + '.json');
  fs.writeFileSync(outFile, JSON.stringify(caseDef, null, 2) + '\n');
  console.log('Caso scritto in', path.relative(process.cwd(), outFile), '—', transcript.length, 'turni di storia. Compila description, expect.rubric e i must_include.');
}

main().catch(function(e) { console.error(e.message || e); process.exit(1); });
