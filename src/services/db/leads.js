// ─── Leads (CRM) ─────────────────────────────────────────────────────────────
'use strict';

var c = require('./client');
var dates = require('../../utils/dates');

async function leadExists(companyName, contactEmail) {
  if (!c.useSupabase) return false;
  try {
    var q = c.getClient().from('leads').select('id').ilike('company_name', companyName);
    if (contactEmail) q = q.eq('contact_email', contactEmail);
    var res = await q.limit(1);
    return !!(res.data && res.data.length > 0);
  } catch(e) { return false; }
}

async function insertLead(lead) {
  if (!c.useSupabase) return null;
  try {
    var row = {
      company_name: lead.company_name, contact_name: lead.contact_name || null,
      contact_email: lead.contact_email || null, contact_role: lead.contact_role || null,
      source: lead.source || 'sheet_import', service_interest: lead.service_interest || null,
      estimated_value: lead.estimated_value || null, status: lead.status || 'new',
      owner_slack_id: lead.owner_slack_id || null, first_contact: lead.first_contact || null,
      last_contact: lead.last_contact || null, next_followup: lead.next_followup || null,
      notes: lead.notes || null, phone: lead.phone || null, website: lead.website || null,
    };
    var res = await c.getClient().from('leads').insert(row);
    if (res.error) throw res.error;
    return res.data;
  } catch(e) { c.logErr('insertLead', e); throw e; }
}

async function getLeadsPipeline() {
  if (!c.useSupabase) return { byStatus: {}, upcoming: [] };
  try {
    var res = await c.getClient().from('leads').select('status');
    var byStatus = {};
    (res.data || []).forEach(function(r) { var s = r.status || 'new'; byStatus[s] = (byStatus[s] || 0) + 1; });
    var today = dates.todayISO();
    var tomorrow = dates.daysFromTodayISO(1);
    var upRes = await c.getClient().from('leads').select('company_name, contact_name, next_followup, status').lte('next_followup', tomorrow).gte('next_followup', today).order('next_followup');
    return { byStatus: byStatus, upcoming: upRes.data || [], total: (res.data || []).length };
  } catch(e) { c.logErr('getLeadsPipeline', e); return { byStatus: {}, upcoming: [], total: 0 }; }
}

async function updateLead(identifier, updates) {
  if (!c.useSupabase) return null;
  try {
    var updateData = Object.assign({}, updates, { updated_at: new Date().toISOString() });
    // Path 1: identifier è un UUID → aggiorna esattamente quel record.
    if (identifier && identifier.match && identifier.match(/^[0-9a-f-]{36}$/i)) {
      var resById = await c.getClient().from('leads').update(updateData).eq('id', identifier).select();
      if (resById.error) throw resById.error;
      return resById.data;
    }
    // Path 2: identifier è un nome azienda. Risolviamo PRIMA a un singolo
    // record: un update per ilike diretto aggiornerebbe tutti gli omonimi e i
    // caratteri % / _ verrebbero interpretati come wildcard LIKE. Quindi:
    // escape dei wildcard, lookup, e update solo se il match è univoco.
    var pattern = String(identifier || '').replace(/[\\%_]/g, '\\$&');
    var matchRes = await c.getClient().from('leads').select('id, company_name').ilike('company_name', pattern);
    if (matchRes.error) throw matchRes.error;
    var matches = matchRes.data || [];
    if (matches.length === 0) return [];
    if (matches.length > 1) {
      var ambErr = new Error('Trovati ' + matches.length + ' lead con nome "' + identifier + '". Specifica l\'ID del record da aggiornare.');
      ambErr.ambiguous = true;
      ambErr.matches = matches;
      throw ambErr;
    }
    var resOne = await c.getClient().from('leads').update(updateData).eq('id', matches[0].id).select();
    if (resOne.error) throw resOne.error;
    return resOne.data;
  } catch(e) { c.logErr('updateLead', e); throw e; }
}

async function searchLeads(params) {
  if (!c.useSupabase) return [];
  try {
    var q = c.getClient().from('leads').select('*');
    if (params.company_name)    q = q.ilike('company_name', '%' + params.company_name + '%');
    if (params.contact_name)    q = q.ilike('contact_name', '%' + params.contact_name + '%');
    if (params.status)          q = q.eq('status', params.status);
    if (params.owner_slack_id)  q = q.eq('owner_slack_id', params.owner_slack_id);
    if (params.updated_after)   q = q.gte('updated_at', params.updated_after);
    if (params.created_after)   q = q.gte('created_at', params.created_after);
    if (params.active_after)    q = q.or('last_contact.gte.' + params.active_after + ',first_contact.gte.' + params.active_after);
    if (params.exclude_status)  q = q.not('status', 'in', '(' + params.exclude_status.map(function(s) { return '"' + s + '"'; }).join(',') + ')');
    if (params.is_active === true)  q = q.eq('is_active', true);
    if (params.is_active === false) q = q.eq('is_active', false);
    q = q.order('updated_at', { ascending: false }).limit(params.limit || 20);
    var res = await q;
    return res.data || [];
  } catch(e) { c.logErr('searchLeads', e); return []; }
}

async function queryLeadsDB(input) {
  if (!c.useSupabase) return { leads: [], count: 0 };
  try {
    var q = c.getClient().from('leads').select('*');
    if (input.company_name)   q = q.ilike('company_name', '%' + input.company_name + '%');
    if (input.contact_name)   q = q.ilike('contact_name', '%' + input.contact_name + '%');
    if (input.status)         q = q.eq('status', input.status);
    if (input.owner_slack_id) q = q.eq('owner_slack_id', input.owner_slack_id);
    q = q.order('updated_at', { ascending: false }).limit(input.limit || 10);
    var res = await q;
    return { leads: res.data || [], count: (res.data || []).length };
  } catch(e) { c.logErr('queryLeadsDB', e); return { leads: [], count: 0 }; }
}

async function deleteLead(identifier) {
  if (!c.useSupabase) return null;
  try {
    var q = c.getClient().from('leads').delete();
    if (identifier.match && identifier.match(/^[0-9a-f-]{36}$/i)) {
      q = q.eq('id', identifier);
    } else {
      q = q.ilike('company_name', identifier);
    }
    var res = await q.select();
    if (res.error) throw res.error;
    return res.data || [];
  } catch(e) { c.logErr('deleteLead', e); throw e; }
}

module.exports = { leadExists: leadExists, insertLead: insertLead, getLeadsPipeline: getLeadsPipeline, updateLead: updateLead, searchLeads: searchLeads, queryLeadsDB: queryLeadsDB, deleteLead: deleteLead };
