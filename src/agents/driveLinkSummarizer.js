// ─── Drive Link Summarizer ─────────────────────────────────────────────────────
// Auto-summarizes Google Drive links found in Slack messages.
// Posts summary as a thread reply. Runs in background.

'use strict';

var logger = require('../utils/logger');

var DRIVE_PATTERN = /https:\/\/docs\.google\.com\/(document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]+)/g;

async function autoSummarizeDriveLinks(userId, text, channelId, threadTs) {
  if (!text) return;

  var matches = [];
  var match;
  while ((match = DRIVE_PATTERN.exec(text)) !== null) {
    matches.push({ type: match[1], id: match[2] });
  }
  if (matches.length === 0) return;

  var { getDocsPerUtente, getSheetPerUtente, getSlidesPerUtente } = require('../services/googleAuthService');
  var { app } = require('../services/slackService');
  var { extractDocText } = require('../tools/driveTools');

  for (var i = 0; i < matches.length; i++) {
    var m = matches[i];
    try {
      var summary = null;

      if (m.type === 'document') {
        var docs = getDocsPerUtente(userId);
        if (!docs) continue;
        var doc = await docs.documents.get({ documentId: m.id });
        var docText = extractDocText(doc.data.body.content).substring(0, 3000);
        if (docText.length < 50) continue;

        var Anthropic = require('@anthropic-ai/sdk');
        var client = new Anthropic();
        var res = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          system: 'Riassumi questo documento in 3-4 righe. ' +
            'Formato Slack: *grassetto* per punti chiave, • per liste. ' +
            'MAI ** o ##.',
          messages: [{ role: 'user',
            content: 'Doc: "' + doc.data.title + '"\n\n' + docText }],
        });
        summary = '*' + doc.data.title + '*\n' + res.content[0].text;
      }

      if (m.type === 'spreadsheets') {
        var sheets = getSheetPerUtente(userId);
        if (!sheets) continue;
        var meta = await sheets.spreadsheets.get({ spreadsheetId: m.id });
        var title = meta.data.properties.title;
        var sheetNames = (meta.data.sheets || []).map(function(s) {
          return s.properties.title;
        });
        summary = '*' + title + '* (Spreadsheet)\nFogli: ' + sheetNames.join(', ');
      }

      if (m.type === 'presentation') {
        var slides = getSlidesPerUtente(userId);
        if (!slides) continue;
        var pres = await slides.presentations.get({ presentationId: m.id });
        var presTitle = pres.data.title;
        var slideCount = (pres.data.slides || []).length;
        summary = '*' + presTitle + '* (Presentazione)\n' + slideCount + ' slide';
      }

      if (summary) {
        await app.client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: summary,
        });
        logger.info('[DRIVE-SUMMARY] Riassunto postato per:', m.type, m.id);
      }
    } catch(e) {
      logger.error('[DRIVE-SUMMARY] Errore:', e.message);
    }
  }
}

module.exports = { autoSummarizeDriveLinks: autoSummarizeDriveLinks };
