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
    name: 'edit_doc',
    description: 'Modifica un Google Doc esistente. Può aggiungere testo alla fine, sostituire testo, o inserire testo in una posizione. Usa read_doc prima per vedere il contenuto attuale.',
    input_schema: {
      type: 'object',
      properties: {
        doc_id:        { type: 'string', description: 'ID del documento Google' },
        action:        { type: 'string', description: '"append" (aggiungi alla fine), "replace" (sostituisci testo), "insert" (inserisci all\'inizio)' },
        text:          { type: 'string', description: 'Testo da aggiungere/inserire' },
        find_text:     { type: 'string', description: 'Testo da cercare (solo per action "replace")' },
        replace_text:  { type: 'string', description: 'Testo sostitutivo (solo per action "replace")' },
      },
      required: ['doc_id', 'action'],
    },
  },
  {
    name: 'edit_slides',
    description: 'Modifica una presentazione Google Slides esistente. Può aggiungere una nuova slide, modificare testo in una slide esistente, o aggiungere note speaker.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string', description: 'ID della presentazione Google Slides' },
        action:          { type: 'string', description: '"add_slide" (nuova slide), "replace_text" (sostituisci testo), "add_notes" (aggiungi note speaker)' },
        slide_number:    { type: 'number', description: 'Numero slide (1-based, per replace_text e add_notes)' },
        text:            { type: 'string', description: 'Testo da inserire (per add_slide/add_notes)' },
        title:           { type: 'string', description: 'Titolo della nuova slide (per add_slide)' },
        find_text:       { type: 'string', description: 'Testo da cercare (per replace_text)' },
        replace_text:    { type: 'string', description: 'Testo sostitutivo (per replace_text)' },
      },
      required: ['presentation_id', 'action'],
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
    description: 'Legge il contenuto testuale di una presentazione Google Slides. Input: presentation_id (string) — ID della presentazione (dall\'URL: docs.google.com/presentation/d/{ID}/edit). Opzionale: slide_numbers (array di numeri, 1-based) per leggere solo slide specifiche, oppure slide_index (indice 0-based) per una sola slide.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string', description: 'ID della presentazione Google Slides' },
        slide_numbers:   { type: 'array', items: { type: 'number' }, description: 'Numeri slide specifiche da leggere, 1-based (opzionale, default: tutte)' },
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
  {
    name: 'read_doc_comments',
    description: 'Legge i commenti e le discussioni in un Google Doc. I commenti spesso contengono decisioni, feedback e revisioni importanti.',
    input_schema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', description: 'ID del documento Google' },
        include_resolved: { type: 'boolean', description: 'Includi commenti risolti (default: false)' },
      },
      required: ['doc_id'],
    },
  },
  {
    name: 'create_sheet',
    description: 'Crea un nuovo Google Sheets vuoto o con dati iniziali.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Titolo del foglio' },
        headers: { type: 'array', items: { type: 'string' }, description: 'Intestazioni colonne (opzionale)' },
        data: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'Righe di dati iniziali (opzionale)' },
        drive_id: { type: 'string', description: 'ID Drive condiviso (opzionale)' },
      },
      required: ['title'],
    },
  },
  {
    name: 'create_folder',
    description: 'Crea una cartella su Google Drive. Utile per setup nuovi progetti.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nome della cartella' },
        parent_folder_id: { type: 'string', description: 'ID cartella genitore (opzionale)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'move_file',
    description: 'Sposta un file in una cartella diversa su Google Drive.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'ID del file da spostare' },
        destination_folder_id: { type: 'string', description: 'ID cartella di destinazione' },
      },
      required: ['file_id', 'destination_folder_id'],
    },
  },
  {
    name: 'rename_file',
    description: 'Rinomina un file su Google Drive.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'ID del file' },
        new_name: { type: 'string', description: 'Nuovo nome' },
      },
      required: ['file_id', 'new_name'],
    },
  },
  {
    name: 'link_doc_to_project',
    description: 'Collega un documento/file a un progetto. Così "documenti del progetto Aitho?" restituisce tutti i file collegati.',
    input_schema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'ID progetto' },
        file_id: { type: 'string', description: 'ID file su Drive' },
        file_name: { type: 'string', description: 'Nome file' },
        drive_link: { type: 'string', description: 'Link al file' },
        doc_role: { type: 'string', description: 'Ruolo: brief, preventivo, contratto, presentazione, moodboard, report, deliverable, asset, altro' },
      },
      required: ['project_id', 'file_id'],
    },
  },
  {
    name: 'get_project_documents',
    description: 'Mostra tutti i documenti collegati a un progetto.',
    input_schema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'ID progetto' },
        project_name: { type: 'string', description: 'Nome progetto (alternativa a ID)' },
      },
    },
  },
  {
    name: 'get_file_permissions',
    description: 'Mostra chi ha accesso a un file su Google Drive e con quale ruolo.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'ID del file' },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'export_file',
    description: 'Esporta un Google Doc/Sheet/Slides in un formato diverso (PDF, DOCX, XLSX, ecc.).',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'ID del file Google' },
        format: { type: 'string', description: 'Formato: pdf, docx, xlsx, pptx, csv, txt' },
      },
      required: ['file_id', 'format'],
    },
  },
  {
    name: 'get_doc_changes',
    description: 'Mostra le modifiche recenti a un documento Google (chi ha modificato cosa, quando).',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'ID del file' },
      },
      required: ['file_id'],
    },
  },
];

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

    if (toolName === 'edit_doc') {
      var docsEdit = getDocsPerUtente(userId);
      if (!docsEdit) return { error: 'Google Docs non collegato. Scrivi "collega il mio Google".' };
      try {
        var requests = [];
        if (input.action === 'append') {
          // Get document length first
          var docMeta = await docsEdit.documents.get({ documentId: input.doc_id });
          var endIndex = 1;
          if (docMeta.data.body && docMeta.data.body.content) {
            var lastEl = docMeta.data.body.content[docMeta.data.body.content.length - 1];
            endIndex = lastEl.endIndex ? lastEl.endIndex - 1 : 1;
          }
          requests.push({ insertText: { location: { index: Math.max(endIndex, 1) }, text: '\n' + (input.text || '') } });
        } else if (input.action === 'insert') {
          requests.push({ insertText: { location: { index: 1 }, text: (input.text || '') + '\n' } });
        } else if (input.action === 'replace') {
          if (!input.find_text) return { error: 'find_text obbligatorio per action "replace".' };
          requests.push({ replaceAllText: { containsText: { text: input.find_text, matchCase: false }, replaceText: input.replace_text || '' } });
        } else {
          return { error: 'Action non valida. Usa: append, insert, replace.' };
        }
        var result = await docsEdit.documents.batchUpdate({ documentId: input.doc_id, requestBody: { requests: requests } });
        return { success: true, action: input.action, replies: (result.data.replies || []).length };
      } catch(e) {
        if (await handleTokenScaduto(userId, e)) return { error: 'Token scaduto. Scrivi "collega il mio Google".' };
        return { error: 'Errore modifica doc: ' + e.message };
      }
    }

    if (toolName === 'edit_slides') {
      var slidesEdit = getSlidesPerUtente(userId);
      if (!slidesEdit) return { error: 'Google Slides non collegato. Scrivi "collega il mio Google".' };
      try {
        var presData = await slidesEdit.presentations.get({ presentationId: input.presentation_id });
        var allSlides = presData.data.slides || [];
        var requests = [];

        if (input.action === 'add_slide') {
          // Add a new blank slide at the end with title and body
          requests.push({ createSlide: { insertionIndex: allSlides.length, slideLayoutReference: { predefinedLayout: 'TITLE_AND_BODY' } } });
          // We'll need to get the new slide ID after creation to insert text
          var addResult = await slidesEdit.presentations.batchUpdate({
            presentationId: input.presentation_id,
            requestBody: { requests: requests },
          });
          var newSlideId = addResult.data.replies && addResult.data.replies[0] && addResult.data.replies[0].createSlide ? addResult.data.replies[0].createSlide.objectId : null;
          if (newSlideId && (input.title || input.text)) {
            // Re-fetch to get the new slide's elements
            var updatedPres = await slidesEdit.presentations.get({ presentationId: input.presentation_id });
            var newSlide = updatedPres.data.slides.find(function(s) { return s.objectId === newSlideId; });
            if (newSlide && newSlide.pageElements) {
              var textRequests = [];
              for (var eli = 0; eli < newSlide.pageElements.length; eli++) {
                var el = newSlide.pageElements[eli];
                if (el.shape && el.shape.placeholder) {
                  if (el.shape.placeholder.type === 'TITLE' && input.title) {
                    textRequests.push({ insertText: { objectId: el.objectId, text: input.title, insertionIndex: 0 } });
                  } else if (el.shape.placeholder.type === 'BODY' && input.text) {
                    textRequests.push({ insertText: { objectId: el.objectId, text: input.text, insertionIndex: 0 } });
                  }
                }
              }
              if (textRequests.length > 0) {
                await slidesEdit.presentations.batchUpdate({ presentationId: input.presentation_id, requestBody: { requests: textRequests } });
              }
            }
          }
          return { success: true, action: 'add_slide', new_slide_id: newSlideId, total_slides: allSlides.length + 1 };

        } else if (input.action === 'replace_text') {
          if (!input.find_text) return { error: 'find_text obbligatorio per replace_text.' };
          requests.push({ replaceAllText: { containsText: { text: input.find_text, matchCase: false }, replaceText: input.replace_text || '' } });

        } else if (input.action === 'add_notes') {
          var slideIdx = (input.slide_number || 1) - 1;
          if (slideIdx < 0 || slideIdx >= allSlides.length) return { error: 'Slide ' + input.slide_number + ' non trovata.' };
          var targetSlide = allSlides[slideIdx];
          if (targetSlide.slideProperties && targetSlide.slideProperties.notesPage) {
            var notesPage = targetSlide.slideProperties.notesPage;
            var notesShape = (notesPage.pageElements || []).find(function(pe) {
              return pe.shape && pe.shape.placeholder && pe.shape.placeholder.type === 'BODY';
            });
            if (notesShape) {
              requests.push({ insertText: { objectId: notesShape.objectId, text: input.text || '', insertionIndex: 0 } });
            }
          }
        } else {
          return { error: 'Action non valida. Usa: add_slide, replace_text, add_notes.' };
        }

        if (requests.length > 0) {
          await slidesEdit.presentations.batchUpdate({ presentationId: input.presentation_id, requestBody: { requests: requests } });
        }
        return { success: true, action: input.action };
      } catch(e) {
        if (await handleTokenScaduto(userId, e)) return { error: 'Token scaduto. Scrivi "collega il mio Google".' };
        return { error: 'Errore modifica slides: ' + e.message };
      }
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

      // Helper: extract text from textContent
      function extractTextRuns(textContent) {
        if (!textContent || !textContent.textElements) return '';
        return textContent.textElements
          .filter(function(te) { return te.textRun && te.textRun.content; })
          .map(function(te) { return te.textRun.content; })
          .join('')
          .trim();
      }

      // Helper: extract text recursively from a pageElement (shapes, tables, groups)
      function extractTextFromElement(element) {
        if (!element) return '';
        if (element.shape && element.shape.text) {
          return extractTextRuns(element.shape.text);
        }
        if (element.table) {
          var rows = [];
          for (var r = 0; r < (element.table.tableRows || []).length; r++) {
            var cells = [];
            var row = element.table.tableRows[r];
            for (var c2 = 0; c2 < (row.tableCells || []).length; c2++) {
              var cellText = extractTextRuns(row.tableCells[c2].text);
              cells.push(cellText || '');
            }
            rows.push(cells.join(' | '));
          }
          return rows.join('\n');
        }
        if (element.elementGroup && element.elementGroup.children) {
          return element.elementGroup.children.map(extractTextFromElement).filter(Boolean).join('\n');
        }
        return '';
      }

      var slidesList = (presData.slides || []).map(function(slide, idx) {
        var texts = [];
        var notes = '';
        (slide.pageElements || []).forEach(function(el) {
          var extracted = extractTextFromElement(el);
          if (extracted) texts.push(extracted);
        });
        if (slide.slideProperties && slide.slideProperties.notesPage) {
          var notesPage = slide.slideProperties.notesPage;
          (notesPage.pageElements || []).forEach(function(el) {
            var n = extractTextFromElement(el);
            if (n) notes += n + '\n';
          });
        }
        return { index: idx, texts: texts, notes: notes.trim() || null };
      });

      // Filter by slide_numbers (1-based) if provided
      if (input.slide_numbers && input.slide_numbers.length > 0) {
        var filteredSlides = input.slide_numbers.map(function(n) {
          var sl = slidesList[n - 1];
          return sl || null;
        }).filter(Boolean);
        if (filteredSlides.length === 0) return { error: 'Nessuna delle slide richieste trovata. La presentazione ha ' + slidesList.length + ' slide (1-' + slidesList.length + ').' };
        return { title: presData.title, total_slides: slidesList.length, slides: filteredSlides };
      }

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

  // ─── Read Doc Comments ─────────────────────────────────────────────────
  if (toolName === 'read_doc_comments') {
    var driveComments = getDrivePerUtente(userId);
    if (!driveComments) return { error: 'Google Drive non collegato.' };
    try {
      var commentsRes = await driveComments.comments.list({
        fileId: input.doc_id,
        fields: 'comments(id,author,content,resolved,createdTime,replies)',
        includeDeleted: false,
      });
      var comments = (commentsRes.data.comments || []).filter(function(c) {
        if (!input.include_resolved && c.resolved) return false;
        return true;
      });
      return {
        comments: comments.map(function(c) {
          return {
            author: c.author ? c.author.displayName : 'unknown',
            content: c.content,
            resolved: c.resolved || false,
            date: c.createdTime,
            replies: (c.replies || []).map(function(r) {
              return { author: r.author ? r.author.displayName : 'unknown', content: r.content, date: r.createdTime };
            }),
          };
        }),
        total: comments.length,
      };
    } catch(e) {
      if (await handleTokenScaduto(userId, e)) return { error: 'Token scaduto.' };
      return { error: 'Errore commenti: ' + e.message };
    }
  }

  // ─── Create Sheet ─────────────────────────────────────────────────────
  if (toolName === 'create_sheet') {
    var sheetsCreate = getSheetPerUtente(userId);
    if (!sheetsCreate) return { error: 'Google Sheets non collegato.' };
    try {
      var newSheet = await sheetsCreate.spreadsheets.create({
        requestBody: { properties: { title: input.title } },
      });
      var sheetId = newSheet.data.spreadsheetId;
      // Add headers and data if provided
      if (input.headers || input.data) {
        var values = [];
        if (input.headers) values.push(input.headers);
        if (input.data) values = values.concat(input.data);
        await sheetsCreate.spreadsheets.values.update({
          spreadsheetId: sheetId,
          range: 'Sheet1!A1',
          valueInputOption: 'RAW',
          requestBody: { values: values },
        });
      }
      return { success: true, id: sheetId, title: input.title, link: 'https://docs.google.com/spreadsheets/d/' + sheetId };
    } catch(e) {
      if (await handleTokenScaduto(userId, e)) return { error: 'Token scaduto.' };
      return { error: 'Errore creazione sheet: ' + e.message };
    }
  }

  // ─── Create Folder ────────────────────────────────────────────────────
  if (toolName === 'create_folder') {
    var drvFolder = getDrivePerUtente(userId);
    if (!drvFolder) return { error: 'Google Drive non collegato.' };
    try {
      var folderMeta = { name: input.name, mimeType: 'application/vnd.google-apps.folder' };
      if (input.parent_folder_id) folderMeta.parents = [input.parent_folder_id];
      var folderRes = await drvFolder.files.create({ requestBody: folderMeta, fields: 'id, name, webViewLink' });
      return { success: true, folder: folderRes.data };
    } catch(e) {
      if (await handleTokenScaduto(userId, e)) return { error: 'Token scaduto.' };
      return { error: 'Errore creazione cartella: ' + e.message };
    }
  }

  // ─── Move File ────────────────────────────────────────────────────────
  if (toolName === 'move_file') {
    var drvMove = getDrivePerUtente(userId);
    if (!drvMove) return { error: 'Google Drive non collegato.' };
    try {
      var fileInfo = await drvMove.files.get({ fileId: input.file_id, fields: 'parents' });
      var prevParents = (fileInfo.data.parents || []).join(',');
      var moveRes = await drvMove.files.update({
        fileId: input.file_id,
        addParents: input.destination_folder_id,
        removeParents: prevParents,
        fields: 'id, name, parents',
      });
      return { success: true, file: moveRes.data };
    } catch(e) {
      if (await handleTokenScaduto(userId, e)) return { error: 'Token scaduto.' };
      return { error: 'Errore spostamento: ' + e.message };
    }
  }

  // ─── Rename File ──────────────────────────────────────────────────────
  if (toolName === 'rename_file') {
    var drvRename = getDrivePerUtente(userId);
    if (!drvRename) return { error: 'Google Drive non collegato.' };
    try {
      var renameRes = await drvRename.files.update({ fileId: input.file_id, requestBody: { name: input.new_name }, fields: 'id, name' });
      return { success: true, file: renameRes.data };
    } catch(e) { return { error: 'Errore rinomina: ' + e.message }; }
  }

  // ─── Link Doc to Project ──────────────────────────────────────────────
  if (toolName === 'link_doc_to_project') {
    try {
      var supabaseLink = require('../services/db/client').getClient();
      var { data } = await supabaseLink.from('project_documents').insert({
        project_id: input.project_id, file_id: input.file_id,
        file_name: input.file_name || null, drive_link: input.drive_link || null,
        doc_role: input.doc_role || 'altro', added_by: userId,
      }).select().single();
      return { success: true, document: data };
    } catch(e) { return { error: e.message }; }
  }

  // ─── Get Project Documents ────────────────────────────────────────────
  if (toolName === 'get_project_documents') {
    try {
      var supabaseDocs = require('../services/db/client').getClient();
      var projectId = input.project_id;
      if (!projectId && input.project_name) {
        var db = require('../../supabase');
        var projects = await db.searchProjects({ name: input.project_name, limit: 1 });
        if (projects && projects.length > 0) projectId = projects[0].id;
      }
      if (!projectId) return { error: 'Progetto non trovato.' };
      var { data } = await supabaseDocs.from('project_documents').select('*').eq('project_id', projectId).order('created_at');
      return { documents: data || [], count: (data || []).length };
    } catch(e) { return { error: e.message }; }
  }

  // ─── File Permissions ─────────────────────────────────────────────────
  if (toolName === 'get_file_permissions') {
    var drvPerm = getDrivePerUtente(userId);
    if (!drvPerm) return { error: 'Google Drive non collegato.' };
    try {
      var permRes = await drvPerm.permissions.list({ fileId: input.file_id, fields: 'permissions(id,emailAddress,role,displayName,type)' });
      return { permissions: (permRes.data.permissions || []).map(function(p) {
        return { email: p.emailAddress, name: p.displayName, role: p.role, type: p.type };
      }) };
    } catch(e) { return { error: 'Errore permessi: ' + e.message }; }
  }

  // ─── Export File ──────────────────────────────────────────────────────
  if (toolName === 'export_file') {
    var drvExport = getDrivePerUtente(userId);
    if (!drvExport) return { error: 'Google Drive non collegato.' };
    var mimeTypes = {
      'pdf': 'application/pdf', 'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'csv': 'text/csv', 'txt': 'text/plain',
    };
    var mime = mimeTypes[input.format];
    if (!mime) return { error: 'Formato non supportato. Usa: pdf, docx, xlsx, pptx, csv, txt.' };
    try {
      var exportRes = await drvExport.files.export({ fileId: input.file_id, mimeType: mime }, { responseType: 'arraybuffer' });
      // Upload exported file back to Drive
      var originalFile = await drvExport.files.get({ fileId: input.file_id, fields: 'name,parents' });
      var exportName = (originalFile.data.name || 'export') + '.' + input.format;
      var { Readable } = require('stream');
      var stream = new Readable();
      stream.push(Buffer.from(exportRes.data));
      stream.push(null);
      var uploadRes = await drvExport.files.create({
        requestBody: { name: exportName, parents: originalFile.data.parents || [] },
        media: { mimeType: mime, body: stream },
        fields: 'id, name, webViewLink',
      });
      return { success: true, exported: uploadRes.data, format: input.format };
    } catch(e) { return { error: 'Errore export: ' + e.message }; }
  }

  // ─── Doc Changes / Revisions ──────────────────────────────────────────
  if (toolName === 'get_doc_changes') {
    var drvRev = getDrivePerUtente(userId);
    if (!drvRev) return { error: 'Google Drive non collegato.' };
    try {
      var revRes = await drvRev.revisions.list({ fileId: input.file_id, fields: 'revisions(id,modifiedTime,lastModifyingUser)', pageSize: 10 });
      var revisions = (revRes.data.revisions || []).reverse().map(function(r) {
        return {
          date: r.modifiedTime,
          author: r.lastModifyingUser ? r.lastModifyingUser.displayName : 'unknown',
          email: r.lastModifyingUser ? r.lastModifyingUser.emailAddress : null,
        };
      });
      return { revisions: revisions, total: revisions.length };
    } catch(e) { return { error: 'Errore revisioni: ' + e.message }; }
  }

  return { error: 'Tool sconosciuto nel modulo driveTools: ' + toolName };
}

module.exports = { definitions: definitions, execute: execute, extractDocText: extractDocText };
