// ─── Drive Tools ───────────────────────────────────────────────────────────────
// search_drive, create_doc, share_file, read_doc, summarize_doc,
// read_slides, cataloga_preventivi

'use strict';

var logger = require('../utils/logger');
var { withTimeout } = require('../utils/timeout');
var { SLACK_FORMAT_RULES } = require('../utils/slackFormat');
var {
  getDrivePerUtente, getDocsPerUtente, getSlidesPerUtente, getSheetPerUtente,
  handleTokenScaduto,
} = require('../services/googleAuthService');
var { askGemini } = require('../services/geminiService');

// Parametri per Shared Drives — DEVONO essere in TUTTE le chiamate Drive API
var SHARED_DRIVE_PARAMS = { supportsAllDrives: true, includeItemsFromAllDrives: true };

// ─── Tool definitions ──────────────────────────────────────────────────────────

var definitions = [
  {
    name: 'search_drive',
    description: 'Cerca file su Google Drive inclusi i Drive condivisi. ' +
      'Supporta ricerca full-text, per nome, per tipo, per cartella e per data. ' +
      'Cerca in "Il mio Drive" E in tutti i Drive condivisi. ' +
      'Per cercare in un Drive condiviso specifico usa search_in_shared_drive.',
    input_schema: {
      type: 'object',
      properties: {
        query:           { type: 'string', description: 'Testo da cercare (cerca nel nome E nel contenuto dei file)' },
        name_only:       { type: 'boolean', description: 'Se true, cerca solo nel nome del file (default: false)' },
        mime_type:       { type: 'string', description: 'Filtra per tipo: "document", "spreadsheet", "presentation", "pdf", "image", "folder", oppure MIME completo' },
        folder_name:     { type: 'string', description: 'Cerca solo dentro questa cartella (nome cartella)' },
        folder_id:       { type: 'string', description: 'ID diretto di una cartella Drive (da URL: drive.google.com/drive/folders/ID)' },
        modified_after:  { type: 'string', description: 'Solo file modificati dopo questa data ISO 8601' },
        modified_before: { type: 'string', description: 'Solo file modificati prima di questa data ISO 8601' },
        shared_with:     { type: 'string', description: 'Filtra file condivisi con questa email' },
        max:             { type: 'number', description: 'Numero massimo risultati (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'create_doc',
    description: 'Crea un nuovo Google Doc con titolo e contenuto. Usa drive_id per creare dentro un Drive condiviso.',
    input_schema: {
      type: 'object',
      properties: {
        title:    { type: 'string', description: 'Titolo del documento' },
        content:  { type: 'string', description: 'Contenuto testuale del documento' },
        drive_id: { type: 'string', description: 'ID Drive condiviso (da list_shared_drives) - opzionale' },
      },
      required: ['title'],
    },
  },
  {
    name: 'share_file',
    description: 'Condivide un file Google Drive con un utente.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'ID del file su Drive' },
        email:   { type: 'string', description: 'Email dell\'utente con cui condividere' },
        role:    { type: 'string', description: 'Ruolo: "reader", "commenter" o "writer" (default "reader")' },
      },
      required: ['file_id', 'email'],
    },
  },
  {
    name: 'read_doc',
    description: 'Legge il contenuto testuale di un Google Doc.',
    input_schema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', description: 'ID del Google Doc' },
      },
      required: ['doc_id'],
    },
  },
  {
    name: 'summarize_doc',
    description: 'Legge un Google Doc, lo riassume con AI e salva il riassunto in memoria.',
    input_schema: {
      type: 'object',
      properties: {
        doc_id:         { type: 'string', description: 'ID del Google Doc' },
        save_to_memory: { type: 'boolean', description: 'Salva il riassunto in memoria (default true)' },
      },
      required: ['doc_id'],
    },
  },
  {
    name: 'read_slides',
    description: 'Legge il contenuto di una presentazione Google Slides.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string', description: 'ID della presentazione Google Slides' },
        slide_index:     { type: 'integer', description: 'Indice della slide specifica da leggere (0-based, opzionale)' },
      },
      required: ['presentation_id'],
    },
  },
  {
    name: 'cataloga_preventivi',
    description: 'Scansiona Google Drive per trovare preventivi, economics e proposte commerciali e li salva nel database Supabase. Richiede ruolo admin o finance.',
    input_schema: {
      type: 'object',
      properties: {
        max_files: { type: 'number', description: 'Numero massimo di file da processare (default 50)' },
        confirm:   { type: 'boolean', description: 'Se true, procede senza chiedere conferma (default false)' },
      },
    },
  },
  {
    name: 'list_shared_drives',
    description: 'Elenca tutti i Drive condivisi (Shared Drives) a cui l\'utente ha accesso. Usa questo tool PRIMA di search_in_shared_drive.',
    input_schema: {
      type: 'object',
      properties: {
        name_filter: { type: 'string', description: 'Filtra per nome del Drive (opzionale)' },
      },
    },
  },
  {
    name: 'search_in_shared_drive',
    description: 'Cerca file in uno specifico Drive condiviso. Usa list_shared_drives prima per ottenere il drive_id.',
    input_schema: {
      type: 'object',
      properties: {
        drive_id:  { type: 'string', description: 'ID del Drive condiviso (da list_shared_drives)' },
        query:     { type: 'string', description: 'Testo da cercare nei file' },
        mime_type: { type: 'string', description: 'Filtra per tipo: document, spreadsheet, presentation, pdf, folder' },
        max:       { type: 'number', description: 'Numero massimo risultati (default 20)' },
      },
      required: ['drive_id', 'query'],
    },
  },
  {
    name: 'browse_folder',
    description: 'Elenca il contenuto di una cartella Google Drive dato il suo ID o URL. ' +
      'Usa questo quando l\'utente incolla un link Drive come drive.google.com/drive/folders/XXXXX. ' +
      'Funziona sia per "Il mio Drive" che per Drive condivisi.',
    input_schema: {
      type: 'object',
      properties: {
        folder_id: { type: 'string', description: 'ID della cartella o URL completo Drive' },
        max:       { type: 'number', description: 'Numero massimo file (default 30)' },
        mime_type: { type: 'string', description: 'Filtra per tipo: document, spreadsheet, presentation, pdf, folder' },
      },
      required: ['folder_id'],
    },
  },
];

// ─── Document text extraction helper ──────────────────────────────────────────

function extractDocText(elements) {
  var text = '';
  if (!elements) return text;
  elements.forEach(function(el) {
    if (el.paragraph && el.paragraph.elements) {
      el.paragraph.elements.forEach(function(pe) {
        if (pe.textRun && pe.textRun.content) text += pe.textRun.content;
      });
    }
    if (el.table) {
      (el.table.tableRows || []).forEach(function(row) {
        (row.tableCells || []).forEach(function(cell) {
          text += extractDocText(cell.content) + '\t';
        });
        text += '\n';
      });
    }
  });
  return text;
}

// ─── Tool execution ────────────────────────────────────────────────────────────

async function execute(toolName, input, userId) {
  try {
    if (toolName === 'search_drive') {
      var drv = getDrivePerUtente(userId);
      if (!drv) return { error: 'Google Drive non collegato. Scrivi "collega il mio Google".' };

      var max = input.max || 10;
      var escaped = input.query.replace(/'/g, "\\'");
      var qParts = [];

      if (input.name_only) {
        qParts.push("name contains '" + escaped + "'");
      } else {
        qParts.push("fullText contains '" + escaped + "'");
      }
      qParts.push('trashed = false');

      if (input.mime_type) {
        var mimeMap = {
          'document': 'application/vnd.google-apps.document',
          'spreadsheet': 'application/vnd.google-apps.spreadsheet',
          'presentation': 'application/vnd.google-apps.presentation',
          'pdf': 'application/pdf',
          'image': 'application/vnd.google-apps.photo',
          'folder': 'application/vnd.google-apps.folder',
        };
        var resolvedMime = mimeMap[input.mime_type] || input.mime_type;
        if (input.mime_type === 'image') {
          qParts.push("(mimeType contains 'image/')");
        } else {
          qParts.push("mimeType = '" + resolvedMime + "'");
        }
      }

      if (input.modified_after) {
        qParts.push("modifiedTime > '" + new Date(input.modified_after).toISOString() + "'");
      }
      if (input.modified_before) {
        qParts.push("modifiedTime < '" + new Date(input.modified_before).toISOString() + "'");
      }
      if (input.shared_with) {
        qParts.push("'" + input.shared_with + "' in readers or '" + input.shared_with + "' in writers");
      }

      var q = qParts.join(' and ');

      if (input.folder_id) {
        var folderIdClean = (input.folder_id || '').trim();
        var folderIdMatch = folderIdClean.match(/folders\/([a-zA-Z0-9_-]+)/);
        if (folderIdMatch) folderIdClean = folderIdMatch[1];
        q += " and '" + folderIdClean + "' in parents";
      } else if (input.folder_name) {
        try {
          var folderRes = await withTimeout(drv.files.list({
            q: "name = '" + input.folder_name.replace(/'/g, "\\'") + "' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
            fields: 'files(id)',
            pageSize: 1,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          }), 8000, 'search_drive_folder');
          if (folderRes.data.files && folderRes.data.files.length > 0) {
            q += " and '" + folderRes.data.files[0].id + "' in parents";
          }
        } catch(e) { logger.error('Drive folder search error:', e.message); }
      }

      var res = await withTimeout(drv.files.list({
        q: q,
        fields: 'files(id, name, mimeType, webViewLink, modifiedTime, owners, parents, description, driveId)',
        pageSize: max,
        orderBy: 'modifiedTime desc',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: 'allDrives',
      }), 8000, 'search_drive');
      return {
        files: (res.data.files || []).map(function(f) {
          return {
            id: f.id,
            name: f.name,
            type: f.mimeType,
            link: f.webViewLink,
            modified: f.modifiedTime,
            owner: (f.owners && f.owners[0]) ? f.owners[0].emailAddress : null,
            description: f.description || null,
          };
        }),
      };
    }

    if (toolName === 'create_doc') {
      var docsApi = getDocsPerUtente(userId);
      if (!docsApi) return { error: 'Google Docs non collegato. Scrivi "collega il mio Google".' };
      var doc = await docsApi.documents.create({ requestBody: { title: input.title } });
      var docId = doc.data.documentId;
      if (input.content) {
        await docsApi.documents.batchUpdate({ documentId: docId, requestBody: { requests: [{ insertText: { location: { index: 1 }, text: input.content } }] } });
      }
      return { success: true, doc_id: docId, link: 'https://docs.google.com/document/d/' + docId + '/edit' };
    }

    if (toolName === 'share_file') {
      var drv = getDrivePerUtente(userId);
      if (!drv) return { error: 'Google Drive non collegato. Scrivi "collega il mio Google".' };
      var role = input.role || 'reader';
      await drv.permissions.create({
        fileId: input.file_id,
        requestBody: { type: 'user', role: role, emailAddress: input.email },
        sendNotificationEmail: true,
        supportsAllDrives: true,
      });
      return { success: true, shared_with: input.email, role: role };
    }

    if (toolName === 'read_doc') {
      var docsApi = getDocsPerUtente(userId);
      if (!docsApi) return { error: 'Google Docs non collegato. Scrivi "collega il mio Google".' };
      var doc = await docsApi.documents.get({ documentId: input.doc_id });
      var text = extractDocText(doc.data.body.content);
      var docResult = { title: doc.data.title, content: text.substring(0, 4000) };
      if (text.length > 200) {
        try {
          var docSummary = await askGemini(
            'Documento: "' + doc.data.title + '"\n\nContenuto:\n' + text.substring(0, 3000) +
            '\n\nFai un riassunto strutturato: argomento principale, punti chiave (max 5), eventuali azioni/decisioni menzionate.',
            'Sei un assistente che riassume documenti aziendali. Rispondi in italiano, conciso e strutturato.'
          );
          if (docSummary && docSummary.response) {
            docResult.gemini_summary = docSummary.response;
          }
        } catch(e) { logger.error('Gemini doc summary error:', e.message); }
      }
      return docResult;
    }

    if (toolName === 'summarize_doc') {
      var docsApi = getDocsPerUtente(userId);
      if (!docsApi) return { error: 'Google Docs non collegato. Scrivi "collega il mio Google".' };
      var doc = await docsApi.documents.get({ documentId: input.doc_id });
      var docText = extractDocText(doc.data.body.content);
      var docTitle = doc.data.title;

      var client = require('../services/anthropicService').client;
      var docSummaryRes = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        system: 'Sei un assistente che riassume documenti in italiano. Fai un riassunto strutturato: scopo del documento, punti chiave, conclusioni. Max 12 righe. ' + SLACK_FORMAT_RULES,
        messages: [{ role: 'user', content: 'Riassumi questo documento "' + docTitle + '":\n\n' + docText.substring(0, 8000) }],
      });
      var docSummary = docSummaryRes.content[0].text;

      var saveToMemory = input.save_to_memory !== false;
      if (saveToMemory) {
        var db = require('../../supabase');
        db.addMemory(userId, 'Riassunto doc "' + docTitle + '": ' + docSummary, ['documento', 'riassunto', (docTitle || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')]);
      }

      return { title: docTitle, summary: docSummary, saved_to_memory: saveToMemory };
    }

    if (toolName === 'read_slides') {
      var slides = getSlidesPerUtente(userId);
      if (!slides) return { error: 'Google Slides non collegato. Scrivi "collega il mio Google".' };
      var pres = await slides.presentations.get({ presentationId: input.presentation_id });
      var presData = pres.data;
      var slidesList = (presData.slides || []).map(function(slide, idx) {
        var texts = [];
        var notes = '';
        (slide.pageElements || []).forEach(function(el) {
          if (el.shape && el.shape.text) {
            var t = el.shape.text.textElements.map(function(te) {
              return te.textRun ? te.textRun.content : '';
            }).join('').trim();
            if (t) texts.push(t);
          }
        });
        if (slide.slideProperties && slide.slideProperties.notesPage) {
          var notesPage = slide.slideProperties.notesPage;
          (notesPage.pageElements || []).forEach(function(el) {
            if (el.shape && el.shape.text) {
              var n = el.shape.text.textElements.map(function(te) {
                return te.textRun ? te.textRun.content : '';
              }).join('').trim();
              if (n) notes += n + '\n';
            }
          });
        }
        return { index: idx, texts: texts, notes: notes.trim() || null };
      });

      if (input.slide_index !== undefined && input.slide_index !== null) {
        var target = slidesList[input.slide_index];
        if (!target) return { error: 'Slide ' + input.slide_index + ' non trovata. La presentazione ha ' + slidesList.length + ' slide (0-' + (slidesList.length - 1) + ').' };
        return { title: presData.title, total_slides: slidesList.length, slide: target };
      }

      var slidesResult = { title: presData.title, total_slides: slidesList.length, slides: slidesList };
      if (slidesList.length > 1) {
        try {
          var slidesText = slidesList.map(function(s) {
            return 'Slide ' + s.index + ': ' + s.texts.join(' ');
          }).join('\n').substring(0, 3000);
          var slidesSummary = await askGemini(
            'Presentazione: "' + presData.title + '" (' + slidesList.length + ' slide)\n\n' + slidesText +
            '\n\nFai un riassunto: tema principale, struttura della presentazione, messaggi chiave per slide.',
            'Sei un assistente che analizza presentazioni aziendali. Rispondi in italiano, conciso e strutturato.'
          );
          if (slidesSummary && slidesSummary.response) {
            slidesResult.gemini_summary = slidesSummary.response;
          }
        } catch(e) { logger.error('Gemini slides summary error:', e.message); }
      }
      return slidesResult;
    }

    if (toolName === 'cataloga_preventivi') {
      // Lazy import to avoid circular dep
      var { catalogaPreventivi } = require('../handlers/cronHandlers');
      catalogaPreventivi(userId, userId, input.max_files || 50, input.confirm || false)
        .catch(function(e) { logger.error('[CATALOGA] Errore:', e.message); });
      return { success: true, message: 'Scansione preventivi avviata. Ti avviso su Slack quando ho finito.' };
    }

  } catch(e) {
    if (await handleTokenScaduto(userId, e)) return { error: 'Token scaduto. Utente notificato per riautenticarsi.' };
    return { error: e.message };
  }

  if (toolName === 'list_shared_drives') {
    var drv = getDrivePerUtente(userId);
    if (!drv) return { error: 'Google Drive non collegato. Scrivi "collega il mio Google".' };
    try {
      var drivesRes = await withTimeout(drv.drives.list({ pageSize: 50, fields: 'drives(id, name)' }), 8000, 'list_shared_drives');
      var drives = (drivesRes.data.drives || []);
      if (input.name_filter) {
        var f = (input.name_filter || '').toLowerCase();
        drives = drives.filter(function(d) { return (d.name || '').toLowerCase().includes(f); });
      }
      return { shared_drives: drives.map(function(d) { return { id: d.id, name: d.name }; }), count: drives.length };
    } catch(e) {
      if (await handleTokenScaduto(userId, e)) return { error: 'Token scaduto.' };
      return { error: 'Errore listing shared drives: ' + e.message };
    }
  }

  if (toolName === 'search_in_shared_drive') {
    var drv = getDrivePerUtente(userId);
    if (!drv) return { error: 'Google Drive non collegato.' };
    try {
      var max = input.max || 20;
      var escaped = (input.query || '').replace(/'/g, "\\'");
      var q = "fullText contains '" + escaped + "' and trashed = false";
      if (input.mime_type) {
        var mimeMap = { 'document': 'application/vnd.google-apps.document', 'spreadsheet': 'application/vnd.google-apps.spreadsheet', 'presentation': 'application/vnd.google-apps.presentation', 'pdf': 'application/pdf', 'folder': 'application/vnd.google-apps.folder' };
        q += " and mimeType = '" + (mimeMap[input.mime_type] || input.mime_type) + "'";
      }
      var res = await withTimeout(drv.files.list({
        q: q, driveId: input.drive_id, corpora: 'drive',
        supportsAllDrives: true, includeItemsFromAllDrives: true,
        fields: 'files(id, name, mimeType, webViewLink, modifiedTime, description)', pageSize: max, orderBy: 'modifiedTime desc',
      }), 10000, 'search_in_shared_drive');
      return { drive_id: input.drive_id, files: (res.data.files || []).map(function(f) { return { id: f.id, name: f.name, type: f.mimeType, link: f.webViewLink, modified: f.modifiedTime }; }), count: (res.data.files || []).length };
    } catch(e) {
      if (await handleTokenScaduto(userId, e)) return { error: 'Token scaduto.' };
      return { error: 'Errore ricerca Drive condiviso: ' + e.message };
    }
  }

  if (toolName === 'browse_folder') {
    var drv = getDrivePerUtente(userId);
    if (!drv) return { error: 'Google Drive non collegato. Scrivi "collega il mio Google".' };
    var rawId = (input.folder_id || '').trim();
    var idMatch = rawId.match(/folders\/([a-zA-Z0-9_-]+)/);
    var folderId = idMatch ? idMatch[1] : rawId;
    if (!folderId) return { error: 'ID cartella non valido.' };
    try {
      var folderInfo = null;
      try {
        var fi = await withTimeout(drv.files.get({ fileId: folderId, fields: 'id, name, mimeType, driveId', supportsAllDrives: true }), 8000, 'browse_folder_info');
        folderInfo = fi.data;
      } catch(e) {
        logger.warn('[DRIVE-TOOLS] operazione fallita:', e.message);
      }
      var bMax = input.max || 30;
      var bq = "'" + folderId + "' in parents and trashed = false";
      if (input.mime_type) {
        var bMimeMap = { 'document': 'application/vnd.google-apps.document', 'spreadsheet': 'application/vnd.google-apps.spreadsheet', 'presentation': 'application/vnd.google-apps.presentation', 'pdf': 'application/pdf', 'folder': 'application/vnd.google-apps.folder' };
        bq += " and mimeType = '" + (bMimeMap[input.mime_type] || input.mime_type) + "'";
      }
      var bRes = await withTimeout(drv.files.list({
        q: bq, fields: 'files(id, name, mimeType, webViewLink, modifiedTime, size)',
        pageSize: bMax, orderBy: 'folder,name', supportsAllDrives: true, includeItemsFromAllDrives: true,
      }), 10000, 'browse_folder');
      var bFiles = bRes.data.files || [];
      return {
        folder_id: folderId, folder_name: folderInfo ? folderInfo.name : '(cartella)',
        files: bFiles.map(function(f) {
          return { id: f.id, name: f.name, type: f.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : f.mimeType, link: f.webViewLink, modified: f.modifiedTime, is_folder: f.mimeType === 'application/vnd.google-apps.folder' };
        }),
        count: bFiles.length,
      };
    } catch(e) {
      if (await handleTokenScaduto(userId, e)) return { error: 'Token scaduto.' };
      if (e.message && e.message.includes('404')) return { error: 'Cartella non trovata o accesso non autorizzato.', folder_id: folderId };
      return { error: 'Errore lettura cartella: ' + e.message };
    }
  }

  return { error: 'Tool sconosciuto nel modulo driveTools: ' + toolName };
}

module.exports = { definitions: definitions, execute: execute, extractDocText: extractDocText };
