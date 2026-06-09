// ─── Attio CRM Context ─────────────────────────────────────────────────────────
// Shared helper that proactively grounds CRM questions in Attio (the real CRM)
// so Giuno answers from companies/deals instead of noisy memories. Used by both
// context paths: the orchestrator's contextBuilder (agent path) and
// anthropicService.askGiuno (GENERAL path), plus the CRM-flavoured agents.

'use strict';

var attio = require('../services/attioService');
var logger = require('../utils/logger');
var { safeCall } = require('../utils/safeCall');

// Any message that smells of CRM should trigger Attio grounding.
var CRM_KEYWORDS = /\b(client[ei]|aziend[ae]|deal|trattativ[ae]|pipeline|offert[ae]|preventiv[oi]|propost[ae]|lead|prospect|fattur|contratt[oi]|won|lost|vint[oiae]|pers[oiae]|crm|attio)\b/i;

// Generic pipeline/overview questions that carry no specific company name.
var OVERVIEW_KEYWORDS = /\b(pipeline|trattativ|deal|vint|won|pers|lost|apert|in corso|offert|preventiv|client|aziend|crm|fattur|propost)\b/i;

function isCrmIsh(message) {
  return CRM_KEYWORDS.test(message || '');
}

// Pull candidate CRM search terms out of the message: resolved entity names
// first, then capitalised tokens (likely company/person names). Bounded to 2.
var _TERM_STOP = { Giuno: 1, Antonio: 1, Ciao: 1, Ehi: 1, Hey: 1, Ok: 1, Grazie: 1, Quale: 1, Quali: 1, Come: 1, Cosa: 1, Chi: 1, Quanto: 1, Quando: 1, Dove: 1, Perche: 1, 'Perché': 1, Deal: 1, Crm: 1, Attio: 1 };
function extractCrmTerms(message, entities) {
  var terms = [];
  var seen = {};
  var push = function(t) {
    if (!t) return;
    t = String(t).trim();
    if (t.length < 3) return;
    var key = t.toLowerCase();
    if (seen[key] || _TERM_STOP[t]) return;
    seen[key] = 1; terms.push(t);
  };
  (entities || []).forEach(function(e) { if (e && e.name) push(e.name); });
  var caps = (message || '').match(/\b[A-ZÀ-Ý][\wÀ-ÿ.&'’-]{2,}\b/g) || [];
  caps.forEach(push);
  return terms.slice(0, 2);
}

// Best-effort: returns { companies, deals } or null when Attio isn't configured
// or nothing matches.
async function buildAttioContext(message, entities) {
  if (!attio.isConfigured()) return null;
  var terms = extractCrmTerms(message, entities);

  var companies = [];
  var deals = [];
  var seenCo = {}, seenDeal = {};
  for (var i = 0; i < terms.length; i++) {
    var filter = { name: { '$contains': terms[i] } };
    var cs = await safeCall('CTX.attio.companies', function() { return attio.queryRecords('companies', filter, 3); }, []);
    var ds = await safeCall('CTX.attio.deals', function() { return attio.queryRecords('deals', filter, 3); }, []);
    (cs || []).forEach(function(c) { if (c.record_id && !seenCo[c.record_id]) { seenCo[c.record_id] = 1; companies.push(c); } });
    (ds || []).forEach(function(d) { if (d.record_id && !seenDeal[d.record_id]) { seenDeal[d.record_id] = 1; deals.push(d); } });
  }

  // Resolve a few deals linked to the top company match (answers "che deal con X").
  if (companies[0] && companies[0].values && companies[0].values.associated_deals) {
    var refs = [].concat(companies[0].values.associated_deals);
    for (var j = 0; j < refs.length && j < 3; j++) {
      var rid = refs[j] && refs[j].record_id;
      if (rid && !seenDeal[rid]) {
        var dd = await safeCall('CTX.attio.dealRef', function() { return attio.getRecord('deals', rid); }, null);
        if (dd) { seenDeal[rid] = 1; deals.push(dd); }
      }
    }
  }

  // Overview fallback: generic CRM/pipeline question with no specific match.
  if (deals.length === 0 && companies.length === 0 && OVERVIEW_KEYWORDS.test(message)) {
    var recent = await safeCall('CTX.attio.recentDeals', function() {
      return attio.queryRecords('deals', null, 8, [{ attribute: 'created_at', direction: 'desc' }]);
    }, []);
    (recent || []).forEach(function(d) { if (d.record_id && !seenDeal[d.record_id]) { seenDeal[d.record_id] = 1; deals.push(d); } });
  }

  if (companies.length === 0 && deals.length === 0) return null;
  logger.info('[CTX-ATTIO] grounded:', companies.length, 'aziende,', deals.length, 'deal | termini:', terms.join(',') || '(overview)');
  return { companies: companies.slice(0, 4), deals: deals.slice(0, 5) };
}

// Render an attioContext object into a prompt block. Returns '' when empty.
function formatAttioForPrompt(attioContext) {
  if (!attioContext) return '';
  var companies = attioContext.companies || [];
  var deals = attioContext.deals || [];
  if (companies.length === 0 && deals.length === 0) return '';

  var lines = [];
  companies.forEach(function(c) {
    var v = c.values || {};
    var line = (v.name || '(senza nome)');
    if (v.description) line += ' — ' + String(v.description).substring(0, 120);
    lines.push('• AZIENDA ' + line + ' [id:' + c.record_id + ']');
  });
  deals.forEach(function(d) {
    var v = d.values || {};
    var bits = [];
    if (v.stage) bits.push('stage: ' + (Array.isArray(v.stage) ? v.stage.join('/') : v.stage));
    else if (v.status_trattativa) bits.push('stato: ' + [].concat(v.status_trattativa).join('/'));
    if (v.value != null) bits.push('valore: ' + v.value);
    if (v.servizio_proposto) bits.push('servizio: ' + [].concat(v.servizio_proposto).join(', '));
    lines.push('• DEAL ' + (v.name || '(senza nome)') + (bits.length ? ' — ' + bits.join(' | ') : '') + ' [id:' + d.record_id + ']');
  });
  return 'ATTIO (CRM — FONTE DI VERITÀ per clienti/trattative, usa QUESTI dati, non le memorie; per dettagli/modifiche usa i tool attio_*):\n' + lines.join('\n');
}

module.exports = {
  CRM_KEYWORDS: CRM_KEYWORDS,
  isCrmIsh: isCrmIsh,
  extractCrmTerms: extractCrmTerms,
  buildAttioContext: buildAttioContext,
  formatAttioForPrompt: formatAttioForPrompt,
};
