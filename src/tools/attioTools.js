// ─── Attio CRM Tools ───────────────────────────────────────────────────────────
// Lets Giuno read and write Katania Studio's real CRM on Attio: aziende/clienti
// (companies), contatti (people), pipeline/trattative (deals) and note.

'use strict';

var attio = require('../services/attioService');
var logger = require('../utils/logger');

var OBJECT_HELP = 'companies (aziende/clienti), people (contatti) o deals (trattative/pipeline)';

var definitions = [
  {
    name: 'attio_search',
    description: 'Cerca su Attio, il CRM reale di Katania Studio. Usalo per clienti, contatti e trattative ' +
      '(pipeline, valore €, stage Won/Lost, servizio proposto). object = ' + OBJECT_HELP + '. ' +
      'Passa "query" per una ricerca per nome, oppure "filter" con un filtro Attio grezzo per query avanzate.',
    input_schema: {
      type: 'object',
      properties: {
        object: { type: 'string', description: 'companies | people | deals' },
        query:  { type: 'string', description: 'Testo da cercare nel nome del record (opzionale)' },
        filter: { type: 'object', description: 'Filtro Attio grezzo, es. {"stage":{"$eq":"Won 🎉"}} o {"name":{"$contains":"Tomarchio"}} (opzionale, alternativo a query)' },
        limit:  { type: 'number', description: 'Max risultati (default 10, max 50)' },
      },
      required: ['object'],
    },
  },
  {
    name: 'attio_get_record',
    description: 'Ottieni tutti i dettagli di un record Attio dal suo record_id. object = ' + OBJECT_HELP + '.',
    input_schema: {
      type: 'object',
      properties: {
        object:    { type: 'string', description: 'companies | people | deals' },
        record_id: { type: 'string', description: 'record_id Attio' },
      },
      required: ['object', 'record_id'],
    },
  },
  {
    name: 'attio_create_record',
    description: 'Crea un nuovo record su Attio (azienda, contatto o trattativa). object = ' + OBJECT_HELP + '. ' +
      '"values" è una mappa slug→valore: per testo/numero passa il valore semplice (es. {"name":"Acme","value":3000}); ' +
      'per un riferimento a un altro record passa {"target_object":"companies","target_record_id":"..."}; ' +
      'per uno status/select passa il titolo dell\'opzione (es. {"stage":"Won 🎉"}).',
    input_schema: {
      type: 'object',
      properties: {
        object: { type: 'string', description: 'companies | people | deals' },
        values: { type: 'object', description: 'Mappa attributo→valore' },
      },
      required: ['object', 'values'],
    },
  },
  {
    name: 'attio_update_record',
    description: 'Aggiorna un record Attio esistente. Stesso formato "values" di attio_create_record — includi solo i campi da cambiare.',
    input_schema: {
      type: 'object',
      properties: {
        object:    { type: 'string', description: 'companies | people | deals' },
        record_id: { type: 'string', description: 'record_id Attio del record da aggiornare' },
        values:    { type: 'object', description: 'Mappa attributo→nuovo valore' },
      },
      required: ['object', 'record_id', 'values'],
    },
  },
  {
    name: 'attio_add_note',
    description: 'Aggiunge una nota di testo a un record Attio (es. esito di una call, follow-up).',
    input_schema: {
      type: 'object',
      properties: {
        parent_object:    { type: 'string', description: 'companies | people | deals' },
        parent_record_id: { type: 'string', description: 'record_id del record a cui agganciare la nota' },
        title:            { type: 'string', description: 'Titolo della nota (opzionale)' },
        content:          { type: 'string', description: 'Testo della nota' },
      },
      required: ['parent_object', 'parent_record_id', 'content'],
    },
  },
];

var VALID_OBJECTS = { companies: 1, people: 1, deals: 1 };

function notConfiguredMsg() {
  return { error: 'Attio non è ancora collegato: manca la variabile ATTIO_API_KEY. Avvisa Antonio.' };
}

function checkObject(object) {
  if (!object || !VALID_OBJECTS[object]) {
    return { error: 'object non valido: usa companies, people o deals.' };
  }
  return null;
}

async function execute(toolName, input, userId, userRole) {
  if (!attio.isConfigured()) return notConfiguredMsg();
  input = input || {};

  try {
    if (toolName === 'attio_search') {
      var objErr = checkObject(input.object);
      if (objErr) return objErr;
      var filter = input.filter || null;
      if (!filter && input.query) filter = { name: { '$contains': input.query } };
      var records = await attio.queryRecords(input.object, filter, input.limit);
      return { object: input.object, count: records.length, records: records };
    }

    if (toolName === 'attio_get_record') {
      var ge = checkObject(input.object);
      if (ge) return ge;
      var rec = await attio.getRecord(input.object, input.record_id);
      if (!rec) return { error: 'Record non trovato.' };
      return rec;
    }

    if (toolName === 'attio_create_record') {
      var ce = checkObject(input.object);
      if (ce) return ce;
      if (!input.values || typeof input.values !== 'object') return { error: 'values mancante o non valido.' };
      var created = await attio.createRecord(input.object, input.values);
      logger.info('[ATTIO] record creato', input.object, created.record_id, 'da', userId);
      return { ok: true, created: created };
    }

    if (toolName === 'attio_update_record') {
      var ue = checkObject(input.object);
      if (ue) return ue;
      if (!input.record_id) return { error: 'record_id mancante.' };
      if (!input.values || typeof input.values !== 'object') return { error: 'values mancante o non valido.' };
      var updated = await attio.updateRecord(input.object, input.record_id, input.values);
      logger.info('[ATTIO] record aggiornato', input.object, input.record_id, 'da', userId);
      return { ok: true, updated: updated };
    }

    if (toolName === 'attio_add_note') {
      var ne = checkObject(input.parent_object);
      if (ne) return ne;
      if (!input.parent_record_id) return { error: 'parent_record_id mancante.' };
      var note = await attio.createNote(input.parent_object, input.parent_record_id, input.title, input.content);
      logger.info('[ATTIO] nota aggiunta a', input.parent_object, input.parent_record_id, 'da', userId);
      return { ok: true, note: note };
    }

    return { error: 'Tool sconosciuto in attioTools: ' + toolName };
  } catch(e) {
    if (e && e.notConfigured) return notConfiguredMsg();
    logger.warn('[ATTIO] errore', toolName, e && e.message);
    return { error: 'Errore Attio: ' + (e && e.message ? e.message : 'sconosciuto') };
  }
}

module.exports = {
  definitions: definitions,
  execute: execute,
};
