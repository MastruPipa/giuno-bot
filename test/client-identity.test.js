'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {identify}=require('../src/services/clientIdentity');
const {groupClientActivities}=require('../src/domain/plannerActivities');
const clients=[{id:'c',name:'Gambino Vini',aliases:['gambino','vini gambino'],default_project_id:'general'},{id:'t',name:'Tarocco'}];
test('caption and compound planner text resolve client without inventing another project',()=>{
 for(const text of ['caption video gambino','Vini Gambino - riunione + premi + shooting'])assert.equal(identify(text,clients).client.id,'c');
 assert.equal(identify('gambinone caption',clients),null);
 assert.equal(identify('Gambino + Tarocco',clients).ambiguous,true);
});
test('multiple activities preserve descriptions and total without changing original rows',()=>{
 const rows=[{index:1,client_id:'c',project_id:'p',hours:2,other_name:'caption Gambino'},{index:2,client_id:'c',project_id:'p',hours:3,other_name:'shooting Gambino'},{index:3,project_id:'other',hours:1}];
 const result=groupClientActivities(rows);assert.equal(result.length,2);assert.equal(result[0].hours,5);assert.equal(result[0].activities.length,2);assert.equal(rows[0].hours,2);assert.equal(result.reduce((s,r)=>s+r.hours,0),6);
});
test('reconciled project cannot be merged before touching the hour ledger',async()=>{
 const {applyMerge}=require('../src/jobs/projectDedupJob');const touched=[];
 const client={useSupabase:true,getClient:()=>({from(table){touched.push(table);return {select(){return this},in:async()=>({data:[{project_id:'p'}]})}}})};
 await assert.rejects(applyMerge({id:'p'},{id:'q'},{client}),/riconciliati/);
 assert.deepEqual(touched,['project_client_links']);
});

test('invalid individual hours cannot disappear into a positive aggregate',()=>{
 const rows=[{client_id:'c',project_id:'p',hours:-1},{client_id:'c',project_id:'p',hours:2}];
 const result=groupClientActivities(rows);assert.equal(result.length,2);assert.equal(result[0].hours,-1);
});
test('daily matcher preserves activity text and refuses an ambiguous client',async()=>{
 const matcher=require('../src/services/projectMatcher');
 const tasks=[{task:'caption video Gambino'},{task:'Gambino e Tarocco'}];
 await matcher.enrichTasksWithProjects(tasks,{clients,catalog:[],activities:false,useLlm:false});
 assert.equal(tasks[0].project_id,'general');assert.equal(tasks[0].task,'caption video Gambino');
 assert.equal(tasks[0].activity_id,undefined);assert.equal(tasks[1].project_id,undefined);
 assert.equal(tasks[1].assignment_status,'ambiguous_client');
});
test('Altro uses the reconciled posting account without invoking contextual guesswork',async()=>{
 const {resolveOtherProject}=require('../src/services/otherProjectResolver');
 const identity={resolve:async text=>identify(text,clients)};
 const r=await resolveOtherProject('caption video Gambino','u',[{id:'general',name:'Gambino Vini',status:'active'}],{db:{},matcher:{},identity,model:false});
 assert.equal(r.project.id,'general');assert.equal(r.client_id,'c');assert.equal(r.text,'caption video Gambino');
 const a=await resolveOtherProject('Gambino e Tarocco','u',[],{db:{},matcher:{},identity});assert(a.error);
});
