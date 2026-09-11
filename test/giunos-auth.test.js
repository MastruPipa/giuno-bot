'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {authorize} = require('../src/giunos/auth');
test('dedicated dashboard key does not accept admin fallback or URL credentials',()=>{
 const fallback=()=>{throw Error('must not use admin fallback');};
 assert.equal(authorize({headers:{'x-admin-token':'dashboard'}},{},'dashboard',fallback),true);
 for (const token of ['admin','wrong','',undefined,['dashboard']]) assert.equal(authorize({headers:{'x-admin-token':token}},{query:{token:'dashboard'}},'dashboard',fallback),false);
});
test('existing deployments preserve admin authorization until dashboard key is configured',()=>{
 assert.equal(authorize({headers:{}},{},undefined,()=>true),true);
 assert.equal(authorize({headers:{}},{},'',()=>false),false);
});
