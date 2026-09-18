'use strict';
const {createHash}=require('node:crypto');
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
function fingerprint(e){return createHash('sha256').update(JSON.stringify(stable({id:e.id,date:e.date,source:e.source,tasks:e.oggi_tasks||[]}))).digest('hex');}
const round=n=>Math.round(n*100)/100;
const duration=t=>{const h=Number(t.hours||0),m=Number(t.minutes||0);return Number.isFinite(h)&&Number.isFinite(m)&&h>=0&&m>=0?h+m/60:null;};
function canonicalMap(projects){const byId=new Map(projects.map(p=>[p.id,p]));return new Map(projects.map(p=>{let id=p.id;const seen=new Set();while(id&&!seen.has(id)){seen.add(id);const row=byId.get(id);if(!row)return [p.id,null];if(!row.merged_into)return [p.id,row.status==='merged'?null:id];id=row.merged_into;}return [p.id,null];}));}
function reviewEntries(raw){
 const entries=(raw.standup_entries||[]).map(e=>({...e})),notes=[];
 for(const r of raw.giunos_daily_reviews||[]){
  const basis=(raw.standup_entries||[]).find(e=>e.id===r.basis_entry_id),target=entries.find(e=>e.slack_user_id===r.slack_user_id&&e.date===r.date);
  const fresh=r.basis_entry_id?basis&&fingerprint(basis)===r.basis_hash:!target;
  const crossDate=r.basis_entry_id&&basis?.date!==r.date;
  if(!fresh||(crossDate&&target)){notes.push({...r,status:'stale',tasks:undefined,note:'Il daily è cambiato dopo il confronto Slack: verifica da ripetere. '+r.note});continue;}
  notes.push({...r,tasks:undefined});
  if(r.status==='excluded'){if(target)target.excluded=true;continue;}
  if(r.status==='conflict'){if(target)target.review=r;continue;}
  const next={...(target||{id:r.id,slack_user_id:r.slack_user_id,date:r.date,source:'slack_review'}),oggi_tasks:Array.isArray(r.tasks)?r.tasks:target?.oggi_tasks,review:r};
  if(target)Object.assign(target,next);else entries.push(next);
 }
 return {entries:entries.filter(e=>!e.excluded),notes};
}
function buildReconciliation(raw,period,today,logs){
 const aliases=canonicalMap(raw.projects||[]),canonical=id=>aliases.has(id)?aliases.get(id):null;
 const {entries,notes}=reviewEntries(raw),selected=entries.filter(e=>e.date>=period.start&&e.date<=period.end&&e.date<=today);
 const rows=new Map(),unassigned=[],proposals=[];const key=(user,date,project)=>JSON.stringify([user,date,project]);
 const get=(user,date,project)=>{const k=key(user,date,project);if(!rows.has(k))rows.set(k,{user,date,project,daily_hours:null,log_hours:null,estimated_hours:null,tasks:[],sources:[],review:null});return rows.get(k);};
 const people=new Set();
 for(const e of selected){if(e.source==='estimate'){proposals.push({user:e.slack_user_id,date:e.date,tasks:e.oggi_tasks||[],hours:round((e.oggi_tasks||[]).reduce((s,t)=>s+(duration(t)||0),0))});continue;}people.add(e.slack_user_id);
  for(const t of e.oggi_tasks||[]){const h=duration(t),pid=canonical(t.project_id);if(!pid||h===null){unassigned.push({user:e.slack_user_id,date:e.date,task:t.task,hours:h,source:e.source,sources:e.review?.source_urls||[],reason:h===null?'Durata non valida':t.project_id?'Progetto non risolvibile':'Progetto da attribuire'});continue;}
   const r=get(e.slack_user_id,e.date,pid);r.daily_hours=(r.daily_hours||0)+h;r.tasks.push({text:t.task,hours:h});r.source=e.source;r.review=e.review?.status||null;r.sources=[...new Set([...r.sources,...(e.review?.source_urls||[])])];
  }
 }
 for(const l of logs){const r=get(l.person,l.date,l.project);const field=l.estimated?'estimated_hours':'log_hours';r[field]=(r[field]||0)+l.hours;}
 const result=[...rows.values()].map(r=>{for(const f of ['daily_hours','log_hours','estimated_hours'])if(r[f]!==null)r[f]=round(r[f]);return {...r,delta:round((r.daily_hours||0)-(r.log_hours||0)),category:r.daily_hours===null?'ledger_only':r.log_hours===null?'missing':Math.abs(r.daily_hours-r.log_hours)<.02?'aligned':'difference'};});
 return {available:Array.isArray(raw.standup_entries),rows:result,unassigned,proposals,notes:notes.filter(r=>r.date>=period.start&&r.date<=period.end),people:[...people],dailyPeople:people.size,dailyCount:selected.filter(e=>e.source!=='estimate').length,dailyHours:Array.isArray(raw.standup_entries)?round(result.reduce((s,r)=>s+(r.daily_hours||0),0)+unassigned.reduce((s,t)=>s+(t.hours||0),0)):null,ledgerHours:logs.some(l=>!l.estimated)?round(logs.filter(l=>!l.estimated).reduce((s,l)=>s+l.hours,0)):null,estimatedHours:round(logs.filter(l=>l.estimated).reduce((s,l)=>s+l.hours,0))};
}
function estimateSummary(raw,period,today){
 const all=(raw.daily_estimate_calibration||[]).filter(r=>r.date<=today&&Number(r.estimated_hours)>0&&Number(r.actual_hours)>0);
 const counts=new Map();for(const r of all)counts.set(r.slack_user_id,(counts.get(r.slack_user_id)||0)+1);
 const pending=Object.entries((raw.standup_data||[]).find(r=>r.id==='current')?.stime||{}).map(([user,v])=>({user,date:v.date,tasks:v.structured?.oggi||[],hours:round((v.structured?.oggi||[]).reduce((s,t)=>s+(duration(t)||0),0)),generatedAt:v.structured?.estimate?.generated_at,sources:v.structured?.estimate?.sources||[],note:v.structured?.estimate?.note||null})).filter(r=>r.date>=period.start&&r.date<=period.end);
 return {available:Array.isArray(raw.daily_estimate_calibration),pending,calibration:all.filter(r=>r.date>=period.start&&r.date<=period.end).map(r=>({user:r.slack_user_id,date:r.date,estimated:Number(r.estimated_hours),actual:Number(r.actual_hours),confirmed:r.confirmed})),eligiblePeople:[...counts].filter(([,n])=>n>=3).length,totalCases:all.length};
}
module.exports={fingerprint,canonicalMap,reviewEntries,buildReconciliation,estimateSummary};
