'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var pf = require('../src/agents/pipelineFollowups');
var attio = require('../src/services/attioService');

var NOW = Date.parse('2026-09-10T10:00:00Z');
function deal(id, name, stage, value, lastIso) { return { record_id: id, values: { name: name, stage: stage, value: value }, created_at: '2026-06-01T00:00:00Z', last_activity_at: lastIso }; }

test('isOpen: stage chiusi esclusi', function() {
  assert.equal(pf.isOpen(deal('1', 'a', 'Meet')), true);
  assert.equal(pf.isOpen(deal('2', 'b', 'Won')), false);
  assert.equal(pf.isOpen(deal('3', 'c', 'Lost')), false);
  assert.equal(pf.isOpen(deal('4', 'd', 'In Progress')), false);
  assert.equal(pf.isOpen(deal('5', 'e', null)), false);
});

test('findIssues: fermi da 14+ giorni ordinati per valore, proposte senza valore', function() {
  var issues = pf.findIssues([
    deal('a', 'Tarocco PED', 'Proposal', 5000, '2026-08-20T00:00:00Z'),
    deal('b', 'Elios', 'Meet', null, '2026-09-08T00:00:00Z'),
    deal('c', 'Vinokilo', 'Negotiation', 17750, '2026-08-01T00:00:00Z'),
    deal('d', 'Nuovo lead', 'Lead', null, '2026-07-01T00:00:00Z'),
    deal('e', 'Proposta senza cifra', 'Proposal', null, '2026-09-09T00:00:00Z'),
  ], { now: NOW });
  assert.deepEqual(issues.stale.map(function(s) { return s.name; }), ['Vinokilo', 'Tarocco PED', 'Nuovo lead']);
  assert.equal(issues.stale[0].days, 40);
  assert.deepEqual(issues.no_value.map(function(s) { return s.name; }), ['Proposta senza cifra']);
  var text = pf.formatReport(issues);
  assert.match(text, /3 deal fermi da 14\+ giorni/);
  assert.match(text, /\*Vinokilo\* — Negotiation, €17\.750, ultimo movimento 40 gg fa \(2026-08-01\)\n   → proposta in sospeso/);
  assert.match(text, /Nuovo lead[\s\S]*chiudilo come Lost/);
  assert.match(text, /Proposte senza valore su Attio:\* Proposta senza cifra \(Proposal\)/);
  assert.match(pf.formatReport({ stale: [], no_value: [] }), /nessun deal fermo/);
});

test('runPipelineReview: avvisa gli admin con throttle per deal', async function() {
  var posted = [];
  var seen = {};
  var deps = {
    now: function() { return NOW; },
    gate: { notificheEnabled: function() { return true; }, itemHash: function(t) { return t; }, followupAllowed: async function(_, uid, h) { seen[h] = (seen[h] || 0) + 1; return { allowed: seen[h] === 1, attempts: 0 }; }, recordFollowup: async function() {} },
    supabase: {}, app: { client: { chat: { postMessage: async function(a) { posted.push(a); return { ts: '1' }; } } } },
    roles: [{ slack_user_id: 'U_ANT', role: 'admin' }, { slack_user_id: 'U_PAOLO', role: 'member' }],
  };
  var deals = [deal('a', 'Tarocco PED', 'Proposal', 5000, '2026-08-20T00:00:00Z'), deal('b', 'Elios', 'Meet', null, '2026-09-08T00:00:00Z')];
  var r = await pf.runPipelineReview({ notify: true, deals: deals, deps: deps });
  assert.equal(r.notified, 1);
  assert.equal(posted[0].channel, 'U_ANT');
  assert.match(posted[0].text, /Tarocco PED/);
  posted.length = 0;
  var r2 = await pf.runPipelineReview({ notify: true, deals: deals, deps: deps });
  assert.equal(r2.notified, 0, 'stesso deal non viene rimandato');
});

test('attio.lastActivityAt: il più recente active_from fra i valori', function() {
  var values = { name: [{ value: 'x', active_from: '2026-08-01T00:00:00.000Z' }], stage: [{ status: { title: 'Proposal' }, active_from: '2026-09-02T09:00:00.000Z' }] };
  assert.equal(attio.lastActivityAt(values, '2026-06-01T00:00:00Z'), '2026-09-02T09:00:00.000Z');
  assert.equal(attio.lastActivityAt({}, '2026-06-01T00:00:00Z'), '2026-06-01T00:00:00.000Z');
});
