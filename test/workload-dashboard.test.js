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
  assert.match(html, /settimana 2026-06-08 → 2026-06-14/);
  assert.match(html, /Nessun time log/);
  // navigazione settimana prec/succ
  assert.match(html, /week=2026-06-01/);
  assert.match(html, /week=2026-06-15/);
});

test('renderWorkloadPage: il token admin viene propagato nei link', async function() {
  var html = await dashboard.renderWorkloadPage({ week: '2026-06-10', token: 'segreto' });
  assert.match(html, /token=segreto/);
});

test('renderCsv: header e range di default', async function() {
  var csv = await dashboard.renderCsv({});
  assert.match(csv.content, /^log_date,log_type,utente,slack_user_id,progetto,ore,note\n/);
  assert.match(csv.filename, /^timelogs_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);
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
  assert.equal(oauthHandler.isProtectedPath('/oauth/callback'), false);
});
