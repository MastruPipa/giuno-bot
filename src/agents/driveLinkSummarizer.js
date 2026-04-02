// ─── Drive Link Auto-Reader V2 ──────────────────────────────────────────────
// When someone shares a Google Doc/Sheet/Slides/Drive link in Slack:
// 1. Opens and reads the content
// 2. Generates AI summary
// 3. Saves to KB with client/project tags
// 4. Posts thread reply with summary
// Also handles: Drive folder links, generic drive.google.com links.

'use strict';

var logger = require('../utils/logger');
var db = require('../../supabase');

// Match all Google Drive/Docs/Sheets/Slides links
var LINK_PATTERNS = [
  { pattern: /https:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/g, type: 'document' },
  { pattern: /https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/g, type: 'spreadsheet' },
  { pattern: /https:\/\/docs\.google\.com\/presentation\/d\/([a-zA-Z0-9_-]+)/g, type: 'presentation' },
  { pattern: /https:\/\/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/g, type: 'drive_file' },
  { pattern: /https:\/\/drive\.google\.com\/drive\/folders\/([a-zA-Z0-9_-]+)/g, type: 'folder' },
];

// Deduplicate: don't re-process the same file within 1 hour
var _processed = {}; // fileId -> timestamp
var DEDUP_TTL = 60 * 60 * 1000;

function wasRecentlyProcessed(fileId) {
  var last = _processed[fileId];
  if (last && Date.now() - last < DEDUP_TTL) return true;
  _processed[fileId] = Date.now();
  return false;
}

async function autoSummarizeDriveLinks(userId, text, channelId, threadTs) {
  if (!text) return;

  // Extract all links
  var links = [];
  LINK_PATTERNS.forEach(function(lp) {
    var regex = new RegExp(lp.pattern.source, 'g');
    var match;
    while ((match = regex.exec(text)) !== null) {
      if (!wasRecentlyProcessed(match[1])) {
        links.push({ type: lp.type, id: match[1] });
      }
    }
  });
  if (links.length === 0) return;

  var { getDocsPerUtente, getSheetPerUtente, getSlidesPerUtente, getDrivePerUtente } = require('../services/googleAuthService');
  var { app } = require('../services/slackService');
  var { extractDocText } = require('../tools/driveTools');
  var Anthropic = require('@anthropic-ai/sdk');
  var anthropicClient = new Anthropic();

  // Get channel context for tagging
  var channelMap = db.getChannelMapCache();
  var chMapping = channelMap[channelId] || {};
  var baseTags = ['source:slack_shared'];
  if (chMapping.cliente) baseTags.push('cliente:' + chMapping.cliente.toLowerCase());
  if (chMapping.progetto) baseTags.push('progetto:' + chMapping.progetto.toLowerCase());
  if (chMapping.channel_name) baseTags.push('canale:' + chMapping.channel_name);

  for (var i = 0; i < links.length; i++) {
    var link = links[i];
    try {
      var title = '';
      var contentText = '';
      var fileType = link.type;

      // ─── Google Document ────────────────────────────────────────────
      if (link.type === 'document') {
        var docs = getDocsPerUtente(userId);
        if (!docs) continue;
        var doc = await docs.documents.get({ documentId: link.id });
        title = doc.data.title || 'Documento senza titolo';
        contentText = extractDocText(doc.data.body.content).substring(0, 5000);
      }

      // ─── Google Spreadsheet ─────────────────────────────────────────
      if (link.type === 'spreadsheet') {
        var sheets = getSheetPerUtente(userId);
        if (!sheets) continue;
        var meta = await sheets.spreadsheets.get({ spreadsheetId: link.id });
        title = meta.data.properties.title || 'Foglio senza titolo';
        var sheetNames = (meta.data.sheets || []).map(function(s) { return s.properties.title; });
        // Read first sheet content
        try {
          var firstSheet = sheetNames[0] || 'Sheet1';
          var vals = await sheets.spreadsheets.values.get({ spreadsheetId: link.id, range: firstSheet + '!A1:Z50' });
          if (vals.data.values) {
            contentText = vals.data.values.map(function(row) { return row.join(' | '); }).join('\n').substring(0, 4000);
          }
        } catch(e) { contentText = 'Fogli: ' + sheetNames.join(', '); }
      }

      // ─── Google Presentation ────────────────────────────────────────
      if (link.type === 'presentation') {
        var slides = getSlidesPerUtente(userId);
        if (!slides) continue;
        var pres = await slides.presentations.get({ presentationId: link.id });
        title = pres.data.title || 'Presentazione senza titolo';
        var slideTexts = [];
        (pres.data.slides || []).forEach(function(slide, idx) {
          var texts = [];
          (slide.pageElements || []).forEach(function(el) {
            if (el.shape && el.shape.text && el.shape.text.textElements) {
              var t = el.shape.text.textElements.map(function(te) { return te.textRun ? te.textRun.content : ''; }).join('').trim();
              if (t) texts.push(t);
            }
          });
          if (texts.length > 0) slideTexts.push('Slide ' + (idx + 1) + ': ' + texts.join(' '));
        });
        contentText = slideTexts.join('\n').substring(0, 4000);
      }

      // ─── Generic Drive file (PDF, image, etc.) ─────────────────────
      if (link.type === 'drive_file') {
        var drv = getDrivePerUtente(userId);
        if (!drv) continue;
        try {
          var fileMeta = await drv.files.get({ fileId: link.id, fields: 'id,name,mimeType,description,webViewLink' });
          title = fileMeta.data.name || 'File';
          fileType = fileMeta.data.mimeType || 'unknown';
          contentText = 'File: ' + title + '\nTipo: ' + fileType;
          if (fileMeta.data.description) contentText += '\nDescrizione: ' + fileMeta.data.description;
        } catch(e) { continue; }
      }

      // ─── Drive folder ───────────────────────────────────────────────
      if (link.type === 'folder') {
        var drvFolder = getDrivePerUtente(userId);
        if (!drvFolder) continue;
        try {
          var folderFiles = await drvFolder.files.list({
            q: "'" + link.id + "' in parents and trashed = false",
            fields: 'files(id,name,mimeType,modifiedTime)',
            pageSize: 20, orderBy: 'modifiedTime desc',
          });
          title = 'Cartella condivisa';
          var fileList = (folderFiles.data.files || []).map(function(f) { return '• ' + f.name + ' (' + (f.mimeType || '').split('.').pop() + ')'; });
          contentText = fileList.join('\n');
        } catch(e) { continue; }
      }

      if (!contentText || contentText.length < 20) continue;

      // ─── Generate AI summary ──────────────────────────────────────
      var summary = '';
      try {
        var summaryRes = await anthropicClient.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 400,
          system: 'Riassumi questo documento condiviso in un canale Slack di un\'agenzia di marketing.\n' +
            'Estrai: tema principale, punti chiave, azioni richieste, deadline menzionate.\n' +
            'Formato Slack: *grassetto* per titoli. • per liste. Max 8 righe. MAI ** o ##.\n' +
            'Se è un foglio con dati: evidenzia i numeri più importanti.\n' +
            'Se è una presentazione: tema, struttura, messaggi chiave.',
          messages: [{ role: 'user', content: 'Titolo: "' + title + '"\nTipo: ' + fileType + '\n\nContenuto:\n' + contentText }],
        });
        summary = summaryRes.content[0].text.trim();
      } catch(e) {
        summary = contentText.substring(0, 200);
        logger.warn('[DRIVE-READER] Summary LLM error:', e.message);
      }

      // ─── Save to KB ───────────────────────────────────────────────
      var kbContent = '[DOC] ' + title + ': ' + summary.substring(0, 500);
      var kbTags = baseTags.concat(['tipo:documento', 'file:' + title.toLowerCase().substring(0, 50)]);
      try {
        db.addKBEntry(kbContent, kbTags, userId, {
          confidenceTier: 'drive_indexed',
          sourceType: 'slack_shared',
          sourceChannelId: channelId,
        });
      } catch(e) { logger.warn('[DRIVE-READER] KB save error:', e.message); }

      // Save to drive_content_index if available
      try {
        db.saveDriveContent({
          file_id: link.id,
          file_name: title,
          ai_summary: summary,
          web_link: 'https://docs.google.com/' + (link.type === 'document' ? 'document' : link.type === 'spreadsheet' ? 'spreadsheets' : link.type === 'presentation' ? 'presentation' : 'file') + '/d/' + link.id,
          doc_category: link.type,
          related_client: chMapping.cliente || null,
          confidence_score: 0.8,
        });
      } catch(e) { /* non-blocking */ }

      // ─── Post thread reply ────────────────────────────────────────
      var replyMsg = '*📄 ' + title + '*\n' + summary;
      try {
        await app.client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: replyMsg,
          unfurl_links: false,
        });
        logger.info('[DRIVE-READER] Auto-read:', title, '| type:', link.type, '| saved to KB');
      } catch(e) { logger.warn('[DRIVE-READER] Reply error:', e.message); }

    } catch(e) {
      logger.error('[DRIVE-READER] Error processing', link.type, link.id + ':', e.message);
    }
  }
}

module.exports = { autoSummarizeDriveLinks: autoSummarizeDriveLinks };
