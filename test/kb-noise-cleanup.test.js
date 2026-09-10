'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');

// Stub del client Supabase: registra le query e risponde con righe finte.
var dbClient = require('../src/services/db/client');
var calls = [];
function fakeQuery(table, rows) {
  var q = {
    _table: table, _filters: [], _update: null,
    select: function() { return q; },
    eq: function(k, v) { q._filters.push(['eq', k, v]); return q; },
    neq: function(k, v) { q._filters.push(['neq', k, v]); return q; },
    lt: function(k, v) { q._filters.push(['lt', k, v]); return q; },
    like: function(k, v) { q._filters.push(['like', k, v]); return q; },
    not: function(k, op, v) { q._filters.push(['not', k, op, v]); return q; },
    in: function(k, v) { q._filters.push(['in', k, v]); return q; },
    update: function(v) { q._update = v; return q; },
    limit: function() { return Promise.resolve({ data: rows(q) }); },
    then: function(res, rej) { return Promise.resolve({ data: null, error: null }).then(res, rej); },
  };
  return q;
}

function installClient(rowsFn) {
  dbClient.getClient = function() {
    return { from: function(table) { var q = fakeQuery(table, rowsFn); calls.push(q); return q; } };
  };
}

var { runNoiseCleanup, formatReport } = require('../src/jobs/kbNoiseCleanupJob');

test('dry-run: conta i candidati, non aggiorna nulla', async function() {
  calls = [];
  installClient(function(q) {
    var hasAuthor = q._filters.some(function(f) { return f[0] === 'eq' && f[1] === 'added_by'; });
    var hasLike = q._filters.some(function(f) { return f[0] === 'like'; });
    var hasStale = q._filters.some(function(f) { return f[0] === 'eq' && f[1] === 'usage_count'; });
    if (hasAuthor) return [{ id: 'a', content: '[#dev] testo grezzo', created_at: '2026-05-01' }];
    if (hasLike) return [{ id: 'a', content: '[#dev] testo grezzo', created_at: '2026-05-01' }, { id: 'b', content: '[#x] altro', created_at: '2026-05-02' }];
    if (hasStale) return [{ id: 'c', content: 'auto learn inutile', created_at: '2026-03-01', confidence_score: 0.3 }];
    return [];
  });
  var r = await runNoiseCleanup({ apply: false });
  assert.equal(r.dry_run, true);
  assert.equal(r.watcher_dump, 2, 'dedup tra le due query watcher');
  assert.equal(r.stale_auto_learn, 1);
  assert.equal(r.total_candidates, 3);
  assert.equal(r.rejected, 0);
  assert.ok(!calls.some(function(q) { return q._update; }), 'nessun update in dry-run');
  var report = formatReport(r);
  assert.match(report, /anteprima/);
  assert.match(report, /kb-cleanup apply/);
});

test('apply: rigetta i candidati in batch e protegge official/drive_indexed', async function() {
  calls = [];
  installClient(function(q) {
    var hasStale = q._filters.some(function(f) { return f[0] === 'eq' && f[1] === 'usage_count'; });
    if (hasStale) return [{ id: 'c', content: 'x', created_at: '2026-03-01' }];
    return [{ id: 'a', content: '[#dev] y', created_at: '2026-05-01' }];
  });
  var r = await runNoiseCleanup({ apply: true, staleDays: 30 });
  assert.equal(r.rejected, 2);
  var updates = calls.filter(function(q) { return q._update; });
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0]._update, { validation_status: 'rejected' });
  var protectedFilter = calls.find(function(q) { return q._filters.some(function(f) { return f[0] === 'not' && f[1] === 'confidence_tier'; }); });
  assert.ok(protectedFilter, 'le query escludono i tier protetti');
  assert.match(formatReport(r), /eseguita/);
});

test('senza Supabase ritorna errore leggibile', async function() {
  dbClient.getClient = function() { return null; };
  var r = await runNoiseCleanup({});
  assert.ok(r.error);
  assert.match(formatReport(r), /non eseguita/);
});
