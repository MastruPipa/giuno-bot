'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {isActiveProject} = require('../src/giunos/projectScope');
const {buildSnapshot,periodBounds} = require('../src/giunos/model');
const now = new Date('2026-09-10T12:00:00Z');
const p = {id:'attio_a',name:'Client',status:'active',tags:['sales:won'],lifecycle_evidence:{state:'active',source_url:'https://example.com/project-status',observed_on:'2026-09-09',valid_until:'2026-09-30'}};
test('won alone, Slack alone and pre-sale are not active operational projects',()=>{
 assert.equal(isActiveProject({...p,lifecycle_evidence:null},'2026-09-10'),false);
 assert.equal(isActiveProject({...p,tags:[]},'2026-09-10'),false);
 assert.equal(isActiveProject({id:'chan_a',status:'active'},'2026-09-10'),false);
 assert.equal(isActiveProject(p,'2026-09-10'),true);
});
test('terminal, suspended, merged and expired evidence stay out of active dashboard',()=>{
 for(const status of ['completed','archived','cancelled','on_hold','planning']) assert.equal(isActiveProject({...p,status},'2026-09-10'),false);
 assert.equal(isActiveProject({...p,merged_into:'x'},'2026-09-10'),false);
 assert.equal(isActiveProject(p,'2026-10-01'),false);
 assert.equal(isActiveProject({...p,lifecycle_evidence:{...p.lifecycle_evidence,observed_on:'2026-09-11'}},'2026-09-10'),false);
});
test('historical hours and names survive exclusion from active projects',()=>{
 const raw={projects:[{...p,status:'completed'}],time_logs:[{slack_user_id:'u',project_id:p.id,log_type:'daily',log_date:'2026-09-09',hours:2}],project_actions:[]};
 const s=buildSnapshot(raw,periodBounds('month','2026-09-10'),now);
 assert.equal(s.projects.length,0);
 assert.equal(s.hours.total,2);
 assert.equal(s.people[0].projects[0].name,'Client');
 assert.equal(s.people[0].projects[0].status,'completed');
});
