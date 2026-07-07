'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var modals = require('../src/handlers/timeTrackingModals');

var PROJECTS = [
  { id: 'p1', name: 'Dicar', status: 'active' },
  { id: 'p2', name: 'Abadir', status: 'active' },
];

function blockIds(blocks) {
  return blocks.map(function(b) { return b.block_id; }).filter(Boolean);
}

test('buildPlannerBlocks: i block_id delle righe esistenti restano stabili quando si aggiunge una riga', function() {
  var two = blockIds(modals.buildPlannerBlocks(PROJECTS, 2, '2026-06-15'));
  var three = blockIds(modals.buildPlannerBlocks(PROJECTS, 3, '2026-06-15'));
  // Tutti i block_id di input della versione a 2 righe sono presenti identici in quella a 3
  two.filter(function(id) { return /^wp_(project|hours)_/.test(id); }).forEach(function(id) {
    assert.ok(three.indexOf(id) !== -1, id + ' deve restare stabile');
  });
  assert.ok(three.indexOf('wp_project_3') !== -1);
  assert.ok(three.indexOf('wp_hours_3') !== -1);
});

test('buildPlannerBlocks: bottone + Aggiungi sparisce al cap di righe', function() {
  var atCap = modals.buildPlannerBlocks(PROJECTS, modals.MAX_ROWS_PLANNER, '2026-06-15');
  var hasButton = atCap.some(function(b) {
    return b.type === 'actions' && b.elements && b.elements[0].action_id === 'wp_add_row';
  });
  assert.equal(hasButton, false);
});

test('buildCheckinBlocks: righe tt_, nota opzionale e number_input con range 0.5-24', function() {
  var blocks = modals.buildCheckinBlocks(PROJECTS, 2, '2026-06-10');
  var ids = blockIds(blocks);
  assert.ok(ids.indexOf('tt_project_1') !== -1);
  assert.ok(ids.indexOf('tt_hours_2') !== -1);
  assert.ok(ids.indexOf('tt_note') !== -1);
  var hoursBlock = blocks.filter(function(b) { return b.block_id === 'tt_hours_1'; })[0];
  assert.equal(hoursBlock.element.type, 'number_input');
  assert.equal(hoursBlock.element.is_decimal_allowed, true);
  assert.equal(hoursBlock.element.min_value, '0.5');
  assert.equal(hoursBlock.element.max_value, '24');
});

test('buildPlannerBlocks: le ore weekly ammettono fino a 60h per riga', function() {
  var blocks = modals.buildPlannerBlocks(PROJECTS, 1, '2026-06-15');
  var hoursBlock = blocks.filter(function(b) { return b.block_id === 'wp_hours_1'; })[0];
  assert.equal(hoursBlock.element.max_value, '60');
  assert.equal(hoursBlock.element.min_value, '0.5');
});

test('extractRows: parsa progetto+ore, accetta la virgola decimale e salta le righe vuote', function() {
  var state = {
    tt_project_1: { project_select: { selected_option: { value: 'p1' } } },
    tt_hours_1: { hours_input: { value: '4,5' } },
    tt_project_2: { project_select: { selected_option: null } },
    tt_hours_2: { hours_input: { value: null } },
    tt_project_3: { project_select: { selected_option: { value: 'p2' } } },
    tt_hours_3: { hours_input: { value: '2' } },
  };
  var rows = modals.extractRows(state, 'tt');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { index: 1, project_id: 'p1', hours: 4.5 });
  assert.deepEqual(rows[1], { index: 3, project_id: 'p2', hours: 2 });
});

test('extractRows: riga incompleta (solo ore) viene inclusa per la validazione', function() {
  var state = {
    wp_hours_1: { hours_input: { value: '3' } },
  };
  var rows = modals.extractRows(state, 'wp');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].project_id, null);
  assert.equal(rows[0].hours, 3);
});

test('extractNote: trim e null per nota vuota', function() {
  assert.equal(modals.extractNote({ tt_note: { note_input: { value: '  Caption PED ' } } }), 'Caption PED');
  assert.equal(modals.extractNote({ tt_note: { note_input: { value: '   ' } } }), null);
  assert.equal(modals.extractNote({}), null);
});

// ─── Prefill dal daily del mattino ───────────────────────────────────────────

test('buildCheckinBlocks: prefill imposta initial_option e initial_value sulle righe', function() {
  var prefill = [{ project_id: 'p1', hours: 3.5 }, { project_id: 'p2', hours: 1 }];
  var blocks = modals.buildCheckinBlocks(PROJECTS, 2, '2026-07-07', prefill);

  var proj1 = blocks.find(function(b) { return b.block_id === 'tt_project_1'; });
  assert.ok(proj1.element.initial_option, 'riga 1 deve avere il progetto preselezionato');
  assert.equal(proj1.element.initial_option.value, 'p1');

  var hours1 = blocks.find(function(b) { return b.block_id === 'tt_hours_1'; });
  assert.equal(hours1.element.initial_value, '3.5');

  var proj2 = blocks.find(function(b) { return b.block_id === 'tt_project_2'; });
  assert.equal(proj2.element.initial_option.value, 'p2');

  // Il banner "precompilato dal daily" è presente
  var hasBanner = blocks.some(function(b) {
    return b.type === 'context' && b.elements && /precompilato/i.test(b.elements[0].text || '');
  });
  assert.ok(hasBanner);
});

test('buildCheckinBlocks: senza prefill nessun initial_option né banner', function() {
  var blocks = modals.buildCheckinBlocks(PROJECTS, 2, '2026-07-07');
  var proj1 = blocks.find(function(b) { return b.block_id === 'tt_project_1'; });
  assert.equal(proj1.element.initial_option, undefined);
  var hasBanner = blocks.some(function(b) {
    return b.type === 'context' && b.elements && /precompilato/i.test(b.elements[0].text || '');
  });
  assert.equal(hasBanner, false);
});

test('buildCheckinBlocks: prefill con project_id sconosciuto non rompe la riga', function() {
  var blocks = modals.buildCheckinBlocks(PROJECTS, 2, '2026-07-07', [{ project_id: 'sconosciuto', hours: 2 }]);
  var proj1 = blocks.find(function(b) { return b.block_id === 'tt_project_1'; });
  assert.equal(proj1.element.initial_option, undefined, 'niente initial_option se il progetto non è tra le opzioni');
  var hours1 = blocks.find(function(b) { return b.block_id === 'tt_hours_1'; });
  assert.equal(hours1.element.initial_value, '2', 'le ore restano precompilate');
});

test('findOptionByValue: trova le option anche dentro option_groups', function() {
  var grouped = { option_groups: [{ label: { type: 'plain_text', text: 'G' }, options: [
    { text: { type: 'plain_text', text: 'Dicar' }, value: 'p1' },
  ] }] };
  assert.equal(modals.findOptionByValue(grouped, 'p1').value, 'p1');
  assert.equal(modals.findOptionByValue(grouped, 'px'), null);
});
