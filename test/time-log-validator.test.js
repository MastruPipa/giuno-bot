'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var validator = require('../src/agents/timeLogValidator');

var PROJECTS_BY_ID = {
  p1: { name: 'Dicar', status: 'active' },
  p2: { name: 'Abadir', status: 'active' },
  p3: { name: 'Vecchio Sito', status: 'archived' },
};

function ctx(overrides) {
  return Object.assign({ prefix: 'tt', logType: 'daily', projectsById: PROJECTS_BY_ID }, overrides || {});
}

// ─── validateDeterministic ───────────────────────────────────────────────────

test('deterministic: nessuna riga → errore sul primo blocco progetto', function() {
  var res = validator.validateDeterministic([], ctx());
  assert.equal(res.ok, false);
  assert.ok(res.errors.tt_project_1);
});

test('deterministic: righe valide passano', function() {
  var res = validator.validateDeterministic([
    { index: 1, project_id: 'p1', hours: 4 },
    { index: 2, project_id: 'p2', hours: 1.5 },
  ], ctx());
  assert.equal(res.ok, true);
});

test('deterministic: ore fuori range o non numeriche → errore sul blocco ore giusto', function() {
  [0, 0.2, 25, NaN, null].forEach(function(h) {
    var res = validator.validateDeterministic([{ index: 2, project_id: 'p1', hours: h }], ctx());
    assert.equal(res.ok, false);
    assert.match(res.errors.tt_hours_2, /0\.5 e 24/);
  });
});

test('deterministic: progetto sconosciuto o archiviato viene rifiutato', function() {
  var unknown = validator.validateDeterministic([{ index: 1, project_id: 'pX', hours: 2 }], ctx());
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors.tt_project_1, /Progetto non valido/);

  var archived = validator.validateDeterministic([{ index: 1, project_id: 'p3', hours: 2 }], ctx());
  assert.equal(archived.ok, false);
  assert.match(archived.errors.tt_project_1, /non è più attivo/);
});

test('deterministic: progetto duplicato viene rifiutato', function() {
  var res = validator.validateDeterministic([
    { index: 1, project_id: 'p1', hours: 2 },
    { index: 2, project_id: 'p1', hours: 3 },
  ], ctx());
  assert.equal(res.ok, false);
  assert.match(res.errors.tt_project_2, /duplicato/);
});

test('deterministic: weekly ammette fino a 60h per riga (es. 40h su un progetto), oltre rifiuta', function() {
  var wctx = ctx({ prefix: 'wp', logType: 'weekly' });
  var ok = validator.validateDeterministic([{ index: 1, project_id: 'p1', hours: 40 }], wctx);
  assert.equal(ok.ok, true);

  var over = validator.validateDeterministic([{ index: 1, project_id: 'p1', hours: 61 }], wctx);
  assert.equal(over.ok, false);
  assert.match(over.errors.wp_hours_1, /0\.5 e 60/);

  // il daily resta cappato a 24h per riga
  var daily = validator.validateDeterministic([{ index: 1, project_id: 'p1', hours: 25 }], ctx());
  assert.equal(daily.ok, false);
  assert.match(daily.errors.tt_hours_1, /0\.5 e 24/);
});

test('deterministic: totale daily > 24h viene rifiutato, per weekly è ammesso', function() {
  var rows = [
    { index: 1, project_id: 'p1', hours: 14 },
    { index: 2, project_id: 'p2', hours: 12 },
  ];
  var daily = validator.validateDeterministic(rows, ctx());
  assert.equal(daily.ok, false);
  assert.match(daily.errors.tt_hours_1, /24 ore/);

  var weekly = validator.validateDeterministic(rows, ctx({ prefix: 'wp', logType: 'weekly' }));
  assert.equal(weekly.ok, true);
});

// ─── validateSubmission (gate con LLM iniettato) ─────────────────────────────

test('gate: verdict ok dell\'AI → salva con status ai_ok e anomalie', async function() {
  validator.setLLMCaller(function() {
    return Promise.resolve({ verdict: 'ok', anomalies: [{ row: 1, severity: 'high', reason: 'test' }] });
  });
  try {
    var res = await validator.validateSubmission([{ index: 1, project_id: 'p1', hours: 4 }], ctx());
    assert.equal(res.ok, true);
    assert.equal(res.validation.status, 'ai_ok');
    assert.equal(res.validation.anomalies.length, 1);
  } finally { validator.setLLMCaller(null); }
});

test('gate: verdict reject dell\'AI → errori in modale, nessun salvataggio', async function() {
  validator.setLLMCaller(function() {
    return Promise.resolve({ verdict: 'reject', reject_reason: 'Dati impossibili' });
  });
  try {
    var res = await validator.validateSubmission([{ index: 1, project_id: 'p1', hours: 4 }], ctx());
    assert.equal(res.ok, false);
    assert.equal(res.errors.tt_hours_1, 'Dati impossibili');
    assert.equal(res.validation, null);
  } finally { validator.setLLMCaller(null); }
});

test('gate: LLM in errore/timeout → fallback, i dati passano comunque', async function() {
  validator.setLLMCaller(function() {
    return Promise.reject(new Error('provider giù'));
  });
  try {
    var res = await validator.validateSubmission([{ index: 1, project_id: 'p1', hours: 4 }], ctx());
    assert.equal(res.ok, true);
    assert.equal(res.validation.status, 'fallback_deterministic_only');
  } finally { validator.setLLMCaller(null); }
});

test('gate: LLM lento oltre il budget → fallback entro il timeout configurato', async function() {
  validator.setLLMCaller(function() {
    return new Promise(function(resolve) {
      setTimeout(function() { resolve({ verdict: 'ok', anomalies: [] }); }, 500);
    });
  });
  try {
    var res = await validator.validateSubmission(
      [{ index: 1, project_id: 'p1', hours: 4 }],
      ctx({ aiTimeoutMs: 50 })
    );
    assert.equal(res.ok, true);
    assert.equal(res.validation.status, 'fallback_deterministic_only');
  } finally { validator.setLLMCaller(null); }
});

test('gate: il deterministico blocca PRIMA di chiamare l\'AI', async function() {
  var called = false;
  validator.setLLMCaller(function() { called = true; return Promise.resolve({ verdict: 'ok' }); });
  try {
    var res = await validator.validateSubmission([{ index: 1, project_id: 'pX', hours: 99 }], ctx());
    assert.equal(res.ok, false);
    assert.equal(called, false);
  } finally { validator.setLLMCaller(null); }
});

// ─── detectAnomalies ─────────────────────────────────────────────────────────

test('anomalie: lavoro consistente su progetto non pianificato → medium', function() {
  var anomalies = validator.detectAnomalies({
    rows: [{ index: 1, project_id: 'p1', hours: 5 }],
    planned: {}, actuals: { p1: 5 }, projectsById: PROJECTS_BY_ID,
  });
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].severity, 'medium');
});

test('anomalie: consuntivo >= 2x pianificato con scarto >= 4h → high (es. 4h pianificate, 16h consuntivate)', function() {
  var anomalies = validator.detectAnomalies({
    rows: [{ index: 1, project_id: 'p1', hours: 8 }],
    planned: { p1: 4 }, actuals: { p1: 16 }, projectsById: PROJECTS_BY_ID,
  });
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].severity, 'high');
});

test('anomalie: scostamenti piccoli non vengono segnalati', function() {
  var anomalies = validator.detectAnomalies({
    rows: [{ index: 1, project_id: 'p1', hours: 2 }],
    planned: { p1: 4 }, actuals: { p1: 5 }, projectsById: PROJECTS_BY_ID,
  });
  assert.equal(anomalies.length, 0);
});
