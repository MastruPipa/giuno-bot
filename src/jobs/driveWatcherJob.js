// ─── Drive Watcher Job ───────────────────────────────────────────────────────
// Polls Google Drive for changes using drive.changes.list() with saved page token.
// Processes new/modified Docs, Slides, Sheets → KB + Drive Content Index.
'use strict';

var logger = require('../utils/logger');
var dbClient = require('../services/db/client');
var { getDrivePerUtente, getDocsPerUtente, getSheetPerUtente } = require('../services/googleAuthService');
var { extractDocText } = require('../tools/driveTools');

var CONFIG = {
  MODEL: 'claude-haiku-4-5-20251001',
  MAX_FILES_PER_RUN: 20,
  DEFAULT_USER_ID: process.env.GIUNO_DEFAULT_USER_ID || process.env.ANTONIO_SLACK_ID || 'U052S2RT7B6',
};

var PROCESSABLE_MIMES = [
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.spreadsheet',
];

async function getStartPageToken(drv) {
  var res = await drv.changes.getStartPageToken({ supportsAllDrives: true });
  return res.data.startPageToken;
}

async function processDocument(drv, docsApi, file, supabase) {
  if (!docsApi) return null;
  try {
    var doc = await docsApi.documents.get({ documentId: file.fileId });
    var text = extractDocText(doc.data.body.content).substring(0, 4000);
    if (text.length < 100) return null;

    var Anthropic = require('@anthropic-ai/sdk');
    var client = new Anthropic();
    var res = await client.messages.create({
      model: CONFIG.MODEL, max_tokens: 400,
      messages: [{ role: 'user', content:
        'Analizza questo documento Google di Katania Studio.\nFile: ' + (file.name || '?') + '\n\n' + text + '\n\n' +
        'JSON: {"worth_saving":true,"summary":"2-3 frasi","doc_type":"brief|preventivo|strategia|presentazione|altro","client":"nome|null","importance":1-5}\n' +
        'Se irrilevante: {"worth_saving":false}'
      }],
    });
    var match = res.content[0].text.trim().replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch(e) {
    logger.warn('[DRIVE-WATCH] Doc process error:', file.name, e.message);
    return null;
  }
}

async function processSpreadsheet(sheetsApi, file, supabase) {
  if (!sheetsApi) return;
  try {
    var sheetScanner = require('./sheetScannerJob');
    // Auto-discover and register tabs
    var meta = await sheetsApi.spreadsheets.get({ spreadsheetId: file.fileId, fields: 'sheets.properties' });
    var tabs = (meta.data.sheets || []).map(function(s) { return s.properties.title; });
    logger.info('[DRIVE-WATCH] Sheet changed:', file.name, '(' + tabs.length + ' tabs)');
    // The sheet scanner will handle it on its next run
  } catch(e) {
    logger.warn('[DRIVE-WATCH] Sheet process error:', e.message);
  }
}

async function runDriveWatcher(options) {
  options = options || {};
  var supabase = dbClient.getClient();
  if (!supabase) return { processed: 0 };

  var userId = options.userId || CONFIG.DEFAULT_USER_ID;
  var drv = getDrivePerUtente(userId);
  if (!drv) { logger.warn('[DRIVE-WATCH] No Drive for user:', userId); return { processed: 0 }; }

  // Get or create page token
  var tokenKey = 'drive_watch_token_' + userId;
  var { data: tokenRow } = await supabase.from('scan_progress')
    .select('last_cursor').eq('source_id', tokenKey).maybeSingle();

  var pageToken = tokenRow ? tokenRow.last_cursor : null;

  if (!pageToken) {
    // First run: save start token, don't process anything yet
    pageToken = await getStartPageToken(drv);
    await supabase.from('scan_progress').upsert({
      id: tokenKey, source_id: tokenKey, scan_type: 'drive_watch', source_name: 'Drive Watch',
      status: 'done', last_cursor: pageToken, updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });
    logger.info('[DRIVE-WATCH] First run — saved start token:', pageToken);
    return { processed: 0, first_run: true };
  }

  // Poll for changes
  var processed = 0;
  try {
    var changesRes = await drv.changes.list({
      pageToken: pageToken,
      pageSize: CONFIG.MAX_FILES_PER_RUN,
      fields: 'newStartPageToken, nextPageToken, changes(fileId, file(name, mimeType, modifiedTime, trashed))',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    var changes = changesRes.data.changes || [];
    var newToken = changesRes.data.newStartPageToken || changesRes.data.nextPageToken;

    var docsApi = getDocsPerUtente(userId);
    var sheetsApi = getSheetPerUtente(userId);

    for (var i = 0; i < changes.length; i++) {
      var change = changes[i];
      if (!change.file || change.file.trashed) continue;
      if (PROCESSABLE_MIMES.indexOf(change.file.mimeType) === -1) continue;

      var mime = change.file.mimeType;

      if (mime.includes('document') || mime.includes('presentation')) {
        var summary = await processDocument(drv, docsApi, { fileId: change.fileId, name: change.file.name }, supabase);
        if (summary && summary.worth_saving && summary.importance >= 3) {
          var kbId = 'kb_watch_' + Date.now().toString(36);
          await supabase.from('knowledge_base').insert({
            id: kbId,
            content: '[DRIVE] ' + change.file.name + '\n' + summary.summary,
            source_type: 'drive_realtime',
            confidence_score: 0.75,
            confidence_tier: 'drive_indexed',
            validation_status: 'approved',
            added_by: 'drive_watcher',
            tags: [summary.doc_type, summary.client].filter(Boolean),
          }).catch(function() {});
          processed++;
          logger.info('[DRIVE-WATCH] Indexed:', change.file.name);
        }
      } else if (mime.includes('spreadsheet')) {
        await processSpreadsheet(sheetsApi, { fileId: change.fileId, name: change.file.name }, supabase);
      }

      await new Promise(function(r) { setTimeout(r, 300); });
    }

    // Save new token
    if (newToken) {
      await supabase.from('scan_progress').update({
        last_cursor: newToken, updated_at: new Date().toISOString(),
      }).eq('source_id', tokenKey);
    }

    if (changes.length > 0) {
      logger.info('[DRIVE-WATCH] Processed', processed, '/', changes.length, 'changes');
    }
  } catch(e) {
    logger.error('[DRIVE-WATCH] Error:', e.message);
  }

  return { processed: processed };
}

module.exports = { runDriveWatcher: runDriveWatcher };
