// ─── Attio Service ─────────────────────────────────────────────────────────────
// Thin client for the Attio REST API v2. Attio is Katania Studio's real CRM:
//   • companies  → clienti / aziende
//   • people     → contatti
//   • deals      → pipeline (valore €, stage Won/Lost, servizio proposto, note)
//   • notes      → annotazioni agganciate a un record
//
// Auth is a single workspace API key in process.env.ATTIO_API_KEY. The service
// degrades gracefully (returns an { error } object) when the key is missing, so
// the rest of the bot keeps working even if Attio isn't configured yet.

'use strict';

var logger = require('../utils/logger');

var ATTIO_BASE = 'https://api.attio.com/v2';

function getKey() { return process.env.ATTIO_API_KEY || null; }
function isConfigured() { return !!getKey(); }

// Core fetch wrapper. Returns parsed JSON on success or throws with a readable
// message built from Attio's error payload.
async function attioFetch(path, options) {
  options = options || {};
  var key = getKey();
  if (!key) { var e = new Error('ATTIO_NOT_CONFIGURED'); e.notConfigured = true; throw e; }

  var res = await fetch(ATTIO_BASE + path, {
    method: options.method || 'GET',
    headers: {
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  var text = await res.text();
  var json = null;
  try { json = text ? JSON.parse(text) : null; } catch(_) { /* non-JSON body */ }

  if (!res.ok) {
    var detail = (json && (json.message || (json.errors && json.errors[0] && json.errors[0].message))) || text || ('HTTP ' + res.status);
    var err = new Error('Attio API ' + res.status + ': ' + detail);
    err.status = res.status;
    throw err;
  }
  return json;
}

// Attio write payloads want each attribute as an array of value objects. Accept
// the LLM's friendly map (slug -> scalar | array | object) and normalise it:
//   "Acme"                      -> [{ value: "Acme" }]
//   123                         -> [{ value: 123 }]
//   [{...}, {...}]              -> passed through untouched (refs / multiselect)
//   { target_record_id: ... }  -> [{ target_record_id: ... }]
function wrapValues(values) {
  var out = {};
  Object.keys(values || {}).forEach(function(k) {
    var v = values[k];
    if (Array.isArray(v)) out[k] = v;
    else if (v !== null && typeof v === 'object') out[k] = [v];
    else out[k] = [{ value: v }];
  });
  return out;
}

// Flatten an Attio record's verbose value shape into something compact for the
// LLM: { slug: <simple value or array of simple values> }.
function simplifyValues(values) {
  var out = {};
  Object.keys(values || {}).forEach(function(slug) {
    var arr = values[slug];
    if (!Array.isArray(arr)) { out[slug] = arr; return; }
    var simple = arr.map(function(item) {
      if (item == null || typeof item !== 'object') return item;
      if ('value' in item) return item.value;
      if (item.option && item.option.title) return item.option.title;        // select / status
      if (item.status && item.status.title) return item.status.title;
      if (item.target_record_id) return { object: item.target_object, record_id: item.target_record_id }; // reference
      if (item.full_name) return item.full_name;                              // personal-name
      if (item.email_address) return item.email_address;
      if (item.currency_value != null) return item.currency_value;
      if (item.referenced_actor_id) return item.referenced_actor_id;
      return item;
    });
    out[slug] = simple.length === 1 ? simple[0] : simple;
  });
  return out;
}

function recordId(rec) {
  return rec && rec.id ? (rec.id.record_id || rec.id) : null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

// Query records of an object. `filter` is a raw Attio filter object (optional).
// `offset` enables pagination for callers that need to sweep all records.
async function queryRecords(object, filter, limit, sorts, offset) {
  var body = { limit: Math.min(limit || 10, 50) };
  if (filter) body.filter = filter;
  if (sorts) body.sorts = sorts;
  if (offset) body.offset = offset;
  var json = await attioFetch('/objects/' + encodeURIComponent(object) + '/records/query', {
    method: 'POST', body: body,
  });
  return (json && json.data || []).map(function(rec) {
    var createdAt = rec && (rec.created_at || (rec.id && rec.id.created_at)) || null;
    return { record_id: recordId(rec), values: simplifyValues(rec.values), created_at: createdAt };
  });
}

async function getRecord(object, id) {
  var json = await attioFetch('/objects/' + encodeURIComponent(object) + '/records/' + encodeURIComponent(id));
  var rec = json && json.data;
  if (!rec) return null;
  return { record_id: recordId(rec), values: simplifyValues(rec.values) };
}

async function createRecord(object, values) {
  var json = await attioFetch('/objects/' + encodeURIComponent(object) + '/records', {
    method: 'POST', body: { data: { values: wrapValues(values) } },
  });
  var rec = json && json.data;
  return { record_id: recordId(rec), values: rec ? simplifyValues(rec.values) : {} };
}

async function updateRecord(object, id, values) {
  var json = await attioFetch('/objects/' + encodeURIComponent(object) + '/records/' + encodeURIComponent(id), {
    method: 'PATCH', body: { data: { values: wrapValues(values) } },
  });
  var rec = json && json.data;
  return { record_id: recordId(rec), values: rec ? simplifyValues(rec.values) : {} };
}

async function createNote(parentObject, parentRecordId, title, content) {
  var json = await attioFetch('/notes', {
    method: 'POST',
    body: {
      data: {
        parent_object: parentObject,
        parent_record_id: parentRecordId,
        title: title || 'Nota da Giuno',
        format: 'plaintext',
        content: content || '',
      },
    },
  });
  var note = json && json.data;
  return { note_id: note && note.id ? (note.id.note_id || note.id) : null };
}

module.exports = {
  isConfigured: isConfigured,
  queryRecords: queryRecords,
  getRecord: getRecord,
  createRecord: createRecord,
  updateRecord: updateRecord,
  createNote: createNote,
};
