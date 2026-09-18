'use strict';
const {monthEnd}=require('../agents/billingSheet');
const norm=s=>String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const validDate=s=>/^\d{4}-\d{2}-\d{2}$/.test(s||'')&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
function deriveEvidence(clients,links,projects,billing){
 const out=[];
 for(const row of billing){
  // Full identity equality: an accounting line is never split among similarly named clients.
  const matches=clients.filter(c=>[c.name,...(c.aliases||[])].some(a=>norm(a)===norm(row.client)));
  if(matches.length!==1||!/^\d{4}-(0[1-9]|1[0-2])$/.test(row.month||'')||!/^https:\/\//.test(row.source_url||''))continue;
  const c=matches[0];
  out.push({id:'billing-sync:'+c.id+':'+row.month+':'+encodeURIComponent(row.source_url),client_id:c.id,kind:'accounting',valid_from:row.month+'-01',valid_until:monthEnd(row.month),source_url:row.source_url,detail:'Presente nella contabilità di '+row.month+'. '+(row.description||'')+' La riga non prova da sola operatività, incasso o durata contrattuale.'});
 }
 const supported=new Set(['kickoff','recap','action_open','calendar','admin','weekly_plan']);
 for(const p of projects){
  const link=links.find(l=>l.project_id===p.id),e=p.lifecycle_evidence;
  if(!link||!e||e.state!=='active'||!supported.has(e.kind)||!validDate(e.observed_on)||!validDate(e.valid_until)||e.observed_on>e.valid_until||!/^https:\/\//.test(e.source_url||''))continue;
  // Closing one engagement must never close its entire client.
  out.push({id:'operations-sync:'+p.id,client_id:link.client_id,kind:'operational',valid_from:e.observed_on,valid_until:e.valid_until,source_url:e.source_url,detail:(e.detail||e.kind)+' · evidenza della commessa '+p.name});
 }
 return [...new Map(out.map(e=>[e.id,e])).values()];
}
async function run(options={}){
 const sb=options.supabase||require('../services/db/client').getClient();if(!sb)return {written:0};
 const {readTable}=require('../giunos/data');
 const [clients,links,projects,billing]=await Promise.all([
  readTable(sb,'agency_clients'),readTable(sb,'project_client_links'),readTable(sb,'projects'),
  options.billing||require('../agents/billingSheet').readBillingRows({force:true})
 ]);
 const rows=deriveEvidence(clients,links,projects,billing);
 if(rows.length){const r=await sb.from('client_evidence').upsert(rows,{onConflict:'id'});if(r.error)throw r.error;}
 return {written:rows.length,clients:clients.length};
}
module.exports={deriveEvidence,run};
