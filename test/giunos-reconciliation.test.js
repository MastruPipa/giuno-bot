'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fingerprint,reviewEntries,buildReconciliation,canonicalMap}=require('../src/giunos/reconciliation');
const {buildSnapshot,periodBounds}=require('../src/giunos/model');
const period=periodBounds('month','2026-09-18'),now=new Date('2026-09-18T10:00:00Z');
const entry={id:'e',slack_user_id:'u',date:'2026-09-11',source:'modal',oggi_tasks:[{task:'Work',hours:2,project_id:'old'}]};
const raw=()=>({projects:[{id:'old',name:'Old',status:'merged',merged_into:'middle'},{id:'middle',status:'merged',merged_into:'p'},{id:'p',name:'Project',status:'active'}],team_members:[{slack_user_id:'u',canonical_name:'Person',active:true},{slack_user_id:'empty',canonical_name:'No Daily',active:true}],standup_entries:[structuredClone(entry)],time_logs:[],project_actions:[],daily_estimate_calibration:[],standup_data:[]});
test('reviews correct work dates once, preserve originals and invalidate on source change',()=>{
 const r=raw();r.giunos_daily_reviews=[{id:'exclude',slack_user_id:'u',date:'2026-09-11',basis_entry_id:'e',basis_hash:fingerprint(entry),status:'excluded',source_urls:['https://slack/x']},{id:'actual',slack_user_id:'u',date:'2026-09-10',basis_entry_id:'e',basis_hash:fingerprint(entry),status:'supplement',tasks:entry.oggi_tasks,source_urls:['https://slack/x']}];
 const original=structuredClone(r);let v=reviewEntries(r);assert.deepEqual(v.entries.map(e=>e.date),['2026-09-10']);assert.deepEqual(r,original);
 let s=buildSnapshot(r,period,now);assert.equal(s.reconciliation.dailyHours,2);assert.equal(s.reconciliation.rows[0].project,'p');assert.equal(s.reconciliation.dailyCount,1);assert.equal(s.people.find(p=>p.id==='empty').hours.total,null);
 r.standup_entries[0].oggi_tasks[0].hours=3;v=reviewEntries(r);assert.equal(v.entries[0].date,'2026-09-11');assert.equal(v.notes.filter(n=>n.status==='stale').length,2);assert.equal(buildSnapshot(r,period,now).reconciliation.dailyHours,3);
});
test('supplements never replace a new daily; dates with direct ledger entries preserve those hours',()=>{
 const r=raw();r.giunos_daily_reviews=[{id:'s',slack_user_id:'u',date:'2026-09-12',status:'supplement',tasks:[{task:'Recovered',hours:4,project_id:'p'}]}];
 r.standup_entries.push({...entry,id:'new',date:'2026-09-12'});assert.equal(reviewEntries(r).notes[0].status,'stale');
 r.time_logs=[{slack_user_id:'u',project_id:'p',log_date:'2026-09-10',log_type:'daily',hours:7.5}];const s=buildSnapshot(r,period,now);assert.equal(s.reconciliation.ledgerHours,7.5);assert.equal(s.reconciliation.rows.find(r=>r.date==='2026-09-10').category,'ledger_only');
});
test('unconfirmed estimates never count as declared hours or received human daily',()=>{
 const r=raw();r.standup_entries[0].source='estimate';r.time_logs=[{slack_user_id:'u',project_id:'p',log_date:'2026-09-11',log_type:'daily',hours:2,validation:{status:'estimate'}}];const s=buildSnapshot(r,period,now);assert.equal(s.reconciliation.dailyHours,0);assert.equal(s.reconciliation.dailyPeople,0);assert.equal(s.reconciliation.ledgerHours,null);assert.equal(s.reconciliation.estimatedHours,2);assert.equal(s.reconciliation.proposals.length,1);
});
test('decimal durations retained, missing data stays unavailable, broken chains remain unresolved',()=>{
 const r=raw();r.standup_entries[0].oggi_tasks=[{task:'Decimal',hours:1.5,minutes:15,project_id:'old'},{task:'Mixed',hours:2},{task:'Invalid',hours:-1}];let s=buildSnapshot(r,period,now);assert.equal(s.reconciliation.dailyHours,3.75);assert.equal(s.reconciliation.unassigned.length,2);assert.equal(s.reconciliation.rows[0].daily_hours,1.75);
 r.standup_entries=null;assert.equal(buildSnapshot(r,period,now).reconciliation.dailyHours,null);
 assert.equal(canonicalMap([{id:'a',merged_into:'b'},{id:'b',merged_into:'a'}]).get('a'),null);
 assert.equal(canonicalMap([{id:'a',merged_into:'missing'}]).get('a'),null);
});
test('estimate accuracy reports actual sample size, not a fabricated quality score',()=>{
 const r=raw();r.daily_estimate_calibration=[{slack_user_id:'u',date:'2026-09-10',estimated_hours:1,actual_hours:3,confirmed:false},{slack_user_id:'v',date:'2026-09-11',estimated_hours:2,actual_hours:2,confirmed:true}];r.standup_data=[{id:'current',stime:{u:{date:'2026-09-18',structured:{oggi:[{task:'Pending',hours:1}],estimate:{generated_at:'2026-09-18T06:00:00Z'}}}}}];
 const s=buildSnapshot(r,period,now);assert.equal(s.estimates.totalCases,2);assert.equal(s.estimates.eligiblePeople,0);assert.equal(s.estimates.pending[0].hours,1);assert.equal(s.reconciliation.dailyHours,2);assert.deepEqual(periodBounds('day','2026-09-18'),{kind:'day',start:'2026-09-18',end:'2026-09-18'});
});
test('live UX renders full roster, source comparisons, canonical clients and all routes safely',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),elements=new Map();
 const element=()=>({innerHTML:'',textContent:'',hidden:false,disabled:false,value:'',classList:{toggle(){}},setAttribute(){},removeAttribute(){},addEventListener(){},showModal(){},close(){},focus(){}});
 const doc={querySelector(q){if(!elements.has(q))elements.set(q,element());return elements.get(q);},querySelectorAll(){return [];}};
 const r=raw();r.standup_entries[0].oggi_tasks[0].task='<img src=x onerror=alert(1)>';const s=buildSnapshot(r,period,now);
 const context={document:doc,window:{addEventListener(){}},location:{hash:'#team'},URL,URLSearchParams,Intl,Date,console,CSS:{escape:x=>x},fetch:async()=>({status:401,ok:false})};vm.createContext(context);
 for(const name of ['ux.js','app.js'])vm.runInContext(fs.readFileSync(require.resolve('../src/giunos/public/'+name),'utf8'),context);
 for(const [route,expected] of [['team','No Daily'],['person/empty','Nessun daily nel periodo'],['person/u','Confronta'],['clients','Project'],['group/project','Commesse e consegne'],['quality','Confronto consultivo'],['estimates','Quanto possiamo fidarci'],['overview','Lo studio'],['project/p','Project']]){
 context.snapshot=s;context.location.hash='#'+route;vm.runInContext('data=snapshot;render()',context);const html=elements.get('#app').innerHTML;assert.ok(html.includes(expected),route);assert.ok(!html.includes('<img src=x')&&!html.includes('NaN'),route);}
 assert.ok(!elements.get('#app').innerHTML.includes('Old'),'merged project not a second client');
});
