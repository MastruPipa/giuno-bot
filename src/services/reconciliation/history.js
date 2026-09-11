'use strict';
// Review historical evidence without mutating the canonical time ledger.
// Project aliases are explicit, unique mappings from source investigation.
function norm(s){return String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}
function matches(text,aliases) {
  const t=' '+norm(text)+' ';
  return Object.entries(aliases).filter(([,names])=>names.some(n=>norm(n)&&t.includes(' '+norm(n)+' '))).map(([id])=>id);
}
function reconcileHistory({logs=[],standups=[],legacy=[],aliases={},projectIds=null}) {
  logs=logs||[];standups=standups||[];legacy=legacy||[];
  const candidates=[],reviews=[];
  const key=r=>JSON.stringify([r.slack_user_id,r.project_id,r.log_date]);
  const known=new Map(logs.filter(r=>r.log_type==='daily').map(r=>[key(r),r]));
  for(const log of logs.filter(r=>r.log_type==='daily')) {
    const related=standups.filter(s=>s.slack_user_id===log.slack_user_id&&s.date===log.log_date);
    const tasks=related.flatMap(s=>s.oggi_tasks||[]).filter(t=>t.project_id===log.project_id);
    const issues=[];
    if(tasks.some(t=>matches(t.task,aliases).length>1))issues.push('La descrizione include più progetti: ore non separabili.');
    if(log.notes==='auto: dal daily' && !log.validation?.source)issues.push('Daily storico: verificare se oggi indicava pianificato o svolto.');
    if(!tasks.length)issues.push('Nessun dettaglio svolto collegato alla data del registro.');
    if(issues.length)reviews.push({record_id:log.id,project_id:log.project_id,hours:Number(log.hours),issues});
  }
  for(const entry of standups) {
    for(const [field,meaning] of [['ieri_tasks','previous_day_report'],['oggi_tasks','unknown_historical_meaning']]) {
      for(const [index,task] of (entry[field]||[]).entries()) {
        const ids=matches(task.task,aliases);
        if(!ids.length || (projectIds && !ids.some(id=>projectIds.includes(id))))continue;
        const h=Number(task.hours||0)+Number(task.minutes||0)/60;
        if(!Number.isFinite(h)||h<=0)continue;
        const pid=ids.length===1?ids[0]:null;
        candidates.push({source_key:JSON.stringify([entry.slack_user_id,entry.date,field,index]),
          reported_on:entry.date,work_date:null,person:entry.slack_user_id,project_id:pid,
          hours:h,meaning,description:task.task,status:'needs_evidence',
          overlaps_canonical:!!(pid&&known.has(key({slack_user_id:entry.slack_user_id,project_id:pid,log_date:entry.date}))),
          issues:ids.length>1?['Più progetti nella stessa durata.']:['Confermare data effettiva e significato del daily prima di importare.']});
      }
    }
  }
  for(const entry of legacy)candidates.push({source_key:'time_entries:'+entry.id,status:'needs_evidence',person:entry.slack_user_id,project_id:entry.project_id,hours:entry.hours,issues:['Registro alternativo: verificare sovrapposizioni prima di importare.']});
  return {reviews,candidates,importable:[],note:'Le ore candidate non si sommano al consuntivo.'};
}
module.exports={reconcileHistory,matches};
