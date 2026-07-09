'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var dashboard = require('../src/handlers/workloadDashboard');
var timeTrackingTools = require('../src/tools/timeTrackingTools');
var oauthHandler = require('../src/handlers/oauthHandler');

// Senza Supabase i moduli db sono no-op: la pagina deve comunque renderizzare.

test('renderWorkloadPage: HTML valido con settimana normalizzata al lunedì', async function() {
  var html = await dashboard.renderWorkloadPage({ week: '2026-06-10' }); // mercoledì
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /dal 2026-06-08 al 2026-06-14/);
  assert.match(html, /Nessun time log/);
  // navigazione settimana prec/succ (retrocompatibile ?week=)
  assert.match(html, /week=2026-06-01/);
  assert.match(html, /week=2026-06-15/);
});

test('renderWorkloadPage: il token admin viene propagato nei link e nel form', async function() {
  var html = await dashboard.renderWorkloadPage({ week: '2026-06-10', token: 'segreto' });
  assert.match(html, /token=segreto/);
  assert.match(html, /name="token" value="segreto"/);
});

test('renderWorkloadPage: auto-refresh, barra filtri e link preset', async function() {
  var html = await dashboard.renderWorkloadPage({ range: 'mese' });
  assert.match(html, /http-equiv="refresh"/);
  assert.match(html, /Ultimo aggiornamento/);
  assert.match(html, /<form method="get" action="\/dashboard\/workload">/);
  assert.match(html, /range=oggi/);
  assert.match(html, /range=trimestre/);
  // export CSV con il range attivo
  assert.match(html, /\/export\/timelogs\.csv\?from=\d{4}-\d{2}-01/);
});

test('renderWorkloadPage: input malevoli non finiscono in pagina', async function() {
  var html = await dashboard.renderWorkloadPage({ user: '<script>alert(1)</script>', project: '"><img>' });
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /"><img>/);
});

test('renderCsv: header e range di default', async function() {
  var csv = await dashboard.renderCsv({});
  assert.match(csv.content, /^log_date,log_type,utente,slack_user_id,progetto,ore,note\n/);
  assert.match(csv.filename, /^timelogs_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);
});

test('renderCsv: filtri utente/progetto nel filename', async function() {
  var csv = await dashboard.renderCsv({ from: '2026-06-01', to: '2026-06-30', user: 'U0DEADBEEF', project: 'prj_x' });
  assert.equal(csv.filename, 'timelogs_2026-06-01_2026-06-30_U0DEADBEEF_prj_x.csv');
});

test('query_time_logs: settimana vuota → note esplicativa, nessun errore', async function() {
  var res = await timeTrackingTools.queryTimeLogs({ week: '2026-06-10' });
  assert.equal(res.week_start, '2026-06-08');
  assert.equal(res.total_hours_actual, 0);
  assert.ok(res.note);
});

test('query_time_logs: utente sconosciuto → errore parlante', async function() {
  var res = await timeTrackingTools.queryTimeLogs({ user_name: 'utente-inesistente-xyz' });
  assert.ok(res.error);
});

test('isProtectedPath: le nuove route workload sono protette', function() {
  assert.equal(oauthHandler.isProtectedPath('/dashboard/workload'), true);
  assert.equal(oauthHandler.isProtectedPath('/export/timelogs.csv'), true);
  assert.equal(oauthHandler.isProtectedPath('/api/workload'), true);
  assert.equal(oauthHandler.isProtectedPath('/oauth/callback'), false);
});
