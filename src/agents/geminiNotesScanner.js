// ─── Gemini Notes Scanner (Drive) ────────────────────────────────────────────
// Google Meet salva gli appunti di Gemini come Google Doc su Drive
// ("<Titolo> - 2026/09/08 10:03 CEST - Appunti di Gemini"). Il vecchio
// scanner li cercava su Gmail e negli allegati calendario, e ne prendeva una
// frazione. Qui si legge Drive direttamente: kick-off e recap vengono
// estratti in forma strutturata (decisioni, azioni, scadenze, rischi),
// salvati in KB, collegati al progetto e il dossier viene segnato da
// aggiornare. Le informazioni personali non legate al lavoro si scartano.

'use strict';

var logger = require('../utils/logger');
var { MODELS } = require('../config/models');
var { safeParse } = require('../utils/safeCall');

var NOTE_TITLE_RE = /appunti di gemini|note della riunione|notes by gemini|meeting notes|gemini notes/i;
var KICKOFF_RE = /kick[\s_-]?off/i;
var MAX_DOC_CHARS = 14000;
var KB_MAX_CHARS = 1800;

function classifyTitle(title) {
  var t = String(title || '');
  if (KICKOFF_RE.test(t)) return 'kickoff';
  if (NOTE_TITLE_RE.test(t)) return 'recap';
  return null;
}

// Data della riunione dal titolo Gemini ("… - 2026/09/08 10:03 CEST - …").
function dateFromTitle(title) {
  var m = /(\d{4})\/(\d{2})\/(\d{2})/.exec(String(title || ''));
  return m ? (m[1] + '-' + m[2] + '-' + m[3]) : null;
}

// Titolo "pulito" della riunione senza data e suffisso Gemini.
function cleanTitle(title) {
  return String(title || '')
    .replace(/\s*-\s*\d{4}\/\d{2}\/\d{2}[^-]*-\s*appunti di gemini.*$/i, '')
    .replace(/\s*-\s*appunti di gemini.*$/i, '')
    .replace(/\s*\((italiano|inglese|english|italian)\)\s*$/i, '')
    .trim();
}

function buildDriveQuery(sinceIso) {
  return "(name contains 'Appunti di Gemini' or name contains 'Note della riunione' or name contains 'Meeting notes' or name contains 'Kick' or name contains 'KICK') " +
    "and mimeType = 'application/vnd.google-apps.document' and modifiedTime > '" + sinceIso + "' and trashed = false";
}

function alreadyIngested(fileId, kbCache, existingDoc) {
  if (existingDoc) return true;
  var tag = 'drive_file_id:' + fileId;
  return (kbCache || []).some(function(e) { return Array.isArray(e.tags) && e.tags.indexOf(tag) !== -1; });
}

function parseExtraction(text) {
  var m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  var obj = safeParse('dossier-json', m[0], null);
  if (!obj || typeof obj !== 'object') return null;
  ['partecipanti', 'decisioni', 'azioni', 'scadenze', 'rischi', 'progetto_candidati'].forEach(function(k) {
    if (!Array.isArray(obj[k])) obj[k] = [];
  });
  return obj;
}

var EXTRACTION_SYSTEM =
  'Sei l\'assistente interno di Katania Studio (agenzia di comunicazione). Ricevi gli appunti di una riunione (o un documento di kick-off) e ne estrai SOLO ciò che serve al lavoro.\n' +
  'Rispondi con un unico JSON valido:\n' +
  '{"tipo":"kickoff|recap|skip","titolo":"...","data":"YYYY-MM-DD|null","cliente":"nome cliente o null",' +
  '"progetto_candidati":["nomi di progetto/cliente citati, i più probabili prima"],' +
  '"partecipanti":["nome (ruolo/azienda)"],' +
  '"sintesi":"5-10 righe: di cosa si è parlato e cosa è stato deciso, con numeri e date se ci sono",' +
  '"decisioni":["..."],"azioni":[{"chi":"...","cosa":"...","entro":"YYYY-MM-DD|null"}],' +
  '"scadenze":[{"cosa":"...","quando":"YYYY-MM-DD o descrizione","chi":"..."}],"rischi":["..."],' +
  '"obiettivi":["solo per kick-off: obiettivi/KPI"],"deliverable":["solo per kick-off"],"referenti_cliente":["solo per kick-off: nome (ruolo)"],"budget":"solo per kick-off, se scritto"}\n' +
  'Regole: tipo "skip" se non è una riunione di lavoro o non contiene nulla di utile. Niente informazioni personali, di salute, private o battute: se un passaggio non riguarda il lavoro, non riportarlo. ' +
  'Non inventare: se un campo non c\'è, lascialo vuoto o null. Scrivi in italiano.';

async function extractNotes(client, params) {
  var kind = params.kind || 'recap';
  var projectsHint = (params.projectNames || []).slice(0, 60).join(', ');
  var res = await client.messages.create({
    model: params.model || MODELS.UTILITY,
    max_tokens: 1500,
    system: EXTRACTION_SYSTEM,
    messages: [{ role: 'user', content:
      'Tipo atteso: ' + kind + '\nTitolo documento: ' + params.title + '\n' +
      (projectsHint ? 'Progetti/clienti attivi noti (usa questi nomi se corrispondono): ' + projectsHint + '\n' : '') +
      '\n--- DOCUMENTO ---\n' + String(params.text || '').substring(0, MAX_DOC_CHARS) }],
  });
  var text = (res.content || []).filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('\n');
  return parseExtraction(text);
}

function formatKbEntry(kind, meta, ex) {
  var head = (kind === 'kickoff' ? '[KICK-OFF] ' : '[RECAP MEETING] ') + (ex.titolo || meta.cleanTitle) + (ex.data || meta.date ? ' (' + (ex.data || meta.date) + ')' : '');
  var lines = [head];
  if (ex.cliente) lines.push('Cliente: ' + ex.cliente);
  if (ex.partecipanti.length) lines.push('Partecipanti: ' + ex.partecipanti.slice(0, 10).join(', '));
  if (ex.sintesi) lines.push(ex.sintesi);
  if (ex.obiettivi && ex.obiettivi.length) lines.push('Obiettivi: ' + ex.obiettivi.join('; '));
  if (ex.deliverable && ex.deliverable.length) lines.push('Deliverable: ' + ex.deliverable.join('; '));
  if (ex.decisioni.length) lines.push('Decisioni: ' + ex.decisioni.join('; '));
  if (ex.azioni.length) lines.push('Azioni: ' + ex.azioni.map(function(a) { return (a.chi ? a.chi + ' → ' : '') + a.cosa + (a.entro ? ' (entro ' + a.entro + ')' : ''); }).join('; '));
  if (ex.scadenze.length) lines.push('Scadenze: ' + ex.scadenze.map(function(s) { return s.cosa + (s.quando ? ' — ' + s.quando : '') + (s.chi ? ' (' + s.chi + ')' : ''); }).join('; '));
  if (ex.rischi.length) lines.push('Rischi: ' + ex.rischi.join('; '));
  if (ex.budget) lines.push('Budget: ' + ex.budget);
  lines.push('Fonte: ' + meta.link);
  var out = lines.join('\n');
  return out.length > KB_MAX_CHARS ? out.substring(0, KB_MAX_CHARS - 1) + '…' : out;
}

function normName(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9àèéìòù]+/g, ' ').trim(); }

// Sceglie il progetto: prima i candidati dell'estrazione contro il catalogo,
// poi titolo + cliente. Ritorna { id, name } o null.
function matchProject(matcher, catalog, ex, title) {
  var texts = (ex.progetto_candidati || []).concat([title, ex.cliente || '']).filter(Boolean);
  for (var i = 0; i < texts.length; i++) {
    var hit = matcher.matchTaskAgainstCatalog(texts[i], catalog);
    if (hit) return { id: hit.id, name: hit.name };
  }
  return null;
}

function resolveAssignee(db, chi) {
  var name = String(chi || '').trim();
  if (!name || /^(il gruppo|tutti|team|gruppo)$/i.test(name)) return null;
  try {
    var m = (db.findTeamMemberByName && db.findTeamMemberByName(name)) ||
      (db.findTeamMemberByName && db.findTeamMemberByName(name.split(/[\s(,]/)[0])) || null;
    if (!m && db.findTeamMembersInText) { var found = db.findTeamMembersInText(name); m = found && found[0]; }
    return m ? m.slack_user_id : null;
  } catch(_) { return null; }
}

async function saveActions(dossiers, db, ex, meta) {
  if (!dossiers.addProjectAction) return 0;
  var n = 0;
  var list = (ex.azioni || []).filter(function(a) { return a && a.cosa; }).slice(0, 15);
  for (var i = 0; i < list.length; i++) {
    var a = list[i];
    var row = await dossiers.addProjectAction({
      project_id: meta.project ? meta.project.id : null, source_file_id: meta.fileId, source_title: meta.title, source_link: meta.link,
      meeting_date: meta.date || null, assignee_name: a.chi || null, assignee_slack_id: resolveAssignee(db, a.chi),
      description: String(a.cosa).substring(0, 400), due_date: a.entro && /^\d{4}-\d{2}-\d{2}$/.test(a.entro) ? a.entro : null,
    });
    if (row) n++;
  }
  return n;
}

function pickScanUsers(tokens, roles) {
  var ids = Object.keys(tokens || {});
  var admins = (roles || []).filter(function(r) { return r.role === 'admin'; }).map(function(r) { return r.slack_user_id; });
  return ids.sort(function(a, b) {
    var ia = admins.indexOf(a), ib = admins.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}

// deps (per i test): { drives: {userId: driveApi}, docs: {userId: docsApi}, client, db, dossiers, matcher, tokens, roles, now }
async function scanGeminiNotes(opts) {
  opts = opts || {};
  var deps = opts.deps || {};
  var db = deps.db || require('../../supabase');
  var dossiers = deps.dossiers || require('../services/db/dossiers');
  var matcher = deps.matcher || require('../services/projectMatcher');
  var gauth = deps.gauth || require('../services/googleAuthService');
  var client = deps.client || require('../services/anthropicService').client;
  var days = opts.days || 3;
  var now = deps.now ? deps.now() : Date.now();
  var sinceIso = new Date(now - days * 86400000).toISOString();

  var tokens = deps.tokens || gauth.getUserTokens() || {};
  var roles = deps.roles || [];
  if (!deps.roles) { try { roles = await require('../../rbac').getAllRoles(); } catch(_) { roles = []; } }
  var userIds = pickScanUsers(tokens, roles);
  var kbCache = (typeof db.getKBCache === 'function') ? db.getKBCache() : [];
  var catalog = await matcher.getCatalog();
  var projectNames = catalog.map(function(p) { return p.name; });

  var report = { scanned: 0, ingested: 0, skipped: 0, errors: 0, files: [] };
  var seen = {};

  for (var ui = 0; ui < userIds.length; ui++) {
    var userId = userIds[ui];
    var drive = deps.drives ? deps.drives[userId] : gauth.getDrivePerUtente(userId);
    var docsApi = deps.docs ? deps.docs[userId] : gauth.getDocsPerUtente(userId);
    if (!drive || !docsApi) continue;
    var files = [];
    try {
      var listRes = await drive.files.list({
        q: buildDriveQuery(sinceIso), pageSize: 50, orderBy: 'modifiedTime desc',
        fields: 'files(id,name,modifiedTime,webViewLink)', supportsAllDrives: true, includeItemsFromAllDrives: true,
      });
      files = (listRes.data && listRes.data.files) || [];
    } catch(e) {
      logger.warn('[GEMINI-NOTES] files.list fallita per', userId, ':', e.message);
      continue;
    }
    for (var fi = 0; fi < files.length; fi++) {
      var f = files[fi];
      if (seen[f.id]) continue;
      seen[f.id] = true;
      var kind = classifyTitle(f.name);
      if (!kind) continue;
      report.scanned++;
      var existingDoc = await dossiers.findProjectDocumentByFile(f.id);
      var ingested = alreadyIngested(f.id, kbCache, existingDoc);
      if (!ingested && typeof db.kbHasTag === 'function') { try { ingested = await db.kbHasTag('drive_file_id:' + f.id); } catch(_) {} }
      if (ingested) { report.skipped++; continue; }
      try {
        var docRes = await docsApi.documents.get({ documentId: f.id });
        var { extractDocText } = require('../tools/driveTools');
        var text = extractDocText(docRes.data.body.content);
        if (!text || text.length < 200) { report.skipped++; continue; }
        var meta = { fileId: f.id, title: f.name, cleanTitle: cleanTitle(f.name), date: dateFromTitle(f.name), link: f.webViewLink || ('https://docs.google.com/document/d/' + f.id), modified: f.modifiedTime };
        var ex = await extractNotes(client, { kind: kind, title: f.name, text: text, projectNames: projectNames, model: opts.model });
        if (!ex || ex.tipo === 'skip') { report.skipped++; continue; }
        if (ex.tipo === 'kickoff') kind = 'kickoff';
        var project = matchProject(matcher, catalog, ex, meta.cleanTitle);
        var tags = [kind === 'kickoff' ? 'tipo:kickoff' : 'tipo:meeting_recap', 'fonte:drive', 'drive_file_id:' + f.id];
        if (project) tags.push('progetto:' + normName(project.name));
        if (ex.cliente) tags.push('cliente:' + normName(ex.cliente));
        var content = formatKbEntry(kind, meta, ex);
        await db.addKBEntry(content, tags, userId, { confidenceTier: 'drive_indexed', sourceType: 'drive' });
        if (project) {
          await dossiers.addProjectDocument({
            project_id: project.id, file_id: f.id, file_name: f.name, file_type: 'gdoc', drive_link: meta.link,
            doc_role: kind, added_by: 'gemini-notes', notes: (ex.data || meta.date || '') + (ex.sintesi ? ' — ' + String(ex.sintesi).substring(0, 200) : ''),
          });
          await dossiers.markNeedsRefresh(project.id, f.modifiedTime);
        }
        // Azioni a carico di persone del team → project_actions (follow-up il
        // giorno dopo e promemoria a ridosso della scadenza).
        var savedActions = await saveActions(dossiers, db, ex, { project: project, fileId: f.id, title: meta.cleanTitle, date: ex.data || meta.date, link: meta.link });
        if (savedActions) report.actions = (report.actions || 0) + savedActions;
        report.ingested++;
        report.files.push({ id: f.id, title: meta.cleanTitle, kind: kind, project: project ? project.name : null });
        logger.info('[GEMINI-NOTES] ' + kind + ' "' + meta.cleanTitle + '" → ' + (project ? project.name : 'nessun progetto'));
      } catch(e) {
        report.errors++;
        logger.warn('[GEMINI-NOTES] errore su "' + f.name + '":', e.message);
      }
    }
  }
  logger.info('[GEMINI-NOTES] scan: ' + report.scanned + ' file, ' + report.ingested + ' ingeriti, ' + report.skipped + ' saltati, ' + report.errors + ' errori');
  return report;
}

function formatReport(r) {
  var lines = ['*Appunti Gemini (Drive):* ' + r.scanned + ' file trovati, ' + r.ingested + ' nuovi, ' + r.skipped + ' già noti/saltati' + (r.errors ? ', ' + r.errors + ' errori' : '') + (r.actions ? ', ' + r.actions + ' azioni registrate' : '')];
  (r.files || []).slice(0, 15).forEach(function(f) { lines.push('• ' + (f.kind === 'kickoff' ? '🚀 ' : '📝 ') + f.title + ' → ' + (f.project || '_senza progetto_')); });
  return lines.join('\n');
}

module.exports = {
  classifyTitle: classifyTitle,
  dateFromTitle: dateFromTitle,
  cleanTitle: cleanTitle,
  buildDriveQuery: buildDriveQuery,
  alreadyIngested: alreadyIngested,
  parseExtraction: parseExtraction,
  extractNotes: extractNotes,
  formatKbEntry: formatKbEntry,
  matchProject: matchProject,
  pickScanUsers: pickScanUsers,
  resolveAssignee: resolveAssignee,
  saveActions: saveActions,
  scanGeminiNotes: scanGeminiNotes,
  formatReport: formatReport,
};
