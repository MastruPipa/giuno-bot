'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var cr = require('../src/agents/coverageReport');

function fakeSupabase(tables) {
  return { from: function(table) {
    var rows = tables[table];
    var q = { _f: [] };
    ['select', 'gte', 'eq', 'contains', 'lte'].forEach(function(m) { q[m] = function() { return q; }; });
    q.select = function(_, o) { q._head = !!(o && o.head); return q; };
    q.eq = function(k, v) { q._f.push([k, v]); return q; };
    q.not = function(k, op, v) { q._f.push([k, '__not_null__']); return q; };
    q.limit = function() { return q; };
    q.then = function(res) {
      if (rows === undefined) return res({ error: new Error('missing table') });
      var data = rows.filter(function(r) { return q._f.every(function(f) { return f[1] === '__not_null__' ? r[f[0]] != null : (r[f[0]] === undefined || r[f[0]] === f[1]); }); });
      return res(q._head ? { count: data.length } : { data: data });
    };
    return q;
  } };
}

test('buildCoverage/formatCoverage: persone, integrazioni, dati e cosa sbloccare', async function() {
  var supabase = fakeSupabase({
    standup_entries: [{ slack_user_id: 'U1', date: '2026-09-09', source: 'daily' }, { slack_user_id: 'U2', date: '2026-09-09', source: 'estimate' }],
    time_logs: [{ slack_user_id: 'U1', hours: 6, log_type: 'daily', validation: { status: 'ok' } }, { slack_user_id: 'U2', hours: 4, log_type: 'daily', validation: { status: 'estimate' } }],
    projects: [{ status: 'active' }, { status: 'active' }, { status: 'closed' }],
    project_dossiers: [], project_documents: [{}], project_actions: [{}, {}], knowledge_base: [{}],
    giunos_budgets: [{ verified: true }, { verified: false }],
  });
  var db = { getTeamRoster: function() { return [{ slack_user_id: 'U1', canonical_name: 'Gianna Rossi' }, { slack_user_id: 'U2', canonical_name: 'Paolo Bianchi' }, { slack_user_id: 'U3', canonical_name: 'Ex', active: false }]; } };
  var c = await cr.buildCoverage({ days: 7, deps: { supabase: supabase, db: db, tokens: { U1: 'tok' }, prefs: { U2: { standup_enabled: false } }, env: { ATTIO_API_KEY: 'x' } } });
  assert.equal(c.people.length, 2);
  assert.deepEqual([c.people[0].google, c.people[0].daily_real, c.people[0].hours_real], [true, 1, 6]);
  assert.deepEqual([c.people[1].google, c.people[1].daily_estimate, c.people[1].hours_estimate, c.people[1].standup_enabled], [false, 1, 4, false]);
  assert.equal(c.data.projects_active, 2); assert.equal(c.data.budgets, 2); assert.equal(c.data.budgets_verified, 1); assert.equal(c.data.dossiers, 0);
  var text = cr.formatCoverage(c);
  assert.match(text, /✅ \*Gianna Rossi\* — daily 1\/0 · ore 6h\/0h/);
  assert.match(text, /❌ \*Paolo Bianchi\* — daily 0\/1 · ore 0h\/4h _\(daily disattivato\)_/);
  assert.match(text, /Slack search ❌ · token admin\/dashboard ❌ · Attio ✅/);
  assert.match(text, /budget 2 \(1 verificati\)/);
  assert.match(text, /\*Da sbloccare:\*[\s\S]*collegare Google: Paolo[\s\S]*nessun daily vero: Paolo[\s\S]*SLACK_USER_TOKEN[\s\S]*OAUTH_ADMIN_TOKEN[\s\S]*gemini-scan 60/);
  // tabella budget assente
  var c2 = await cr.buildCoverage({ deps: { supabase: fakeSupabase({ standup_entries: [], time_logs: [], projects: [] }), db: db, tokens: {}, prefs: {}, env: {} } });
  assert.equal(c2.data.budgets, null);
  assert.match(cr.formatCoverage(c2), /budget tabella assente[\s\S]*applicare docs\/giunos-budgets\.sql/);
});
