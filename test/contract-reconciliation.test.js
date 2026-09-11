'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {extractEconomics}=require('../src/services/reconciliation/economics');
const {assessContract,projectBudgets}=require('../src/services/reconciliation/contracts');
const {reconcileHistory}=require('../src/services/reconciliation/history');
const {refreshInput}=require('../src/services/reconciliation/refresh');
const {budgetFor,buildSnapshot,periodBounds}=require('../src/giunos/model');
const ev={url:'https://example.com/source',revision:'v1'};
function sample(){return {file_id:'sheet',revision:'v1',range:"'2. Effort team'!A1:Z100",values:[
 ['Effort estimate',null,null,'Design'],[null,null,null,'Designer'],['People involved:',null,null,'A'],
 ['Project activities','M/D','Price (€ )',600],['#1 Production',2,1200],['Design',2,1200,2],
 ['TOT. (IVA esclusa)',2,1200,1200],['per ROLE','M/D',null,2]]};}
function valid(){return {project_id:'p',contract:{...ev,file_id:'contract'},scope:'period',period_start:'2026-09-01',period_end:'2026-09-30',
 acceptance:{...ev,contract_revision:'v1'},scope_link:{...ev,contract_revision:'v1',economics_revision:'v1'},
 day_conversion:{...ev,hours_per_day:8},cycle_evidence:ev,sheet:sample()};}
test('economics excludes subtotals, prices and rate card; preserves cell provenance',()=>{
 const r=extractEconomics(sample());assert.equal(r.issues.length,0);assert.equal(r.lines.length,1);
 assert.equal(r.lines[0].quantity,2);assert.equal(r.lines[0].unit,'day');assert.equal(r.lines[0].source.cell,'D6');
});
test('malformed quantity, unknown role, mismatched totals and partial sheets block verification',()=>{
 for(const mutate of [s=>s.values[5][3]='0,.5',s=>s.values[1][3]='markup',s=>s.values[7][3]=4,s=>s.values.pop()]) {
  const s=sample();mutate(s);assert.equal(extractEconomics(s).complete,false);
 }
});
test('sold hours require accepted revision, matching scope and explicit conversion',()=>{
 assert.equal(assessContract(valid()).hours,16);
 for(const field of ['acceptance','scope_link','day_conversion','cycle_evidence','contract']){
  const input=valid();delete input[field];const a=assessContract(input);assert.equal(a.hours,null);assert.equal(a.status,'needs_evidence');
 }
 const changed=valid();changed.sheet.revision='v2';assert.equal(assessContract(changed).hours,null);
 const conflicted=valid();conflicted.conflicts=['Photography versus video'];assert.equal(assessContract(conflicted).hours,null);
});
test('overlapping accepted revisions produce no budget; individual hours are not inferred from names',()=>{
 const input=valid();assert.equal(projectBudgets([input]).rows[0].slack_user_id,null);
 const other=valid();other.contract={...ev,url:'https://example.com/other'};
 assert.equal(projectBudgets([input,other]).rows.length,0);
});
test('quarter aggregates three complete monthly budgets, never partial cycles or duplicates',()=>{
 const rows=[['07','31'],['08','31'],['09','30']].map(([m,d])=>({project_id:'p',scope:'period',verified:true,source_url:ev.url,hours:10,period_start:'2026-'+m+'-01',period_end:'2026-'+m+'-'+d}));
 assert.equal(budgetFor(rows,'p',null,'2026-07-01','2026-09-30').hours,30);
 assert.equal(budgetFor(rows.slice(1),'p',null,'2026-07-01','2026-09-30'),null);
 assert.equal(budgetFor([...rows,rows[0]],'p',null,'2026-07-01','2026-09-30'),null);
 assert.equal(budgetFor(rows,'p',null,'2026-07-06','2026-07-12'),null);
});
test('historical review detects mixed clients without shifting yesterday or importing duplicate hours',()=>{
 const log={id:'l',slack_user_id:'u',project_id:'p',log_date:'2026-07-21',log_type:'daily',hours:1.5,notes:'auto: dal daily'};
 const standup={slack_user_id:'u',date:'2026-07-21',oggi_tasks:[{task:'Client A + Client B',hours:1,minutes:30,project_id:'p'}],ieri_tasks:[{task:'Client A',hours:2}]};
 const r=reconcileHistory({logs:[log],standups:[standup],legacy:null,aliases:{p:['Client A'],q:['Client B']}});
 assert.equal(r.importable.length,0);assert.equal(r.candidates[1].project_id,null);
 assert.equal(r.candidates[0].work_date,null);assert.equal(r.reviews[0].issues.length,2);
});
test('changed or unavailable source invalidates baseline; refresh cannot retain stale verification',async()=>{
 const input=valid();let calls=0;
 const drive={files:{get:async({fileId})=>({data:{modifiedTime:fileId==='sheet'?'v2':'v1'}})}};
 const sheets={spreadsheets:{values:{get:async()=>{calls++;return {data:{values:sample().values,range:sample().range}};}}}};
 const out=await refreshInput(input,drive,sheets);assert.equal(calls,1);assert.equal(assessContract(out).hours,null);
 const failed=await refreshInput(input,{files:{get:async()=>{throw Error('offline');}}},sheets);
 assert.equal(assessContract(failed).hours,null);assert.ok(failed.read_error);
});
test('dashboard consumes only freshly verified contract projections and reports evidence gaps',()=>{
 const raw={projects:[{id:'p',name:'Project'}],project_contract_sources:[{project_id:'p',input:valid(),updated_at:'2026-09-10T08:00:00Z'}]};
 const snapshot=buildSnapshot(raw,periodBounds('month','2026-09-10'),new Date('2026-09-10T12:00:00Z'));
 assert.equal(snapshot.projects[0].budget.hours,16);
 raw.project_contract_sources[0].updated_at='2026-09-01T00:00:00Z';
 const stale=buildSnapshot(raw,periodBounds('month','2026-09-10'),new Date('2026-09-10T12:00:00Z'));
 assert.equal(stale.projects[0].budget,null);assert.equal(stale.projects[0].contractEvidence[0].status,'needs_evidence');
});
test('documented assignment exposes a role but never invents person hours',()=>{
 const input=valid();input.assignments=[{slack_user_id:'u',role:'PM',source:ev}];
 const a=assessContract(input);assert.equal(a.assignments[0].hours,null);
 assert.equal(projectBudgets([input]).rows.length,1);
});
test('context-only project aliases detect mixing without generating unrelated candidates',()=>{
 const r=reconcileHistory({projectIds:['p'],aliases:{p:['Alpha'],q:['Beta']},standups:[{date:'2026-07-01',slack_user_id:'u',oggi_tasks:[{task:'Beta',hours:1},{task:'Alpha + Beta',hours:2}]}]});
 assert.equal(r.candidates.length,1);assert.equal(r.candidates[0].project_id,null);
});
