'use strict';
// Server-only, SELECT-only adapter. No Slack jobs, model calls or database writes.
const columns={
  standup_entries:'slack_user_id,date,oggi_tasks,source',
  projects:'id,name,client_name,status,owner_slack_id,merged_into,tags,lifecycle_evidence',
  team_members:'slack_user_id,canonical_name,role,active',
  time_logs:'slack_user_id,project_id,log_date,log_type,hours,validation,updated_at',
  project_dossiers:'project_id,dossier,updated_at',
  project_documents:'project_id,file_name,drive_link',
  project_actions:'id,project_id,description,status,assignee_slack_id,due_date,done_at,created_at',
  project_contract_sources:'id,project_id,input,updated_at',
  giunos_budgets:'project_id,slack_user_id,period_start,period_end,hours,verified,source_url,scope'
};
async function readTable(client,table) {
  const rows=[];
  for(let offset=0;offset<100000;offset+=500) {
    // Stable pagination prevents the default 1000-row API cap from changing totals.
    let q=client.from(table).select(columns[table]).order(table==='team_members'?'slack_user_id':table==='project_dossiers'?'project_id':'id').range(offset,offset+499);
    if(table==='time_logs') q=q.eq('log_type','daily');
    if (q.abortSignal) q=q.abortSignal(AbortSignal.timeout(15000));
    const res=await q;
    if(res.error) throw new Error(table+' unavailable');
    rows.push(...(res.data||[]));
    if((res.data||[]).length<500)return rows;
  }
  throw new Error(table+' exceeds read limit');
}
async function loadRaw(client) {
  if(!client) return {mode:'disconnected',warnings:['Collegamento ai dati di Giuno non configurato.'],projects:[],team_members:[],time_logs:[],project_actions:null};
  const raw={mode:'live',warnings:[]};
  await Promise.all(Object.keys(columns).map(async table=>{
    try {raw[table]=await readTable(client,table);}
    catch(e){ if(['projects','time_logs','team_members'].includes(table)) throw e; raw[table]=null;raw.warnings.push({table,message:table==='giunos_budgets'?'Budget venduti non ancora collegati.':'Una fonte di dettaglio non è disponibile.'}); }
  }));
  return raw;
}
module.exports={loadRaw,readTable};
