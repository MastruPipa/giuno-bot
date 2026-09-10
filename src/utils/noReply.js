// ─── NO_REPLY sentinel ───────────────────────────────────────────────────────
// Quando Giuno è in un thread ma il messaggio non è rivolto a lui, il modello
// risponde con questa stringa esatta e l'handler non posta nulla. Vive in un
// modulo minuscolo perché serve sia al servizio LLM sia agli handler Slack.

'use strict';

var NO_REPLY = '[NO_REPLY]';

function isNoReply(text) {
  return /^\s*\[?\s*NO_REPLY\s*\]?\s*$/i.test(String(text || ''));
}

module.exports = { NO_REPLY: NO_REPLY, isNoReply: isNoReply };
