'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var s = require('../src/agents/activitySessions');
var cal = require('../src/services/estimateCalibration');

test('buildSessions: eventi vicini formano una sessione, pause > 45 min la spezzano, riunioni con durata reale', function() {
  var out = s.buildSessions([
    { at: '2026-09-10T09:00:00Z', kind: 'drive', name: 'Doc A' },
    { at: '2026-09-10T09:30:00Z', kind: 'slack', channel: 'proj' },
    { at: '2026-09-10T10:10:00Z', kind: 'drive', name: 'Doc A' },
    { at: '2026-09-10T12:00:00Z', kind: 'calendar', name: 'Call cliente', minutes: 45 },
    { at: '2026-09-10T12:30:00Z', kind: 'figma', name: 'Layout' },
    { at: '2026-09-10T16:00:00Z', kind: 'slack', channel: 'proj' },
  ]);
  assert.equal(out.length, 3);
  assert.equal(out[0].minutes, 70); assert.equal(out[0].events, 3);
  assert.deepEqual(out[0].refs.map(function(r) { return r.kind + ':' + (r.name || r.channel) + ':' + r.count; }), ['drive:Doc A:2', 'slack:proj:1']);
  assert.equal(out[1].minutes, 45, 'la riunione dura 45 anche se Figma cade dentro');
  assert.equal(out[2].minutes, 15, 'minimo 15 minuti');
  assert.equal(s.totalMinutes(out), 130);
  assert.match(s.formatSessions(out, 120), /^- 11:00–12:10 \(1h10min\): Drive "Doc A" \(2 modifiche\); #proj \(1 messaggi\)\n- 14:00–14:45 \(45min\): riunione "Call cliente"; Figma "Layout" \(1 versioni\)/);
  assert.deepEqual(s.buildSessions([{ at: 'boh' }]), []);
});

test('calibration: mediana reale/stimato, verso e suggerimento; servono almeno 3 coppie', function() {
  assert.equal(cal.summarize([{ estimated_hours: 2, actual_hours: 4 }, { estimated_hours: 2, actual_hours: 3 }]), null);
  var low = cal.summarize([{ estimated_hours: 2, actual_hours: 4 }, { estimated_hours: 3, actual_hours: 4.5 }, { estimated_hours: 1, actual_hours: 1.6 }]);
  assert.equal(low.bias, 'basso'); assert.equal(low.ratio, 1.6); assert.match(low.hint, /più basse del reale di circa il 60%: alza/);
  var ok = cal.summarize([{ estimated_hours: 2, actual_hours: 2 }, { estimated_hours: 3, actual_hours: 3.3 }, { estimated_hours: 4, actual_hours: 3.6 }]);
  assert.equal(ok.bias, 'ok');
  assert.equal(cal.hoursOf([{ hours: 1, minutes: 30 }, { minutes: 15 }]), 1.75);
});

test('recordCorrection: scrive la coppia; senza stima non scrive; tabella assente → false', async function() {
  var rows = [];
  var sb = { from: function() { return { upsert: async function(r) { rows.push(r); return {}; } }; } };
  assert.equal(await cal.recordCorrection('U1', '2026-09-10', [{ hours: 1 }, { minutes: 30 }], [{ hours: 3 }], { supabase: sb, confirmed: false, sources: ['calendario'] }), true);
  assert.equal(rows[0].estimated_hours, 1.5); assert.equal(rows[0].actual_hours, 3); assert.equal(rows[0].estimated_tasks, 2);
  assert.equal(await cal.recordCorrection('U1', '2026-09-10', [], [{ hours: 3 }], { supabase: sb }), false);
  var broken = { from: function() { return { upsert: async function() { return { error: new Error('relation missing') }; } }; } };
  assert.equal(await cal.recordCorrection('U1', '2026-09-10', 2, 2, { supabase: broken }), false);
});
