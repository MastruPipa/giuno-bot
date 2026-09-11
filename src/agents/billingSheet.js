// ─── Foglio "Contabilità e Bilancio <anno>": chi fatturiamo, mese per mese ──
// Il foglio di Antonio ha una tabella per mese con: cliente, descrizione del
// servizio, importo una tantum, mensilità, fattura inviata (TRUE/FALSE),
// incassato (TRUE/FALSE). Una riga in un mese dice che quel cliente è sotto
// contratto in quel mese: è la fonte più affidabile per capire quali
// commesse sono davvero in corso, più di Attio (un deal "won" resta won
// anche a lavoro finito) e dei canali Slack.
//
// Lettura: Sheets API con il token Google di un admin (come lo scanner dei
// fogli). Il foglio si trova per id (BILANCIO_SHEET_ID) o per titolo
// ("Contabilità e Bilancio " + anno a due cifre) cercando su Drive. Le schede
// mensili si riconoscono dal nome (gennaio…dicembre) e, se il nome non aiuta,
// dall'ordine in cui compaiono le tabelle con l'intestazione "Cl | … |
// Mensilità". Tutto in sola lettura, nessuna scrittura sul foglio.

'use strict';

var logger = require('../utils/logger');
var { withTimeout } = require('../utils/timeout');

var MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
var TIMEOUT_MS = 10000;
var CACHE_MS = 6 * 3600000;

function norm(s) { return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function pad(n) { return String(n).padStart(2, '0'); }

// "€ 2.105,00" → 2105; "10000" → 10000; vuoto → 0
function euro(cell) {
  var s = String(cell == null ? '' : cell).replace(/[€\s]/g, '');
  if (!s) return 0;
  var neg = /^-/.test(s) || /^\\-/.test(s);
  s = s.replace(/^\\?-/, '');
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  var n = parseFloat(s);
  return isFinite(n) ? (neg ? -n : n) : 0;
}
function bool(cell) { return /^(true|vero|sì|si|x|ok|1)$/i.test(String(cell == null ? '' : cell).trim()); }

function monthFromTitle(title) {
  var t = norm(title);
  for (var i = 0; i < MONTHS.length; i++) if (t.indexOf(MONTHS[i]) !== -1 || t === MONTHS[i].slice(0, 3)) return i + 1;
  return null;
}

// Intestazione: cerca la riga con "Cl" e "Mensilità"; le colonne si leggono
// per nome perché la descrizione a volte c'è e a volte no.
function findHeader(values) {
  for (var r = 0; r < Math.min(values.length, 30); r++) {
    var row = values[r] || [];
    var cols = {};
    row.forEach(function(c, i) {
      var n = norm(c);
      if (n === 'cl' && cols.client === undefined) cols.client = i;
      else if (/^1 ?tantum$/.test(n) && cols.oneOff === undefined) cols.oneOff = i;
      else if (/^mensilita/.test(n) && cols.monthly === undefined) cols.monthly = i;
      else if (/^fattura inviata/.test(n) && cols.invoiced === undefined) cols.invoiced = i;
      else if (n === 'incassato' && cols.paid === undefined) cols.paid = i;
    });
    if (cols.client !== undefined && cols.monthly !== undefined) {
      // La descrizione, se c'è, è la colonna vuota fra "Cl" e "1Tantum"
      cols.description = cols.oneOff !== undefined && cols.oneOff - cols.client >= 2 ? cols.client + 1 : null;
      return { row: r, cols: cols };
    }
  }
  return null;
}

// values (matrice della scheda) → righe [{ client, description, one_off, monthly, invoiced, paid }]
function parseTab(values) {
  var h = findHeader(values || []);
  if (!h) return [];
  var out = [];
  for (var r = h.row + 1; r < values.length; r++) {
    var row = values[r] || [];
    var client = String(row[h.cols.client] || '').trim();
    if (!client) continue;
    if (/^(totale|tot|cassa)/i.test(client)) continue;
    var oneOff = h.cols.oneOff !== undefined ? euro(row[h.cols.oneOff]) : 0;
    var monthly = euro(row[h.cols.monthly]);
    if (!(oneOff > 0) && !(monthly > 0)) continue;
    out.push({ client: client, description: h.cols.description !== null ? String(row[h.cols.description] || '').trim() : '', one_off: oneOff, monthly: monthly,
      invoiced: h.cols.invoiced !== undefined ? bool(row[h.cols.invoiced]) : false, paid: h.cols.paid !== undefined ? bool(row[h.cols.paid]) : false });
  }
  return out;
}

// tabs: [{ title, gid, values }] → righe con month 'YYYY-MM' e source_url.
// Il mese viene dal titolo della scheda; se nessun titolo è un mese, dall'ordine
// delle schede che hanno una tabella mensile (la prima è gennaio).
function rowsFromTabs(tabs, year, sheetId) {
  var out = [];
  // Conta come scheda mensile ogni scheda con l'intestazione, anche vuota:
  // un gennaio senza righe non deve far slittare febbraio.
  var withTable = (tabs || []).map(function(t) { return { tab: t, rows: parseTab(t.values), header: !!findHeader(t.values || []) }; }).filter(function(x) { return x.header; });
  var titled = withTable.filter(function(x) { return monthFromTitle(x.tab.title); });
  withTable.forEach(function(x, idx) {
    var m = monthFromTitle(x.tab.title) || (titled.length ? null : idx + 1);
    if (!m || m > 12) return;
    var month = year + '-' + pad(m);
    var url = 'https://docs.google.com/spreadsheets/d/' + sheetId + '/edit' + (x.tab.gid != null ? '#gid=' + x.tab.gid : '');
    x.rows.forEach(function(r) { out.push(Object.assign({}, r, { month: month, tab: x.tab.title, source_url: url })); });
  });
  return out;
}

// ─── Accesso a Google ────────────────────────────────────────────────────────
async function pickScanner(deps) {
  var gauth = deps.gauth || require('../services/googleAuthService');
  var tokens = gauth.getUserTokens ? (gauth.getUserTokens() || {}) : {};
  var roles = deps.roles;
  if (!roles) { try { roles = await require('../../rbac').getAllRoles(); } catch(_) { roles = []; } }
  // Solo admin e manager: il foglio contabile non si legge con il Google di
  // un membro qualsiasi. Senza un token elevato non si legge affatto.
  var lead = (roles || []).filter(function(r) { return (r.role === 'admin' || r.role === 'manager') && tokens[r.slack_user_id]; }).map(function(r) { return r.slack_user_id; });
  return lead[0] || null;
}

async function findSheetId(deps, year) {
  if (deps.sheetId) return deps.sheetId;
  if (process.env.BILANCIO_SHEET_ID) return process.env.BILANCIO_SHEET_ID;
  var gauth = deps.gauth || require('../services/googleAuthService');
  var uid = await pickScanner(deps);
  var drive = uid && gauth.getDrivePerUtente ? gauth.getDrivePerUtente(uid) : null;
  if (!drive) return null;
  var title = 'Contabilità e Bilancio ' + String(year).slice(2);
  var res = await withTimeout(function() { return drive.files.list({ q: "name contains '" + title.replace(/'/g, "\\'") + "' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false", fields: 'files(id,name)', pageSize: 5 }); }, TIMEOUT_MS, 'billing.find');
  var files = (res.data && res.data.files) || [];
  var exact = files.find(function(f) { return norm(f.name) === norm(title); }) || files[0];
  return exact ? exact.id : null;
}

var _cache = { at: 0, year: null, rows: null };

// Righe di fatturazione dell'anno (cache 6h). deps: { sheetId, sheets, gauth, roles, tabs }
async function readBillingRows(opts) {
  opts = opts || {};
  var deps = opts.deps || {};
  var year = opts.year || Number(new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' }).slice(0, 4));
  if (!opts.force && !deps.tabs && !deps.sheets && _cache.rows && _cache.year === year && (Date.now() - _cache.at) < CACHE_MS) return _cache.rows;
  try {
    var sheetId = await findSheetId(deps, year);
    var tabs = deps.tabs;
    if (!tabs) {
      if (!sheetId) { logger.debug('[BILLING] foglio non trovato per il ' + year); return []; }
      var gauth = deps.gauth || require('../services/googleAuthService');
      var sheets = deps.sheets || (function() { var uid = null; return pickScanner(deps).then(function(u) { uid = u; return uid && gauth.getSheetPerUtente ? gauth.getSheetPerUtente(uid) : null; }); })();
      sheets = await sheets;
      if (!sheets) { logger.debug('[BILLING] nessun token Google per leggere il foglio'); return []; }
      var meta = await withTimeout(function() { return sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: 'sheets.properties' }); }, TIMEOUT_MS, 'billing.meta');
      var props = ((meta.data && meta.data.sheets) || []).map(function(s) { return s.properties || {}; });
      tabs = [];
      for (var i = 0; i < props.length && i < 20; i++) {
        var p = props[i];
        try {
          var v = await withTimeout(function() { return sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "'" + String(p.title || '').replace(/'/g, "''") + "'!A1:Z400" }); }, TIMEOUT_MS, 'billing.tab');
          tabs.push({ title: p.title, gid: p.sheetId, values: (v.data && v.data.values) || [] });
        } catch(e) { logger.debug('[BILLING] scheda ' + p.title + ' non letta:', e.message); }
      }
    }
    var rows = rowsFromTabs(tabs, year, sheetId || 'sheet');
    if (!deps.tabs && !deps.sheets) _cache = { at: Date.now(), year: year, rows: rows };
    logger.info('[BILLING] ' + rows.length + ' righe di fatturazione lette dal foglio ' + year);
    return rows;
  } catch(e) { logger.warn('[BILLING] lettura foglio fallita:', e.message); return _cache.rows || []; }
}

// Le righe che riguardano una commessa: il cliente della riga combacia con il
// cliente o il nome della commessa. Se la descrizione nomina esplicitamente
// un'altra commessa dello stesso cliente, la riga va solo a quella.
function rowsForProject(rows, project, siblings) {
  var needles = [project.client_name, project.name].concat(Array.isArray(project.aliases) ? project.aliases : []).map(norm).filter(function(n) { return n && n.length >= 4; });
  if (!needles.length) return [];
  var others = (siblings || []).filter(function(p) { return p.id !== project.id && norm(p.client_name) && norm(p.client_name) === norm(project.client_name); });
  return (rows || []).filter(function(r) {
    var c = norm(r.client);
    if (!c || c.length < 4) return false;
    var hit = needles.some(function(n) { return c === n || c.indexOf(n) !== -1 || n.indexOf(c) !== -1; });
    if (!hit) return false;
    var d = ' ' + norm(r.description) + ' ';
    if (d.trim() && others.length) {
      var mine = d.indexOf(' ' + norm(project.name) + ' ') !== -1;
      var theirs = others.some(function(p) { var pn = norm(p.name); return pn.length >= 4 && d.indexOf(' ' + pn + ' ') !== -1; });
      if (theirs && !mine) return false;
    }
    return true;
  });
}

function monthEnd(month) { var y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7)); return y + '-' + pad(m) + '-' + pad(new Date(Date.UTC(y, m, 0)).getUTCDate()); }

module.exports = { MONTHS: MONTHS, euro: euro, bool: bool, monthFromTitle: monthFromTitle, findHeader: findHeader, parseTab: parseTab, rowsFromTabs: rowsFromTabs, readBillingRows: readBillingRows, rowsForProject: rowsForProject, monthEnd: monthEnd, findSheetId: findSheetId };
