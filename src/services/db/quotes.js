// ─── Quotes + Rate Card ──────────────────────────────────────────────────────
'use strict';

var c = require('./client');

async function searchQuotes(query) {
  if (!c.useSupabase) return [];
  try {
    var q = c.getClient().from('quotes').select('*');
    if (query.client_name)       q = q.ilike('client_name', '%' + query.client_name + '%');
    if (query.project_name)      q = q.ilike('project_name', '%' + query.project_name + '%');
    if (query.status)            q = q.eq('status', query.status);
    if (query.service_category)  q = q.ilike('service_category', '%' + query.service_category + '%');
    if (query.year)              q = q.eq('quote_year', query.year);
    if (query.quarter)           q = q.eq('quote_quarter', query.quarter);
    q = q.order('date', { ascending: false }).limit(query.limit || 20);
    var res = await q;
    return res.data || [];
  } catch(e) { c.logErr('searchQuotes', e); return []; }
}

async function quoteExistsByDocId(sourceDocId) {
  if (!c.useSupabase) return false;
  try {
    var res = await c.getClient().from('quotes').select('id').eq('source_doc_id', sourceDocId).single();
    return !!(res.data);
  } catch(e) { return false; }
}

async function saveQuote(quote) {
  if (!c.useSupabase) return false;
  try { await c.getClient().from('quotes').upsert(quote); return true; } catch(e) { c.logErr('saveQuote', e); return false; }
}

async function getRateCard(version) {
  if (!c.useSupabase) return null;
  try {
    var q = c.getClient().from('rate_card_history').select('*');
    q = version ? q.eq('version', version) : q.order('effective_from', { ascending: false }).limit(1);
    var res = await q;
    return res.data && res.data.length > 0 ? res.data[0] : null;
  } catch(e) { c.logErr('getRateCard', e); return null; }
}

async function listRateCards() {
  if (!c.useSupabase) return [];
  try {
    var res = await c.getClient().from('rate_card_history').select('id, version, effective_from, notes, created_at').order('effective_from', { ascending: false });
    return res.data || [];
  } catch(e) { c.logErr('listRateCards', e); return []; }
}

async function saveRateCard(rateCard) {
  if (!c.useSupabase) return false;
  try { await c.getClient().from('rate_card_history').upsert(rateCard); return true; } catch(e) { c.logErr('saveRateCard', e); return false; }
}

module.exports = { searchQuotes: searchQuotes, quoteExistsByDocId: quoteExistsByDocId, saveQuote: saveQuote, getRateCard: getRateCard, listRateCards: listRateCards, saveRateCard: saveRateCard };
