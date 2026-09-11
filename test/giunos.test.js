'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {periodBounds,normalizeLogs,buildSnapshot,categoryHours}=require('../src/giunos/model');
const {createHandler}=require('../src/giunos/handler');
const {readTable,loadRaw}=require('../src/giunos/data');
const now=new Date('2026-09-10T12:00:00Z'),period=periodBounds('month','2026-09-10');
const log=(extra={})=>({slack_user_id:'u',project_id:'p',log_type:'daily',log_date:'2026-09-08',hours:2,...extra});
const raw=(extra={})=>({projects:[{id:'p',name:'Project',status:'active'}],team_members:[{slack_user_id:'u',canonical_name:'Person'}],time_logs:[],project_actions:[],...extra});
test('periods use calendar boundaries, Monday weeks, leap years and reject bad dates',()=>{
  assert.deepEqual(periodBounds('week','2026-01-01'),{kind:'week',start:'2025-12-29',end:'2026-01-04'});
  assert.equal(periodBounds('month','2024-02-12').end,'2024-02-29');
  assert.equal(periodBounds('quarter','2026-12-31').start,'2026-10-01');
  assert.throws(()=>periodBounds('month','2026-02-30'));
  assert.throws(()=>periodBounds('year','2026-09-10'));
});
test('weekly plans excluded, duplicate daily corrections replace old hours, estimates separate',()=>{
 const s=buildSnapshot(raw({time_logs:[log({hours:1,updated_at:'2026-09-08'}),log({hours:3,updated_at:'2026-09-09'}),log({log_type:'weekly',hours:20}),log({log_date:'2026-09-09',hours:2,validation:{status:'estimate'}})]}),period,now);
 assert.deepEqual(s.hours,{recorded:3,estimated:2,total:5});
});
test('missing data stays null and future/out-of-period entries are excluded',()=>{
 const s=buildSnapshot(raw({time_logs:[log({log_date:'2026-10-01'}),log({log_date:'2026-08-31'})]}),period,now);
 assert.equal(s.hours.total,null);assert.equal(s.projects[0].lifetime.total,2);assert.equal(s.people[0].buckets[0].hours,null);
 assert.equal(normalizeLogs([log({hours:null}),log({hours:-1}),log({hours:'x'})]).length,0);
});
test('budgets require verified provenance and exactly matching scope; person budget not project sold',()=>{
 const b={project_id:'p',hours:1,period_start:period.start,period_end:period.end,verified:true,source_url:'https://example.org/contract'};
 let s=buildSnapshot(raw({time_logs:[log()],giunos_budgets:[b]}),period,now);assert.equal(s.projects[0].overrun,1);
 for(const budgets of [[{...b,verified:false}],[{...b,slack_user_id:'u'}],[{...b,period_start:'2026-07-01'}],[b,b]]){
 s=buildSnapshot(raw({time_logs:[log()],giunos_budgets:budgets}),period,now);assert.equal(s.projects[0].budget,null);}
});
test('task closures require explicit done date; acknowledgment does not close an action',()=>{
 const actions=[{assignee_slack_id:'u',status:'acknowledged',done_at:'2026-09-09'}, {assignee_slack_id:'u',status:'done'}, {assignee_slack_id:'u',status:'done',done_at:'2026-09-09T12:00:00Z',created_at:'2026-09-07T12:00:00Z'}];
 const s=buildSnapshot(raw({project_actions:actions}),period,now);assert.equal(s.people[0].closed,1);assert.equal(s.people[0].medianDays,2);
 assert.equal(buildSnapshot(raw({project_actions:null}),period,now).people[0].closed,null);
});
test('classification never introduces hours from a mismatched daily',()=>{
 const logs=normalizeLogs([log()]);const entry={slack_user_id:'u',date:'2026-09-08',source:'dm',oggi_tasks:[{project_id:'p',task:'Revisioni',hours:3}]};
 assert.deepEqual(categoryHours(logs,[entry]),[{name:'Non classificato',hours:2}]);entry.oggi_tasks[0].hours=2;
 assert.deepEqual(categoryHours(logs,[entry]),[{name:'Revisioni',hours:2}]);
});
async function request(handler,pathname,query={},headers={},method='GET') {let status,body,responseHeaders;await handler({method,headers},{writeHead(s,h){status=s;responseHeaders=h;},end(b){body=b;}},{pathname,query});return {status,body,headers:responseHeaders};}
test('API auth denies URL token, read-only methods, and invalid periods before data access',async()=>{
 let loads=0;const handler=createHandler({getClient:()=>null,authorize:(req,p)=>req.headers['x-admin-token']==='secret'||p.query.token==='secret',load:async()=>{loads++;return raw();},clock:()=>now});
 assert.equal((await request(handler,'/giunos/api/snapshot',{token:'secret'})).status,401);
 assert.equal((await request(handler,'/giunos/api/snapshot',{}, {'x-admin-token':'secret'},'POST')).status,405);
 assert.equal((await request(handler,'/giunos/api/snapshot',{period:'year'},{'x-admin-token':'secret'})).status,400);
 assert.equal(loads,0);
 const res=await request(handler,'/giunos/api/snapshot',{date:'2026-09-10'},{'x-admin-token':'secret'});assert.equal(res.status,200);assert.equal(res.headers['Cache-Control'],'no-store');
});
test('database errors are 503 without leaking details or returning zero totals',async()=>{
 const handler=createHandler({getClient:()=>null,authorize:()=>true,load:async()=>{throw Error('secret database info');}});
 const res=await request(handler,'/giunos/api/snapshot');assert.equal(res.status,503);assert(!res.body.includes('secret'));
});
test('read adapter paginates past default cap and propagates read failures',async()=>{
 let ranges=[];const client={from(){const q={select(){return q;},order(){return q;},eq(){return q;},range(a,b){ranges.push([a,b]);return Promise.resolve({data:Array(a===0?500:12).fill({id:a})});}};return q;}};
 assert.equal((await readTable(client,'projects')).length,512);assert.deepEqual(ranges,[[0,499],[500,999]]);
 const empty=await loadRaw(null);assert.equal(empty.mode,'disconnected');
});
test('whole-project sold budget is separate from calendar-period sold budget',()=>{
 const b={scope:'project',project_id:'p',period_start:'2026-07-01',period_end:'2026-12-31',hours:8,verified:true,source_url:'https://example.org/contract'};
 const s=buildSnapshot(raw({time_logs:[log({log_date:'2026-08-10',hours:7}),log()],giunos_budgets:[b]}),period,now);
 assert.equal(s.projects[0].budget,null);assert.equal(s.projects[0].wholeBudget.used.total,9);assert.equal(s.projects[0].hours.total,2);
});
test('frontend renders all routes and periods, escapes external text and rejects unsafe links',async()=>{
 const vm=require('node:vm'),fs=require('node:fs');
 const elements=new Map();const element=()=>({innerHTML:'',textContent:'',hidden:false,disabled:false,value:'',classList:{toggle(){}},setAttribute(){},removeAttribute(){},addEventListener(){}});
 const doc={querySelector(s){if(!elements.has(s))elements.set(s,element());return elements.get(s);},querySelectorAll(){return [];}};
 const context={document:doc,window:{addEventListener(){}},location:{hash:'#overview'},URL,URLSearchParams,Intl,Date,console,fetch:async()=>({status:200,ok:true,json:async()=>buildSnapshot(raw(),period,now)})};
 vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../src/giunos/public/app.js'),'utf8'),context);
 await new Promise(resolve=>setImmediate(resolve));
 const fixture=raw({projects:[{id:'p',name:'<script>alert(1)</script>',client_name:'<img src=x onerror=alert(1)>',status:'active'},{id:'q',name:'Solo piano',status:'active'}],time_logs:[log(),log({log_type:'weekly',log_date:'2026-09-07',project_id:'q',hours:4,slack_user_id:'w'})],team_members:[{slack_user_id:'u',canonical_name:'Person'},{slack_user_id:'w',canonical_name:'Planner'}],project_dossiers:[{project_id:'p',dossier:{deliverable:[{nome:'Output',stato:'consegnato'}]}}]});
 for(const kind of ['week','month','quarter'])for(const route of ['overview','projects','people','project/p','person/u','project/q','person/w']){
 context.snapshot=buildSnapshot(fixture,periodBounds(kind,'2026-09-10'),now);context.location.hash='#'+route;
 vm.runInContext(`data=snapshot;period='${kind}';render()`,context);
 const html=elements.get('#app').innerHTML;assert(!html.includes('<script>'));assert(!html.includes('<img src=x'));assert(!html.includes('NaN'));
 if(route==='project/q'&&kind==='month')assert(html.includes('Planner')&&html.includes('pianificate 4 h'),'chi ha solo un piano compare nella scheda commessa');
 if(route==='person/w'&&kind==='month')assert(html.includes('Solo piano')&&html.includes('nessuna ora ancora'),'il progetto solo pianificato compare nella scheda persona');
 }
 assert.equal(vm.runInContext("safeSource('javascript:alert(1)','Fonte')",context),'Fonte');
});
test('Giuno HTTP integration protects the snapshot in production without admin credentials',async()=>{
 const old=process.env.NODE_ENV;process.env.NODE_ENV='production';
 try {const oauth=require('../src/handlers/oauthHandler');let status,body;await oauth.handleRequest({url:'/giunos/api/snapshot',method:'GET',headers:{}},{writeHead(s){status=s;},end(b){body=b;}});assert.equal(status,401);assert(!body.includes('projects'));}
 finally{if(old===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=old;}
});
test('revisione criteri: venduto sulla commessa mostrato anche come proposta (marcata), mai due baseline; oltre il venduto solo se verificato',()=>{
 const sold=(extra={})=>({scope:'project',project_id:'p',period_start:'2026-07-01',period_end:'2026-12-31',hours:10,verified:false,source_url:'https://example.org/quote',...extra});
 let s=buildSnapshot(raw({time_logs:[log({log_date:'2026-08-10',hours:7}),log({hours:5})],giunos_budgets:[sold()]}),period,now);
 assert.equal(s.projects[0].sold.verified,false);assert.equal(s.projects[0].sold.used.total,12);assert.equal(s.projects[0].sold.remaining,-2);assert.equal(s.projects[0].sold.ratio,1.2);
 assert.ok(!s.alerts.some(a=>a.kind==='sold'),'una proposta non genera allarmi di sforamento');
 s=buildSnapshot(raw({time_logs:[log({log_date:'2026-08-10',hours:7}),log({hours:5})],giunos_budgets:[sold({verified:true})]}),period,now);
 assert.equal(s.projects[0].sold.verified,true);assert.ok(s.alerts.some(a=>a.kind==='sold'&&/oltre il venduto/.test(a.title)));
 s=buildSnapshot(raw({time_logs:[log()],giunos_budgets:[sold(),sold({hours:20,source_url:'https://example.org/other'})]}),period,now);
 assert.equal(s.projects[0].sold,null);assert.equal(s.projects[0].soldConflict,true);
 s=buildSnapshot(raw({time_logs:[log()]}),period,now);
 assert.equal(s.projects[0].sold,null);assert.ok(s.alerts.some(a=>a.kind==='nosold'),'ore senza venduto è un segnale');
});
test('revisione criteri: tipologie di attività da agenzia, distribuzione per progetto e per team',()=>{
 const {category}=require('../src/giunos/model');
 assert.equal(category('Montaggio video reel Mandorle'),'Video e foto');
 assert.equal(category('Copy per i post di settembre'),'Contenuti e copy');
 assert.equal(category('Impaginazione brochure su Figma'),'Design');
 assert.equal(category('Landing page: deploy e bug'),'Sviluppo');
 assert.equal(category('SAL con il cliente'),'Riunioni e coordinamento');
 assert.equal(category('Preventivo per Elios'),'Commerciale');
 assert.equal(category('Registro uscite cassa'),'Amministrazione');
 assert.equal(category('Revisioni grafiche dal feedback'),'Revisioni');
 assert.equal(category('boh'),'Non classificato');
 const entries=[{slack_user_id:'u',date:'2026-09-08',source:'dm',oggi_tasks:[{project_id:'p',task:'Montaggio video',hours:1},{project_id:'p',task:'Call cliente',hours:1}]}];
 const s=buildSnapshot(raw({time_logs:[log()],standup_entries:entries}),period,now);
 assert.deepEqual(s.projects[0].categories,[{name:'Video e foto',hours:1},{name:'Riunioni e coordinamento',hours:1}]);
 assert.deepEqual(s.categories,[{name:'Video e foto',hours:1},{name:'Riunioni e coordinamento',hours:1}]);
 assert.equal(s.people[0].projects[0].share,100);
});
test('revisione criteri: ciclo di vita, candidati separati dallo storico, blocchi, milestone scadute, azioni scadute, copertura persone',()=>{
 const projects=[
  {id:'attio_1',name:'Acquisito',status:'planning',tags:['attio-sync','sales:won']},
  {id:'attio_2',name:'Operativo',status:'active',tags:['attio-sync','sales:won'],lifecycle_evidence:{state:'active',source_url:'https://d/k',observed_on:'2026-09-01',valid_until:'2026-11-30',kind:'kickoff',detail:'kick-off'}},
  {id:'prj_3',name:'Sospeso',status:'on_hold'},{id:'prj_4',name:'Chiuso',status:'completed'},
 ];
 const dossiers=[{project_id:'attio_2',dossier:{rischi_blocchi:['Attesa materiali dal cliente'],scadenze:[{cosa:'Consegna sito',quando:'2026-09-01',stato:'aperta'},{cosa:'Go live',quando:'2026-10-01',stato:'aperta'}],prossimi_passi:[{cosa:'Review',chi:'Paolo',entro:'2026-09-15'}],deliverable:[{nome:'Sito',stato:'in corso'},{nome:'Logo',stato:'consegnato'}],team:[{nome:'Paolo',ruolo:'PM'}]}}];
 const actions=[{id:'a1',project_id:'attio_2',status:'open',due_date:'2026-09-05',description:'Inviare doc'},{id:'a2',project_id:'attio_2',status:'done',done_at:'2026-09-09T10:00:00Z',created_at:'2026-09-08T10:00:00Z',assignee_slack_id:'u'}];
 const s=buildSnapshot(raw({projects,project_dossiers:dossiers,project_actions:actions,time_logs:[log({project_id:'attio_2'}),log({project_id:'attio_2',log_date:'2026-09-09',validation:{status:'estimate'},slack_user_id:'v'})]}),period,now);
 assert.deepEqual(s.projects.map(p=>p.id),['attio_2']);
 assert.deepEqual(s.candidateProjects.map(p=>p.lifecycle),['da verificare']);
 assert.deepEqual(s.historicalProjects.map(p=>p.lifecycle).sort(),['concluso','sospeso']);
 const p=s.projects[0];
 assert.equal(p.lifecycle,'operativo');assert.equal(p.evidence.validUntil,'2026-11-30');
 assert.deepEqual(p.blocks,['Attesa materiali dal cliente']);
 assert.equal(p.milestones.filter(m=>m.overdue).length,1);assert.equal(p.nextSteps[0].who,'Paolo');
 assert.deepEqual(p.deliveryCounts,{done:1,inProgress:1,todo:0,total:2});assert.equal(p.overdueActions,1);assert.equal(p.openActions,1);
 assert.deepEqual(p.dossierTeam,[{name:'Paolo',role:'PM'}]);
 assert.deepEqual(s.alerts.map(a=>a.kind),['block','overdue','milestone','nosold']);
 assert.deepEqual(s.coverage,{people:2,peopleWithHours:2,peopleOnlyEstimates:1});
 assert.match(s.warnings.join(' '),/1 progetti acquisiti attendono/);
});
test('cliente → commesse e gruppo Interno: raggruppamento, ordine per ore, quota interna per persona',()=>{
 const projects=[
  {id:'attio_1',name:'Sito Elios',client_name:'Elios Srl',status:'active',lifecycle_evidence:{state:'active',source_url:'https://d/k',observed_on:'2026-09-01',valid_until:'2026-11-30'},tags:['attio-sync','sales:won']},
  {id:'attio_2',name:'Social Elios',client_name:'Elios Srl',status:'active',lifecycle_evidence:{state:'active',source_url:'https://d/k',observed_on:'2026-09-01',valid_until:'2026-11-30'},tags:['attio-sync','sales:won']},
  {id:'prj_3',name:'Mandorle',client_name:'Mandorle',status:'active'},
  {id:'cat_riunioni_team',name:'Daily e riunioni di team',client_name:'Interno',status:'active'},
  {id:'cat_formazione_admin',name:'Formazione',client_name:'Interno',status:'active'},
 ];
 const logs=[log({project_id:'attio_1',hours:2}),log({project_id:'attio_2',hours:1}),log({project_id:'prj_3',hours:5}),log({project_id:'cat_riunioni_team',hours:1}),log({project_id:'cat_formazione_admin',hours:1,slack_user_id:'v'})];
 const s=buildSnapshot(raw({projects,time_logs:logs,team_members:[{slack_user_id:'u',canonical_name:'U'},{slack_user_id:'v',canonical_name:'V'}]}),period,now);
 assert.deepEqual(s.clients.map(c=>[c.name,c.projects.length,c.hours.total]),[['Mandorle',1,5],['Elios Srl',2,3]]);
 assert.deepEqual(s.internal.map(i=>[i.id,i.hours.total]),[['cat_riunioni_team',1],['cat_formazione_admin',1]]);
 assert.equal(s.internalHours.total,2);assert.equal(s.clientHours.total,8);assert.equal(s.internalShare,20);
 assert.ok(!s.projects.some(p=>p.id.startsWith('cat_')),'le attività interne non stanno tra le commesse');
 assert.ok(!s.historicalProjects.some(p=>p.id.startsWith('cat_')));
 const u=s.people.find(p=>p.id==='u');assert.equal(u.internalShare,11);assert.deepEqual(u.internal,[{id:'cat_riunioni_team',name:'Daily e riunioni di team',hours:1}]);
 assert.equal(s.people.find(p=>p.id==='v').internalShare,100);
});
test('pianificazione in dashboard: ore pianificate separate dalle registrate, per persona e progetto, copertura del planner',()=>{
 const rows=[log({hours:2}),log({log_type:'weekly',log_date:'2026-09-07',hours:10}),log({log_type:'weekly',log_date:'2026-09-14',hours:8,slack_user_id:'v'}),log({log_type:'weekly',log_date:'2026-08-31',hours:5})];
 const s=buildSnapshot(raw({time_logs:rows,team_members:[{slack_user_id:'u',canonical_name:'U'},{slack_user_id:'v',canonical_name:'V'}]}),period,now);
 assert.equal(s.hours.total,2,'le pianificate non si sommano');
 assert.equal(s.planned,23,'settimane che iniziano nel mese o che lo contengono (31/8) contano');
 assert.equal(s.projects[0].planned,23);assert.deepEqual(s.projects[0].plannedPeople.sort(),['u','v']);
 const u=s.people.find(p=>p.id==='u');assert.equal(u.planned,15);assert.equal(u.plannedThisWeek,10);assert.deepEqual(u.plannedProjects,[{id:'p',name:'Project',hours:15}]);
 assert.deepEqual(s.plannerCoverage,{week:'2026-09-07',people:2,planned:1});
 const {normalizePlans}=require('../src/giunos/model');
 assert.equal(normalizePlans([log({log_type:'weekly',log_date:'2026-09-07',hours:3,updated_at:'a'}),log({log_type:'weekly',log_date:'2026-09-07',hours:4,updated_at:'b'})])[0].hours,4,'ultima correzione');
});
test('attività in dashboard: ore per attività solo se il daily torna con il consuntivo, microtask per persona, tendina e schede',()=>{
 const {activityRows,projectActivities}=require('../src/giunos/model');
 const acts=[
  {id:'act_ped9',project_id:'p',name:'PED settembre 2026',kind:'ricorrente',period_start:'2026-09-01',period_end:'2026-09-30',status:'open'},
  {id:'act_old',project_id:'p',name:'Shooting agosto',kind:'consegna',period_start:'2026-08-01',period_end:'2026-08-20',status:'done'},
  {id:'act_tpl',project_id:'p',name:'PED',recurrence:'mensile',status:'open'},
  {id:'act_late',project_id:'p',name:'Landing',kind:'consegna',period_start:'2026-08-15',period_end:'2026-09-05',status:'open'},
 ];
 const entries=[
  {slack_user_id:'u',date:'2026-09-08',source:'modal',oggi_tasks:[{task:'caption video',hours:1,minutes:30,project_id:'p',activity_id:'act_ped9',activity_name:'PED settembre 2026'},{task:'call cliente',hours:0,minutes:30,project_id:'p'}]},
  {slack_user_id:'v',date:'2026-09-09',source:'modal',oggi_tasks:[{task:'reel vendemmia',hours:3,project_id:'p',activity_id:'act_ped9'}]},
 ];
 const logs=[log({hours:2}),log({slack_user_id:'v',log_date:'2026-09-09',hours:2}),log({slack_user_id:'w',log_date:'2026-09-09',hours:1})];
 const rows=activityRows(normalizeLogs(logs),entries);
 assert.deepEqual(rows.map(r=>[r.person,r.activity,r.hours]),[['u','act_ped9',1.5],['u','__none__',0.5],['v','__none__',2],['w','__none__',1]],'v non torna col consuntivo (3h dichiarate, 2 registrate) → senza attività; w non ha daily');
 const pa=projectActivities('p',rows,acts,period,'2026-09-10');
 assert.deepEqual(pa.activities.map(a=>[a.id,a.hours.total,a.people,a.tasks.length,a.status,a.overdue]),[['act_ped9',1.5,['u'],1,'open',false],['act_late',null,[],0,'open',true]],'il modello ricorrente e la consegna di agosto fuori periodo non compaiono; la landing aperta oltre la fine è segnalata');
 assert.equal(pa.unassigned.total,3.5);assert.equal(pa.unassignedTasks,1);
 const s=buildSnapshot(raw({projects:[{id:'p',name:'Gambino Social',client_name:'Gambino Vini',status:'active'}],time_logs:logs,standup_entries:entries,project_activities:acts,team_members:[{slack_user_id:'u',canonical_name:'Giusy'},{slack_user_id:'v',canonical_name:'V'},{slack_user_id:'w',canonical_name:'W'}]}),period,now);
 assert.equal(s.projects[0].activities[0].name,'PED settembre 2026');assert.equal(s.projects[0].hours.total,5,'il consuntivo della commessa non cambia');
 const u=s.people.find(x=>x.id==='u');
 assert.deepEqual(u.activities.map(g=>[g.project,g.activities.map(a=>[a.name,a.hours.total,a.tasks[0].task]),g.unassignedTasks.map(t=>t.task)]),[['p',[['PED settembre 2026',1.5,'caption video']],['call cliente']]]);
 assert.deepEqual(s.people.find(x=>x.id==='w').activities,[],'senza microtask niente pannello');
 // review Codex: guardando agosto, il PED di settembre (aperto) non compare; le attività senza date sì
 const aug=periodBounds('month','2026-08-10');
 const paAug=projectActivities('p',[],acts.concat([{id:'act_free',project_id:'p',name:'Continuativa',status:'open'}]),aug,'2026-09-10');
 assert.deepEqual(paAug.activities.map(a=>a.id).sort(),['act_free','act_late','act_old'],'settembre escluso, agosto chiuso e landing (15/8→5/9) inclusi, senza date inclusa');
 // review Codex: dopo un merge i task e le attività del duplicato seguono la commessa canonica
 const merged=buildSnapshot(raw({projects:[{id:'p',name:'Gambino Social',status:'active'},{id:'dup',name:'Gambino',status:'merged',merged_into:'p'}],
  time_logs:[log({project_id:'dup',hours:2})],standup_entries:[{slack_user_id:'u',date:'2026-09-08',source:'modal',oggi_tasks:[{task:'caption video',hours:2,project_id:'dup',activity_id:'act_dup'}]}],
  project_activities:[{id:'act_dup',project_id:'dup',name:'PED settembre',status:'open',period_start:'2026-09-01',period_end:'2026-09-30'}],team_members:[{slack_user_id:'u',canonical_name:'Giusy'}]}),period,now);
 assert.deepEqual(merged.projects[0].activities.map(a=>[a.id,a.name,a.hours.total]),[['act_dup','PED settembre',2]]);assert.equal(merged.projects[0].unassigned.total,null);
 assert.deepEqual(merged.projects[0].categories,[{name:'Video e foto',hours:2}],'anche le categorie leggono i task tramite l\'alias');
 // senza tabella project_activities: le attività nominate nei daily compaiono comunque, per nome
 const s2=buildSnapshot(raw({projects:[{id:'p',name:'Gambino Social',status:'active'}],time_logs:logs,standup_entries:entries,project_activities:null}),period,now);
 assert.deepEqual(s2.projects[0].activities.map(a=>[a.id,a.name,a.status]),[['act_ped9','PED settembre 2026','sconosciuta']]);
 // frontend: tendina nella tabella, pannelli nelle schede, testo esterno sempre escapato
 const vm=require('node:vm'),fs=require('node:fs');
 const elements=new Map();const element=()=>({innerHTML:'',textContent:'',hidden:false,disabled:false,value:'',classList:{toggle(){}},setAttribute(){},removeAttribute(){},addEventListener(){}});
 const doc={querySelector(q){if(!elements.has(q))elements.set(q,element());return elements.get(q);},querySelectorAll(){return [];}};
 const context={document:doc,window:{addEventListener(){}},location:{hash:'#projects'},URL,URLSearchParams,Intl,Date,console,CSS:{escape:x=>x},fetch:async()=>({status:200,ok:true,json:async()=>s})};
 vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../src/giunos/public/app.js'),'utf8'),context);
 const evil=buildSnapshot(raw({projects:[{id:'p',name:'Gambino Social',status:'active'}],time_logs:logs,standup_entries:[{slack_user_id:'u',date:'2026-09-08',source:'modal',oggi_tasks:[{task:'<img src=x onerror=alert(1)>',hours:2,project_id:'p',activity_id:'a1',activity_name:'<script>alert(1)</script>'}]}],project_activities:null,team_members:[{slack_user_id:'u',canonical_name:'Giusy'}]}),period,now);
 for(const [snap,route,expect] of [[s,'projects','2 attività'],[s,'project/p','Senza attività'],[s,'person/u','call cliente'],[evil,'project/p','&lt;script&gt;'],[evil,'person/u','&lt;img src=x']]){
  context.snapshot=snap;context.location.hash='#'+route;vm.runInContext("data=snapshot;period='month';render()",context);
  const html=elements.get('#app').innerHTML;assert(html.includes(expect),route+' → '+expect);assert(!html.includes('<script>')&&!html.includes('<img src=x')&&!html.includes('NaN'));
 }
});
