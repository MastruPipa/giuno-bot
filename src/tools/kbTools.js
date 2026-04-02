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
  {
    name: 'get_channel_digest',
    description: 'Recupera il riassunto recente di un canale Slack. Utile per capire di cosa si parla in un canale senza leggerlo tutto.',
    input_schema: {
      type: 'object',
      properties: {
        channel_name: { type: 'string', description: 'Nome del canale (es. "operation", "preventivi-clienti")' },
      },
      required: ['channel_name'],
    },
  },
  {
    name: 'get_entity_relationships',
    description: 'Recupera il grafo di relazioni di un\'entità (cliente, fornitore, progetto). Mostra entità collegate, memorie associate, documenti.',
    input_schema: {
      type: 'object',
      properties: {
        entity_name: { type: 'string', description: 'Nome dell\'entità (es. "Aitho", "Andrea Lo Pinzi")' },
      },
      required: ['entity_name'],
    },
  },
  {
    name: 'search_drive_index',
    description: 'Cerca nei documenti Drive già indicizzati e riassunti dal sistema. Più veloce di search_drive perché cerca nei riassunti AI già generati.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Testo da cercare nei documenti indicizzati' },
        client_filter: { type: 'string', description: 'Filtra per nome cliente (opzionale)' },
      },
      required: ['query'],
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

  if (toolName === 'get_channel_digest') {
    var chName = (input.channel_name || '').toLowerCase().replace(/^#/, '');
    if (!chName) throw new UserInputError('Nome canale mancante.');
    var digests = db.getChannelDigestCache();
    var channelMap = db.getChannelMapCache();
    // Find channel by name
    var targetChId = null;
    for (var chId in channelMap) {
      if ((channelMap[chId].channel_name || '').toLowerCase() === chName) {
        targetChId = chId;
        break;
      }
    }
    if (!targetChId) return { error: 'Canale "' + chName + '" non trovato nella mappa canali.' };
    var digest = digests[targetChId];
    var mapping = channelMap[targetChId] || {};
    return {
      channel: chName,
      cliente: mapping.cliente || null,
      progetto: mapping.progetto || null,
      tags: mapping.tags || [],
      last_digest: digest ? digest.last_digest : 'Nessun digest disponibile',
      last_updated: digest ? digest.last_ts : null,
    };
  }

  if (toolName === 'get_entity_relationships') {
    var entName = (input.entity_name || '').trim();
    if (!entName) throw new UserInputError('Nome entità mancante.');
    try {
      var entityCtx = await db.getEntityContext(entName, 2);
      if (entityCtx && entityCtx.found) return entityCtx;
      // Fallback: resolve entity + search memories
      var resolved = await db.resolveEntity(entName);
      if (resolved) {
        var memories = await db.searchMemories(null, entName);
        return {
          entity: resolved,
          related_memories: (memories || []).slice(0, 5).map(function(m) { return m.content; }),
        };
      }
      return { error: 'Entità "' + entName + '" non trovata.' };
    } catch(e) {
      return { error: 'Errore ricerca entità: ' + e.message };
    }
  }

  if (toolName === 'search_drive_index') {
    var driveQuery = (input.query || '').trim();
    if (!driveQuery) throw new UserInputError('Query mancante.');
    try {
      var driveResults = await db.searchDriveContent(driveQuery, 10);
      if (input.client_filter) {
        var clientFilter = input.client_filter.toLowerCase();
        driveResults = (driveResults || []).filter(function(d) {
          return (d.related_client || '').toLowerCase().includes(clientFilter) ||
                 (d.file_name || '').toLowerCase().includes(clientFilter);
        });
      }
      return { results: (driveResults || []).slice(0, 8), count: (driveResults || []).length };
    } catch(e) {
      return { error: 'Errore ricerca Drive index: ' + e.message };
    }
  }

  return { error: 'Tool sconosciuto nel modulo kbTools: ' + toolName };
}

module.exports = { definitions: definitions, execute: execute };
