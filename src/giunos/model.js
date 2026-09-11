'use strict';
const {isActiveProject} = require('./projectScope');
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
// Pianificazione settimanale (log_type=weekly, log_date=lunedì): ore che la
// persona ha DICHIARATO di voler dedicare. Mai sommate alle registrate.
function normalizePlans(rows) {
  const unique=new Map();
  for(const r of rows||[]) {
    if(r.log_type!=='weekly' || !validDate(r.log_date) || !r.project_id || !r.slack_user_id || !Number.isFinite(Number(r.hours)) || Number(r.hours)<0) continue;
    const key=JSON.stringify([r.slack_user_id,r.project_id,r.log_date]);
    const prior=unique.get(key);
    if(!prior || String(r.updated_at||'')>=String(prior.updated_at||'')) unique.set(key,r);
  }
  return [...unique.values()].map(r=>({person:r.slack_user_id,project:r.project_id,week:r.log_date,hours:Number(r.hours)}));
}
function planned(rows){return rows.length?round(rows.reduce((s,r)=>s+r.hours,0)):null;}
function budgetFor(rows,pid,person,start,end) {
  const candidates=rows.filter(b=>b.scope!=='project' && b.project_id===pid && (b.slack_user_id||null)===(person||null) && b.verified===true && b.period_start===start && b.period_end===end && b.source_url && b.hours!==null && Number.isFinite(Number(b.hours)) && Number(b.hours)>=0);
  // Conflicting baselines must never be silently resolved by recency.
  return candidates.length===1 ? {hours:Number(candidates[0].hours),source:candidates[0].source_url} : null;
}
// Categorie di attività di un'agenzia creativa, ricavate dal testo del task.
// Indicative: mai usate per dedurre ore o completamento. L'ordine conta: le
// voci più specifiche vengono prima di quelle generiche.
const CATEGORY_RULES=[
  ['Revisioni',/\brevision|correzion|feedback|modifich|fix\b|aggiust/],
  ['Riunioni e coordinamento',/riunion|\bcall\b|meeting|\bsal\b|allineament|coordin|kick.?off|daily|weekly|brief(?!ing)|confronto/],
  ['Commerciale',/preventiv|proposta|offerta|\blead\b|prospect|contratt|pitch|trattativ/],
  ['Strategia e analisi',/strateg|analisi|ricerca|report|benchmark|audit|kpi|dati|insight/],
  ['Video e foto',/video|montagg|shooting|riprese|foto|editing|reel|animazion|motion/],
  ['Contenuti e copy',/copy|testo|testi|script|contenut|post\b|carosell|caption|newsletter|articol|blog|social/],
  ['Design',/design|grafic|layout|logo|brand|mockup|figma|illustraz|impaginaz|visual|ui\b|ux\b/],
  ['Sviluppo',/svilupp|sito|web|landing|codice|deploy|bug|github|integrazion|app\b|wordpress|shopify/],
  ['Pianificazione e gestione',/pianific|organizz|gestion|calendar|piano|planning|task|to.?do|scadenz/],
  ['Amministrazione',/amministr|fattur|cassa|registro|contabil|pagament|hr\b|document/],
  ['Formazione',/formazion|corso|studio|tutorial|scuola|onboarding/],
];
function category(text) {
  const t=String(text||'').toLowerCase();
  for(const [name,re] of CATEGORY_RULES) if(re.test(t)) return name;
  return 'Non classificato';
}
// I task del daily possono portare l'id di un duplicato unito dopo: si
// confrontano con la commessa canonica (mappa degli alias), come i log.
const canon=(aliases,id)=>(aliases&&aliases.get(id))||id;
function categoryHours(logs,entries,aliases) {
  const totals=new Map();
  function add(name,h){totals.set(name,round((totals.get(name)||0)+h));}
  for(const l of logs) {
    const matches=(entries||[]).filter(e=>e.slack_user_id===l.person && e.date===l.date);
    const e=matches.length===1?matches[0]:null;
    const tasks=e && Array.isArray(e.oggi_tasks)?e.oggi_tasks.filter(t=>canon(aliases,t.project_id)===l.project):[];
    const parts=tasks.map(t=>({category:category(t.task),hours:(parseInt(t.hours,10)||0)+(parseInt(t.minutes,10)||0)/60}));
    const sum=parts.reduce((a,t)=>a+t.hours,0);
    // Daily details are explanatory only; they must reconcile with the canonical log.
    if(!parts.length || parts.some(t=>t.hours<0) || Math.abs(sum-l.hours)>.02 || (e.source==='estimate')!==l.estimated) add('Non classificato',l.hours);
    else parts.forEach(t=>add(t.category,t.hours));
  }
  return [...totals].map(([name,hours])=>({name,hours}));
}
// Attività di progetto (cliente → commessa → ATTIVITÀ → microtask). Le ore
// per attività si ricavano dalle microtask del daily (activity_id nel JSON) e
// valgono solo se il daily torna con il consuntivo, come le categorie: mai
// ore inventate. Il resto della commessa resta "senza attività".
const NO_ACTIVITY='__none__';
function activityRows(logs,entries,aliases) {
  const out=[];
  for(const l of logs) {
    const matches=(entries||[]).filter(e=>e.slack_user_id===l.person && e.date===l.date);
    const e=matches.length===1?matches[0]:null;
    const tasks=e && Array.isArray(e.oggi_tasks)?e.oggi_tasks.filter(t=>canon(aliases,t.project_id)===l.project):[];
    const parts=tasks.map(t=>({activity:t.activity_id||NO_ACTIVITY,activityName:t.activity_name||null,task:String(t.task||''),hours:(parseInt(t.hours,10)||0)+(parseInt(t.minutes,10)||0)/60}));
    const sum=parts.reduce((a,t)=>a+t.hours,0);
    if(!parts.length || parts.some(t=>t.hours<0) || Math.abs(sum-l.hours)>.02 || (e.source==='estimate')!==l.estimated) { out.push({person:l.person,project:l.project,date:l.date,activity:NO_ACTIVITY,activityName:null,task:null,hours:l.hours,estimated:l.estimated}); continue; }
    parts.forEach(t=>out.push({person:l.person,project:l.project,date:l.date,activity:t.activity,activityName:t.activityName,task:t.task,hours:round(t.hours),estimated:l.estimated}));
  }
  return out;
}
// Attività di una commessa nel periodo: quelle aperte (o con periodo che tocca
// il periodo scelto) più quelle che hanno ore, con persone e microtask.
function projectActivities(pid,rows,activities,period,today) {
  const mine=rows.filter(r=>r.project===pid);
  const defs=(activities||[]).filter(a=>a.project_id===pid && !a.recurrence);
  // Un'attività compare nel periodo se il suo intervallo lo tocca (un'aperta
  // senza date sempre; il PED di settembre non compare guardando agosto) o se
  // ha ore nel periodo.
  const overlaps=a=>(!a.period_start || a.period_start<=period.end) && (!a.period_end || a.period_end>=period.start);
  const ids=new Set([...defs.filter(a=>(a.status==='open' || a.period_start || a.period_end) && overlaps(a)).map(a=>a.id),...mine.filter(r=>r.activity!==NO_ACTIVITY).map(r=>r.activity)]);
  const list=[...ids].map(id=>{
    const def=defs.find(a=>a.id===id);
    const rs=mine.filter(r=>r.activity===id);
    const name=def?def.name:(rs.find(r=>r.activityName)?.activityName||id);
    const tasks=rs.filter(r=>r.task).map(r=>({person:r.person,date:r.date,task:r.task,hours:r.hours,estimated:r.estimated})).sort((a,b)=>b.date.localeCompare(a.date));
    return {id,name,status:def?def.status:'sconosciuta',kind:def?.kind||null,start:def?.period_start||null,end:def?.period_end||null,overdue:!!(def && def.status==='open' && def.period_end && def.period_end<today),
      hours:hours(rs.map(r=>({hours:r.hours,estimated:r.estimated}))),people:[...new Set(rs.map(r=>r.person))],tasks};
  }).sort((a,b)=>((b.hours.total||0)-(a.hours.total||0))||String(a.start||'').localeCompare(String(b.start||''))||a.name.localeCompare(b.name));
  const loose=mine.filter(r=>r.activity===NO_ACTIVITY);
  return {activities:list,unassigned:hours(loose.map(r=>({hours:r.hours,estimated:r.estimated}))),unassignedTasks:loose.filter(r=>r.task).length};
}
function buildSnapshot(raw,period,now=new Date()) {
  const today=romeToday(now), cutoff=period.end<today?period.end:today;
  const aliases=new Map((raw.projects||[]).filter(p=>p.merged_into).map(p=>[p.id,p.merged_into]));
  const allLogs=normalizeLogs(raw.time_logs||[]).filter(r=>r.date<=today).map(r=>({...r,project:aliases.get(r.project)||r.project}));
  const logs=allLogs.filter(r=>r.date>=period.start && r.date<=cutoff);
  // Piani delle settimane che iniziano nel periodo (anche future, entro il periodo)
  const allPlans=normalizePlans(raw.time_logs||[]).map(r=>({...r,project:aliases.get(r.project)||r.project}));
  const plans=allPlans.filter(r=>r.week>=periodBounds('week',period.start).start && r.week<=period.end);
  const thisWeek=periodBounds('week',today).start;
  const budgets=raw.giunos_budgets||[];
  const actions=raw.project_actions||[];
  const activityDefs=(raw.project_activities||[]).map(a=>({...a,project_id:canon(aliases,a.project_id)}));
  const actRows=activityRows(logs,raw.standup_entries,aliases);
  const catalogue=(raw.projects||[]).filter(p=>!p.merged_into).map(p=>{
    const dossier=(raw.project_dossiers||[]).find(d=>d.project_id===p.id);
    const evidence=dossier?.dossier||{};
    const b=budgetFor(budgets,p.id,null,period.start,period.end);
    const projectLogs=logs.filter(l=>l.project===p.id);
    const used=hours(projectLogs);
    const projectPlans=plans.filter(r=>r.project===p.id);
    const wholeRows=budgets.filter(b=>b.scope==='project' && b.project_id===p.id && !b.slack_user_id && b.source_url && validDate(b.period_start) && validDate(b.period_end) && b.hours!==null && Number.isFinite(Number(b.hours)) && Number(b.hours)>=0);
    const whole=wholeRows.filter(b=>b.verified===true);
    const wholeBudget=whole.length===1?whole[0]:null;
    const wholeUsed=wholeBudget?hours(allLogs.filter(l=>l.project===p.id && l.date>=wholeBudget.period_start && l.date<=wholeBudget.period_end)):null;
    // Venduto sull'intera commessa: la baseline verificata se c'è; altrimenti
    // la proposta (preventivo, kick-off, deal) SEMPRE marcata come tale.
    const soldRow=wholeBudget||(whole.length===0 && wholeRows.length===1?wholeRows[0]:null);
    const soldUsed=soldRow?hours(allLogs.filter(l=>l.project===p.id && l.date>=soldRow.period_start && l.date<=soldRow.period_end)):null;
    const sold=soldRow?{hours:Number(soldRow.hours),verified:soldRow.verified===true,source:soldRow.source_url,start:soldRow.period_start,end:soldRow.period_end,used:soldUsed,
      remaining:soldUsed&&soldUsed.total!==null?round(Number(soldRow.hours)-soldUsed.total):null,
      ratio:soldUsed&&soldUsed.total!==null&&Number(soldRow.hours)>0?round(soldUsed.total/Number(soldRow.hours)):null,
      conflict:false}:null;
    if(!sold&&wholeRows.length>1) var soldConflict=true;

    const deliveries=Array.isArray(evidence.deliverable)?evidence.deliverable:[];
    const details=deliveries.map(d=>({name:String(d.nome||'Consegna'),status:String(d.stato||'non rilevato')}));
    const deliveryCounts={done:details.filter(d=>/consegnat|approvat|fatt/.test(d.status)).length,inProgress:details.filter(d=>/in corso/.test(d.status)).length,todo:details.filter(d=>/da fare/.test(d.status)).length,total:details.length};
    const milestones=(Array.isArray(evidence.scadenze)?evidence.scadenze:[]).map(m=>({what:String(m.cosa||m.scadenza||''),when:validDate(String(m.quando||'').slice(0,10))?String(m.quando).slice(0,10):(m.quando||null),status:String(m.stato||'aperta'),overdue:validDate(String(m.quando||'').slice(0,10))&&String(m.quando).slice(0,10)<today&&!/fatt|chius|consegnat/.test(String(m.stato||''))}));
    const blocks=(Array.isArray(evidence.rischi_blocchi)?evidence.rischi_blocchi:[]).map(x=>typeof x==='string'?x:String(x.testo||x.rischio||x.cosa||JSON.stringify(x))).filter(Boolean);
    const nextSteps=(Array.isArray(evidence.prossimi_passi)?evidence.prossimi_passi:[]).map(x=>typeof x==='string'?{what:x,who:null,when:null}:{what:String(x.cosa||''),who:x.chi||null,when:x.entro||null}).filter(x=>x.what);
    const projectActions=actions.filter(a=>a.project_id===p.id);
    const openActions=projectActions.filter(a=>a.status==='open'||a.status==='acknowledged');
    const overdueActions=openActions.filter(a=>validDate(a.due_date)&&a.due_date<today);
    const dossierTeam=(Array.isArray(evidence.team)?evidence.team:[]).map(x=>typeof x==='string'?{name:x,role:null}:{name:String(x.nome||x.chi||''),role:x.ruolo||null}).filter(x=>x.name);
    const lifecycle=String(p.id).startsWith('cat_')?'interno':p.status==='completed'?'concluso':p.status==='on_hold'?'sospeso':p.status==='archived'||p.status==='cancelled'?'archiviato':isActiveProject(p,today)?'operativo':p.status==='planning'||p.status==='active'?'da verificare':p.status;
    return {id:p.id,name:p.name,client:p.client_name,status:p.status,lifecycle,owner:p.owner_slack_id,
      evidence:p.lifecycle_evidence&&p.lifecycle_evidence.valid_until?{kind:p.lifecycle_evidence.kind||null,validUntil:p.lifecycle_evidence.valid_until,detail:p.lifecycle_evidence.detail||null}:null,
      wholeBudget:wholeBudget?{hours:Number(wholeBudget.hours),source:wholeBudget.source_url,start:wholeBudget.period_start,end:wholeBudget.period_end,used:wholeUsed}:null,
      sold,soldConflict:!!soldConflict,
      hours:used,planned:planned(projectPlans),plannedPeople:[...new Set(projectPlans.map(r=>r.person))],budget:b,overrun:b&&used.total!==null?round(used.total-b.hours):null,
      lifetime:hours(allLogs.filter(l=>l.project===p.id)),deliveries:details,deliveryCounts,milestones,blocks,nextSteps,
      summary:evidence.stato_sintesi||null,phase:evidence.fase||null,updatedAt:dossier?.updated_at||null,
      deadlines:Array.isArray(evidence.scadenze)?evidence.scadenze:[],
      team: [...new Set(projectLogs.map(l=>l.person))],dossierTeam,
      categories:categoryHours(projectLogs,raw.standup_entries,aliases),
      ...projectActivities(p.id,actRows,activityDefs,period,today),
      documents:(raw.project_documents||[]).filter(d=>d.project_id===p.id).map(d=>({name:d.file_name,url:d.drive_link})),
      actions:projectActions.map(a=>({id:a.id,name:a.description,status:a.status,due:a.due_date,assignee:a.assignee_slack_id})),
      openActions:openActions.length,overdueActions:overdueActions.length};
  });
  const activeIds=new Set((raw.projects||[]).filter(p=>isActiveProject(p,today)).map(p=>p.id));
  const projects=catalogue.filter(p=>activeIds.has(p.id));
  const peopleIds=new Set([...(raw.team_members||[]).filter(m=>m.active!==false).map(m=>m.slack_user_id),...logs.map(l=>l.person)]);
  const people=[...peopleIds].map(id=>{
    const member=(raw.team_members||[]).find(m=>m.slack_user_id===id);
    const mine=logs.filter(l=>l.person===id);
    const myPlans=plans.filter(r=>r.person===id);
    const closed=actions.filter(a=>a.assignee_slack_id===id && a.status==='done' && a.done_at && a.done_at.slice(0,10)>=period.start && a.done_at.slice(0,10)<=cutoff);
    const durations=closed.filter(a=>validDate(a.created_at?.slice(0,10)) && Date.parse(a.done_at)>=Date.parse(a.created_at)).map(a=>(Date.parse(a.done_at)-Date.parse(a.created_at))/day).sort((a,b)=>a-b);
    const median=durations.length ? round((durations[Math.floor((durations.length-1)/2)]+durations[Math.floor(durations.length/2)])/2):null;
    const buckets=new Map();
    for(let d=new Date(period.start);iso(d)<=cutoff;d=new Date(d.getTime()+day)) {const key=period.kind==='week'?iso(d):periodBounds('week',iso(d)).start;buckets.set(key,{date:key,hours:null,projects:{}});}
    mine.forEach(l=>{const key=period.kind==='week'?l.date:periodBounds('week',l.date).start;const bucket=buckets.get(key);if(bucket){bucket.hours=round((bucket.hours||0)+l.hours);bucket.projects[l.project]=round((bucket.projects[l.project]||0)+l.hours);}});
    return {id,name:member?.canonical_name||id,role:member?.role||null,hours:hours(mine),
      planned:planned(myPlans),plannedProjects:[...new Set(myPlans.map(r=>r.project))].map(pid=>({id:pid,name:(raw.projects||[]).find(p=>p.id===pid)?.name||pid,hours:planned(myPlans.filter(r=>r.project===pid))})),
      plannedThisWeek:planned(allPlans.filter(r=>r.person===id&&r.week===thisWeek)),
      projects:[...new Set(mine.map(l=>l.project))].map(pid=>{const ph=hours(mine.filter(l=>l.project===pid));const tot=hours(mine).total;return {id:pid,name:(raw.projects||[]).find(p=>p.id===pid)?.name||pid,status:(raw.projects||[]).find(p=>p.id===pid)?.status||'unknown',hours:ph,share:tot&&ph.total!==null?Math.round(ph.total/tot*100):null,budget:budgetFor(budgets,pid,id,period.start,period.end)};}).sort((a,b)=>(b.hours.total||0)-(a.hours.total||0)),
      internal:[...new Set(mine.filter(l=>String(l.project).startsWith('cat_')).map(l=>l.project))].map(pid=>({id:pid,name:(raw.projects||[]).find(p=>p.id===pid)?.name||pid,hours:hours(mine.filter(l=>l.project===pid)).total})),
      internalShare:(()=>{const tot=hours(mine).total;const int=hours(mine.filter(l=>String(l.project).startsWith('cat_'))).total;return tot?Math.round((int||0)/tot*100):null;})(),
      closed:raw.project_actions===null?null:closed.length,medianDays:median,closureSample:durations.length,
      categories:categoryHours(mine,raw.standup_entries,aliases),
      activities:[...new Set(mine.map(l=>l.project))].map(pid=>{const pa=projectActivities(pid,actRows.filter(r=>r.person===id),activityDefs,period,today);return {project:pid,name:(raw.projects||[]).find(p=>p.id===pid)?.name||pid,activities:pa.activities.filter(a=>a.hours.total!==null).map(a=>({id:a.id,name:a.name,status:a.status,hours:a.hours,tasks:a.tasks})),unassigned:pa.unassigned,unassignedTasks:actRows.filter(r=>r.person===id&&r.project===pid&&r.activity===NO_ACTIVITY&&r.task).map(r=>({date:r.date,task:r.task,hours:r.hours,estimated:r.estimated})).sort((a,b)=>b.date.localeCompare(a.date))};}).filter(x=>x.activities.length||x.unassignedTasks.length),
      projectCategories:Object.fromEntries([...new Set(mine.map(l=>l.project))].map(pid=>[pid,categoryHours(mine.filter(l=>l.project===pid),raw.standup_entries,aliases)])),
      closureTypes:[...new Set(closed.map(a=>category(a.description)))].map(name=>{const cases=closed.filter(a=>category(a.description)===name);const values=cases.filter(a=>Date.parse(a.done_at)>=Date.parse(a.created_at)).map(a=>(Date.parse(a.done_at)-Date.parse(a.created_at))/day).sort((a,b)=>a-b);return {name,count:cases.length,medianDays:values.length?round((values[Math.floor((values.length-1)/2)]+values[Math.floor(values.length/2)])/2):null};}),
      buckets:[...buckets.values()]};
  });
  // Segnali, in ordine di gravità: sforamenti verificati, sforamenti sulla
  // commessa, blocchi dichiarati, azioni e milestone scadute, ore senza venduto.
  const alerts=[];
  projects.filter(p=>p.overrun>0).forEach(p=>alerts.push({project:p.id,kind:'overrun',title:p.name+' · oltre budget',detail:round(p.overrun)+' h oltre le ore vendute nel periodo'}));
  projects.filter(p=>p.sold&&p.sold.verified&&p.sold.remaining!==null&&p.sold.remaining<0).forEach(p=>alerts.push({project:p.id,kind:'sold',title:p.name+' · oltre il venduto',detail:round(-p.sold.remaining)+' h oltre le '+p.sold.hours+' h vendute sulla commessa'}));
  projects.filter(p=>p.sold&&p.sold.verified&&p.sold.ratio!==null&&p.sold.ratio>=0.8&&p.sold.remaining>=0).forEach(p=>alerts.push({project:p.id,kind:'sold_near',title:p.name+' · venduto quasi esaurito',detail:Math.round(p.sold.ratio*100)+'% delle ore vendute già utilizzate'}));
  projects.filter(p=>p.blocks.length).forEach(p=>alerts.push({project:p.id,kind:'block',title:p.name+' · blocco segnalato',detail:p.blocks[0].slice(0,120)}));
  projects.filter(p=>p.overdueActions>0).forEach(p=>alerts.push({project:p.id,kind:'overdue',title:p.name+' · azioni scadute',detail:p.overdueActions+' azioni dalle call oltre la scadenza'}));
  projects.filter(p=>p.milestones.some(m=>m.overdue)).forEach(p=>alerts.push({project:p.id,kind:'milestone',title:p.name+' · milestone scaduta',detail:p.milestones.find(m=>m.overdue).what.slice(0,120)}));
  projects.filter(p=>p.phase==='in attesa cliente').forEach(p=>alerts.push({project:p.id,kind:'waiting',title:p.name+' · attesa cliente',detail:'Stato ricostruito dal dossier di progetto'}));
  projects.filter(p=>!p.sold&&p.hours.total>0).forEach(p=>alerts.push({project:p.id,kind:'nosold',title:p.name+' · ore senza venduto',detail:round(p.hours.total)+' h nel periodo, nessun budget ore sulla commessa'}));
  const candidates=catalogue.filter(p=>p.lifecycle==='da verificare');
  // Cliente → commesse: il cliente è client_name (o il nome stesso), le commesse operative sotto.
  const clientKey=p=>String(p.client||p.name||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()||p.id;
  const clientsMap=new Map();
  projects.forEach(p=>{const k=clientKey(p);if(!clientsMap.has(k))clientsMap.set(k,{key:k,name:p.client||p.name,projects:[]});clientsMap.get(k).projects.push(p.id);});
  const clients=[...clientsMap.values()].map(c=>{const ids=new Set(c.projects);const cl=logs.filter(l=>ids.has(l.project));const ps=projects.filter(p=>ids.has(p.id));
    return {...c,hours:hours(cl),soldVerified:round(ps.filter(p=>p.sold&&p.sold.verified).reduce((s,p)=>s+p.sold.hours,0)),soldProposed:round(ps.filter(p=>p.sold&&!p.sold.verified).reduce((s,p)=>s+p.sold.hours,0)),
      blocks:ps.reduce((s,p)=>s+p.blocks.length,0),overdue:ps.reduce((s,p)=>s+p.overdueActions+p.milestones.filter(m=>m.overdue).length,0)};})
    .sort((a,b)=>((b.hours.total||0)-(a.hours.total||0))||a.name.localeCompare(b.name));
  // Interno: le attività trasversali (cat_*), sempre visibili, senza venduto.
  const internal=catalogue.filter(p=>p.lifecycle==='interno').map(p=>({id:p.id,name:p.name,hours:p.hours,lifetime:p.lifetime,planned:p.planned,plannedPeople:p.plannedPeople,categories:p.categories,team:p.team,activities:p.activities,unassigned:p.unassigned,unassignedTasks:p.unassignedTasks})).sort((a,b)=>(b.hours.total||0)-(a.hours.total||0));
  const internalHours=hours(logs.filter(l=>String(l.project).startsWith('cat_')));
  const clientHours=hours(logs.filter(l=>!String(l.project).startsWith('cat_')));
  return {period:{...period,cutoff},fetchedAt:now.toISOString(),mode:raw.mode||'live',warnings:[...(raw.warnings||[]),...(candidates.length?[candidates.length+' progetti acquisiti attendono un\'evidenza operativa e non sono conteggiati tra gli attivi. Le ore storiche restano nei consuntivi.']:[])],projects,clients,internal,internalHours,clientHours,planned:planned(plans),plannerCoverage:{week:thisWeek,people:people.filter(u=>(raw.team_members||[]).some(m=>m.slack_user_id===u.id&&m.active!==false)).length,planned:people.filter(u=>u.plannedThisWeek!==null).length},internalShare:hours(logs).total?Math.round((internalHours.total||0)/hours(logs).total*100):null,candidateProjects:candidates,historicalProjects:catalogue.filter(p=>!activeIds.has(p.id)&&p.lifecycle!=='da verificare'&&p.lifecycle!=='interno'),people,alerts:alerts.slice(0,8),hours:hours(logs),categories:categoryHours(logs,raw.standup_entries,aliases),coverage:{people:people.length,peopleWithHours:people.filter(u=>u.hours.total!==null).length,peopleOnlyEstimates:people.filter(u=>u.hours.total!==null&&!u.hours.recorded).length}};
}
module.exports={CATEGORY_RULES,category,categoryHours,activityRows,projectActivities,normalizePlans,periodBounds,validDate,romeToday,normalizeLogs,hours,budgetFor,buildSnapshot};
