// ─── Knowledge Engine ──────────────────────────────────────────────────────────
// Scans Drive and Slack to build/update the KB automatically.
// Runs nightly via cron or manually via /giuno studia.

'use strict';

var logger = require('../utils/logger');
var db = require('../../supabase');
var { getDrivePerUtente, getDocsPerUtente, getSheetPerUtente } = require('../services/googleAuthService');
var { extractDocText } = require('../tools/driveTools');
var { withTimeout } = require('../utils/timeout');
var { acquireCronLock, releaseCronLock } = require('../../supabase');
var { safeParse } = require('../utils/safeCall');

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

  var lookbackDays = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();

  var res = await withTimeout(drv.files.list({
    q: "modifiedTime > '" + lookbackDays + "' and trashed = false and (" +
       "mimeType = 'application/vnd.google-apps.document' or " +
       "mimeType = 'application/vnd.google-apps.spreadsheet' or " +
       "mimeType = 'application/vnd.google-apps.presentation' or " +
       "mimeType = 'application/pdf')",
    fields: 'files(id, name, mimeType, modifiedTime)',
    pageSize: 150,
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

      // Change detection: skip if file hasn't been modified since last index
      try {
        var supabaseCheck = require('../services/db/client').getClient();
        if (supabaseCheck) {
          var { data: existingIdx } = await supabaseCheck.from('drive_content_index')
            .select('last_modified').eq('file_id', file.id).limit(1);
          if (existingIdx && existingIdx.length > 0 && existingIdx[0].last_modified === file.modifiedTime) {
            continue; // File not changed since last index
          }
        }
      } catch(e) { /* proceed with indexing */ }

      var content = '';
      if (file.mimeType.includes('document')) {
        var docs = getDocsPerUtente(userId);
        if (!docs) continue;
        var doc = await withTimeout(
          docs.documents.get({ documentId: file.id }),
          10000, 'read_doc'
        );
        content = extractDocText(doc.data.body.content).substring(0, 4000);
      } else if (file.mimeType.includes('spreadsheet')) {
        var sheets = getSheetPerUtente(userId);
        if (!sheets) continue;
        var sheet = await withTimeout(
          sheets.spreadsheets.values.get({ spreadsheetId: file.id, range: 'A1:Z50' }),
          10000, 'read_sheet'
        );
        content = JSON.stringify(sheet.data.values || []).substring(0, 4000);
      } else if (file.mimeType.includes('presentation')) {
        var { getSlidesPerUtente } = require('../services/googleAuthService');
        var slides = getSlidesPerUtente(userId);
        if (!slides) continue;
        var pres = await withTimeout(
          slides.presentations.get({ presentationId: file.id }),
          10000, 'read_slides'
        );
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
        content = slideTexts.join('\n').substring(0, 4000);
      } else if (file.mimeType === 'application/pdf') {
        // PDF: save metadata + name (can't read content directly)
        content = 'PDF: ' + file.name + ' (modificato: ' + file.modifiedTime + ')';
      }

      if (!content || content.length < 50) continue;

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

      db.addKBEntry(kbContent, tags, 'kb-engine-drive', { confidenceTier: 'drive_indexed', sourceType: 'drive', sourceChannelType: 'drive' });

      // Save to drive_content_index with change tracking
      try {
        db.saveDriveContent({
          file_id: file.id,
          file_name: file.name,
          ai_summary: kbContent.substring(0, 500),
          web_link: 'https://docs.google.com/' + (file.mimeType.includes('document') ? 'document' : file.mimeType.includes('spreadsheet') ? 'spreadsheets' : file.mimeType.includes('presentation') ? 'presentation' : 'file') + '/d/' + file.id,
          doc_category: classification.type,
          related_client: classification.client || null,
          confidence_score: 0.8,
          last_modified: file.modifiedTime,
        });
      } catch(e) { /* non-blocking */ }

      report.filesIndexed++;

      if (classification.client && report.clientsFound.indexOf(classification.client) === -1) {
        report.clientsFound.push(classification.client);
      }

      // Auto-link file to project if client matches
      if (classification.client) {
        try {
          var projects = await db.searchProjects({ client_name: classification.client, limit: 1 });
          if (projects && projects.length > 0) {
            var supabaseLink = require('../services/db/client').getClient();
            if (supabaseLink) {
              var { data: existingLink } = await supabaseLink.from('project_documents')
                .select('id').eq('file_id', file.id).limit(1);
              if (!existingLink || existingLink.length === 0) {
                await supabaseLink.from('project_documents').insert({
                  project_id: projects[0].id, file_id: file.id, file_name: file.name,
                  drive_link: 'https://docs.google.com/d/' + file.id,
                  doc_role: classification.type || 'altro', added_by: 'kb-engine',
                });
                logger.info('[KB-ENGINE][DRIVE] Auto-linked to project:', projects[0].name);
              }
            }
          }
        } catch(e) { /* non-blocking */ }
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

// ─── Slack Thread Classification (Haiku) ──────────────────────────────────────

async function classifySlackThread(channelName, threadText) {
  try {
    var Anthropic = require('@anthropic-ai/sdk');
    var client = new Anthropic();
    var res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: 'Analizza questo thread Slack aziendale.\n' +
        'Rispondi SOLO in JSON valido:\n' +
        '{"has_decision":false,"has_deadline":false,"has_client":false,"has_task":false,"has_project":false,"skip":false,' +
        '"items":[{"type":"decisione|scadenza|task|cliente|progetto","content":"stringa","client":null,"project":null,"date":null}]}\n' +
        'skip=true se: chiacchiere, saluti, standup generici.\n' +
        'Includi SOLO info concretamente utili da ricordare.\n' +
        'Data oggi: ' + new Date().toISOString().slice(0, 10),
      messages: [{ role: 'user', content: 'Canale: #' + channelName + '\n\n' + threadText }],
    });
    var text = res.content[0].text.trim();
    var jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return safeParse('KB-ENGINE', jsonMatch[0], null);
  } catch(e) {
    logger.error('[KB-ENGINE][SLACK] Haiku error:', e.message);
    return null;
  }
}

// ─── Slack Indexing ───────────────────────────────────────────────────────────

async function indexSlack(report) {
  var { app } = require('../services/slackService');

  var channelsRes = await app.client.conversations.list({
    limit: 100,
    types: 'public_channel,private_channel',
  });
  var channels = (channelsRes.channels || []).filter(function(c) { return !c.is_archived; });

  var sevenDaysAgo = String(Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000));

  for (var ci = 0; ci < channels.length; ci++) {
    var ch = channels[ci];
    try {
      try { await app.client.conversations.join({ channel: ch.id }); } catch(e) {
        logger.debug('[KB-ENGINE] join canale ignorato:', e.message);
      }

      var hist = await app.client.conversations.history({
        channel: ch.id,
        oldest: sevenDaysAgo,
        limit: 100,
      });
      // Include bot messages (Gemini recaps, summaries) — skip only Giuno's own SKIP messages
      var msgs = (hist.messages || []).filter(function(m) {
        if (m.type !== 'message' || !m.text || m.text.length < 20) return false;
        if (m.text.startsWith('SKIP')) return false;
        return true;
      });

      // Group by thread
      var threads = {};
      for (var mi = 0; mi < msgs.length; mi++) {
        var msg = msgs[mi];
        var key = msg.thread_ts || msg.ts;
        if (!threads[key]) threads[key] = [];
        threads[key].push(msg);
      }

      var threadKeys = Object.keys(threads);
      for (var ti = 0; ti < threadKeys.length; ti++) {
        var threadMsgs = threads[threadKeys[ti]];
        report.threadsScanned++;

        if (threadMsgs.length < 3) continue;

        var threadText = threadMsgs.map(function(m) {
          return (m.user ? '<@' + m.user + '>' : 'bot') + ': ' + m.text.substring(0, 300);
        }).join('\n').substring(0, 3000);

        var classification = await classifySlackThread(ch.name, threadText);
        if (!classification || classification.skip) continue;
        if (!classification.items || classification.items.length === 0) continue;

        for (var ii = 0; ii < classification.items.length; ii++) {
          var item = classification.items[ii];
          if (!item.content || item.content.length < 10) continue;

          var tags = [
            'fonte:slack',
            'tipo:' + item.type,
            'canale:' + ch.name,
            'anno:' + new Date().getFullYear(),
          ];
          if (item.client) tags.push('cliente:' + item.client.toLowerCase());
          if (item.project) tags.push('progetto:' + item.project.toLowerCase());
          if (item.date) tags.push('deadline:' + item.date);

          var kbContent = '';
          if (item.type === 'decisione') {
            kbContent = 'Decisione in #' + ch.name + ': ' + item.content;
            if (report.decisionsFound.length < 5) report.decisionsFound.push(item.content.substring(0, 80));
          } else if (item.type === 'scadenza') {
            kbContent = 'Scadenza in #' + ch.name + ': ' + item.content;
            if (item.date) kbContent += ' — entro ' + item.date;
            if (report.deadlinesFound.length < 5) report.deadlinesFound.push(item.content.substring(0, 80));
          } else {
            kbContent = 'Da #' + ch.name + ' (' + item.type + '): ' + item.content;
          }

          db.addKBEntry(kbContent, tags, 'kb-engine-slack', {
            confidenceTier: ch.is_private ? 'slack_private' : 'slack_public',
            sourceType: 'slack',
            sourceChannelId: ch.id,
            sourceChannelType: ch.is_private ? 'private' : 'public',
          });
          report.threadsIndexed++;

          if (item.client && report.clientsFound.indexOf(item.client) === -1) {
            report.clientsFound.push(item.client);
          }

          logger.info('[KB-ENGINE][SLACK] Salvato da #' + ch.name + ':', item.content.substring(0, 60));
        }
      }
    } catch(e) {
      if (!e.message || !e.message.includes('ratelimited')) {
        report.errorsCount++;
        report.errors.push('Slack #' + ch.name + ' — ' + (e.message || '').substring(0, 80));
        logger.error('[KB-ENGINE][SLACK] Errore #' + ch.name + ':', e.message);
      }
    }
    await new Promise(function(r) { setTimeout(r, 200); });
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runKnowledgeEngine(userId) {
  var locked = await acquireCronLock('knowledge_engine', 120);
  if (!locked) {
    logger.info('[KB-ENGINE] Già in esecuzione su altra istanza, skip.');
    return { skipped: true };
  }
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

  // Slack — isolato in try/catch, gira sempre
  try {
    await indexSlack(report);
  } catch(e) {
    report.errorsCount++;
    report.errors.push('Slack generale: ' + e.message);
    logger.error('[KB-ENGINE][SLACK] Errore generale:', e.message);
  }

  report.endAt = new Date().toISOString();
  report.durationMs = Date.now() - startAt.getTime();

  logger.info('[KB-ENGINE] Completato in', report.durationMs + 'ms |',
    'Drive:', report.filesIndexed + '/' + report.filesScanned,
    '| Slack:', report.threadsIndexed + '/' + report.threadsScanned,
    '| Errori:', report.errorsCount
  );

  // Report only in logs — no DM to users (it's system data, not useful)
  logger.info('[KB-ENGINE] Report completo:',
    'Clienti:', report.clientsFound.join(', '),
    '| Decisioni:', report.decisionsFound.length,
    '| Scadenze:', report.deadlinesFound.length,
    '| Errori:', report.errorsCount
  );

  await releaseCronLock('knowledge_engine');
  return report;
}

module.exports = { runKnowledgeEngine: runKnowledgeEngine };
