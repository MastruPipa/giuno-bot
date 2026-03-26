// ─── Knowledge Engine ──────────────────────────────────────────────────────────
// Scans Drive and Slack to build/update the KB automatically.
// Runs nightly via cron or manually via /giuno studia.

'use strict';

var logger = require('../utils/logger');
var db = require('../../supabase');
var { getDrivePerUtente, getDocsPerUtente, getSheetPerUtente } = require('../services/googleAuthService');
var { extractDocText } = require('../tools/driveTools');
var { withTimeout } = require('../utils/timeout');

// ─── Document Classification (Haiku) ─────────────────────────────────────────

async function classifyDocument(fileName, content) {
  try {
    var Anthropic = require('@anthropic-ai/sdk');
    var client = new Anthropic();
    var res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: 'Classifica questo documento aziendale.\n' +
        'Rispondi SOLO in JSON valido:\n' +
        '{"type":"preventivo|brief|contratto|strategia|comunicazione|altro",' +
        '"client":"string|null","project":"string|null",' +
        '"date":"YYYY-MM-DD|null","key_points":["max 3 frasi"],' +
        '"relevance":"alta|media|bassa"}\n' +
        'relevance=bassa: template vuoti, doc interni generici, < 200 char utili.',
      messages: [{ role: 'user', content: 'File: "' + fileName + '"\n\n' + content }],
    });
    var text = res.content[0].text.trim();
    var jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch(e) {
    logger.error('[KB-ENGINE][DRIVE] Haiku classify error:', e.message);
    return null;
  }
}

// ─── Drive Indexing ───────────────────────────────────────────────────────────

var EXCLUDED_NAMES = ['template', 'copia di', 'untitled', 'senza titolo', 'giuno'];

async function indexDrive(userId, report) {
  var drv = getDrivePerUtente(userId);
  if (!drv) {
    report.errors.push('Drive non collegato per ' + userId);
    return;
  }

  var ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  var res = await withTimeout(drv.files.list({
    q: "modifiedTime > '" + ninetyDaysAgo + "' and trashed = false and (" +
       "mimeType = 'application/vnd.google-apps.document' or " +
       "mimeType = 'application/vnd.google-apps.spreadsheet')",
    fields: 'files(id, name, mimeType, modifiedTime)',
    pageSize: 100,
    orderBy: 'modifiedTime desc',
  }), 15000, 'drive_list');

  var files = res.data.files || [];
  report.filesScanned += files.length;
  logger.info('[KB-ENGINE][DRIVE] File trovati:', files.length);

  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    try {
      var nameLow = (file.name || '').toLowerCase();
      if (EXCLUDED_NAMES.some(function(e) { return nameLow.includes(e); })) continue;

      var content = '';
      if (file.mimeType.includes('document')) {
        var docs = getDocsPerUtente(userId);
        if (!docs) continue;
        var doc = await withTimeout(
          docs.documents.get({ documentId: file.id }),
          10000, 'read_doc'
        );
        content = extractDocText(doc.data.body.content).substring(0, 3000);
      } else if (file.mimeType.includes('spreadsheet')) {
        var sheets = getSheetPerUtente(userId);
        if (!sheets) continue;
        var sheet = await withTimeout(
          sheets.spreadsheets.values.get({ spreadsheetId: file.id, range: 'A1:Z50' }),
          10000, 'read_sheet'
        );
        content = JSON.stringify(sheet.data.values || []).substring(0, 3000);
      }

      if (!content || content.length < 200) continue;

      var classification = await classifyDocument(file.name, content);
      if (!classification || classification.relevance === 'bassa') continue;

      var kbContent = 'File Drive: "' + file.name + '"\n' +
        'Tipo: ' + classification.type + '\n' +
        (classification.client ? 'Cliente: ' + classification.client + '\n' : '') +
        (classification.project ? 'Progetto: ' + classification.project + '\n' : '') +
        (classification.date ? 'Data: ' + classification.date + '\n' : '') +
        'Punti chiave:\n' +
        (classification.key_points || []).map(function(p) { return '• ' + p; }).join('\n');

      var tags = [
        'fonte:drive',
        'tipo:' + classification.type,
        'anno:' + new Date(file.modifiedTime).getFullYear(),
      ];
      if (classification.client) tags.push('cliente:' + classification.client.toLowerCase());
      if (classification.project) tags.push('progetto:' + classification.project.toLowerCase());

      db.addKBEntry(kbContent, tags, 'kb-engine-drive');
      report.filesIndexed++;

      if (classification.client && report.clientsFound.indexOf(classification.client) === -1) {
        report.clientsFound.push(classification.client);
      }

      logger.info('[KB-ENGINE][DRIVE] Indicizzato:', file.name.substring(0, 50));
    } catch(e) {
      report.errorsCount++;
      report.errors.push('Drive: ' + file.name + ' — ' + e.message.substring(0, 80));
      logger.error('[KB-ENGINE][DRIVE] Errore file:', file.name, e.message);
    }

    // Pausa anti-quota
    await new Promise(function(r) { setTimeout(r, 300); });
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runKnowledgeEngine(userId) {
  var startAt = new Date();
  var report = {
    startAt: startAt.toISOString(),
    endAt: null,
    durationMs: 0,
    filesScanned: 0,
    filesIndexed: 0,
    threadsScanned: 0,
    threadsIndexed: 0,
    errorsCount: 0,
    clientsFound: [],
    decisionsFound: [],
    deadlinesFound: [],
    errors: [],
  };

  logger.info('[KB-ENGINE] Avvio — userId:', userId);

  // Drive — isolato in try/catch
  try {
    var driveUserId = userId !== 'system'
      ? userId
      : Object.keys(db.getTokenCache())[0];
    if (driveUserId) {
      await indexDrive(driveUserId, report);
    } else {
      report.errors.push('Nessun utente con token Google trovato');
    }
  } catch(e) {
    report.errorsCount++;
    report.errors.push('Drive generale: ' + e.message);
    logger.error('[KB-ENGINE][DRIVE] Errore generale:', e.message);
  }

  // TODO: Fase 3 — indexSlack

  report.endAt = new Date().toISOString();
  report.durationMs = Date.now() - startAt.getTime();

  logger.info('[KB-ENGINE] Completato in', report.durationMs + 'ms |',
    'Drive:', report.filesIndexed + '/' + report.filesScanned,
    '| Errori:', report.errorsCount
  );

  return report;
}

module.exports = { runKnowledgeEngine: runKnowledgeEngine };
