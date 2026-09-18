'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {resolveNode}=require('../src/services/workNodeMatcher');
const {deriveEvidence}=require('../src/jobs/clientEvidenceJob');
const nodes=[{id:'social',client_id:'c',kind:'engagement',name:'Gestione social',metadata:{match_terms:['caption','ped','social']}},...['09','10'].map(m=>({id:m,client_id:'c',parent_id:'social',kind:'objective',name:'PED '+(m==='09'?'settembre':'ottobre')+' 2026',period_start:'2026-'+m+'-01'}))];
test('task reaches the parent when month is absent, explicit future month wins over work date',()=>{
 assert.equal(resolveNode('caption video Gambino','c',nodes,'2026-09-12').id,'social');
 assert.equal(resolveNode('caption Gambino settembre','c',nodes,'2026-09-12').id,'09');
 assert.equal(resolveNode('caption Gambino prossimo mese','c',nodes,'2026-09-12').id,'10');
 assert.equal(resolveNode('PED ottobre 2027','c',nodes,'2026-09-12').id,'social');
 assert.equal(resolveNode('PED settembre e ottobre','c',nodes,'2026-09-12'),null);
 assert.equal(resolveNode('caption video Gambino','other',nodes,'2026-09-12'),null);
});
test('accounting does not imply operations; won and closed engagements cannot activate or close client',()=>{
 const clients=[{id:'c',name:'Gambino Vini',aliases:['gambino']}];
 const billing=[{client:'gambino',month:'2026-09',source_url:'https://sheet.example/1',description:'social'}];
 const p={id:'p',name:'Social',lifecycle_evidence:{state:'active',kind:'billing',observed_on:'2026-09-01',valid_until:'2026-10-15',source_url:'https://sheet.example/1'}};
 let rows=deriveEvidence(clients,[{project_id:'p',client_id:'c'}],[p],billing);
 assert.equal(rows.length,1);assert.equal(rows[0].kind,'accounting');assert.equal(rows[0].valid_until,'2026-09-30');
 p.lifecycle_evidence.kind='weekly_plan';rows=deriveEvidence(clients,[{project_id:'p',client_id:'c'}],[p],billing);assert.equal(rows.length,2);
 p.lifecycle_evidence.state='completed';rows=deriveEvidence(clients,[{project_id:'p',client_id:'c'}],[p],billing);assert.equal(rows.length,1);
 clients.push({id:'another',name:'Gambino'});assert.equal(deriveEvidence(clients,[],[],billing).length,0);
});
