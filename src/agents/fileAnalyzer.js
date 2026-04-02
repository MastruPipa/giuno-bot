// ─── File Analyzer ──────────────────────────────────────────────────────────
// Handles Slack file uploads: PDFs, images, documents uploaded directly.
// Reads content, categorizes, saves to KB.
'use strict';

var logger = require('../utils/logger');
var db = require('../../supabase');
var { app } = require('../services/slackService');
var { formatPerSlack } = require('../utils/slackFormat');

// Document categories for auto-classification
var DOC_CATEGORIES = [
  { category: 'preventivo', patterns: /preventivo|quotazione|offerta|economics|proposta commerciale|stima costi/i },
  { category: 'brief', patterns: /brief|briefing|richiesta|requisiti|specifiche/i },
  { category: 'contratto', patterns: /contratto|accordo|agreement|termini|condizioni|nda/i },
  { category: 'report', patterns: /report|analisi|risultati|performance|kpi|metrics/i },
  { category: 'strategia', patterns: /strategi[ac]|piano|roadmap|planning|obiettivi/i },
  { category: 'creativo', patterns: /moodboard|concept|visual|design|logo|brand|identity/i },
  { category: 'presentazione', patterns: /presentazione|deck|pitch|slide/i },
  { category: 'fattura', patterns: /fattura|invoice|pagamento|ricevuta/i },
];

function classifyDocument(title, content) {
  var text = ((title || '') + ' ' + (content || '')).toLowerCase();
  for (var i = 0; i < DOC_CATEGORIES.length; i++) {
    if (DOC_CATEGORIES[i].patterns.test(text)) return DOC_CATEGORIES[i].category;
  }
  return 'altro';
}

// Deduplicate
var _processed = {};
var DEDUP_TTL = 60 * 60 * 1000;

async function processSlackFile(file, userId, channelId, threadTs, messageTs) {
  if (!file || !file.id) return;
  if (_processed[file.id] && Date.now() - _processed[file.id] < DEDUP_TTL) return;
  _processed[file.id] = Date.now();

  var fileName = file.name || 'file';
  var mimeType = file.mimetype || '';
  var fileSize = file.size || 0;

  // Skip very large files (>10MB) and very small files
  if (fileSize > 10 * 1024 * 1024 || fileSize < 100) return;

  var channelMap = db.getChannelMapCache();
  var chMapping = channelMap[channelId] || {};
  var baseTags = ['source:slack_upload'];
  if (chMapping.cliente) baseTags.push('cliente:' + chMapping.cliente.toLowerCase());
  if (chMapping.progetto) baseTags.push('progetto:' + chMapping.progetto.toLowerCase());

  try {
    var contentText = '';
    var summary = '';

    // ─── Text-based files (txt, csv, json, code) ────────────────────
    if (/^text\/|application\/json|application\/csv/i.test(mimeType) || /\.(txt|csv|json|md|html|xml)$/i.test(fileName)) {
      if (file.url_private) {
        try {
          var fetch = require('node-fetch');
          var res = await fetch(file.url_private, { headers: { 'Authorization': 'Bearer ' + process.env.SLACK_BOT_TOKEN } });
          contentText = await res.text();
          contentText = contentText.substring(0, 5000);
        } catch(e) { logger.debug('[FILE-ANALYZER] Download error:', e.message); }
      }
    }

    // ─── Images (jpg, png, gif, webp) — Vision AI analysis ────────────
    if (/^image\/(jpeg|jpg|png|gif|webp)/i.test(mimeType)) {
      try {
        var fetch = require('node-fetch');
        var imgRes = await fetch(file.url_private, {
          headers: { 'Authorization': 'Bearer ' + process.env.SLACK_BOT_TOKEN },
        });
        var imgBuffer = await imgRes.buffer();
        var base64Image = imgBuffer.toString('base64');
        var mediaType = mimeType.replace('image/jpg', 'image/jpeg'); // normalize

        // Only process images < 5MB for vision
        if (imgBuffer.length < 5 * 1024 * 1024) {
          var Anthropic = require('@anthropic-ai/sdk');
          var visionClient = new Anthropic();
          var visionRes = await visionClient.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 500,
            messages: [{
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: mediaType, data: base64Image },
                },
                {
                  type: 'text',
                  text: 'Analizza questa immagine condivisa nel canale Slack di un\'agenzia di marketing.\n' +
                    'Descrivi:\n' +
                    '1. Cosa mostra l\'immagine (mockup, screenshot, foto, grafica, documento?)\n' +
                    '2. Se c\'è testo leggibile, trascrivilo (OCR)\n' +
                    '3. Se è un design/mockup: colori, layout, font, brand elements\n' +
                    '4. Se è una foto: soggetto, contesto, qualità\n' +
                    '5. Se è uno screenshot: di quale app/sito, cosa mostra\n' +
                    'Rispondi in italiano, max 8 righe. Formato: *grassetto* per punti chiave.',
                },
              ],
            }],
          });
          contentText = visionRes.content[0].text.trim();
          summary = '🖼 *' + fileName + '*\n' + contentText;
          logger.info('[FILE-ANALYZER] Vision analysis done for:', fileName);
        }
      } catch(e) {
        logger.warn('[FILE-ANALYZER] Vision error:', e.message);
        contentText = 'Immagine: ' + fileName;
        summary = '🖼 *' + fileName + '* caricata (analisi visiva non disponibile)';
      }
    }

    // ─── PDF ────────────────────────────────────────────────────────
    if (/application\/pdf/i.test(mimeType) || /\.pdf$/i.test(fileName)) {
      // Can't read PDF content directly, but save metadata
      contentText = 'PDF: ' + fileName +
        (file.title && file.title !== fileName ? ' — ' + file.title : '');
      if (file.preview) contentText += '\nAnteprima: ' + file.preview;
    }

    // ─── Slack posts/snippets ───────────────────────────────────────
    if (file.filetype === 'post' || file.filetype === 'snippet') {
      contentText = file.preview || file.plain_text || '';
      contentText = contentText.substring(0, 3000);
    }

    if (!contentText || contentText.length < 10) return;

    // ─── Categorize ─────────────────────────────────────────────────
    var category = classifyDocument(fileName, contentText);
    baseTags.push('categoria:' + category);
    baseTags.push('tipo:file_upload');

    // ─── Generate summary if we have enough content ─────────────────
    if (contentText.length > 50 && !/^image\//i.test(mimeType)) {
      try {
        var Anthropic = require('@anthropic-ai/sdk');
        var client = new Anthropic();
        var summaryRes = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          system: 'Riassumi questo file condiviso su Slack. Estrai: scopo del documento, punti chiave, azioni/deadline se presenti. Max 5 righe. Formato Slack: *grassetto*, •liste. MAI **.',
          messages: [{ role: 'user', content: 'File: "' + fileName + '" (categoria: ' + category + ')\n\n' + contentText.substring(0, 3000) }],
        });
        summary = '*📎 ' + fileName + '* [' + category + ']\n' + summaryRes.content[0].text.trim();
      } catch(e) {
        summary = '*📎 ' + fileName + '* [' + category + ']';
        logger.debug('[FILE-ANALYZER] Summary error:', e.message);
      }
    }

    if (!summary) summary = '*📎 ' + fileName + '* [' + category + ']';

    // ─── Save to KB ─────────────────────────────────────────────────
    var kbContent = '[FILE] ' + fileName + ' [' + category + ']: ' + (contentText || '').substring(0, 400);
    db.addKBEntry(kbContent, baseTags, userId, {
      confidenceTier: 'auto_learn',
      sourceType: 'slack_upload',
      sourceChannelId: channelId,
    });

    // ─── Post thread reply ──────────────────────────────────────────
    if (channelId && threadTs) {
      try {
        await app.client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: formatPerSlack(summary),
          unfurl_links: false,
        });
      } catch(e) { /* Don't reply if we can't — non-blocking */ }
    }

    // React 📝 to show Giuno processed this file
    if (channelId && messageTs) {
      try {
        var { app: slackApp } = require('../services/slackService');
        await slackApp.client.reactions.add({ channel: channelId, timestamp: messageTs, name: 'memo' });
      } catch(e2) { /* ignore */ }
    }

    logger.info('[FILE-ANALYZER] Processed:', fileName, '| category:', category, '| channel:', chMapping.channel_name || channelId);
  } catch(e) {
    logger.error('[FILE-ANALYZER] Error:', e.message);
  }
}

// Process all files in a message
async function processMessageFiles(message, channelId) {
  if (!message || !message.files || message.files.length === 0) return;
  var threadTs = message.thread_ts || message.ts;
  for (var i = 0; i < message.files.length; i++) {
    processSlackFile(message.files[i], message.user, channelId, threadTs, message.ts).catch(function(e) {
      logger.debug('[FILE-ANALYZER] Process error:', e.message);
    });
  }
}

module.exports = { processSlackFile: processSlackFile, processMessageFiles: processMessageFiles, classifyDocument: classifyDocument };
