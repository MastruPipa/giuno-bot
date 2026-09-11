'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {createRequire} = require('node:module');
function load(file, stubs) {
  const filename = path.resolve(__dirname,'..',file);
  const native = createRequire(filename);
  const mod = {exports:{}};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{
    module:mod,exports:mod.exports,require:n => Object.hasOwn(stubs,n) ? stubs[n] : native(n),
    console,process,setTimeout,clearTimeout,Buffer,
  },{filename});
  return mod.exports;
}
const quiet = {info(){},warn(){},error(){},debug(){}};
test('daily free text calls SDK and returns normalized work',async () => {
  let calls=0;
  function SDK() {this.messages={create:async () => {
    calls++; return {content:[{text:JSON.stringify({oggi:[{task:'Design progetto',hours:2}],domani:[]})}]};
  }};}
  const parser=load('src/services/dailyParser.js',{'@anthropic-ai/sdk':SDK,'../utils/logger':quiet});
  const result=await parser.parseDailyText('Ho lavorato due ore al design del progetto');
  assert.equal(calls,1);
  assert.equal(result.oggi[0].hours,2);
});
test('timeout accepts promises, lazy calls, failures and releases timer',async () => {
  const {withTimeout}=require('../src/utils/timeout');
  assert.equal(await withTimeout(Promise.resolve(1),1000,'a'),1);
  assert.equal(await withTimeout(() => 2,1000,'a'),2);
  await assert.rejects(withTimeout(() => {throw Error('failure');},1000,'a'),/failure/);
  await assert.rejects(withTimeout(() => new Promise(()=>{}),5,'a'),/timeout/);
});
test('Attio outage and pagination cap never archive projects',async () => {
  for (const query of [async()=>{throw Error('offline');},async()=>Array.from({length:50},(_,i)=>({record_id:String(i),values:{name:'Project',stage:'in progress'}}))]) {
    let archived=0;
    const sync=load('src/jobs/projectSyncJob.js',{
      '../utils/logger':quiet,'../services/attioService':{isConfigured:()=>true,queryRecords:query},
      '../../supabase':{isSupabase:()=>true,archiveStaleSyncedProjects:async()=>{archived++;}},
      '../services/slackService':{},
    });
    await assert.rejects(sync.syncActiveProjectsFromAttio());
    assert.equal(archived,0);
  }
});
test('both chat tools use same total writer without touching monetary budgets',async () => {
  const calls=[];
  const writer={recordDailyTotal:async input=>{calls.push(input);return {success:true};}};
  const stubs={'../../supabase':{getClient:()=>({})},'../services/timeRecording':writer};
  const agency=load('src/tools/agencyTools.js',stubs);
  const project=load('src/tools/projectTools.js',stubs);
  await agency.execute('log_time',{project_id:'p1',hours:3,date:'2026-09-10'},'U1','member');
  await project.execute('log_hours',{project_id:'p1',hours:3,date:'2026-09-10'},'U1','member');
  assert.equal(calls.length,2);
  assert.equal(calls[0].projectId,calls[1].projectId);
  assert.equal(calls[0].hours,calls[1].hours);
  assert.equal(calls[0].date,calls[1].date);
  const denied=await project.execute('log_hours',{project_id:'p1',hours:3,slack_user_id:'U2'},'U1','member');
  assert.ok(denied.error);
  assert.equal(calls.length,2);
});
test('daily total writer reports database failure and preserves source',async () => {
  let payload;
  const db={saveTimeLogs:async rows=>{payload=rows;return rows;},syncAllocationHoursLogged:async()=>null};
  const svc=load('src/services/timeRecording.js',{'./db/timeLogs':db});
  const input={userId:'U1',projectId:'p1',date:'2026-09-10',hours:0.25};
  const result=await svc.recordDailyTotal(input);
  assert.equal(result.success,true);
  assert.ok(result.warning);
  assert.equal(payload[0].validation.status,'declared');
  assert.equal(payload[0].validation.billable,null);
  assert.ok((await svc.recordDailyTotal({...input,hours:-1})).error);
  assert.ok((await svc.recordDailyTotal({...input,date:'2026-02-30'})).error);
  db.saveTimeLogs=async()=>null;
  assert.ok((await svc.recordDailyTotal(input)).error);
});
test('dossier cron keeps lock until work finishes and reports failures',async () => {
  let task, releaseWork, releases=0;
  let work = new Promise(resolve=>{releaseWork=resolve;});
  const scheduler=load('src/jobs/scheduler.js',{
    'node-cron':{schedule:(_expr,fn)=>{task=fn;return {}; }},
    '../utils/logger':quiet,
    '../services/db/cron':{acquireCronLock:async()=>true,releaseCronLock:async()=>{releases++;}},
  });
  const source=fs.readFileSync(path.join(__dirname,'../src/handlers/cronHandlers.js'),'utf8');
  const match=source.match(/cron\.schedule\([^\n]+, function\(\) \{\n\s+var \{ refreshDossiers \}[^\n]+\n([^]*?)\n  \}, \{[^\n]+name: '([^']+)'[^\n]+\}\);/);
  assert.ok(match,'actual dossier callback found');
  const fn=vm.runInNewContext('(function(){'+match[1]+'})',{
    refreshDossiers:()=>work,logger:quiet,
  });
  scheduler.schedule('* * * * *',fn,{name:match[2],lockTtl:10});
  const run=task();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(scheduler.listJobs()[0].running,true);
  assert.equal(releases,0);
  releaseWork(); await run;
  assert.equal(releases,1);
  work=Promise.reject(Error('source failed'));
  await task();
  assert.equal(scheduler.listJobs()[0].failures,1);
});
test('empty archive snapshot is never sent to the database',async()=>{
  const db=load('src/services/db/projects.js',{'./client':{useSupabase:true,getClient:()=>{throw Error('must not write');}}});
  assert.equal(await db.archiveStaleSyncedProjects('attio_%',[]),0);
});
test('RPC failure has no destructive nontransactional fallback',async()=>{
  let calls=0;
  const db=load('src/services/db/timeLogs.js',{'./client':{
    useSupabase:true,logErr(){},getClient:()=>({rpc:async()=>{calls++;return {error:Error('missing migration')};}}),
  }});
  assert.equal(await db.replaceTimeLogs('U1','2026-09-10','daily',[]),null);
  assert.equal(calls,1);
});
test('scheduler skips overlapping lock acquisition and fails closed on outage',async()=>{
  let task, resolveLock, calls=0, runs=0;
  const gate=new Promise(resolve=>{resolveLock=resolve;});
  const locks={acquireCronLock:()=>{calls++;return gate;},releaseCronLock:async()=>{}};
  const scheduler=load('src/jobs/scheduler.js',{
    'node-cron':{schedule:(_e,fn)=>{task=fn;return {};}},
    '../utils/logger':quiet,'../services/db/cron':locks,
  });
  scheduler.schedule('* * * * *',async()=>{runs++;},{name:'test',lockTtl:10});
  const first=task();
  await task();
  assert.equal(calls,1);
  resolveLock(true); await first;
  assert.equal(runs,1);
  locks.acquireCronLock=async()=>{throw Error('DB unavailable');};
  await task();
  assert.equal(runs,1);
  assert.equal(scheduler.listJobs()[0].lastError,'DB unavailable');
});
test('Attio commercial stages never become operational projects',async()=>{
  const rows=[];
  const sync=load('src/jobs/projectSyncJob.js',{
    '../utils/logger':quiet,'../services/attioService':{isConfigured:()=>true,queryRecords:async()=>['In Progress','Contratto','Proposta','Lost','Not won','Won 🎉'].map((stage,i)=>({record_id:String(i),values:{name:'Client '+i,stage}}))},
    '../../supabase':{isSupabase:()=>true,upsertSyncedProject:async row=>{rows.push(row);return row;},archiveStaleSyncedProjects:async()=>0},
  });
  await sync.syncActiveProjectsFromAttio();
  assert.equal(rows.length,1);
  assert.equal(rows[0].id,'attio_5');
  assert.equal(rows[0].status,'planning');
  assert.ok(rows[0].tags.includes('sales:won'));
});
test('source sync cannot reactivate closed projects or write after failed status lookup',async()=>{
 for(const status of ['completed','cancelled','archived','merged','on_hold','error']) {
  let writes=0;
  const query={select(){return this;},eq(){return this;},maybeSingle:async()=>status==='error'?{error:Error('offline')}:{data:{id:'p',status}},upsert(){writes++;throw Error('unexpected');}};
  const db=load('src/services/db/projects.js',{'./client':{useSupabase:true,getClient:()=>({from:()=>query}),logErr(){}}});
  const result=await db.upsertSyncedProject({id:'p',status:'active'});
  assert.equal(writes,0);
  if(status==='error') assert.equal(result,null); else assert.equal(result.status,status);
 }
});
