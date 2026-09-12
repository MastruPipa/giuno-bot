'use strict';

// A read projection over the canonical time ledger, never another hours ledger.
// Mappings are explicit: names/channels do not prove that two projects are equal.
const round = n => Math.round(n * 100) / 100;
function total(rows) {
  if (!rows.length) return { recorded: null, estimated: null, total: null };
  const recorded = round(rows.filter(r => !r.estimated).reduce((s,r) => s+r.hours,0));
  const estimated = round(rows.filter(r => r.estimated).reduce((s,r) => s+r.hours,0));
  return { recorded, estimated, total: round(recorded+estimated) };
}
function validOn(e, date) { return e.valid_from <= date && date <= e.valid_until; }
function buildClientHierarchy(raw, logs, catalogue, today) {
  const clients = raw.agency_clients || [];
  const links = raw.project_client_links || [];
  const nodes = raw.work_nodes || [];
  const projects = new Map((raw.projects || []).map(p => [p.id,p]));
  function canonical(id) {
    const seen = new Set();
    while (projects.get(id)?.merged_into) {
      if (seen.has(id)) return null;
      seen.add(id); id = projects.get(id).merged_into;
    }
    return id;
  }
  const mapped = new Map();
  const warnings = [];
  for (const link of links) {
    const id = canonical(link.project_id);
    if (!id || !projects.has(id)) continue;
    const prev = mapped.get(id);
    // Conflicting associations must not move or double-count hours.
    if (prev && prev.client_id !== link.client_id) {
      mapped.set(id, { conflict: true });
      warnings.push('Associazione cliente in conflitto per '+id); continue;
    }
    if (prev?.conflict) continue;
    if (prev && prev.node_id !== link.node_id) {
      mapped.set(id, { ...link, node_id: null });
    } else mapped.set(id, link);
  }
  const result = clients.map(client => {
    const clientNodes = nodes.filter(n => n.client_id === client.id);
    const byId = new Map(clientNodes.map(n => [n.id,n]));
    const ids = new Set([...mapped].filter(([,l]) => !l.conflict && l.client_id===client.id).map(([id])=>id));
    const mine = logs.filter(l => ids.has(l.project));
    // Task detail is trusted only when it reconciles with the canonical ledger.
    const detail=mine.flatMap(l=>{
      const entries=(raw.standup_entries||[]).filter(e=>e.slack_user_id===l.person&&e.date===l.date);
      const e=entries.length===1?entries[0]:null;
      const parts=e&&Array.isArray(e.oggi_tasks)?e.oggi_tasks.filter(t=>canonical(t.project_id)===l.project).map(t=>({ ...l,node:t.work_node_id,task:String(t.task||''),hours:Number(t.hours||0)+Number(t.minutes||0)/60 })):[];
      if(!parts.length||parts.some(t=>!Number.isFinite(t.hours)||t.hours<0)||Math.abs(parts.reduce((s,t)=>s+t.hours,0)-l.hours)>.02||(e.source==='estimate')!==!!l.estimated)return [{...l,node:mapped.get(l.project)?.node_id}];
      return parts.map(t=>({...t,node:byId.has(t.node)?t.node:mapped.get(l.project)?.node_id}));
    });
    function isWithin(id, ancestor) {
      const seen = new Set();
      while (id && byId.has(id) && !seen.has(id)) {
        if (id === ancestor) return true;
        seen.add(id); id = byId.get(id).parent_id;
      }
      return false;
    }
    function branch(n, visited = new Set()) {
      if (visited.has(n.id)) return null;
      const path = new Set(visited); path.add(n.id);
      const direct = detail.filter(l => l.node === n.id);
      const subtree = detail.filter(l => isWithin(l.node,n.id));
      return { ...n, hours: total(subtree), directHours: total(direct), tasks:direct.filter(l=>l.task).map(l=>({text:l.task,hours:l.hours,date:l.date,person:(raw.team_members||[]).find(p=>p.slack_user_id===l.person)?.canonical_name||l.person})),
        children: clientNodes.filter(child=>child.parent_id===n.id).map(child=>branch(child,path)).filter(Boolean) };
    }
    const evidence = (raw.client_evidence || []).filter(e=>e.client_id===client.id);
    const current = evidence.filter(e=>validOn(e,today) && (!e.id?.startsWith('operations-sync:') || !['completed','archived','cancelled','on_hold','merged'].includes(projects.get(e.id.slice('operations-sync:'.length))?.status)));
    const closure = current.some(e=>e.kind==='closure');
    const operational = current.some(e=>e.kind==='operational');
    const accounting = current.some(e=>e.kind==='accounting');
    const state = closure && (operational || accounting) ? 'conflicting' : closure ? 'closed' : operational ? 'operational' : accounting ? 'accounting_only' : 'unverified';
    return { id:client.id, name:client.name, state, economicActive:accounting,
      hours:total(mine), unassignedHours:total(detail.filter(l=>!byId.has(l.node))),
      projectIds:[...ids], projects:catalogue.filter(p=>ids.has(p.id)),
      nodes:clientNodes.filter(n=>!n.parent_id).map(n=>branch(n)), evidence };
  });
  return { clients:result, mappedProjectIds:[...mapped].filter(([,l])=>!l.conflict).map(([id])=>id), warnings };
}
module.exports = { buildClientHierarchy };
