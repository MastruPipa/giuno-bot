'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {resolve} = require('../src/services/canonicalProject');
const matcher = require('../src/services/projectMatcher');
const {resolveOtherProject} = require('../src/services/otherProjectResolver');
const evidence = {kind:'admin', decided_by:'U052S2RT7B6', state:'active'};
const projects = [
 {id:'old',name:'Angela ricerca e scrittura nuovi format',status:'merged',merged_into:'channel',lifecycle_evidence:evidence},
 {id:'channel',name:'Angela Intelisano - Piano Editoriale',status:'merged',merged_into:'prj_client_angela_intelisano',lifecycle_evidence:evidence},
 {id:'prj_client_angela_intelisano',name:'Angela Intelisano',status:'active',lifecycle_evidence:evidence}
];
const lookup = async id => projects.find(p=>p.id===id);
test('canonical resolution follows multiple merges and fails closed on cycles/missing targets',async()=>{
 assert.equal((await resolve('old',lookup)).id,'prj_client_angela_intelisano');
 assert.equal(await resolve('missing',lookup),null);
 assert.equal(await resolve('a',async id=>({id,status:'merged',merged_into:id==='a'?'b':'a'})),null);
 assert.equal(await resolve('a',async id=>({id,status:'merged'})),null);
});
test('microtasks canonicalize stale client defaults, existing assignments and catalogue matches without database writes',async()=>{
 const before=JSON.stringify(projects);
 const tasks=[{task:'caption Angela Intelisano'},{task:'revisioni',project_id:'old'},{task:'Piano Editoriale',project_id:'channel'}];
 await matcher.enrichTasksWithProjects(tasks,{projects,clients:[{id:'angela',name:'Angela Intelisano',default_project_id:'old'}],catalog:[],activities:false,useLlm:false});
 assert.deepEqual(tasks.map(t=>t.project_id),Array(3).fill('prj_client_angela_intelisano'));
 assert.equal(JSON.stringify(projects),before);
 assert.equal(tasks[0].task,'caption Angela Intelisano');
});
test('unresolvable microtask projects do not retain invalid posting IDs',async()=>{
 const tasks=[{task:'caption',project_id:'missing',activity_id:'stale'}];
 await matcher.enrichTasksWithProjects(tasks,{projects,clients:[],catalog:[],activities:false,useLlm:false});
 assert.equal(tasks[0].project_id,undefined);assert.equal(tasks[0].activity_id,undefined);
});
test('planner client identity follows merged defaults without duplicating or modifying admin rows',async()=>{
 const before=JSON.stringify(projects);
 const result=await resolveOtherProject('Angela Intelisano caption','u',projects,{db:{getProject:lookup},matcher:{},identity:{resolve:async()=>({client:{id:'angela',default_project_id:'old'}})}});
 assert.equal(result.project.id,'prj_client_angela_intelisano');assert.equal(result.created,false);
 assert.equal(JSON.stringify(projects),before);
});
test('planner refuses closed admin projects and never reopens them',async()=>{
 for(const status of ['completed','archived','cancelled']){
  const row={id:'closed',name:'Cliente chiuso',status,lifecycle_evidence:evidence};
  const result=await resolveOtherProject(row.name,'u',[],{db:{searchProjects:async()=>[row],getProject:async()=>row,updateProject:()=>assert.fail('must not overwrite admin decision')},matcher:{},identity:{resolve:async()=>null}});
  assert.ok(result.error);assert.equal(row.status,status);
 }
});
test('catalog collapses merged names onto a single canonical posting account',async()=>{
 const db=require('../supabase');const original=db.searchProjects;
 db.searchProjects=async()=>projects;matcher.invalidateCatalog();
 try {
  const catalog=await matcher.getCatalog();
  assert.equal(catalog.length,1);assert.equal(catalog[0].id,'prj_client_angela_intelisano');
  assert.equal(matcher.resolveTask('Angela ricerca e scrittura nuovi format',catalog).id,'prj_client_angela_intelisano');
  assert.equal(matcher.resolveTask('Angela Intelisano - Piano Editoriale',catalog).id,'prj_client_angela_intelisano');
 } finally {db.searchProjects=original;matcher.invalidateCatalog();}
});
