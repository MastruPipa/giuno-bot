// ─── DB: dossier di progetto e documenti collegati ───────────────────────────
// project_dossiers: una riga per progetto con la scheda strutturata (JSON),
// il riassunto testuale, le fonti usate e il changelog delle versioni.
// project_documents: kick-off, recap Gemini, brief… collegati al progetto.
// Fallback JSON su disco quando Supabase non c'è (dev locale, test).

'use strict';

var logger = require('../../utils/logger');

function _c() { return require('./client'); }

var DOSSIERS_FILE = 'project_dossiers.json';
var DOCS_FILE = 'project_documents.json';

function _readDossiers() { return _c().readJSON(DOSSIERS_FILE, {}); }
function _readDocs() { return _c().readJSON(DOCS_FILE, []); }

async function getDossier(projectId) {
  var c = _c();
  if (!c.useSupabase) return _readDossiers()[projectId] || null;
  try {
    var res = await c.getClient().from('project_dossiers').select('*').eq('project_id', projectId).maybeSingle();
    if (res.error) throw res.error;
    return res.data || null;
  } catch(e) { c.logErr('getDossier', e); return null; }
}

async function listDossiers(opts) {
  opts = opts || {};
  var c = _c();
  var rows;
  if (!c.useSupabase) {
    var all = _readDossiers();
    rows = Object.keys(all).map(function(k) { return all[k]; });
  } else {
    try {
      var q = c.getClient().from('project_dossiers').select('*').order('updated_at', { ascending: false }).limit(opts.limit || 200);
      if (opts.needsRefresh) q = q.eq('needs_refresh', true);
      var res = await q;
      if (res.error) throw res.error;
      rows = res.data || [];
    } catch(e) { c.logErr('listDossiers', e); rows = []; }
  }
  if (opts.needsRefresh) rows = rows.filter(function(r) { return r.needs_refresh; });
  return rows;
}

async function saveDossier(row) {
  row.updated_at = new Date().toISOString();
  var c = _c();
  if (!c.useSupabase) {
    var all = _readDossiers();
    all[row.project_id] = row;
    c.writeJSON(DOSSIERS_FILE, all);
    return row;
  }
  try {
    var res = await c.getClient().from('project_dossiers').upsert(row, { onConflict: 'project_id' });
    if (res.error) throw res.error;
  } catch(e) { c.logErr('saveDossier', e); }
  return row;
}

// Segna che sono arrivate fonti nuove (recap, kick-off, documenti): il
// prossimo refresh ricostruisce la scheda. Se il dossier non esiste ancora,
// crea la riga "vuota" così il refresh lo trova.
async function markNeedsRefresh(projectId, sourceAt) {
  var existing = await getDossier(projectId);
  var row = existing || { project_id: projectId, dossier: {}, summary: null, sources: null, changelog: [], version: 0 };
  row.needs_refresh = true;
  row.last_source_at = sourceAt || new Date().toISOString();
  return saveDossier(row);
}

async function getProjectDocuments(projectId) {
  var c = _c();
  if (!c.useSupabase) return _readDocs().filter(function(d) { return d.project_id === projectId; });
  try {
    var res = await c.getClient().from('project_documents').select('*').eq('project_id', projectId).order('created_at', { ascending: false }).limit(100);
    if (res.error) throw res.error;
    return res.data || [];
  } catch(e) { c.logErr('getProjectDocuments', e); return []; }
}

async function findProjectDocumentByFile(fileId) {
  var c = _c();
  if (!c.useSupabase) return _readDocs().find(function(d) { return d.file_id === fileId; }) || null;
  try {
    var res = await c.getClient().from('project_documents').select('*').eq('file_id', fileId).limit(1);
    if (res.error) throw res.error;
    return (res.data && res.data[0]) || null;
  } catch(e) { c.logErr('findProjectDocumentByFile', e); return null; }
}

// Collega un file a un progetto; se il file è già collegato allo stesso
// progetto non duplica (aggiorna solo nome/ruolo).
async function addProjectDocument(row) {
  row.id = row.id || ('pdoc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7));
  row.created_at = row.created_at || new Date().toISOString();
  var c = _c();
  if (!c.useSupabase) {
    var docs = _readDocs();
    var idx = -1;
    for (var i = 0; i < docs.length; i++) if (docs[i].project_id === row.project_id && docs[i].file_id === row.file_id) { idx = i; break; }
    if (idx === -1) docs.push(row); else docs[idx] = Object.assign({}, docs[idx], { file_name: row.file_name, doc_role: row.doc_role, notes: row.notes });
    c.writeJSON(DOCS_FILE, docs);
    return row;
  }
  try {
    var ex = await c.getClient().from('project_documents').select('id').eq('project_id', row.project_id).eq('file_id', row.file_id).limit(1);
    if (ex.data && ex.data.length > 0) {
      await c.getClient().from('project_documents').update({ file_name: row.file_name, doc_role: row.doc_role, notes: row.notes || null }).eq('id', ex.data[0].id);
      return Object.assign({}, row, { id: ex.data[0].id });
    }
    var res = await c.getClient().from('project_documents').insert(row);
    if (res.error) throw res.error;
  } catch(e) { c.logErr('addProjectDocument', e); }
  return row;
}

async function getProjectTimeLogs(projectId, dateFrom) {
  var c = _c();
  if (!c.useSupabase) return [];
  try {
    var res = await c.getClient().from('time_logs')
      .select('slack_user_id, log_date, log_type, hours, notes')
      .eq('project_id', projectId).gte('log_date', dateFrom).limit(500);
    if (res.error) throw res.error;
    return res.data || [];
  } catch(e) { c.logErr('getProjectTimeLogs', e); return []; }
}

async function getProjectSignals(projectRef, days) {
  var c = _c();
  if (!c.useSupabase || !projectRef) return [];
  try {
    var since = new Date(Date.now() - (days || 30) * 86400000).toISOString();
    var res = await c.getClient().from('pm_signals')
      .select('signal_type, message_excerpt, urgency_score, status, detected_at')
      .ilike('project_ref', '%' + projectRef + '%').gte('detected_at', since)
      .order('detected_at', { ascending: false }).limit(20);
    if (res.error) throw res.error;
    return res.data || [];
  } catch(e) { c.logErr('getProjectSignals', e); return []; }
}

module.exports = {
  getDossier: getDossier,
  listDossiers: listDossiers,
  saveDossier: saveDossier,
  markNeedsRefresh: markNeedsRefresh,
  getProjectDocuments: getProjectDocuments,
  findProjectDocumentByFile: findProjectDocumentByFile,
  addProjectDocument: addProjectDocument,
  getProjectTimeLogs: getProjectTimeLogs,
  getProjectSignals: getProjectSignals,
};

// ─── Azioni dalle call (project_actions) ─────────────────────────────────────
// "Corrado → inviare documenti Caritas entro il 10/09" estratto dagli appunti
// Gemini: una riga per azione, con assegnatario risolto sul roster quando si
// può. Dedup per (file sorgente, descrizione compatta).

var ACTIONS_FILE = 'project_actions.json';
function _readActions() { return _c().readJSON(ACTIONS_FILE, []); }
function _compactText(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9àèéìòù]+/g, '').substring(0, 80); }

async function addProjectAction(row) {
  row.id = row.id || ('act_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7));
  row.status = row.status || 'open';
  row.created_at = row.created_at || new Date().toISOString();
  row.description_key = _compactText(row.description);
  var c = _c();
  if (!c.useSupabase) {
    var acts = _readActions();
    if (acts.some(function(a) { return a.source_file_id === row.source_file_id && a.description_key === row.description_key; })) return null;
    acts.push(row);
    c.writeJSON(ACTIONS_FILE, acts);
    return row;
  }
  try {
    var ex = await c.getClient().from('project_actions').select('id').eq('source_file_id', row.source_file_id || '').eq('description_key', row.description_key).limit(1);
    if (ex.data && ex.data.length > 0) return null;
    var res = await c.getClient().from('project_actions').insert(row);
    if (res.error) throw res.error;
    return row;
  } catch(e) { c.logErr('addProjectAction', e); return null; }
}

async function listProjectActions(filter) {
  filter = filter || {};
  var c = _c();
  var rows;
  if (!c.useSupabase) rows = _readActions();
  else {
    try {
      var q = c.getClient().from('project_actions').select('*').order('created_at', { ascending: false }).limit(filter.limit || 300);
      if (filter.status) q = q.eq('status', filter.status);
      if (filter.assignee) q = q.eq('assignee_slack_id', filter.assignee);
      var res = await q;
      if (res.error) throw res.error;
      rows = res.data || [];
    } catch(e) { c.logErr('listProjectActions', e); rows = []; }
  }
  return rows.filter(function(a) {
    if (filter.status && a.status !== filter.status) return false;
    if (filter.assignee && a.assignee_slack_id !== filter.assignee) return false;
    if (filter.notNotified && a.notified_at) return false;
    if (filter.createdAfter && !(a.created_at >= filter.createdAfter)) return false;
    if (filter.dueBefore && !(a.due_date && a.due_date <= filter.dueBefore)) return false;
    return true;
  });
}

async function updateProjectAction(id, fields) {
  fields.updated_at = new Date().toISOString();
  var c = _c();
  if (!c.useSupabase) {
    var acts = _readActions().map(function(a) { return a.id === id ? Object.assign({}, a, fields) : a; });
    c.writeJSON(ACTIONS_FILE, acts);
    return;
  }
  try {
    var res = await c.getClient().from('project_actions').update(fields).eq('id', id);
    if (res.error) throw res.error;
  } catch(e) { c.logErr('updateProjectAction', e); }
}

module.exports.addProjectAction = addProjectAction;
module.exports.listProjectActions = listProjectActions;
module.exports.updateProjectAction = updateProjectAction;
