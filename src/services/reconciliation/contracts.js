'use strict';
const {createHash}=require('node:crypto');
const {extractEconomics}=require('./economics');
function date(s){return typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;}
function evidence(e){return e && typeof e.url==='string' && /^https:\/\//.test(e.url) && typeof e.revision==='string' && e.revision.length>0;}
function assessContract(input) {
  const extracted=input.sheet?extractEconomics(input.sheet):{lines:[],issues:['Economics non trovato.'],complete:false};
  const issues=[...extracted.issues,...(input.conflicts||[])];
  if(input.read_error)issues.push('Fonte non aggiornata: '+input.read_error);
  const acceptance=input.acceptance;
  if(!evidence(input.contract))issues.push('Documento contrattuale e revisione non identificati.');
  if(!evidence(acceptance)||acceptance.contract_revision!==input.contract?.revision)issues.push('Accettazione della specifica revisione non verificata.');
  if(!evidence(input.scope_link)||input.scope_link.economics_revision!==input.sheet?.revision||input.scope_link.contract_revision!==input.contract?.revision)issues.push('Collegamento tra economics e perimetro accettato non verificato.');
  if(!input.project_id)issues.push('Progetto non identificato.');
  if(!['project','period'].includes(input.scope)||!date(input.period_start)||!date(input.period_end)||input.period_end<input.period_start)issues.push('Periodo del budget non definito.');
  const conversion=input.day_conversion;
  if(!evidence(conversion)||typeof conversion.hours_per_day!=='number'||conversion.hours_per_day<=0||conversion.hours_per_day>24)issues.push('Conversione giornate/ore non documentata.');
  if(input.scope==='period'&&!evidence(input.cycle_evidence))issues.push('Budget del ciclo non documentato: nessuna ripartizione automatica.');
  const ready=issues.length===0;
  const roleBudgets=[];
  if(ready) {
    const groups=new Map();
    for(const line of extracted.lines) {
      const key=JSON.stringify([line.area,line.role]);
      const group=groups.get(key)||{area:line.area,role:line.role,hours:0,sources:[]};
      group.hours+=line.quantity*conversion.hours_per_day;group.sources.push(line.source);groups.set(key,group);
    }
    roleBudgets.push(...[...groups.values()].map(g=>({...g,hours:Math.round(g.hours*100)/100})));
  }
  return {id:createHash('sha256').update(JSON.stringify([input.project_id,input.contract?.url,input.contract?.revision,input.sheet?.file_id,input.sheet?.revision,input.scope,input.period_start,input.period_end])).digest('hex'),
    project_id:input.project_id,status:ready?'verified':'needs_evidence',scope:input.scope,
    period_start:input.period_start||null,period_end:input.period_end||null,
    assignments:(input.assignments||[]).filter(a=>a.slack_user_id && a.role && evidence(a.source)).map(a=>({person:a.slack_user_id,role:a.role,source:a.source,valid_from:a.valid_from||null,valid_to:a.valid_to||null,hours:null})),
    source:input.contract||null,issues:[...new Set(issues)],effort:extracted.lines,role_budgets:roleBudgets,
    hours:ready?Math.round(roleBudgets.reduce((s,r)=>s+r.hours,0)*100)/100:null};
}
function projectBudgets(inputs) {
  const assessments=inputs.map(assessContract), rows=[];
  for(const a of assessments.filter(a=>a.status==='verified')) {
    const overlap=assessments.filter(b=>b.status==='verified'&&b.project_id===a.project_id&&b.scope===a.scope&&b.period_start<=a.period_end&&b.period_end>=a.period_start);
    if(overlap.length!==1){a.status='conflict';a.issues.push('Revisioni o budget sovrapposti: scegliere la baseline valida.');continue;}
    rows.push({project_id:a.project_id,slack_user_id:null,scope:a.scope,period_start:a.period_start,period_end:a.period_end,hours:a.hours,verified:true,source_url:a.source.url,source_revision:a.source.revision});
  }
  // A later conflicting assessment must not leave the first projection alive.
  return {assessments,rows:rows.filter(r=>!assessments.some(a=>a.status==='conflict'&&a.project_id===r.project_id&&a.scope===r.scope&&a.period_start<=r.period_end&&a.period_end>=r.period_start))};
}
module.exports={assessContract,projectBudgets};
