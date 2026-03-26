// ─── Leads Tools ──────────────────────────────────────────────────────────────
// CRM lead management: import from Google Sheet, query leads pipeline.

'use strict';

var logger = require('../utils/logger');
var { getSheetPerUtente } = require('../services/googleAuthService');
var { withTimeout } = require('../utils/timeout');
var db = require('../../supabase');

var CRM_SHEET_ID = '1xx2GC5AHJLNCUgZZAaMEFDK8mdalEcgFzJFXpdY9db0';
var CORRADO_SLACK_ID = 'U053D9B7WNL';

// ─── Column mapping: Sheet header → leads table field ────────────────────────

var COLUMN_MAP = {
  // Company
  'azienda': 'company_name', 'company': 'company_name', 'cliente': 'company_name',
  'nome azienda': 'company_name', 'company name': 'company_name', 'società': 'company_name',
  'brand': 'company_name', 'nome cliente': 'company_name',
  // Contact name
  'contatto': 'contact_name', 'referente': 'contact_name', 'nome': 'contact_name',
  'contact': 'contact_name', 'nome referente': 'contact_name', 'persona': 'contact_name',
  'nome contatto': 'contact_name',
  // Contact email
  'email': 'contact_email', 'mail': 'contact_email', 'e-mail': 'contact_email',
  'email contatto': 'contact_email',
  // Contact role
  'ruolo': 'contact_role', 'role': 'contact_role', 'posizione': 'contact_role',
  'titolo': 'contact_role', 'qualifica': 'contact_role',
  // Source
  'fonte': 'source', 'source': 'source', 'provenienza': 'source', 'canale': 'source',
  // Service interest
  'servizio': 'service_interest', 'servizi': 'service_interest', 'interesse': 'service_interest',
  'service': 'service_interest', 'categoria': 'service_interest', 'tipo servizio': 'service_interest',
  // Estimated value
  'valore': 'estimated_value', 'budget': 'estimated_value', 'importo': 'estimated_value',
  'valore stimato': 'estimated_value', 'value': 'estimated_value',
  // Status
  'stato': 'status', 'status': 'status', 'fase': 'status', 'stage': 'status',
  // Owner
  'owner': 'owner_slack_id', 'responsabile': 'owner_slack_id', 'assegnato': 'owner_slack_id',
  'account': 'owner_slack_id',
  // Dates
  'primo contatto': 'first_contact', 'first contact': 'first_contact', 'data contatto': 'first_contact',
  'data primo contatto': 'first_contact',
  'ultimo contatto': 'last_contact', 'last contact': 'last_contact', 'data ultimo contatto': 'last_contact',
  'prossimo followup': 'next_followup', 'followup': 'next_followup', 'follow up': 'next_followup',
  'next followup': 'next_followup', 'data followup': 'next_followup',
  // Notes
  'note': 'notes', 'notes': 'notes', 'commenti': 'notes', 'descrizione': 'notes',
  'dettagli': 'notes',
};

// ─── Read CRM Sheet ──────────────────────────────────────────────────────────

async function readCRMSheet(slackUserId, sheetId) {
  var sheets = getSheetPerUtente(slackUserId || CORRADO_SLACK_ID);
  if (!sheets) throw new Error('Google Sheets non collegato per ' + (slackUserId || CORRADO_SLACK_ID));

  var meta = await withTimeout(sheets.spreadsheets.get({
    spreadsheetId: sheetId || CRM_SHEET_ID,
    fields: 'sheets.properties',
  }), 10000, 'crm_meta');

  var sheetNames = meta.data.sheets.map(function(s) { return s.properties.title; });
  var targetSheet = sheetNames[0];

  var res = await withTimeout(sheets.spreadsheets.values.get({
    spreadsheetId: sheetId || CRM_SHEET_ID,
    range: "'" + targetSheet.replace(/'/g, "''") + "'!A1:Z500",
  }), 15000, 'crm_read');

  var rows = res.data.values || [];
  if (rows.length < 2) return { headers: [], rows: [], sheetName: targetSheet };

  return {
    headers: rows[0],
    rows: rows.slice(1),
    sheetName: targetSheet,
    totalRows: rows.length - 1,
  };
}

// ─── Map row → lead object ───────────────────────────────────────────────────

function buildHeaderMapping(headers) {
  var mapping = {};
  for (var i = 0; i < headers.length; i++) {
    var headerLow = (headers[i] || '').toLowerCase().trim();
    if (COLUMN_MAP[headerLow]) {
      mapping[i] = COLUMN_MAP[headerLow];
    }
  }
  return mapping;
}

function parseDate(val) {
  if (!val) return null;
  // Try DD/MM/YYYY
  var dmy = val.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (dmy) return dmy[3] + '-' + dmy[2].padStart(2, '0') + '-' + dmy[1].padStart(2, '0');
  // Try YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
  // Try Date parse
  var d = new Date(val);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function parseValue(val) {
  if (!val) return null;
  var cleaned = val.replace(/[€$,.\s]/g, '').replace(',', '.');
  var num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function normalizeStatus(val) {
  if (!val) return 'new';
  var low = val.toLowerCase().trim();
  var statusMap = {
    'nuovo': 'new', 'new': 'new', 'da contattare': 'new',
    'contattato': 'contacted', 'contacted': 'contacted', 'in contatto': 'contacted',
    'proposta': 'proposal_sent', 'proposta inviata': 'proposal_sent', 'proposal': 'proposal_sent', 'sent': 'proposal_sent',
    'negoziazione': 'negotiating', 'negotiating': 'negotiating', 'trattativa': 'negotiating', 'in trattativa': 'negotiating',
    'vinto': 'won', 'won': 'won', 'chiuso': 'won', 'acquisito': 'won',
    'perso': 'lost', 'lost': 'lost', 'rifiutato': 'lost',
    'dormiente': 'dormant', 'dormant': 'dormant', 'inattivo': 'dormant', 'stand by': 'dormant', 'standby': 'dormant',
  };
  return statusMap[low] || 'new';
}

function mapRowToLead(row, headerMapping) {
  var lead = { source: 'sheet_import' };

  for (var colIdx in headerMapping) {
    var field = headerMapping[colIdx];
    var val = row[colIdx];
    if (!val || !val.trim()) continue;
    val = val.trim();

    if (field === 'estimated_value') {
      lead[field] = parseValue(val);
    } else if (field === 'status') {
      lead[field] = normalizeStatus(val);
    } else if (field === 'first_contact' || field === 'last_contact' || field === 'next_followup') {
      lead[field] = parseDate(val);
    } else if (field === 'service_interest') {
      lead[field] = val.split(/[,;\/]+/).map(function(s) { return s.trim(); }).filter(Boolean);
    } else {
      lead[field] = val;
    }
  }

  return lead;
}

// ─── Import leads to Supabase ────────────────────────────────────────────────

async function importLeadsToSupabase(leads) {
  var imported = 0;
  var skipped = 0;
  var errors = 0;

  for (var i = 0; i < leads.length; i++) {
    var lead = leads[i];
    if (!lead.company_name) { skipped++; continue; }

    try {
      // Check duplicate: same company_name + contact_email (or just company_name)
      var isDuplicate = await db.leadExists(lead.company_name, lead.contact_email);
      if (isDuplicate) { skipped++; continue; }

      await db.insertLead(lead);
      imported++;
    } catch(e) {
      errors++;
      logger.error('[LEADS] Import error for', lead.company_name + ':', e.message);
    }
  }

  return { imported: imported, skipped: skipped, errors: errors };
}

// ─── Main import function ────────────────────────────────────────────────────

async function importCRMSheet(slackUserId, sheetId) {
  var data = await readCRMSheet(slackUserId, sheetId);
  if (data.rows.length === 0) return { error: 'Foglio vuoto o senza dati.' };

  var headerMapping = buildHeaderMapping(data.headers);
  var mappedFields = {};
  for (var idx in headerMapping) {
    mappedFields[data.headers[idx]] = headerMapping[idx];
  }

  var leads = [];
  for (var i = 0; i < data.rows.length; i++) {
    var lead = mapRowToLead(data.rows[i], headerMapping);
    if (lead.company_name) leads.push(lead);
  }

  return {
    sheetName: data.sheetName,
    totalRows: data.totalRows,
    mapping: mappedFields,
    leads: leads,
    preview: leads.slice(0, 3).map(function(l) { return l.company_name; }),
  };
}

// ─── Get leads pipeline summary ──────────────────────────────────────────────

async function getLeadsPipeline() {
  return db.getLeadsPipeline();
}

module.exports = {
  readCRMSheet: readCRMSheet,
  mapRowToLead: mapRowToLead,
  importLeadsToSupabase: importLeadsToSupabase,
  importCRMSheet: importCRMSheet,
  getLeadsPipeline: getLeadsPipeline,
  buildHeaderMapping: buildHeaderMapping,
  CRM_SHEET_ID: CRM_SHEET_ID,
  CORRADO_SLACK_ID: CORRADO_SLACK_ID,
};
