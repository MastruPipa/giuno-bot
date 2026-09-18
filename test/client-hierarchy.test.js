'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildClientHierarchy}=require('../src/domain/clientHierarchy');
const {buildSnapshot,periodBounds}=require('../src/giunos/model');
const seed=()=>({agency_clients:[{id:'c',name:'Gambino'}],projects:[{id:'p',name:'PED',status:'active'},{id:'w',name:'planner',status:'active'}],project_client_links:[{project_id:'p',client_id:'c',node_id:'social'},{project_id:'w',client_id:'c',node_id:null}],work_nodes:[{id:'social',client_id:'c',kind:'engagement',parent_id:null,name:'Social'},{id:'sept',client_id:'c',kind:'objective',parent_id:'social',name:'Settembre'}],client_evidence:[{client_id:'c',kind:'accounting',valid_from:'2026-09-01',valid_until:'2026-09-30'}]});
test('one client aggregates mapped projects without allocating undivided work to a monthly objective',()=>{
 const raw=seed(), logs=[{project:'p',hours:.5,estimated:false},{project:'w',hours:1,estimated:true}];
 const {clients}=buildClientHierarchy(raw,logs,raw.projects,'2026-09-12');const c=clients[0];
 assert.equal(c.hours.total,1.5);assert.equal(c.unassignedHours.total,1);
 assert.equal(c.nodes[0].hours.total,.5);assert.equal(c.nodes[0].children[0].hours.total,null);
 assert.equal(c.state,'accounting_only');
});
test('accounting expiry and explicit closure do not become operational activity',()=>{
 const raw=seed();assert.equal(buildClientHierarchy(raw,[],[],'2026-10-01').clients[0].state,'unverified');
 raw.client_evidence.push({client_id:'c',kind:'closure',valid_from:'2026-09-10',valid_until:'2026-09-30'});
 assert.equal(buildClientHierarchy(raw,[],[],'2026-09-12').clients[0].state,'conflicting');
});
test('merged project links resolve to the existing ledger, once',()=>{
 const raw=seed();raw.projects.push({id:'old',merged_into:'p'});raw.project_client_links.push({project_id:'old',client_id:'c',node_id:'social'});
 const c=buildClientHierarchy(raw,[{project:'p',hours:2}],raw.projects,'2026-09-12').clients[0];
 assert.equal(c.hours.total,2);assert.equal(c.projectIds.filter(x=>x==='p').length,1);
});
test('conflicting client ownership stays outside client totals',()=>{
 const raw=seed();raw.agency_clients.push({id:'other',name:'Other'});raw.project_client_links.push({project_id:'p',client_id:'other'});
 const h=buildClientHierarchy(raw,[{project:'p',hours:2}],raw.projects,'2026-09-12');assert.equal(h.warnings.length,1);assert(h.clients.every(c=>c.hours.total===null));
});
test('snapshot projection conserves canonical daily total and excludes weekly plans',()=>{
 const raw=seed();raw.time_logs=[{slack_user_id:'u',project_id:'p',log_date:'2026-09-10',log_type:'daily',hours:.5},{slack_user_id:'u',project_id:'w',log_date:'2026-09-14',log_type:'weekly',hours:10}];
 const s=buildSnapshot(raw,periodBounds('month','2026-09-12'),new Date('2026-09-12T12:00:00Z'));
 assert.equal(s.hours.total,.5);assert.equal(s.reconciledClients[0].hours.total,.5);assert.equal(s.projects.length,2);
});
test('daily microtasks roll up only when their total matches the actual ledger',()=>{
 const raw=seed();raw.standup_entries=[{slack_user_id:'u',date:'2026-09-10',source:'dm',oggi_tasks:[{project_id:'p',work_node_id:'sept',task:'caption settembre',hours:1},{project_id:'p',task:'allineamento',hours:1}]}];
 const logs=[{person:'u',project:'p',date:'2026-09-10',hours:2,estimated:false}];
 let c=buildClientHierarchy(raw,logs,raw.projects,'2026-09-12').clients[0];assert.equal(c.hours.total,2);assert.equal(c.nodes[0].children[0].hours.total,1);assert.equal(c.nodes[0].children[0].tasks[0].text,'caption settembre');
 raw.standup_entries[0].oggi_tasks[0].hours=4;
 c=buildClientHierarchy(raw,logs,raw.projects,'2026-09-12').clients[0];assert.equal(c.hours.total,2);assert.equal(c.nodes[0].children[0].hours.total,null);
});
test('client frontend expands sourced hierarchy and keeps legacy rows inside history',async()=>{
 const vm=require('node:vm'),fs=require('node:fs');
 const raw=seed();raw.work_nodes[0].source_url='javascript:alert(1)';raw.work_nodes[0].name='<script>Social</script>';
 raw.time_logs=[{slack_user_id:'u',project_id:'p',log_date:'2026-09-10',log_type:'daily',hours:.5}];
 const {periodBounds}=require('../src/giunos/model');
 const snapshot=buildSnapshot(raw,periodBounds('month','2026-09-12'),new Date('2026-09-12T12:00:00Z'));
 const elements=new Map(),element=()=>({innerHTML:'',textContent:'',classList:{toggle(){}},setAttribute(){},removeAttribute(){},addEventListener(){}});
 const doc={querySelector(s){if(!elements.has(s))elements.set(s,element());return elements.get(s);},querySelectorAll(){return [];}};
 const context={document:doc,window:{addEventListener(){}},location:{hash:'#projects'},URL,URLSearchParams,Intl,Date,console,snapshot,fetch:async()=>({status:200,ok:true,json:async()=>snapshot})};
 vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../src/giunos/public/app.js'),'utf8'),context);await new Promise(r=>setImmediate(r));
 let html=elements.get('#app').innerHTML;assert(html.includes('Apri cliente e attività'));assert(html.includes('<details'));assert(!html.includes('javascript:'));assert(!html.includes('<script>'));
 context.location.hash='#client/c';vm.runInContext('render()',context);html=elements.get('#app').innerHTML;
 assert(html.includes('Voci originali e storico ore'));assert(html.includes('0,5 h'));assert(html.includes('Settembre'));assert(!html.includes('NaN'));
});
