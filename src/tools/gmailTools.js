// ─── Gmail Tools ───────────────────────────────────────────────────────────────
// find_emails, read_email, reply_email, send_email, forward_email
// + advanced: read_thread, draft_email, send_draft

'use strict';

var logger = require('../utils/logger');
var { withTimeout } = require('../utils/timeout');
var { getGmailPerUtente, handleTokenScaduto } = require('../services/googleAuthService');
var { askGemini } = require('../services/geminiService');

// ─── Helpers ───────────────────────────────────────────────────────────────────

function getHeader(headers, name) {
  return (headers.find(function(h) { return h.name === name; }) || {}).value || '';
}

// ─── Tool definitions ──────────────────────────────────────────────────────────

var definitions = [
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
    description: 'Inoltra un\'email a un altro destinatario.',
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
  {
    name: 'read_thread',
    description: 'Legge l\'intero thread Gmail dato il threadId.',
    input_schema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string', description: 'ID del thread Gmail' },
      },
      required: ['thread_id'],
    },
  },
  {
    name: 'draft_email',
    description: 'Crea una bozza Gmail senza inviarla.',
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
        draft_id: { type: 'string', description: 'ID della bozza da inviare' },
      },
      required: ['draft_id'],
    },
  },
];

// ─── Tool execution ────────────────────────────────────────────────────────────

async function execute(toolName, input, userId) {
  var gm = getGmailPerUtente(userId);
  if (!gm) return { error: 'Gmail non collegato. Scrivi "collega il mio Google".' };

  try {
    if (toolName === 'find_emails') {
      var max = input.max || 5;
      var res = await withTimeout(
        gm.users.messages.list({ userId: 'me', maxResults: max, q: input.query }),
        8000, 'find_emails'
      );
      if (!res.data.messages) return { emails: [] };
      var emails = await Promise.all(res.data.messages.map(async function(m) {
        var msg = await withTimeout(
          gm.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] }),
          8000, 'find_emails_get'
        );
        var h = msg.data.payload.headers;
        return { id: m.id, subject: getHeader(h, 'Subject'), from: getHeader(h, 'From'), to: getHeader(h, 'To'), date: getHeader(h, 'Date') };
      }));
      return { emails: emails };
    }

    if (toolName === 'read_email') {
      var msg = await withTimeout(
        gm.users.messages.get({ userId: 'me', id: input.message_id, format: 'full' }),
        8000, 'read_email'
      );
      var h = msg.data.payload.headers;
      var body = '';
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
      var orig = await gm.users.messages.get({
        userId: 'me', id: input.message_id, format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Message-Id', 'References'],
      });
      var h = orig.data.payload.headers;
      var origFrom      = getHeader(h, 'From');
      var origSubject   = getHeader(h, 'Subject');
      var origMessageId = getHeader(h, 'Message-Id');
      var origRefs      = getHeader(h, 'References');
      var replySubject  = origSubject.startsWith('Re:') ? origSubject : 'Re: ' + origSubject;

      var replyGeminiReview = null;
      try {
        replyGeminiReview = await askGemini(
          'Risposta a: ' + origFrom + '\nOggetto: ' + replySubject + '\n\nBOZZA RISPOSTA:\n' + input.body,
          'Rivedi questa bozza di risposta email in italiano. Se ci sono errori gravi (grammatica, tono sbagliato, info mancanti), segnalali brevemente. Se va bene, rispondi solo "OK". Max 3 righe.'
        );
      } catch(e) { logger.error('Gemini reply review error:', e.message); }

      var raw = [
        'To: ' + origFrom,
        'Subject: ' + replySubject,
        'In-Reply-To: ' + origMessageId,
        'References: ' + (origRefs ? origRefs + ' ' : '') + origMessageId,
        'Content-Type: text/plain; charset=utf-8',
        'MIME-Version: 1.0',
        '',
        input.body,
      ].join('\r\n');
      var encoded = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      await gm.users.messages.send({ userId: 'me', requestBody: { raw: encoded, threadId: orig.data.threadId } });
      var replyResult = { success: true };
      if (replyGeminiReview && replyGeminiReview.response && replyGeminiReview.response !== 'OK') {
        replyResult.gemini_note = replyGeminiReview.response;
      }
      return replyResult;
    }

    if (toolName === 'send_email') {
      var geminiReview = null;
      try {
        geminiReview = await askGemini(
          'Destinatario: ' + input.to + '\nOggetto: ' + input.subject + '\n\nBOZZA:\n' + input.body,
          'Rivedi questa bozza email in italiano. Se ci sono errori gravi (grammatica, tono sbagliato, info mancanti), segnalali brevemente. Se va bene, rispondi solo "OK". Max 3 righe.'
        );
      } catch(e) { logger.error('Gemini auto-review error:', e.message); }

      var headers = [
        'To: ' + input.to,
        'Subject: ' + input.subject,
        'Content-Type: text/plain; charset=utf-8',
        'MIME-Version: 1.0',
      ];
      if (input.cc) headers.splice(1, 0, 'Cc: ' + input.cc);
      var raw = headers.concat(['', input.body]).join('\r\n');
      var encoded = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      await gm.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
      var result = { success: true, to: input.to, subject: input.subject };
      if (geminiReview && geminiReview.response && geminiReview.response !== 'OK') {
        result.gemini_note = geminiReview.response;
      }
      return result;
    }

    if (toolName === 'forward_email') {
      var orig = await gm.users.messages.get({ userId: 'me', id: input.message_id, format: 'full' });
      var h = orig.data.payload.headers;
      var origSubject = getHeader(h, 'Subject');
      var origFrom    = getHeader(h, 'From');
      var origDate    = getHeader(h, 'Date');
      var origBody = '';
      function extractFwdText(part) {
        if (part.mimeType === 'text/plain' && part.body && part.body.data) {
          origBody += Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
        if (part.parts) part.parts.forEach(extractFwdText);
      }
      extractFwdText(orig.data.payload);
      var fwdSubject = origSubject.startsWith('Fwd:') ? origSubject : 'Fwd: ' + origSubject;
      var body = (input.note ? input.note + '\n\n' : '') +
        '---------- Forwarded message ----------\n' +
        'Da: ' + origFrom + '\n' +
        'Data: ' + origDate + '\n' +
        'Oggetto: ' + origSubject + '\n\n' +
        origBody.substring(0, 3000);
      var raw = [
        'To: ' + input.to,
        'Subject: ' + fwdSubject,
        'Content-Type: text/plain; charset=utf-8',
        'MIME-Version: 1.0',
        '',
        body,
      ].join('\r\n');
      var encoded = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      await gm.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
      return { success: true, forwarded_to: input.to, subject: fwdSubject };
    }

    if (toolName === 'read_thread') {
      var res = await gm.users.threads.get({ userId: 'me', id: input.thread_id, format: 'full' });
      var messages = (res.data.messages || []).map(function(msg) {
        var h = msg.payload.headers;
        var body = '';
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
    }

    if (toolName === 'draft_email') {
      var raw = [
        'To: ' + input.to,
        'Subject: ' + input.subject,
        'Content-Type: text/plain; charset=utf-8',
        'MIME-Version: 1.0',
        '',
        input.body,
      ].join('\r\n');
      var encoded = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      var res = await gm.users.drafts.create({ userId: 'me', requestBody: { message: { raw: encoded } } });
      return { success: true, draft_id: res.data.id };
    }

    if (toolName === 'send_draft') {
      await gm.users.drafts.send({ userId: 'me', requestBody: { id: input.draft_id } });
      return { success: true };
    }

  } catch(e) {
    if (await handleTokenScaduto(userId, e)) return { error: 'Token scaduto. Utente notificato per riautenticarsi.' };
    return { error: e.message };
  }

  return { error: 'Tool sconosciuto nel modulo gmailTools: ' + toolName };
}

module.exports = { definitions: definitions, execute: execute };
