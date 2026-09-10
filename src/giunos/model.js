'use strict';
const day = 86400000;
const iso = d => d.toISOString().slice(0,10);
function validDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && iso(new Date(s)) === s; }
function romeToday(now = new Date()) { return new Intl.DateTimeFormat('en-CA', {timeZone:'Europe/Rome',year:'numeric',month:'2-digit',day:'2-digit'}).format(now); }
function periodBounds(kind = 'month', anchor = romeToday()) {
  if (!['week','month','quarter'].includes(kind) || !validDate(anchor)) throw new Error('Periodo non valido');
  const d = new Date(anchor), start = new Date(d), end = new Date(d);
  if (kind === 'week') { start.setUTCDate(d.getUTCDate() - (d.getUTCDay()+6)%7); end.setTime(start.getTime()+6*day); }
  if (kind === 'month') { start.setUTCDate(1); end.setUTCMonth(d.getUTCMonth()+1,0); }
  if (kind === 'quarter') { start.setUTCMonth(Math.floor(d.getUTCMonth()/3)*3,1); end.setUTCMonth(start.getUTCMonth()+3,0); }
  return {kind,start:iso(start),end:iso(end)};
}
const round = n => Math.round(n*100)/100;
function hours(rows) {
  if (!rows.length) return {recorded:null,estimated:null,total:null};
  let recorded=0,estimated=0;
  rows.forEach(r => { if(r.estimated) estimated+=r.hours; else recorded+=r.hours; });
  return {recorded:round(recorded),estimated:round(estimated),total:round(recorded+estimated)};
}
function normalizeLogs(rows) {
  const unique=new Map();
  for(const r of rows) {
    if(r.log_type!=='daily' || !validDate(r.log_date) || !r.project_id || !r.slack_user_id || r.hours===null || r.hours==='' || !Number.isFinite(Number(r.hours)) || Number(r.hours)<0) continue;
    const key=JSON.stringify([r.slack_user_id,r.project_id,r.log_date]);
    const prior=unique.get(key);
    if(!prior || String(r.updated_at||'')>=String(prior.updated_at||'')) unique.set(key,r);
  }
  return [...unique.values()].map(r=>({person:r.slack_user_id,project:r.project_id,date:r.log_date,hours:Number(r.hours),estimated:r.validation?.status==='estimate'}));
}
function budgetFor(rows,pid,person,start,end) {
  // Sum complete, contiguous contract cycles only. Never prorate a monthly
  // allowance into a week or multiply a project-wide budget across periods.
  const candidates=rows.filter(b=>b.scope!=='project' && b.project_id===pid &&
    (b.slack_user_id||null)===(person||null) && b.verified===true && b.source_url &&
    validDate(b.period_start) && validDate(b.period_end) && b.period_end>=start && b.period_start<=end);
  if(!candidates.length)return null;
  candidates.sort((a,b)=>a.period_start.localeCompare(b.period_start));
  let cursor=start,total=0;
  for(const b of candidates) {
    if(b.period_start!==cursor || b.period_end>end ||
      b.period_end<b.period_start || b.hours===null || b.hours==='' || !Number.isFinite(Number(b.hours)) || Number(b.hours)<0)return null;
    total+=Number(b.hours);
    cursor=iso(new Date(Date.parse(b.period_end)+day));
  }
  if(cursor!==iso(new Date(Date.parse(end)+day)))return null;
  return {hours:round(total),source:candidates[0].source_url,sources:[...new Set(candidates.map(b=>b.source_url))]};
}
// Conservative text labels, never used to infer hours or completion.
function category(text) {
  const t=String(text||'').toLowerCase();
  if(/revision|correzion|feedback/.test(t)) return 'Revisioni';
  if(/riunione|call|coordin|account|kick.?off|brief/.test(t)) return 'Coordinamento';
  if(/strateg|analisi|ricerca|report/.test(t)) return 'Strategia e analisi';
  if(/design|grafica|carosell|montaggio|shooting|video|copy|script|post|contenut/.test(t)) return 'Produzione';
  return 'Non classificato';
}
function categoryHours(logs,entries) {
  const totals=new Map();
  function add(name,h){totals.set(name,round((totals.get(name)||0)+h));}
  for(const l of logs) {
    const matches=(entries||[]).filter(e=>e.slack_user_id===l.person && e.date===l.date);
    const e=matches.length===1?matches[0]:null;
    const tasks=e && Array.isArray(e.oggi_tasks)?e.oggi_tasks.filter(t=>t.project_id===l.project):[];
    const parts=tasks.map(t=>({category:category(t.task),hours:(parseInt(t.hours,10)||0)+(parseInt(t.minutes,10)||0)/60}));
    const sum=parts.reduce((a,t)=>a+t.hours,0);
    // Daily details are explanatory only; they must reconcile with the canonical log.
    if(!parts.length || parts.some(t=>t.hours<0) || Math.abs(sum-l.hours)>.02 || (e.source==='estimate')!==l.estimated) add('Non classificato',l.hours);
    else parts.forEach(t=>add(t.category,t.hours));
  }
  return [...totals].map(([name,hours])=>({name,hours}));
}
function buildSnapshot(raw,period,now=new Date()) {
  const today=romeToday(now), cutoff=period.end<today?period.end:today;
  const aliases=new Map((raw.projects||[]).filter(p=>p.merged_into).map(p=>[p.id,p.merged_into]));
  const allLogs=normalizeLogs(raw.time_logs||[]).filter(r=>r.date<=today).map(r=>({...r,project:aliases.get(r.project)||r.project}));
  const logs=allLogs.filter(r=>r.date>=period.start && r.date<=cutoff);
  const contractInputs=(raw.project_contract_sources||[]).map(r=>{
    const input={...r.input,project_id:r.project_id};
    const age=now.getTime()-Date.parse(r.updated_at);
    if(!Number.isFinite(age)||age>36*60*60*1000||age<0)input.read_error='Verifica fonti scaduta';
    return input;
  });
  const contracts=require('../services/reconciliation/contracts').projectBudgets(contractInputs);
  const budgets=[...(raw.giunos_budgets||[]),...contracts.rows];
  const actions=raw.project_actions||[];
  const active=(raw.projects||[]).filter(p=>!p.merged_into);
  const projects=active.map(p=>{
    const dossier=(raw.project_dossiers||[]).find(d=>d.project_id===p.id);
    const evidence=dossier?.dossier||{};
    const b=budgetFor(budgets,p.id,null,period.start,period.end);
    const projectLogs=logs.filter(l=>l.project===p.id);
    const used=hours(projectLogs);
    const whole=budgets.filter(b=>b.scope==='project' && b.project_id===p.id && !b.slack_user_id && b.verified===true && b.source_url && validDate(b.period_start) && validDate(b.period_end) && b.hours!==null && Number.isFinite(Number(b.hours)) && Number(b.hours)>=0);
    const wholeBudget=whole.length===1?whole[0]:null;
    const wholeUsed=wholeBudget?hours(allLogs.filter(l=>l.project===p.id && l.date>=wholeBudget.period_start && l.date<=wholeBudget.period_end)):null;

    const deliveries=Array.isArray(evidence.deliverable)?evidence.deliverable:[];
    const details=deliveries.map(d=>({name:String(d.nome||'Consegna'),status:String(d.stato||'non rilevato')}));
    return {id:p.id,name:p.name,client:p.client_name,status:p.status,owner:p.owner_slack_id,
      contractEvidence:contracts.assessments.filter(a=>a.project_id===p.id).map(a=>({status:a.status,issues:a.issues,source:a.source,roleBudgets:a.role_budgets,assignments:a.assignments})),
      wholeBudget:wholeBudget?{hours:Number(wholeBudget.hours),source:wholeBudget.source_url,start:wholeBudget.period_start,end:wholeBudget.period_end,used:wholeUsed}:null,
      hours:used,budget:b,overrun:b&&used.total!==null?round(used.total-b.hours):null,
      lifetime:hours(allLogs.filter(l=>l.project===p.id)),deliveries:details,
      summary:evidence.stato_sintesi||null,phase:evidence.fase||null,updatedAt:dossier?.updated_at||null,
      deadlines:Array.isArray(evidence.scadenze)?evidence.scadenze:[],
      team: [...new Set(projectLogs.map(l=>l.person))],
      documents:(raw.project_documents||[]).filter(d=>d.project_id===p.id).map(d=>({name:d.file_name,url:d.drive_link})),
      actions:actions.filter(a=>a.project_id===p.id).map(a=>({id:a.id,name:a.description,status:a.status,due:a.due_date,assignee:a.assignee_slack_id}))};
  });
  const peopleIds=new Set([...(raw.team_members||[]).filter(m=>m.active!==false).map(m=>m.slack_user_id),...logs.map(l=>l.person)]);
  const people=[...peopleIds].map(id=>{
    const member=(raw.team_members||[]).find(m=>m.slack_user_id===id);
    const mine=logs.filter(l=>l.person===id);
    const closed=actions.filter(a=>a.assignee_slack_id===id && a.status==='done' && a.done_at && a.done_at.slice(0,10)>=period.start && a.done_at.slice(0,10)<=cutoff);
    const durations=closed.filter(a=>validDate(a.created_at?.slice(0,10)) && Date.parse(a.done_at)>=Date.parse(a.created_at)).map(a=>(Date.parse(a.done_at)-Date.parse(a.created_at))/day).sort((a,b)=>a-b);
    const median=durations.length ? round((durations[Math.floor((durations.length-1)/2)]+durations[Math.floor(durations.length/2)])/2):null;
    const buckets=new Map();
    for(let d=new Date(period.start);iso(d)<=cutoff;d=new Date(d.getTime()+day)) {const key=period.kind==='week'?iso(d):periodBounds('week',iso(d)).start;buckets.set(key,{date:key,hours:null,projects:{}});}
    mine.forEach(l=>{const key=period.kind==='week'?l.date:periodBounds('week',l.date).start;const bucket=buckets.get(key);if(bucket){bucket.hours=round((bucket.hours||0)+l.hours);bucket.projects[l.project]=round((bucket.projects[l.project]||0)+l.hours);}});
    return {id,name:member?.canonical_name||id,role:member?.role||null,hours:hours(mine),
      projects:[...new Set(mine.map(l=>l.project))].map(pid=>({id:pid,name:projects.find(p=>p.id===pid)?.name||pid,hours:hours(mine.filter(l=>l.project===pid)),budget:budgetFor(budgets,pid,id,period.start,period.end)})),
      closed:raw.project_actions===null?null:closed.length,medianDays:median,closureSample:durations.length,
      categories:categoryHours(mine,raw.standup_entries),
      projectCategories:Object.fromEntries([...new Set(mine.map(l=>l.project))].map(pid=>[pid,categoryHours(mine.filter(l=>l.project===pid),raw.standup_entries)])),
      closureTypes:[...new Set(closed.map(a=>category(a.description)))].map(name=>{const cases=closed.filter(a=>category(a.description)===name);const values=cases.filter(a=>Date.parse(a.done_at)>=Date.parse(a.created_at)).map(a=>(Date.parse(a.done_at)-Date.parse(a.created_at))/day).sort((a,b)=>a-b);return {name,count:cases.length,medianDays:values.length?round((values[Math.floor((values.length-1)/2)]+values[Math.floor(values.length/2)])/2):null};}),
      buckets:[...buckets.values()]};
  });
  const alerts=projects.filter(p=>p.overrun>0).map(p=>({project:p.id,title:p.name+' · oltre budget',detail:round(p.overrun)+' h oltre le ore vendute nel periodo'}));
  projects.filter(p=>p.phase==='in attesa cliente').forEach(p=>alerts.push({project:p.id,title:p.name+' · attesa cliente',detail:'Stato ricostruito dal dossier di progetto'}));
  return {period:{...period,cutoff},fetchedAt:now.toISOString(),mode:raw.mode||'live',warnings:raw.warnings||[],projects,people,alerts:alerts.slice(0,3),hours:hours(logs)};
}
module.exports={category,categoryHours,periodBounds,validDate,romeToday,normalizeLogs,hours,budgetFor,buildSnapshot};
