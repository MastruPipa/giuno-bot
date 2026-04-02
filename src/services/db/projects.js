// ─── Projects DB Module ──────────────────────────────────────────────────────
// CRUD for projects and resource_allocations tables.
'use strict';

var c = require('./client');
var logger = require('../../utils/logger');

// ─── Projects ────────────────────────────────────────────────────────────────

async function createProject(data) {
  if (!c.useSupabase) return null;
  try {
    var row = {
      name: data.name,
      client_name: data.client_name || null,
      lead_id: data.lead_id || null,
      status: data.status || 'active',
      start_date: data.start_date || null,
      end_date: data.end_date || null,
      budget_quoted: data.budget_quoted || null,
      service_category: data.service_category || null,
      description: data.description || null,
      owner_slack_id: data.owner_slack_id || null,
      deliverables: data.deliverables || [],
      tags: data.tags || [],
      source_quote_id: data.source_quote_id || null,
    };
    var res = await c.getClient().from('projects').insert(row).select().single();
    if (res.error) throw res.error;
    return res.data;
  } catch(e) { c.logErr('createProject', e); return null; }
}

async function updateProject(projectId, updates) {
  if (!c.useSupabase) return null;
  try {
    updates.updated_at = new Date().toISOString();
    var res = await c.getClient().from('projects').update(updates).eq('id', projectId).select().single();
    if (res.error) throw res.error;
    return res.data;
  } catch(e) { c.logErr('updateProject', e); return null; }
}

async function searchProjects(params) {
  if (!c.useSupabase) return [];
  params = params || {};
  try {
    var q = c.getClient().from('projects').select('*');
    if (params.status) q = q.eq('status', params.status);
    if (params.client_name) q = q.ilike('client_name', '%' + params.client_name + '%');
    if (params.owner_slack_id) q = q.eq('owner_slack_id', params.owner_slack_id);
    if (params.service_category) q = q.ilike('service_category', '%' + params.service_category + '%');
    if (params.name) q = q.ilike('name', '%' + params.name + '%');
    q = q.order('updated_at', { ascending: false }).limit(params.limit || 20);
    var res = await q;
    return res.data || [];
  } catch(e) { c.logErr('searchProjects', e); return []; }
}

async function getProject(projectId) {
  if (!c.useSupabase) return null;
  try {
    var res = await c.getClient().from('projects').select('*').eq('id', projectId).single();
    return res.data || null;
  } catch(e) { c.logErr('getProject', e); return null; }
}

async function deleteProject(projectId) {
  if (!c.useSupabase) return false;
  try {
    await c.getClient().from('projects').delete().eq('id', projectId);
    return true;
  } catch(e) { c.logErr('deleteProject', e); return false; }
}

// ─── Resource Allocations ────────────────────────────────────────────────────

async function allocateResource(data) {
  if (!c.useSupabase) return null;
  try {
    var row = {
      project_id: data.project_id,
      slack_user_id: data.slack_user_id,
      role: data.role || null,
      hours_allocated: data.hours_allocated || 0,
      hours_logged: data.hours_logged || 0,
      period_start: data.period_start || null,
      period_end: data.period_end || null,
      notes: data.notes || null,
    };
    var res = await c.getClient().from('resource_allocations').insert(row).select().single();
    if (res.error) throw res.error;
    return res.data;
  } catch(e) { c.logErr('allocateResource', e); return null; }
}

async function updateAllocation(allocId, updates) {
  if (!c.useSupabase) return null;
  try {
    updates.updated_at = new Date().toISOString();
    var res = await c.getClient().from('resource_allocations').update(updates).eq('id', allocId).select().single();
    if (res.error) throw res.error;
    return res.data;
  } catch(e) { c.logErr('updateAllocation', e); return null; }
}

async function getProjectAllocations(projectId) {
  if (!c.useSupabase) return [];
  try {
    var res = await c.getClient().from('resource_allocations').select('*').eq('project_id', projectId).order('created_at', { ascending: true });
    return res.data || [];
  } catch(e) { c.logErr('getProjectAllocations', e); return []; }
}

async function getUserAllocations(slackUserId) {
  if (!c.useSupabase) return [];
  try {
    var res = await c.getClient().from('resource_allocations')
      .select('*, projects!inner(name, client_name, status)')
      .eq('slack_user_id', slackUserId)
      .eq('projects.status', 'active')
      .order('created_at', { ascending: false });
    return res.data || [];
  } catch(e) {
    // Fallback without join if inner join fails
    try {
      var res2 = await c.getClient().from('resource_allocations')
        .select('*')
        .eq('slack_user_id', slackUserId)
        .order('created_at', { ascending: false });
      return res2.data || [];
    } catch(e2) { c.logErr('getUserAllocations', e2); return []; }
  }
}

async function getTeamWorkload() {
  if (!c.useSupabase) return [];
  try {
    var res = await c.getClient().from('resource_allocations')
      .select('slack_user_id, hours_allocated, hours_logged, project_id, role, projects!inner(name, status)')
      .eq('projects.status', 'active');
    if (!res.data) return [];
    // Aggregate by user
    var byUser = {};
    res.data.forEach(function(r) {
      if (!byUser[r.slack_user_id]) {
        byUser[r.slack_user_id] = { slack_user_id: r.slack_user_id, total_allocated: 0, total_logged: 0, projects: [] };
      }
      byUser[r.slack_user_id].total_allocated += parseFloat(r.hours_allocated) || 0;
      byUser[r.slack_user_id].total_logged += parseFloat(r.hours_logged) || 0;
      byUser[r.slack_user_id].projects.push({
        project_id: r.project_id,
        project_name: r.projects ? r.projects.name : null,
        role: r.role,
        hours_allocated: r.hours_allocated,
        hours_logged: r.hours_logged,
      });
    });
    return Object.values(byUser);
  } catch(e) {
    c.logErr('getTeamWorkload', e);
    return [];
  }
}

module.exports = {
  createProject: createProject,
  updateProject: updateProject,
  searchProjects: searchProjects,
  getProject: getProject,
  deleteProject: deleteProject,
  allocateResource: allocateResource,
  updateAllocation: updateAllocation,
  getProjectAllocations: getProjectAllocations,
  getUserAllocations: getUserAllocations,
  getTeamWorkload: getTeamWorkload,
};
