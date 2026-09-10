// ─── Mention utilities ───────────────────────────────────────────────────────
// Funzioni pure sui tag <@Uxxxx> di Slack, usate dagli handler.

'use strict';

var MENTION_RE = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g;

function extractMentions(text) {
  var out = [];
  var m;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(String(text || ''))) !== null) out.push({ id: m[1], index: m.index, length: m[0].length });
  return out;
}

// Toglie SOLO la menzione del bot, lasciando quelle delle persone: "@Giuno
// chiedi a @Antonio" deve arrivare al modello con Antonio dentro. Senza id del
// bot (auth.test fallita) si torna al comportamento storico: via tutte.
function stripBotMention(text, botUserId) {
  var t = String(text || '');
  if (botUserId) t = t.replace(new RegExp('<@' + botUserId + '(?:\\|[^>]*)?>', 'g'), '');
  else t = t.replace(MENTION_RE, '');
  return t.replace(/\s{2,}/g, ' ').trim();
}

function mentionsUser(text, userId) {
  if (!userId) return false;
  return extractMentions(text).some(function(m) { return m.id === userId; });
}

// "CC / presa visione": il bot è taggato in coda a un messaggio scritto per
// altre persone ("@Antonio ricordati X @Giuno"). Regola: almeno un'altra
// menzione, il tag del bot è l'ULTIMA menzione e dopo di esso non c'è testo
// significativo. Con l'id del bot noto, "@Giuno chiedi a @Antonio" NON è CC
// (il bot non è l'ultima menzione ma è lui il destinatario).
function detectCCMention(rawText, botUserId) {
  var text = String(rawText || '');
  var mentions = extractMentions(text);
  if (mentions.length < 2) return false;
  var botIdx = -1;
  if (botUserId) {
    for (var i = mentions.length - 1; i >= 0; i--) {
      if (mentions[i].id === botUserId) { botIdx = i; break; }
    }
    if (botIdx === -1) return false;
    if (botIdx !== mentions.length - 1) return false; // qualcuno è taggato DOPO il bot → il bot è il destinatario
    if (botIdx === 0) return false;                   // il bot è la prima menzione → messaggio per lui
  } else {
    botIdx = mentions.length - 1; // euristica storica: il bot è l'ultima menzione
  }
  var after = text.substring(mentions[botIdx].index + mentions[botIdx].length).replace(/[\s.,!?:;]+/g, ' ').trim();
  return after.length < 10;
}

module.exports = {
  extractMentions: extractMentions,
  stripBotMention: stripBotMention,
  mentionsUser: mentionsUser,
  detectCCMention: detectCCMention,
};
