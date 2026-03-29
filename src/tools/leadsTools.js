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
  // Col A — NOME → contact_name
  'nome': 'contact_name', 'referente': 'contact_name', 'persona': 'contact_name',
  'nome referente': 'contact_name', 'nome contatto': 'contact_name',
  // Col B — AZIENDA → company_name
  'azienda': 'company_name', 'company': 'company_name', 'cliente': 'company_name',
  'nome azienda': 'company_name', 'company name': 'company_name', 'società': 'company_name',
  'brand': 'company_name', 'nome cliente': 'company_name',
  // Col C — PROGETTO → notes (project info)
  'progetto': 'notes', 'project': 'notes',
  // Col D — PROPOSTA → service_interest
  'proposta': 'service_interest', 'servizio': 'service_interest', 'servizi': 'service_interest',
  'interesse': 'service_interest', 'service': 'service_interest', 'categoria': 'service_interest',
  'tipo servizio': 'service_interest',
  // Col E — VALUE → estimated_value
  'valore': 'estimated_value', 'budget': 'estimated_value', 'importo': 'estimated_value',
  'valore stimato': 'estimated_value', 'value': 'estimated_value',
  // Col F — STATUS → status
  'stato': 'status', 'status': 'status', 'stage': 'status', 'fase': 'status',
  // Col G — LAST CONTACT → last_contact
  'ultimo contatto': 'last_contact', 'last contact': 'last_contact',
  'data ultimo contatto': 'last_contact',
  // Col H — Contatto → status (sales stage: primo incontro, proposta, trattativa, contratto)
  'contatto': 'status',
  // Col I — EMAIL → contact_email
  'email': 'contact_email', 'mail': 'contact_email', 'e-mail': 'contact_email',
  'email contatto': 'contact_email',
  // Col J — PHONE → phone
  'phone': 'phone', 'telefono': 'phone', 'tel': 'phone', 'cellulare': 'phone',
  // Col K — LEAD SOURCE → source
  'lead source': 'source', 'fonte': 'source', 'source': 'source',
  'provenienza': 'source', 'canale': 'source',
  // Col L — DATE → first_contact
  'date': 'first_contact', 'data': 'first_contact', 'primo contatto': 'first_contact',
  'first contact': 'first_contact', 'data contatto': 'first_contact',
  'initial contact': 'first_contact',
  // Col M — Owner → owner_slack_id
  'owner': 'owner_slack_id', 'responsabile': 'owner_slack_id', 'assegnato': 'owner_slack_id',
  'account': 'owner_slack_id',
  // Col N — sito web → website
  'sito web': 'website', 'website': 'website', 'url': 'website',
  // Col O — Note → notes
  'note': 'notes', 'notes': 'notes', 'commenti': 'notes', 'descrizione': 'notes',
  'dettagli': 'notes',
  // Other date fields
  'prossimo followup': 'next_followup', 'followup': 'next_followup', 'follow up': 'next_followup',
  'next followup': 'next_followup', 'follow-up': 'next_followup',
  // Roles
  'ruolo': 'contact_role', 'role': 'contact_role', 'posizione': 'contact_role',
  'qualifica': 'contact_role',
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
    // New / Cold
    'nuovo': 'new', 'new': 'new', 'da contattare': 'new',
    'cold': 'new',
    // Contacted / Warm
    'contattato': 'contacted', 'contacted': 'contacted', 'in contatto': 'contacted',
    'warm': 'contacted', 'hot': 'contacted',
    'meet': 'contacted', 'initial contact': 'contacted',
    'primo incontro': 'contacted', 'primo contatto': 'contacted',
    // Qualified / Follow-up
    'qualified': 'contacted', 'follow-up': 'contacted', 'follow up': 'contacted',
    // Contratto (from Contatto column)
    'contratto': 'won', 'contract': 'won',
    // Proposal sent
    'proposta': 'proposal_sent', 'proposta inviata': 'proposal_sent', 'proposal': 'proposal_sent',
    'sent': 'proposal_sent',
    // Negotiating
    'negoziazione': 'negotiating', 'negotiating': 'negotiating', 'negotiations': 'negotiating',
    'trattativa': 'negotiating', 'in trattativa': 'negotiating',
    // Won / Start Lavori
    'vinto': 'won', 'won': 'won', 'chiuso': 'won', 'acquisito': 'won',
    'start lavori': 'won',
    // Lost
    'perso': 'lost', 'lost': 'lost', 'rifiutato': 'lost',
    // Dormant
    'dormiente': 'dormant', 'dormant': 'dormant', 'inattivo': 'dormant',
    'stand by': 'dormant', 'standby': 'dormant',
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
      if (!lead[field] || lead[field] === 'new') {
        lead[field] = normalizeStatus(val);
      }
    } else if (field === 'first_contact' || field === 'last_contact' || field === 'next_followup') {
      lead[field] = parseDate(val);
    } else if (field === 'service_interest') {
      lead[field] = val.split(/[,;\/]+/).map(function(s) { return s.trim(); }).filter(Boolean);
    } else if (field === 'notes') {
      lead[field] = lead[field] ? lead[field] + ' | ' + val : val;
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

// ─── Tool definitions for registry ──────────────────────────────────────────

// Status normalization for CRM updates
var STATUS_NORM = {
  'won': 'won', 'vinto': 'won', 'chiuso': 'won', 'contratto firmato': 'won', 'hanno firmato': 'won',
  'lost': 'lost', 'perso': 'lost', 'rifiutato': 'lost', 'hanno rifiutato': 'lost',
  'hot': 'contacted', 'caldo': 'contacted', 'warm': 'contacted', 'tiepido': 'contacted',
  'contacted': 'contacted', 'contattato': 'contacted',
  'cold': 'dormant', 'freddo': 'dormant', 'dormant': 'dormant',
  'new': 'new', 'nuovo': 'new',
  'proposal_sent': 'proposal_sent', 'proposta inviata': 'proposal_sent', 'proposta': 'proposal_sent',
  'negotiating': 'negotiating', 'trattativa': 'negotiating', 'in trattativa': 'negotiating',
};

function normalizeStatusCRM(s) {
  if (!s) return null;
  return STATUS_NORM[s.toLowerCase().trim()] || null;
}

var definitions = [
  {
    name: 'query_leads_db',
    description: 'Interroga direttamente il database CRM (tabella leads su Supabase). Usa SEMPRE questo tool per domande su clienti, lead, pipeline, trattative, follow-up, status commerciale. NON usare search_kb per questi dati.',
    input_schema: {
      type: 'object',
      properties: {
        company_name: { type: 'string', description: 'Nome azienda (ricerca parziale, case-insensitive)' },
        contact_name: { type: 'string', description: 'Nome contatto' },
        status: { type: 'string', description: 'Filtra per status: new|contacted|proposal_sent|negotiating|won|lost|dormant' },
        owner_slack_id: { type: 'string', description: 'Filtra per owner (slack_user_id)' },
        limit: { type: 'integer', description: 'Max risultati (default 20)' },
      },
    },
  },
  {
    name: 'update_lead',
    description: 'Aggiorna un lead nel CRM. Usa questo tool ogni volta che bisogna modificare status, valore, servizi, note o fase di un lead. NON listare tutto il CRM — aggiorna solo il lead richiesto e conferma.',
    input_schema: {
      type: 'object',
      properties: {
        identifier: { type: 'string', description: 'Nome azienda o UUID del lead' },
        status: { type: 'string', description: 'Nuovo status (accetta: hot, warm, cold, won, lost, trattativa, proposta inviata)' },
        estimated_value: { type: 'number', description: 'Valore stimato in euro' },
        service_interest: { type: 'array', items: { type: 'string' }, description: 'Lista servizi (es. ["Branding", "Design"])' },
        notes: { type: 'string', description: 'Note aggiuntive (AGGIUNTE alle esistenti)' },
        next_followup: { type: 'string', description: 'Data prossimo follow-up YYYY-MM-DD' },
        owner_slack_id: { type: 'string', description: 'Slack ID responsabile' },
      },
      required: ['identifier'],
    },
  },
  {
    name: 'create_lead',
    description: 'Crea un nuovo lead nel CRM. Controlla sempre con search_leads prima per evitare duplicati.',
    input_schema: {
      type: 'object',
      properties: {
        company_name: { type: 'string', description: 'Nome azienda (obbligatorio)' },
        contact_name: { type: 'string', description: 'Nome referente' },
        status: { type: 'string', description: 'Status iniziale (default: new)' },
        estimated_value: { type: 'number', description: 'Valore stimato €' },
        service_interest: { type: 'array', items: { type: 'string' } },
        source: { type: 'string', description: 'Fonte: referral|inbound|outbound' },
        notes: { type: 'string' },
        contact_email: { type: 'string' },
        phone: { type: 'string' },
        owner_slack_id: { type: 'string' },
      },
      required: ['company_name'],
    },
  },
  {
    name: 'search_leads',
    description: 'Cerca lead nel CRM. Dati freschi da Supabase. ' +
      'IMPORTANTE: per "aggiornami sul CRM" usa is_active: true. ' +
      'Questo filtra automaticamente i contratti chiusi/vecchi. ' +
      'Solo se l\'utente chiede "tutti i clienti" o "storico" ometti is_active.',
    input_schema: {
      type: 'object',
      properties: {
        company_name: { type: 'string', description: 'Nome azienda (ricerca parziale)' },
        contact_name: { type: 'string', description: 'Nome contatto (ricerca parziale)' },
        status: { type: 'string', description: 'Filtra per status: new|contacted|proposal_sent|negotiating|won|lost|dormant' },
        owner_slack_id: { type: 'string' },
        updated_after: { type: 'string', description: 'Solo lead aggiornati dopo questa data ISO.' },
        created_after: { type: 'string', description: 'Solo lead creati dopo questa data ISO.' },
        active_after: { type: 'string', description: 'Solo lead con last_contact O first_contact dopo questa data.' },
        is_active: { type: 'boolean', description: 'true = solo lead attivi (default per CRM update). false = solo chiusi/storici. Ometti per tutti.' },
        limit: { type: 'number', description: 'Max risultati (default 20)' },
      },
    },
  },
  {
    name: 'delete_lead',
    description: 'Elimina un lead dal CRM. Solo admin. ' +
      'Senza confirm=true, mostra solo i match trovati e chiede conferma. ' +
      'Con confirm=true, elimina effettivamente.',
    input_schema: {
      type: 'object',
      properties: {
        identifier: { type: 'string', description: 'Nome azienda o UUID del lead da eliminare' },
        confirm: { type: 'boolean', description: 'Se true, elimina davvero. Se false (default), mostra solo i match.' },
      },
      required: ['identifier'],
    },
  },
];

async function execute(toolName, input, userId, userRole) {
  if (toolName === 'query_leads_db' || toolName === 'search_leads') {
    try {
      var leads = await db.searchLeads(input);
      return { leads: leads, count: leads.length };
    } catch(e) {
      return { error: 'Errore ricerca: ' + e.message };
    }
  }

  if (toolName === 'update_lead') {
    if (!input.identifier) return { error: 'Specifica il nome azienda o ID del lead.' };
    var updates = {};
    if (input.status) updates.status = normalizeStatusCRM(input.status) || input.status;
    if (input.estimated_value !== undefined) updates.estimated_value = input.estimated_value;
    if (input.service_interest) updates.service_interest = input.service_interest;
    if (input.next_followup) updates.next_followup = input.next_followup;
    if (input.owner_slack_id) updates.owner_slack_id = input.owner_slack_id;
    if (input.notes) {
      try {
        var existing = await db.searchLeads({ company_name: input.identifier, limit: 1 });
        var currentNotes = (existing[0] && existing[0].notes) || '';
        updates.notes = currentNotes ? currentNotes + ' | ' + input.notes : input.notes;
      } catch(e) { updates.notes = input.notes; }
    }
    if (Object.keys(updates).length === 0) return { error: 'Nessun campo da aggiornare.' };
    try {
      var result = await db.updateLead(input.identifier, updates);
      if (!result || (Array.isArray(result) && result.length === 0)) {
        return { error: 'Lead "' + input.identifier + '" non trovato nel CRM.' };
      }
      var updated = Array.isArray(result) ? result[0] : result;
      return { success: true, message: 'Lead aggiornato.', lead: { id: updated.id, company_name: updated.company_name, status: updated.status, service_interest: updated.service_interest, estimated_value: updated.estimated_value } };
    } catch(e) {
      return { error: 'Errore aggiornamento: ' + e.message };
    }
  }

  if (toolName === 'create_lead') {
    if (!input.company_name) return { error: 'company_name obbligatorio.' };
    try {
      var dup = await db.searchLeads({ company_name: input.company_name, limit: 1 });
      if (dup.length > 0) return { already_exists: true, message: 'Lead già presente.', lead: dup[0], suggestion: 'Usa update_lead per modificarlo.' };
    } catch(e) {
      logger.warn('[LEADS-TOOLS] operazione fallita:', e.message);
    }
    var newLead = {
      company_name: input.company_name,
      contact_name: input.contact_name || null,
      status: normalizeStatusCRM(input.status) || 'new',
      estimated_value: input.estimated_value || null,
      service_interest: input.service_interest || null,
      source: input.source || 'manual',
      notes: input.notes || null,
      contact_email: input.contact_email || null,
      phone: input.phone || null,
      owner_slack_id: input.owner_slack_id || null,
      first_contact: new Date().toISOString().slice(0, 10),
    };
    try {
      var created = await db.insertLead(newLead);
      return { success: true, message: 'Lead creato.', lead: created };
    } catch(e) { return { error: 'Errore creazione: ' + e.message }; }
  }

  if (toolName === 'delete_lead') {
    if (userRole !== 'admin') return { error: 'Solo admin possono eliminare lead.' };
    if (!input.identifier) return { error: 'Specifica il nome azienda o ID.' };

    // Step 1: Find matches
    var matches = await db.searchLeads({ company_name: input.identifier, limit: 5 });
    if (matches.length === 0) return { error: 'Nessun lead trovato per: ' + input.identifier };

    // Step 2: If no confirm, just show matches
    if (!input.confirm) {
      return {
        action: 'confirm_required',
        message: 'Trovati ' + matches.length + ' lead. Conferma per eliminare.',
        matches: matches.map(function(l) {
          return { id: l.id, company_name: l.company_name, contact_name: l.contact_name, status: l.status };
        }),
      };
    }

    // Step 3: Actually delete
    try {
      var deleted = await db.deleteLead(input.identifier);
      return { success: true, message: 'Lead eliminato.', deleted_count: (deleted || []).length };
    } catch(e) { return { error: 'Errore eliminazione: ' + e.message }; }
  }

  return { error: 'Tool sconosciuto in leadsTools: ' + toolName };
}

module.exports = {
  definitions: definitions,
  execute: execute,
  readCRMSheet: readCRMSheet,
  mapRowToLead: mapRowToLead,
  importLeadsToSupabase: importLeadsToSupabase,
  importCRMSheet: importCRMSheet,
  getLeadsPipeline: getLeadsPipeline,
  buildHeaderMapping: buildHeaderMapping,
  CRM_SHEET_ID: CRM_SHEET_ID,
  CORRADO_SLACK_ID: CORRADO_SLACK_ID,
};
