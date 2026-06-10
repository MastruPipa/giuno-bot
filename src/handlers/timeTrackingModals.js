// ─── Time Tracking Modals ────────────────────────────────────────────────────
// Block Kit builders per Weekly Planner (prefisso wp_) e Daily Check-in
// (prefisso tt_). Builder puri e testabili; l'unico accesso al DB è la cache
// dei progetti attivi (TTL 5 min, stesso pattern di getProjectStatusMap).
//
// Regola block_id: le righe vengono SOLO aggiunte, mai rinumerate — Slack
// preserva i valori già digitati attraverso views.update solo se
// block_id/action_id restano stabili.
'use strict';

var db = require('../../supabase');

var MAX_ROWS_PLANNER = 8;
var MAX_ROWS_CHECKIN = 6;

// ─── Progetti attivi (cache TTL 5 min) ───────────────────────────────────────

var _projCache = null;
var _projCacheAt = 0;

async function getActiveProjectsCached() {
  var now = Date.now();
  if (_projCache && (now - _projCacheAt) < 300000) return _projCache;
  var list = await db.searchProjects({ status: 'active', limit: 100 });
  if (list && list.length > 0) {
    _projCache = list;
    _projCacheAt = now;
  }
  return _projCache || [];
}

function projectOptions(projects) {
  return (projects || []).slice(0, 100).map(function(p) {
    var name = String(p.name || p.id).substring(0, 75);
    return { text: { type: 'plain_text', text: name }, value: String(p.id) };
  });
}

// ─── Builder righe ───────────────────────────────────────────────────────────

function buildRowBlocks(prefix, i, options) {
  return [
    {
      type: 'input', block_id: prefix + '_project_' + i, optional: i > 1,
      label: { type: 'plain_text', text: 'Progetto ' + i },
      element: {
        type: 'static_select', action_id: 'project_select',
        placeholder: { type: 'plain_text', text: 'Scegli un progetto...' },
        options: options,
      },
    },
    {
      type: 'input', block_id: prefix + '_hours_' + i, optional: i > 1,
      label: { type: 'plain_text', text: '⏱ Ore' },
      element: {
        type: 'number_input', action_id: 'hours_input',
        is_decimal_allowed: true, min_value: '0.5', max_value: '24',
        placeholder: { type: 'plain_text', text: 'Es. 4 o 4.5' },
      },
    },
  ];
}

function buildAddRowButton(actionId, currentCount) {
  return {
    type: 'actions', block_id: actionId + '_action',
    elements: [{
      type: 'button',
      text: { type: 'plain_text', text: '+ Aggiungi progetto' },
      action_id: actionId, value: String(currentCount),
    }],
  };
}

// ─── Weekly Planner ──────────────────────────────────────────────────────────

function buildPlannerBlocks(projects, rowCount, weekStart) {
  var options = projectOptions(projects);
  var blocks = [];
  blocks.push({ type: 'header', text: { type: 'plain_text', text: '🗓  Pianifica la prossima settimana' } });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: 'Ore stimate per progetto per la settimana che inizia *' + (weekStart || '') + '*. Aggiungi una riga per ogni progetto.' }],
  });
  for (var i = 1; i <= rowCount; i++) {
    buildRowBlocks('wp', i, options).forEach(function(b) { blocks.push(b); });
  }
  if (rowCount < MAX_ROWS_PLANNER) blocks.push(buildAddRowButton('wp_add_row', rowCount));
  return blocks;
}

function buildPlannerView(projects, meta) {
  return {
    type: 'modal', callback_id: 'wp_submit',
    private_metadata: JSON.stringify(meta),
    title: { type: 'plain_text', text: 'Weekly Planner' },
    submit: { type: 'plain_text', text: '✅ Invia' },
    close: { type: 'plain_text', text: 'Chiudi' },
    blocks: buildPlannerBlocks(projects, meta.rows || 2, meta.week_start),
  };
}

// ─── Daily Check-in ──────────────────────────────────────────────────────────

function buildCheckinBlocks(projects, rowCount, logDate) {
  var options = projectOptions(projects);
  var blocks = [];
  blocks.push({ type: 'header', text: { type: 'plain_text', text: '⏱  Check-in giornaliero' } });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: 'Ore effettivamente lavorate il *' + (logDate || 'oggi') + '*, progetto per progetto.' }],
  });
  for (var i = 1; i <= rowCount; i++) {
    buildRowBlocks('tt', i, options).forEach(function(b) { blocks.push(b); });
  }
  if (rowCount < MAX_ROWS_CHECKIN) blocks.push(buildAddRowButton('tt_add_row', rowCount));
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'input', block_id: 'tt_note', optional: true,
    label: { type: 'plain_text', text: '📝 Stato / note (opzionale)' },
    element: {
      type: 'plain_text_input', action_id: 'note_input', multiline: true,
      placeholder: { type: 'plain_text', text: 'Es. Caption PED' },
    },
  });
  return blocks;
}

function buildCheckinView(projects, meta) {
  return {
    type: 'modal', callback_id: 'tt_submit',
    private_metadata: JSON.stringify(meta),
    title: { type: 'plain_text', text: 'Check-in giornaliero' },
    submit: { type: 'plain_text', text: '✅ Invia' },
    close: { type: 'plain_text', text: 'Chiudi' },
    blocks: buildCheckinBlocks(projects, meta.rows || 2, meta.log_date),
  };
}

// ─── Parsing submission ──────────────────────────────────────────────────────

// Estrae le righe progetto+ore dallo state della view. Una riga è inclusa se
// almeno uno dei due campi è valorizzato (la completezza la verifica il
// validatore, con errori puntuali sul block_id giusto).
function extractRows(stateValues, prefix) {
  var rows = [];
  var maxRows = prefix === 'wp' ? MAX_ROWS_PLANNER : MAX_ROWS_CHECKIN;
  for (var i = 1; i <= maxRows; i++) {
    var pBlock = stateValues[prefix + '_project_' + i];
    var hBlock = stateValues[prefix + '_hours_' + i];
    var projectId = pBlock && pBlock.project_select && pBlock.project_select.selected_option
      ? pBlock.project_select.selected_option.value : null;
    var hoursRaw = hBlock && hBlock.hours_input ? hBlock.hours_input.value : null;
    if (!projectId && (hoursRaw == null || hoursRaw === '')) continue;
    var hours = (hoursRaw == null || hoursRaw === '') ? null : parseFloat(String(hoursRaw).replace(',', '.'));
    rows.push({ index: i, project_id: projectId, hours: hours });
  }
  return rows;
}

function extractNote(stateValues) {
  var b = stateValues.tt_note;
  var v = b && b.note_input ? b.note_input.value : null;
  return v && String(v).trim() ? String(v).trim() : null;
}

module.exports = {
  MAX_ROWS_PLANNER: MAX_ROWS_PLANNER,
  MAX_ROWS_CHECKIN: MAX_ROWS_CHECKIN,
  getActiveProjectsCached: getActiveProjectsCached,
  buildPlannerBlocks: buildPlannerBlocks,
  buildPlannerView: buildPlannerView,
  buildCheckinBlocks: buildCheckinBlocks,
  buildCheckinView: buildCheckinView,
  extractRows: extractRows,
  extractNote: extractNote,
};
