// ─── Knowledge Base Tools ──────────────────────────────────────────────────────
// add_to_kb, search_kb, delete_from_kb

'use strict';

var logger = require('../utils/logger');
var db = require('../../supabase');
var { askGemini } = require('../services/geminiService');
var { UserInputError } = require('../errors');

// ─── Tool definitions ──────────────────────────────────────────────────────────

var definitions = [
  {
    name: 'add_to_kb',
    description: 'Aggiunge un\'informazione alla knowledge base aziendale condivisa. Usalo per procedure, info clienti, decisioni aziendali che valgono per TUTTI, non per un singolo utente.',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Informazione da salvare' },
        tags:    { type: 'array', items: { type: 'string' }, description: 'Tag (es. "procedura", "cliente-rossi", "hosting", "contratto")' },
      },
      required: ['content'],
    },
  },
  {
    name: 'search_kb',
    description: 'OBBLIGATORIO: Cerca nella knowledge base aziendale di Katania Studio. ' +
      'Chiamare SEMPRE per domande su: procedure interne, rate card, info clienti, ' +
      'documentazione Drive indicizzata, decisioni aziendali. ' +
      'Se non lo chiami, rischi di inventare dati o dare info obsolete.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Testo da cercare' },
      },
      required: ['query'],
    },
  },
  {
    name: 'delete_from_kb',
    description: 'Cancella un\'informazione dalla knowledge base. Solo su richiesta esplicita.',
    input_schema: {
      type: 'object',
      properties: {
        entry_id: { type: 'string', description: 'ID dell\'entry da cancellare' },
      },
      required: ['entry_id'],
    },
  },
];

function normalizeArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return [];
}

// ─── Tool execution ────────────────────────────────────────────────────────────

async function execute(toolName, input, userId) {
  input = input || {};

  if (toolName === 'add_to_kb') {
    var kbContent = (input.content || '').trim();
    if (!kbContent) throw new UserInputError('Contenuto KB mancante.');

    var tags = normalizeArray(input.tags).filter(function(t) { return typeof t === 'string' && t.trim(); });

    var kbNote = null;
    try {
      var kbReview = await askGemini(
        'Questa informazione sta per essere salvata nella knowledge base aziendale:\n\n"' + kbContent + '"\n\nTags: ' + JSON.stringify(tags) +
        '\n\nControlla: è un\'informazione utile e corretta? È troppo vaga o troppo specifica? Suggerisci miglioramenti al testo o ai tag se necessario. Se va bene rispondi solo "OK".',
        'Sei un revisore di knowledge base aziendale. Rispondi in italiano, brevissimo.'
      );
      if (kbReview && kbReview.response && kbReview.response.trim() !== 'OK') {
        kbNote = kbReview.response.substring(0, 200);
        logger.info('[KB-REVIEW] Gemini nota:', kbNote);
      }
    } catch(e) { logger.error('Gemini KB review error:', e.message); }

    await Promise.resolve(db.addKBEntry(kbContent, tags, userId));
    var kbResult = { success: true, message: 'Aggiunto alla knowledge base aziendale.' };
    if (kbNote) kbResult.gemini_review = kbNote;
    return kbResult;
  }

  if (toolName === 'search_kb') {
    var query = (input.query || '').trim();
    if (!query) throw new UserInputError('Query KB mancante.');

    var kbResults = await Promise.resolve(db.searchKB(query));
    kbResults = Array.isArray(kbResults) ? kbResults : [];
    return { entries: kbResults, count: kbResults.length };
  }

  if (toolName === 'delete_from_kb') {
    var entryId = (input.entry_id || '').trim();
    if (!entryId) throw new UserInputError('ID entry KB mancante.');

    var kbDeleted = await Promise.resolve(db.deleteKBEntry(entryId));
    return kbDeleted ? { success: true } : { error: 'Entry non trovata.' };
  }

  return { error: 'Tool sconosciuto nel modulo kbTools: ' + toolName };
}

module.exports = { definitions: definitions, execute: execute };
