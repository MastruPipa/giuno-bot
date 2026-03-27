// ─── Quotes Tools ──────────────────────────────────────────────────────────────
// search_quotes, get_rate_card
// Also includes Gemini-based review tools (ask_gemini, review_content, review_email_draft)
// and search_everywhere

'use strict';

var db = require('../../supabase');
var rbac = require('../../rbac');
var logger = require('../utils/logger');
var { SLACK_FORMAT_RULES } = require('../utils/slackFormat');
var { askGemini } = require('../services/geminiService');

var checkPermission = rbac.checkPermission;
var filterQuoteData = rbac.filterQuoteData;
var getAccessDeniedMessage = rbac.getAccessDeniedMessage;

// ─── Tool definitions ──────────────────────────────────────────────────────────

var definitions = [
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
    description: 'Recupera la rate card (listino prezzi interni). Solo admin e finance possono accedere.',
    input_schema: {
      type: 'object',
      properties: {
        version: { type: 'string', description: 'Versione specifica (opzionale, default: ultima)' },
      },
    },
  },
  {
    name: 'ask_gemini',
    description: 'Chiedi a Gemini (Google AI) con accesso a Google Search in tempo reale. ' +
      'Usalo per: (1) notizie recenti su aziende/persone, (2) info aggiornate dal web, ' +
      '(3) verifica dati esterni (siti, contatti, prezzi), (4) cross-check informazioni. ' +
      'Per dati interni (CRM, Slack, Drive) usa i tool dedicati.',
    input_schema: {
      type: 'object',
      properties: {
        prompt:      { type: 'string', description: 'Domanda per Gemini. Per ricerche web, scrivi la query direttamente.' },
        context:     { type: 'string', description: 'Contesto aggiuntivo (opzionale)' },
        search_mode: { type: 'boolean', description: 'Se true (default), attiva Google Search grounding. False per elaborazioni pure.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'review_content',
    description: 'Gemini rivede un testo/copy e dà feedback su grammatica, tono, chiarezza, SEO e brand voice.',
    input_schema: {
      type: 'object',
      properties: {
        content:    { type: 'string', description: 'Testo da rivedere' },
        type:       { type: 'string', description: 'Tipo di contenuto: "web", "social", "email", "presentation", "generic" (default)' },
        brand_voice:{ type: 'string', description: 'Descrizione del tono di voce del brand (opzionale)' },
        language:   { type: 'string', description: 'Lingua del contenuto (default "italiano")' },
      },
      required: ['content'],
    },
  },
  {
    name: 'review_email_draft',
    description: 'Gemini rivede una bozza email prima dell\'invio: controlla tono, completezza, errori, suggerisce miglioramenti.',
    input_schema: {
      type: 'object',
      properties: {
        to:      { type: 'string', description: 'Destinatario' },
        subject: { type: 'string', description: 'Oggetto' },
        body:    { type: 'string', description: 'Corpo dell\'email da rivedere' },
        context: { type: 'string', description: 'Contesto: a chi scrivi, perché, tono desiderato (opzionale)' },
      },
      required: ['body'],
    },
  },
  {
    name: 'search_everywhere',
    description: 'Cerca contemporaneamente su Drive, Slack, Gmail e nella memoria. Usalo quando l\'utente chiede informazioni generiche su un cliente, progetto o argomento.',
    input_schema: {
      type: 'object',
      properties: {
        query:   { type: 'string', description: 'Testo da cercare ovunque' },
        sources: { type: 'array', items: { type: 'string', enum: ['drive', 'slack', 'email', 'memory'] }, description: 'Dove cercare (default: tutte le fonti)' },
      },
      required: ['query'],
    },
  },
];

// ─── Tool execution ────────────────────────────────────────────────────────────

async function execute(toolName, input, userId, userRole) {
  userRole = userRole || 'member';

  if (toolName === 'search_quotes') {
    if (!checkPermission(userRole, 'view_quote_price') && userRole !== 'member') {
      return { error: getAccessDeniedMessage(userRole) };
    }
    try {
      var quotes = await db.searchQuotes(input);
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

  if (toolName === 'ask_gemini') {
    var prompt = input.prompt;
    if (input.context) prompt = 'Contesto: ' + input.context + '\n\n' + prompt;

    // Auto-detect if search is needed
    var EXTERNAL_PATTERNS = [
      /notizie|news|recenti|aggiornamenti|ultimo[ai]?|oggi/i,
      /sito|website|email|contatto|telefono|indirizzo/i,
      /chi è|cos'è|che azienda|che cosa fa/i,
      /prezzo|costo|tariff[ae]|mercato/i,
      /instagram|linkedin|facebook|social/i,
    ];
    var needsSearch = input.search_mode !== false &&
      (input.search_mode === true || EXTERNAL_PATTERNS.some(function(p) { return p.test(prompt); }));

    if (needsSearch) {
      var { callGeminiWithSearch } = require('../services/geminiService');
      var searchResult = await callGeminiWithSearch(prompt);
      if (searchResult.error) return { error: searchResult.error };
      var response = searchResult.text;
      if (searchResult.sources && searchResult.sources.length > 0) {
        response += '\n\n_Ricerca Google: ' + searchResult.sources.join(', ') + '_';
      }
      return { response: response, searched: true };
    }

    return await askGemini(prompt, 'Sei un assistente AI che collabora con un altro AI (Claude). Rispondi in italiano, in modo conciso e utile.');
  }

  if (toolName === 'review_content') {
    var contentType = input.type || 'generic';
    var lang = input.language || 'italiano';
    var typeInstructions = {
      'web':          'Rivedi questo testo per un sito web. Controlla: SEO (keyword, meta description), leggibilità, CTA, struttura H1/H2, lunghezza paragrafi.',
      'social':       'Rivedi questo post per i social. Controlla: engagement, lunghezza, hashtag, CTA, tono, emoji se appropriate.',
      'email':        'Rivedi questa email professionale. Controlla: tono, chiarezza, call to action, lunghezza, errori.',
      'presentation': 'Rivedi questo testo per una presentazione. Controlla: chiarezza, concisione, impatto visivo del testo, punti chiave evidenziati.',
      'generic':      'Rivedi questo testo. Controlla: grammatica, chiarezza, tono, struttura, errori.',
    };
    var instruction = typeInstructions[contentType] || typeInstructions['generic'];
    if (input.brand_voice) instruction += '\nBrand voice richiesta: ' + input.brand_voice;
    var reviewPrompt = instruction + '\nLingua: ' + lang + '\n\nTESTO DA RIVEDERE:\n' + input.content;
    return await askGemini(reviewPrompt,
      'Sei un copywriter e editor professionista. Dai feedback strutturato in italiano:\n' +
      '1. VALUTAZIONE GENERALE (1 riga)\n' +
      '2. PROBLEMI TROVATI (lista breve)\n' +
      '3. TESTO MIGLIORATO (versione corretta completa)\n' +
      SLACK_FORMAT_RULES
    );
  }

  if (toolName === 'review_email_draft') {
    var emailContext = '';
    if (input.to) emailContext += 'Destinatario: ' + input.to + '\n';
    if (input.subject) emailContext += 'Oggetto: ' + input.subject + '\n';
    if (input.context) emailContext += 'Contesto: ' + input.context + '\n';
    emailContext += '\nBOZZA EMAIL:\n' + input.body;
    return await askGemini(emailContext,
      'Sei un assistente che rivede bozze email professionali in italiano. Analizza:\n' +
      '1. *Tono*: appropriato per il destinatario?\n' +
      '2. *Completezza*: manca qualcosa di importante?\n' +
      '3. *Errori*: grammatica, battitura, formattazione\n' +
      '4. *Chiarezza*: il messaggio è chiaro?\n' +
      '5. *Suggerimenti*: cosa migliorare\n\n' +
      'Se la bozza va bene, dillo. Se va migliorata, proponi la versione corretta.\n' +
      SLACK_FORMAT_RULES
    );
  }

  if (toolName === 'search_everywhere') {
    var sources = input.sources || ['drive', 'slack', 'email', 'memory'];
    var results = {};

    if (sources.includes('memory')) {
      var mems = db.searchMemories(userId, input.query);
      if (mems.length > 0) {
        results.memory = mems.slice(0, 5).map(function(m) {
          return { content: m.content, tags: m.tags, created: m.created };
        });
      }
    }

    // Drive index (fast, no API call)
    if (sources.includes('drive')) {
      var driveCache = db.getDriveCache();
      if (driveCache[userId]) {
        var queryLower = (input.query || '').toLowerCase();
        var indexed = Object.values(driveCache[userId]).filter(function(f) {
          return f.name.toLowerCase().includes(queryLower) || (f.description && f.description.toLowerCase().includes(queryLower));
        }).slice(0, 3);
        if (indexed.length > 0) {
          results.drive_index = indexed.map(function(f) {
            return { name: f.name, type: f.type, link: f.link, modified: f.modified };
          });
        }
      }

      var { getDrivePerUtente, handleTokenScaduto } = require('../services/googleAuthService');
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

    if (sources.includes('email')) {
      var { getGmailPerUtente, handleTokenScaduto: htExpired } = require('../services/googleAuthService');
      var gm = getGmailPerUtente(userId);
      if (gm) {
        try {
          var gmRes = await gm.users.messages.list({ userId: 'me', maxResults: 5, q: input.query });
          if (gmRes.data.messages && gmRes.data.messages.length > 0) {
            var emails = await Promise.all(gmRes.data.messages.map(async function(m) {
              var msg = await gm.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] });
              var h = msg.data.payload.headers;
              function getHdr(hs, n) { return (hs.find(function(x) { return x.name === n; }) || {}).value || ''; }
              return { id: m.id, subject: getHdr(h, 'Subject'), from: getHdr(h, 'From'), date: getHdr(h, 'Date') };
            }));
            results.email = emails;
          }
        } catch(e) { if (await htExpired(userId, e)) results.email_error = 'Token scaduto'; }
      }
    }

    if (sources.includes('slack')) {
      try {
        var { app } = require('../services/slackService');
        var slkRes = await app.client.search.messages({
          token: process.env.SLACK_USER_TOKEN || process.env.SLACK_BOT_TOKEN,
          query: input.query, count: 15, sort: 'timestamp', sort_dir: 'desc',
        });
        var matches = (slkRes.messages && slkRes.messages.matches) || [];
        if (matches.length > 0) {
          results.slack = matches.map(function(m) {
            return { text: (m.text || '').substring(0, 600), user: m.user || m.username, channel: m.channel ? m.channel.name : null, timestamp: m.ts, permalink: m.permalink };
          });
        }
      } catch(e) { logger.error('[SEARCH-EVERYWHERE] Slack error:', e.message); }
    }

    return results;
  }

  return { error: 'Tool sconosciuto nel modulo quotesTools: ' + toolName };
}

module.exports = { definitions: definitions, execute: execute };
