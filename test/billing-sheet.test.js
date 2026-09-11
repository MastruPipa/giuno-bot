'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var bs = require('../src/agents/billingSheet');

test('euro/bool: formati italiani del foglio', function() {
  assert.equal(bs.euro('€ 2.105,00'), 2105); assert.equal(bs.euro('€ 1.159,00'), 1159); assert.equal(bs.euro('10000'), 10000); assert.equal(bs.euro('\\-€ 1.315,56'), -1315.56); assert.equal(bs.euro(''), 0); assert.equal(bs.euro(undefined), 0);
  assert.equal(bs.bool('TRUE'), true); assert.equal(bs.bool('FALSE'), false); assert.equal(bs.bool(''), false);
});

var HEADER_NO_DESC = ['Cl', '1Tantum', 'Mensilità', 'fattura inviata', 'Incassato', 'iva', '1Tantum tot', 'Mens tot'];
var HEADER_DESC = ['Cl', '', '1Tantum', 'Mensilità', '', 'fattura inviata', 'Incassato', 'iva'];

test('parseTab: intestazione trovata per nome, con o senza colonna descrizione; riga dei totali e righe vuote saltate', function() {
  var gennaio = [['Uscite', 'Spese'], [], HEADER_NO_DESC, ['', '', '', '', '', '', '€ 7.698,00', '€ 10.506,00'],
    ['Marchese', '', '€ 1.000,00', '', '€ 1.000,00'], ['gambino vini', '', '€ 1.672,00', 'TRUE', '€ 2.039,84'], ['club house', '€ 1.550,00', '', 'TRUE', '€ 1.891,00'], ['', '', '', '', ''], ['Cassa', '', '', '']];
  var rows = bs.parseTab(gennaio);
  assert.deepEqual(rows.map(function(r) { return [r.client, r.one_off, r.monthly, r.invoiced]; }), [['Marchese', 0, 1000, false], ['gambino vini', 0, 1672, true], ['club house', 1550, 0, true]]);
  assert.equal(rows[0].description, '');
  var settembre = [HEADER_DESC, ['', '', '', '', '', '', '', ''], ['gambino vini', 'Comunicazione e Marketing: produzioni contenuti', '', '€ 2.105,00', '', 'TRUE', 'TRUE'], ['Vinokilo Swiss AG', 'Project Setup - Vinokilo Swiss', '€ 3.000,00', '', '', 'TRUE', 'FALSE']];
  var r2 = bs.parseTab(settembre);
  assert.equal(r2[0].description, 'Comunicazione e Marketing: produzioni contenuti'); assert.equal(r2[0].monthly, 2105); assert.equal(r2[0].paid, true);
  assert.equal(r2[1].client, 'Vinokilo Swiss AG'); assert.equal(r2[1].one_off, 3000); assert.equal(r2[1].paid, false);
  assert.deepEqual(bs.parseTab([['TOTALE'], ['Gennaio', '€ 4.119,00']]), [], 'la scheda dei totali non ha righe cliente');
});

test('rowsFromTabs: il mese dal titolo della scheda, altrimenti dall\'ordine; link con gid; schede senza tabella ignorate', function() {
  var tab = function(title, gid, client) { return { title: title, gid: gid, values: [HEADER_NO_DESC, ['', ''], [client, '', '€ 100,00', 'TRUE', '']] }; };
  var titled = bs.rowsFromTabs([{ title: 'TOTALE', gid: 0, values: [['Uscite']] }, tab('Settembre', 9, 'A'), tab('ottobre 26', 10, 'B')], 2026, 'SHEET');
  assert.deepEqual(titled.map(function(r) { return r.client + '@' + r.month; }), ['A@2026-09', 'B@2026-10']);
  assert.equal(titled[0].source_url, 'https://docs.google.com/spreadsheets/d/SHEET/edit#gid=9');
  var ordered = bs.rowsFromTabs([{ title: 'TOTALE', gid: 0, values: [['Uscite']] }, tab('Foglio2', 1, 'A'), tab('Foglio3', 2, 'B')], 2026, 'SHEET');
  assert.deepEqual(ordered.map(function(r) { return r.month; }), ['2026-01', '2026-02']);
});

test('readBillingRows: legge titoli e valori via Sheets API con il token di un admin; senza token o foglio → []', async function() {
  var calls = [];
  var sheets = { spreadsheets: { get: async function(p) { calls.push('meta'); return { data: { sheets: [{ properties: { title: 'TOTALE', sheetId: 0 } }, { properties: { title: 'Settembre', sheetId: 9 } }] } }; },
    values: { get: async function(p) { calls.push(p.range); return { data: { values: /Settembre/.test(p.range) ? [HEADER_NO_DESC, [''], ['gambino vini', '', '€ 2.105,00', 'TRUE', 'TRUE']] : [['Uscite']] } }; } } } };
  var rows = await bs.readBillingRows({ year: 2026, deps: { sheetId: 'S1', sheets: sheets } });
  assert.equal(rows.length, 1); assert.equal(rows[0].month, '2026-09'); assert.equal(rows[0].client, 'gambino vini'); assert.match(rows[0].source_url, /S1\/edit#gid=9$/);
  assert.deepEqual(calls, ['meta', "'TOTALE'!A1:Z400", "'Settembre'!A1:Z400"]);
  var none = await bs.readBillingRows({ year: 2026, force: true, deps: { sheetId: null, gauth: { getUserTokens: function() { return {}; } }, roles: [] } });
  assert.deepEqual(none, []);
});
