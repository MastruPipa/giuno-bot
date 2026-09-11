// ─── Registro delle posizioni di progetto ────────────────────────────────────
// Dove "vive" una commessa: canali Slack, cartelle Drive, progetti e file
// Figma. Serve per attribuire un artefatto o una sessione di lavoro al
// progetto per POSIZIONE (il file sta nella cartella del progetto, il
// messaggio è nel suo canale) invece che per somiglianza del nome.
//
// Tabella project_locations (migrazione in supabase_migration.sql):
//   project_id, kind (slack_channel|drive_folder|figma_project|figma_file),
//   ref (id del canale / della cartella / del progetto Figma / chiave file),
//   name, source (channel_map|document|figma|admin), confidence (alta|media).
// Senza tabella il registro vive in memoria per la corsa (canali dalla
// channel map), e i comandi admin lo dicono.
//
// Regole: una posizione impostata da un admin non viene mai sovrascritta o
// cancellata da una ricostruzione; le cartelle "Appunti di Gemini"/"Meet
// Recordings" non sono cartelle di progetto.

'use strict';

var logger = require('../utils/logger');

var KINDS = ['slack_channel', 'drive_folder', 'figma_project', 'figma_file'];
var NOISE_FOLDER_RE = /appunti di gemini|meet recordings|registrazioni|gemini notes/i;
var CACHE_MS = 30 * 60000;

function _c() { return require('./db/client'); }
function _db() { return require('../../supabase'); }
function norm(s) { return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

var _cache = { at: 0, rows: null, tableMissing: false };

async function readRows(supabase) {
  if (!supabase) return { rows: [], missing: true };
  try {
    var res = await supabase.from('project_locations').select('*').limit(2000);
    if (res.error) throw res.error;
    return { rows: res.data || [], missing: false };
  } catch(e) {
    return { rows: [], missing: /project_locations/i.test(String(e.message || '')) || /relation|does not exist|schema cache/i.test(String(e.message || '')) };
  }
}

// Canali dalla channel map, derivati al volo (non persistiti finché non si
// lancia la ricostruzione): chan_<id> → il suo canale; gli altri per nome.
function channelRowsFromMap(projects, channelMap) {
  var channelsFor = require('../agents/projectDossier').channelsForProject;
  var out = [];
  (projects || []).forEach(function(p) {
    channelsFor(p, channelMap).forEach(function(ch) {
      var exact = /^chan_(C[A-Z0-9]+)$/.exec(p.id || '');
      out.push({ project_id: p.id, kind: 'slack_channel', ref: ch.channel_id, name: '#' + ch.channel_name, source: 'channel_map', confidence: exact && exact[1] === ch.channel_id ? 'alta' : 'media' });
    });
  });
  return out;
}

// Registro completo: righe persistite + canali derivati (deduplicati).
async function loadRegistry(opts) {
  opts = opts || {};
  var deps = opts.deps || {};
  if (!opts.force && _cache.rows && (Date.now() - _cache.at) < CACHE_MS && !deps.supabase && !deps.db) return _cache.rows;
  var supabase = deps.supabase !== undefined ? deps.supabase : _c().getClient();
  var db = deps.db || _db();
  var stored = await readRows(supabase);
  var projects = deps.projects || await db.searchProjects({ statuses: ['active', 'planning', 'on_hold'], limit: 400 });
  var channelMap = deps.channelMap || (db.getChannelMapCache ? db.getChannelMapCache() : {}) || {};
  var derived = channelRowsFromMap(projects, channelMap);
  var seen = {}, rows = [];
  stored.rows.concat(derived).forEach(function(r) {
    var k = r.project_id + '|' + r.kind + '|' + r.ref;
    if (seen[k]) return;
    seen[k] = true; rows.push(r);
  });
  var names = {};
  (projects || []).forEach(function(p) { names[p.id] = p.name; });
  rows.forEach(function(r) { r.project_name = names[r.project_id] || r.project_name || null; });
  if (!deps.supabase && !deps.db) _cache = { at: Date.now(), rows: rows, tableMissing: stored.missing };
  return rows;
}

function invalidate() { _cache = { at: 0, rows: null, tableMissing: false }; }

// Indice { kind: { ref: row } } con preferenza alle righe admin/alta.
function index(rows) {
  var idx = {};
  KINDS.forEach(function(k) { idx[k] = {}; });
  (rows || []).forEach(function(r) {
    if (!idx[r.kind]) return;
    var cur = idx[r.kind][r.ref];
    if (!cur || rank(r) > rank(cur)) idx[r.kind][r.ref] = r;
  });
  return idx;
}
function rank(r) { return (r.source === 'admin' ? 10 : 0) + (r.confidence === 'alta' ? 2 : 1); }

function lookup(idx, kind, ref) {
  var r = idx && idx[kind] && ref ? idx[kind][ref] : null;
  return r ? { id: r.project_id, name: r.project_name || null, confidence: r.confidence, source: r.source } : null;
}

// ── Ricostruzione ────────────────────────────────────────────────────────────
// deps: { supabase, db, dossiers, channelMap, drive (api con token admin), figmaProjects: [{id,name}], projects }
async function rebuild(opts) {
  opts = opts || {};
  var deps = opts.deps || {};
  var supabase = deps.supabase !== undefined ? deps.supabase : _c().getClient();
  var db = deps.db || _db();
  var dossiers = deps.dossiers || require('./db/dossiers');
  var projects = deps.projects || await db.searchProjects({ statuses: ['active', 'planning', 'on_hold'], limit: 400 });
  projects = (projects || []).filter(function(p) { return p && p.id && !/^cat_/.test(p.id) && !p.merged_into; });
  var channelMap = deps.channelMap || (db.getChannelMapCache ? db.getChannelMapCache() : {}) || {};
  var report = { projects: projects.length, channels: 0, folders: 0, figma: 0, written: 0, skipped_admin: 0, error: null, items: [] };
  var rows = channelRowsFromMap(projects, channelMap);
  report.channels = rows.length;

  // Cartelle Drive: la cartella che contiene il kick-off/brief di un progetto
  var drive = deps.drive !== undefined ? deps.drive : pickDrive(deps);
  if (drive) {
    var folderNames = {};
    for (var i = 0; i < projects.length; i++) {
      var docs = [];
      try { docs = await dossiers.getProjectDocuments(projects[i].id); } catch(_) {}
      var seenFolder = {};
      for (var d = 0; d < docs.length; d++) {
        var doc = docs[d];
        if (!doc.file_id || doc.doc_role === 'recap') continue;
        try {
          var meta = (await drive.files.get({ fileId: doc.file_id, fields: 'parents', supportsAllDrives: true })).data || {};
          var parent = (meta.parents || [])[0];
          if (!parent || seenFolder[parent]) continue;
          seenFolder[parent] = true;
          if (!folderNames[parent]) folderNames[parent] = ((await drive.files.get({ fileId: parent, fields: 'name', supportsAllDrives: true })).data || {}).name || parent;
          if (NOISE_FOLDER_RE.test(folderNames[parent])) continue;
          rows.push({ project_id: projects[i].id, kind: 'drive_folder', ref: parent, name: folderNames[parent], source: 'document', confidence: doc.doc_role === 'kickoff' ? 'alta' : 'media' });
          report.folders++;
        } catch(e) { logger.debug('[LOCATIONS] cartella di ' + doc.file_name + ':', e.message); }
      }
    }
  }

  // Progetti Figma: nome del progetto Figma ~ nome/cliente della commessa
  var figmaProjects = deps.figmaProjects !== undefined ? deps.figmaProjects : await listFigmaProjects(deps);
  (figmaProjects || []).forEach(function(fp) {
    var fn = norm(fp.name);
    if (!fn || fn.length < 4) return;
    projects.forEach(function(p) {
      var pn = norm(p.name), cn = norm(p.client_name);
      var hit = (pn && (pn === fn || fn.indexOf(pn) !== -1 || pn.indexOf(fn) !== -1)) || (cn && cn.length >= 4 && (cn === fn || fn.indexOf(cn) !== -1));
      if (!hit) return;
      rows.push({ project_id: p.id, kind: 'figma_project', ref: String(fp.id), name: fp.name, source: 'figma', confidence: pn === fn ? 'alta' : 'media' });
      report.figma++;
    });
  });

  var names = {};
  projects.forEach(function(p) { names[p.id] = p.name; });
  rows.forEach(function(r) { r.project_name = names[r.project_id] || null; });
  report.items = rows;
  if (!opts.apply) return report;
  if (!supabase) { report.error = 'Supabase non configurato'; return report; }
  var existing = await readRows(supabase);
  if (existing.missing) { report.error = 'tabella project_locations assente: applica la migrazione in supabase_migration.sql'; return report; }
  var admin = {};
  existing.rows.forEach(function(r) { if (r.source === 'admin') admin[r.project_id + '|' + r.kind + '|' + r.ref] = true; });
  for (var w = 0; w < rows.length; w++) {
    var r = rows[w];
    var key = r.project_id + '|' + r.kind + '|' + r.ref;
    if (admin[key]) { report.skipped_admin++; continue; }
    try {
      var up = await supabase.from('project_locations').upsert({ id: 'ploc_' + r.kind + '_' + r.ref + '_' + r.project_id, project_id: r.project_id, kind: r.kind, ref: r.ref, name: r.name || null, source: r.source, confidence: r.confidence, updated_at: new Date().toISOString() }, { onConflict: 'project_id,kind,ref' });
      if (up.error) throw up.error;
      report.written++;
    } catch(e) { logger.warn('[LOCATIONS] scrittura ' + key + ' fallita:', e.message); }
  }
  invalidate();
  logger.info('[LOCATIONS] ' + report.projects + ' progetti: ' + report.channels + ' canali, ' + report.folders + ' cartelle, ' + report.figma + ' progetti Figma, ' + report.written + ' righe scritte');
  return report;
}

function pickDrive(deps) {
  try {
    var gauth = deps.gauth || require('./googleAuthService');
    var tokens = gauth.getUserTokens ? (gauth.getUserTokens() || {}) : {};
    var roles = deps.roles || [];
    var lead = roles.filter(function(r) { return (r.role === 'admin' || r.role === 'manager') && tokens[r.slack_user_id]; }).map(function(r) { return r.slack_user_id; });
    var id = lead[0] || Object.keys(tokens)[0];
    return id ? gauth.getDrivePerUtente(id) : null;
  } catch(_) { return null; }
}

async function listFigmaProjects(deps) {
  var env = deps.env || process.env;
  if (!env.FIGMA_TOKEN || !env.FIGMA_TEAM_ID) return [];
  var doFetch = deps.fetch || global.fetch;
  try {
    var res = await doFetch('https://api.figma.com/v1/teams/' + encodeURIComponent(env.FIGMA_TEAM_ID) + '/projects', { headers: { 'X-Figma-Token': env.FIGMA_TOKEN } });
    if (!res.ok) throw new Error('Figma ' + res.status);
    return ((await res.json()).projects || []).map(function(p) { return { id: String(p.id), name: p.name }; });
  } catch(e) { logger.debug('[LOCATIONS] figma:', e.message); return []; }
}

// ── Impostazione manuale ─────────────────────────────────────────────────────
// link: "<#C123|nome>", "#nome" (risolto sulla channel map), URL cartella Drive,
// URL progetto Figma (figma.com/files/.../project/<id>/...), URL file Figma.
function parseLocation(link, channelMap) {
  var s = String(link || '').trim();
  var m;
  if ((m = /^<#([A-Z0-9]+)(?:\|([^>]*))?>$/.exec(s))) return { kind: 'slack_channel', ref: m[1], name: '#' + (m[2] || m[1]) };
  if ((m = /^#([a-z0-9._-]+)$/i.exec(s))) {
    var id = Object.keys(channelMap || {}).find(function(cid) { return (channelMap[cid].channel_name || '').toLowerCase() === m[1].toLowerCase(); });
    return id ? { kind: 'slack_channel', ref: id, name: '#' + m[1] } : null;
  }
  if ((m = /drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]+)/.exec(s))) return { kind: 'drive_folder', ref: m[1], name: 'cartella Drive ' + m[1].slice(0, 8) + '…' };
  if ((m = /figma\.com\/files\/(?:[^/]+\/)*project\/(\d+)/.exec(s))) return { kind: 'figma_project', ref: m[1], name: 'progetto Figma ' + m[1] };
  if ((m = /figma\.com\/(?:file|design|board)\/([A-Za-z0-9]+)/.exec(s))) return { kind: 'figma_file', ref: m[1], name: 'file Figma ' + m[1].slice(0, 8) + '…' };
  return null;
}

async function setManual(projectName, link, opts) {
  opts = opts || {};
  var deps = opts.deps || {};
  var supabase = deps.supabase !== undefined ? deps.supabase : _c().getClient();
  var db = deps.db || _db();
  var channelMap = deps.channelMap || (db.getChannelMapCache ? db.getChannelMapCache() : {}) || {};
  var loc = parseLocation(link, channelMap);
  if (!loc) return { error: 'Non riconosco la posizione: usa #canale, un link a una cartella Drive, a un progetto o a un file Figma.' };
  var project = await (deps.findProject || require('../agents/projectDossier').findProject)(projectName);
  if (!project) return { error: 'Progetto "' + projectName + '" non trovato.' };
  if (!supabase) return { error: 'Supabase non configurato.' };
  var up = await supabase.from('project_locations').upsert({ id: 'ploc_' + loc.kind + '_' + loc.ref + '_' + project.id, project_id: project.id, kind: loc.kind, ref: loc.ref, name: loc.name, source: 'admin', confidence: 'alta', updated_at: new Date().toISOString() }, { onConflict: 'project_id,kind,ref' });
  if (up.error) return { error: /project_locations/.test(up.error.message) || /relation|schema cache/.test(up.error.message) ? 'tabella project_locations assente: applica la migrazione in supabase_migration.sql' : up.error.message };
  invalidate();
  return { success: true, project: project.name, location: loc, message: project.name + ' ← ' + loc.name + ' (' + loc.kind.replace('_', ' ') + ').' };
}

function formatRows(rows, projectName) {
  var list = (rows || []).filter(function(r) { return !projectName || norm(r.project_name) === norm(projectName); });
  if (!list.length) return projectName ? 'Nessuna posizione registrata per ' + projectName + '.' : 'Registro vuoto: `/giuno admin progetti posizioni rebuild apply`.';
  var byProject = {};
  list.forEach(function(r) { (byProject[r.project_name || r.project_id] = byProject[r.project_name || r.project_id] || []).push(r); });
  var lines = ['*Posizioni di progetto* — ' + list.length + ' su ' + Object.keys(byProject).length + ' progetti'];
  Object.keys(byProject).sort().slice(0, 40).forEach(function(p) {
    lines.push('• *' + p + '*: ' + byProject[p].map(function(r) { return r.name + (r.source === 'admin' ? ' ✎' : r.confidence === 'media' ? ' ?' : ''); }).join(', '));
  });
  if (Object.keys(byProject).length > 40) lines.push('_… e altri ' + (Object.keys(byProject).length - 40) + ' progetti_');
  lines.push('_✎ impostato a mano · ? dedotto dal nome · `/giuno admin progetti posizione <nome> = <#canale|link>` per correggere_');
  return lines.join('\n');
}

function formatReport(r, applied) {
  if (r.error) return '⚠️ ' + r.error;
  return '*Posizioni ricostruite* su ' + r.projects + ' progetti: ' + r.channels + ' canali, ' + r.folders + ' cartelle Drive, ' + r.figma + ' progetti Figma' + (applied ? ' → ' + r.written + ' righe scritte' + (r.skipped_admin ? ', ' + r.skipped_admin + ' impostate a mano lasciate intatte' : '') : ' (anteprima)') + '\n' + formatRows(r.items);
}

module.exports = { KINDS: KINDS, loadRegistry: loadRegistry, invalidate: invalidate, index: index, lookup: lookup, rebuild: rebuild, channelRowsFromMap: channelRowsFromMap, parseLocation: parseLocation, setManual: setManual, formatRows: formatRows, formatReport: formatReport, listFigmaProjects: listFigmaProjects };
