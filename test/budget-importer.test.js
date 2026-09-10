'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var bi = require('../src/agents/budgetImporter');

test('hourlyRateFromCard: media delle tariffe orarie, giornate divise per 8', function() {
  assert.equal(bi.hourlyRateFromCard({ resources: [{ ruolo: 'PM', tariffa_oraria: 60 }, { ruolo: 'Dev', costo_giornata: '€ 400' }] }), 55);
  assert.equal(bi.hourlyRateFromCard({ resources: { note: 'nessun numero' } }), null);
  assert.equal(bi.hourlyRateFromCard(null), null);
});

test('hoursFromText/euroFromText: ore, giornate e importi nel testo del kick-off', function() {
  assert.equal(bi.hoursFromText('stimate 12 giornate uomo e 4 ore di setup'), 96);
  assert.equal(bi.hoursFromText('circa 120 ore in 3 mesi'), 120);
  assert.equal(bi.hoursFromText('nessuna stima'), null);
  assert.equal(bi.euroFromText('budget € 12.500 + iva'), 12500);
  assert.equal(bi.euroFromText('budget 8000 euro'), 8000);
  assert.equal(bi.euroFromText('12500 senza valuta'), null);
});

test('proposeBudget: preventivo > kick-off > € ÷ tariffa; senza fonti null', function() {
  var p = { id: 'attio_1', name: 'Mandorle', start_date: '2026-09-01', end_date: '2026-12-01', budget_quoted: 9000 };
  var q = bi.proposeBudget(p, { quotes: [{ id: 'q1', total_days: 15, price_quoted: 12000, date: '2026-08-20', status: 'accepted', source_doc_id: 'DOC1' }], rate: 50 });
  assert.equal(q.hours, 120); assert.equal(q.basis, 'preventivo'); assert.equal(q.confidence, 'alta'); assert.match(q.source_url, /DOC1/);
  assert.equal(q.period_start, '2026-09-01'); assert.equal(q.period_end, '2026-12-01'); assert.equal(q.verified, false);
  var k = bi.proposeBudget(p, { dossier: { version: 3, dossier: { budget: '10 giornate previste', obiettivi: [] }, sources: { kickoff: { link: 'https://doc/k' } } }, rate: 50 });
  assert.equal(k.hours, 80); assert.equal(k.basis, 'kick-off'); assert.equal(k.source_url, 'https://doc/k');
  var e = bi.proposeBudget(p, { rate: 50 });
  assert.equal(e.hours, 180); assert.match(e.basis, /deal Attio/); assert.equal(e.confidence, 'bassa');
  var noRate = bi.proposeBudget(p, {});
  assert.equal(noRate.hours, null); assert.match(noRate.basis, /rate card/);
  assert.equal(bi.proposeBudget({ id: 'chan_2', name: 'X', created_at: '2026-09-01T10:00:00Z' }, { rate: 50 }), null);
  var per = bi.periodFor({ created_at: '2026-09-01T10:00:00Z' });
  assert.equal(per.start, '2026-09-01'); assert.equal(per.end, '2026-11-30');
});

function fakeSupabase(state) {
  state.rows = state.rows || []; state.writes = [];
  return { from: function(table) {
    assert.equal(table, 'giunos_budgets');
    if (state.missing) return { select: function() { return { eq: function() { return { is: function() { return { limit: async function() { return { error: new Error('relation "giunos_budgets" does not exist') }; } }; } }; } }; } };
    return {
      select: function() { return { eq: function() { return { is: function() { return { limit: async function() { return { data: state.rows }; } }; } }; } }; },
      insert: async function(row) { state.writes.push({ op: 'insert', row: row }); return {}; },
      update: function(row) { return { eq: async function(_, id) { state.writes.push({ op: 'update', id: id, row: row }); return {}; } }; },
    };
  } };
}

test('importBudgets: anteprima e applica; salta i verificati; tabella assente → errore chiaro', async function() {
  var projects = [{ id: 'attio_1', name: 'Mandorle', start_date: '2026-09-01', budget_quoted: 9000 }, { id: 'chan_2', name: 'Vinokilo', created_at: '2026-08-01T00:00:00Z' }, { id: 'cat_x', name: 'Categoria' }];
  var state = { rows: [{ id: 7, project_id: 'chan_2', hours: 40, verified: true }] };
  var deps = { supabase: fakeSupabase(state), db: {}, rateCard: { resources: [{ tariffa_oraria: 50 }] },
    quotes: { searchQuotes: async function() { return []; } }, dossiers: { getDossier: async function() { return null; } } };
  var prev = await bi.importBudgets({ projects: projects, deps: deps });
  assert.equal(prev.considered, 2); assert.equal(prev.skipped_verified, 1); assert.equal(prev.items.length, 1);
  assert.equal(prev.items[0].hours, 180); assert.equal(state.writes.length, 0);
  var applied = await bi.importBudgets({ projects: projects, apply: true, deps: deps });
  assert.equal(applied.proposed, 1); assert.equal(state.writes[0].op, 'insert');
  assert.equal(state.writes[0].row.verified, false); assert.equal(state.writes[0].row.scope, 'project'); assert.match(state.writes[0].row.source_revision, /€9000/);
  assert.match(bi.formatReport(applied, true), /1 proposte su 2 progetti, 1 già verificati → 1 nuove[\s\S]*\*Mandorle\*: 180h \(€9\.000\)/);
  var miss = await bi.importBudgets({ projects: projects, deps: Object.assign({}, deps, { supabase: fakeSupabase({ missing: true }) }) });
  assert.match(miss.error, /giunos-budgets\.sql/);
  assert.match(bi.formatReport(miss), /^⚠️/);
});

test('confirmBudget: conferma la proposta, o crea la riga con le ore indicate', async function() {
  var state = { rows: [{ id: 9, project_id: 'attio_1', hours: 180, verified: false, source_revision: 'tariffa media 50 €/h' }] };
  var deps = { supabase: fakeSupabase(state), dossierAgent: { findProject: async function(n) { return /mandorle/i.test(n) ? { id: 'attio_1', name: 'Mandorle' } : (/nuovo/i.test(n) ? { id: 'chan_9', name: 'Nuovo', created_at: '2026-09-01' } : null); } } };
  var r = await bi.confirmBudget('mandorle', { deps: deps, by: 'antonio' });
  assert.equal(r.success, true); assert.equal(r.hours, 180);
  assert.equal(state.writes[0].op, 'update'); assert.equal(state.writes[0].row.verified, true); assert.match(state.writes[0].row.source_revision, /confermato da antonio/);
  var r2 = await bi.confirmBudget('mandorle', { deps: deps, hours: 150 });
  assert.equal(r2.hours, 150);
  var r3 = await bi.confirmBudget('nuovo', { deps: deps });
  assert.match(r3.error, /indica le ore/);
  var r4 = await bi.confirmBudget('nuovo', { deps: deps, hours: 40 });
  assert.equal(r4.success, true); assert.equal(state.writes[state.writes.length - 1].op, 'insert'); assert.equal(state.writes[state.writes.length - 1].row.hours, 40);
  assert.match((await bi.confirmBudget('boh', { deps: deps })).error, /non trovato/);
});

test('proposeAndNotify: avvisa gli admin solo con proposte nuove, una volta per set', async function() {
  var posted = [], recorded = [];
  var state = { rows: [] };
  var deps = { supabase: fakeSupabase(state), db: { searchProjects: async function() { return [{ id: 'attio_1', name: 'Mandorle', start_date: '2026-09-01', budget_quoted: 9000 }]; } },
    rateCard: { resources: [{ tariffa_oraria: 50 }] }, quotes: { searchQuotes: async function() { return []; } }, dossiers: { getDossier: async function() { return null; } },
    gate: { itemHash: function(s) { return 'h:' + s; }, followupAllowed: async function(_, uid, hash) { return { allowed: recorded.indexOf(hash) === -1, attempts: 0 }; }, recordFollowup: async function(_, uid, hash) { recorded.push(hash); } },
    app: { client: { chat: { postMessage: async function(m) { posted.push(m); } } } }, roles: [{ slack_user_id: 'U_ADM', role: 'admin' }, { slack_user_id: 'U_M', role: 'member' }] };
  assert.equal(await bi.proposeAndNotify(deps), 1);
  assert.equal(posted[0].channel, 'U_ADM'); assert.match(posted[0].text, /💰[\s\S]*Mandorle\*: 180h/);
  assert.equal(await bi.proposeAndNotify(deps), 0, 'stesso set → gate');
});
