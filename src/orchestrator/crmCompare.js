// ─── CRM Compare — Attio vs leads locali ─────────────────────────────────────
// Katania Studio ha due CRM: Attio (fonte di verità, aggiornato dal team) e la
// tabella `leads` su Supabase (importata da Sheet, scritta anche da autoLearn e
// dai tool update_lead/create_lead). Finché convivono, devono CONFRONTARSI:
// quando Giuno parla di un cliente vede entrambi, e se non coincidono lo dice.
//
// Il modulo è puro per la parte di confronto (testabile) e ha due entry point:
//   • compareForContext(attioContext) → blocco da iniettare nel prompt quando il
//     contesto CRM è già stato costruito (contextBuilder / askGiuno).
//   • compareAll(limit) → report completo on-demand (tool crm_compare,
//     "confronta i CRM", "il CRM interno è allineato?").

'use strict';

var logger = require('../utils/logger');
var { safeCall } = require('../utils/safeCall');

// Bucket comune a entrambi i CRM: open | won | lost | unknown
function bucketOfAttioStage(stage) {
  var s = String([].concat(stage || []).join(' ') || '').toLowerCase().trim();
  if (!s) return 'unknown';
  if (/lost|pers|rifiut|annull|declin/.test(s)) return 'lost';
  if (/won|vint|contratt|firmat|in progress|in corso|cliente|attiv/.test(s)) return 'won';
  return 'open';
}

function bucketOfLocalStatus(status) {
  var s = String(status || '').toLowerCase().trim();
  if (!s) return 'unknown';
  if (s === 'won') return 'won';
  if (s === 'lost') return 'lost';
  if (/^(new|contacted|proposal_sent|negotiating|dormant)$/.test(s)) return 'open';
  return 'unknown';
}

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\b(s\.?r\.?l\.?s?|s\.?p\.?a\.?|s\.?n\.?c\.?|srl|spa|snc|ltd|inc|gmbh|sas|ss)\b/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function namesMatch(a, b) {
  var na = normalizeName(a), nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Un nome contenuto nell'altro ("Aitho" ⊂ "Aitho Branding 2026") con almeno 4 char
  var shorter = na.length <= nb.length ? na : nb;
  var longer = na.length <= nb.length ? nb : na;
  return shorter.length >= 4 && longer.indexOf(shorter) !== -1;
}

function attioDealSummary(deal) {
  var v = (deal && deal.values) || {};
  var stage = v.stage || v.status_trattativa || null;
  var value = v.value != null ? Number([].concat(v.value)[0]) : null;
  return {
    name: v.name || '(senza nome)',
    stage: stage ? [].concat(stage).join('/') : null,
    bucket: bucketOfAttioStage(stage),
    value: isNaN(value) ? null : value,
    record_id: deal && deal.record_id,
  };
}

function localLeadSummary(lead) {
  var value = lead && lead.estimated_value != null ? Number(lead.estimated_value) : null;
  return {
    name: (lead && lead.company_name) || '(senza nome)',
    status: (lead && lead.status) || null,
    bucket: bucketOfLocalStatus(lead && lead.status),
    value: isNaN(value) ? null : value,
    last_contact: (lead && lead.last_contact) || null,
    is_active: lead ? lead.is_active : null,
    id: lead && lead.id,
  };
}

// Confronto puro: dati già raccolti da entrambe le parti. Ritorna
// { pairs: [{attio, local, discrepancies:[...]}], attioOnly: [...], localOnly: [...] }
function compareRecords(attioDeals, localLeads) {
  var deals = (attioDeals || []).map(attioDealSummary);
  var leads = (localLeads || []).map(localLeadSummary);
  var usedLead = {};
  var pairs = [];
  var attioOnly = [];

  deals.forEach(function(d) {
    var match = null;
    for (var i = 0; i < leads.length; i++) {
      if (usedLead[i]) continue;
      if (namesMatch(d.name, leads[i].name)) { match = i; break; }
    }
    if (match === null) { attioOnly.push(d); return; }
    usedLead[match] = true;
    var l = leads[match];
    var discrepancies = [];
    if (d.bucket !== 'unknown' && l.bucket !== 'unknown' && d.bucket !== l.bucket) {
      discrepancies.push('stato: Attio "' + (d.stage || d.bucket) + '" vs interno "' + (l.status || l.bucket) + '"');
    }
    if (d.value != null && l.value != null && Math.abs(d.value - l.value) > Math.max(1, d.value * 0.1)) {
      discrepancies.push('valore: Attio ' + d.value + ' vs interno ' + l.value);
    }
    if (d.bucket === 'won' && l.is_active === false) {
      discrepancies.push('Attio lo dà vinto ma il CRM interno lo segna non attivo');
    }
    pairs.push({ attio: d, local: l, discrepancies: discrepancies });
  });

  var localOnly = leads.filter(function(_, i) { return !usedLead[i]; });
  return { pairs: pairs, attioOnly: attioOnly, localOnly: localOnly };
}

function formatComparison(result, opts) {
  opts = opts || {};
  if (!result) return '';
  var lines = [];
  var mismatched = result.pairs.filter(function(p) { return p.discrepancies.length > 0; });
  var aligned = result.pairs.length - mismatched.length;

  mismatched.forEach(function(p) {
    lines.push('• ' + p.attio.name + ' — NON ALLINEATO: ' + p.discrepancies.join('; '));
  });
  if (opts.full) {
    result.pairs.filter(function(p) { return p.discrepancies.length === 0; }).forEach(function(p) {
      lines.push('• ' + p.attio.name + ' — allineato (' + (p.attio.stage || p.attio.bucket) + ')');
    });
    result.attioOnly.forEach(function(d) {
      lines.push('• ' + d.name + ' — solo in Attio (' + (d.stage || d.bucket) + ')');
    });
    result.localOnly.forEach(function(l) {
      lines.push('• ' + l.name + ' — solo nel CRM interno (' + (l.status || '?') + ')');
    });
  } else if (result.localOnly.length > 0 && opts.mentionLocalOnly) {
    lines.push('• Solo nel CRM interno, assenti in Attio: ' + result.localOnly.map(function(l) { return l.name; }).join(', '));
  }

  if (lines.length === 0 && aligned === 0) return '';
  var header = 'CONFRONTO CRM (Attio vs CRM interno' + (aligned > 0 ? ', ' + aligned + ' allineat' + (aligned === 1 ? 'o' : 'i') : '') + '):';
  var rule = mismatched.length > 0
    ? '\nRegola: fa fede Attio. Se rispondi su uno di questi, di\' in una riga che il CRM interno non è allineato e proponi di allinearlo con update_lead (fallo solo se l\'utente conferma).'
    : '';
  if (lines.length === 0) return header + ' nessuna discrepanza.';
  return header + '\n' + lines.join('\n') + rule;
}

// ─── Entry points con I/O ─────────────────────────────────────────────────────

// Per il contesto di un turno: dati Attio già raccolti → cerca i lead locali
// omonimi e confronta. Ritorna la stringa per il prompt ('' se nulla).
async function compareForContext(attioContext) {
  if (!attioContext) return '';
  var deals = attioContext.deals || [];
  var companies = attioContext.companies || [];
  if (deals.length === 0 && companies.length === 0) return '';

  var db = require('../../supabase');
  var names = [];
  deals.forEach(function(d) { var n = d.values && d.values.name; if (n) names.push(n); });
  companies.forEach(function(c) { var n = c.values && c.values.name; if (n) names.push(n); });

  var localLeads = [];
  var seen = {};
  for (var i = 0; i < names.length && i < 6; i++) {
    var term = normalizeName(names[i]).split(' ')[0];
    if (!term || term.length < 3) continue;
    var found = await safeCall('CRM-COMPARE.searchLeads', function() {
      return db.searchLeads({ company_name: term, limit: 5 });
    }, []);
    (found || []).forEach(function(l) { if (l && l.id && !seen[l.id]) { seen[l.id] = 1; localLeads.push(l); } });
  }
  if (localLeads.length === 0) return '';

  // Le aziende senza deal in contesto contano come "deal" con stage ignoto:
  // serve solo per agganciare i lead omonimi e mostrare cosa dice l'interno.
  var pseudoDeals = deals.slice();
  companies.forEach(function(c) {
    var n = c.values && c.values.name;
    if (!n) return;
    var already = deals.some(function(d) { return namesMatch(d.values && d.values.name, n); });
    if (!already) pseudoDeals.push({ record_id: c.record_id, values: { name: n } });
  });

  var result = compareRecords(pseudoDeals, localLeads);
  var block = formatComparison(result, { mentionLocalOnly: false });
  if (block) logger.info('[CRM-COMPARE] contesto:', result.pairs.length, 'coppie,',
    result.pairs.filter(function(p) { return p.discrepancies.length; }).length, 'discrepanze');
  return block;
}

// Report completo on-demand: tutti i lead locali attivi vs deal Attio recenti.
async function compareAll(limit) {
  var attio = require('../services/attioService');
  var db = require('../../supabase');
  if (!attio.isConfigured()) return { error: 'Attio non configurato: nessun confronto possibile.' };

  var deals = await safeCall('CRM-COMPARE.attioDeals', function() { return attio.queryRecords('deals', null, 50); }, []);
  var leads = await safeCall('CRM-COMPARE.localLeads', function() { return db.searchLeads({ limit: limit || 100 }); }, []);
  var result = compareRecords(deals || [], leads || []);
  return {
    summary: {
      attio_deals: (deals || []).length,
      local_leads: (leads || []).length,
      matched: result.pairs.length,
      mismatched: result.pairs.filter(function(p) { return p.discrepancies.length > 0; }).length,
      attio_only: result.attioOnly.length,
      local_only: result.localOnly.length,
    },
    report: formatComparison(result, { full: true }),
    mismatches: result.pairs.filter(function(p) { return p.discrepancies.length > 0; }).map(function(p) {
      return { name: p.attio.name, attio: p.attio, local: p.local, discrepancies: p.discrepancies };
    }),
  };
}

module.exports = {
  bucketOfAttioStage: bucketOfAttioStage,
  bucketOfLocalStatus: bucketOfLocalStatus,
  normalizeName: normalizeName,
  namesMatch: namesMatch,
  compareRecords: compareRecords,
  formatComparison: formatComparison,
  compareForContext: compareForContext,
  compareAll: compareAll,
};
