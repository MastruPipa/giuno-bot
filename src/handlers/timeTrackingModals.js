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
var norm = require('../jobs/projectFilters').norm;

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

function projectOption(p) {
  var name = String(p.name || p.id).substring(0, 75);
  return { text: { type: 'plain_text', text: name }, value: String(p.id) };
}

// Opzioni flat dedupate per nome normalizzato (primo id incontrato vince).
function projectOptions(projects) {
  var seen = {};
  var out = [];
  (projects || []).forEach(function(p) {
    var key = norm(p.name || p.id);
    if (seen[key]) return;
    seen[key] = true;
    out.push(projectOption(p));
  });
  return out.slice(0, 100);
}

// Tipologia di un progetto dal tag 'tipo:*' (fallback su prefisso id).
function projectTipo(p) {
  var tags = (p && p.tags) || [];
  for (var i = 0; i < tags.length; i++) {
    var t = String(tags[i]);
    if (t.indexOf('tipo:') === 0) return t.substring(5);
  }
  var id = String((p && p.id) || '');
  if (id.indexOf('cat_') === 0) return 'categoria';
  if (id.indexOf('attio_') === 0) return 'cliente';
  return 'progetto';
}

// Costruisce la sorgente del static_select: raggruppata per tipologia
// (option_groups) quando ci sono ≥2 gruppi valorizzati, altrimenti options
// flat. Slack ammette max 100 opzioni totali: si troncano in ordine di gruppo.
var GROUP_ORDER = [
  { tipo: 'cliente',   label: 'Clienti' },
  { tipo: 'progetto',  label: 'Progetti' },
  { tipo: 'interno',   label: 'Interni' },
  { tipo: 'categoria', label: 'Categorie' },
];

function buildProjectSelectSource(projects) {
  var buckets = { cliente: [], progetto: [], interno: [], categoria: [] };
  (projects || []).forEach(function(p) {
    var tipo = projectTipo(p);
    if (!buckets[tipo]) tipo = 'progetto';
    buckets[tipo].push(projectOption(p));
  });

  // Dedup per nome normalizzato attraverso i gruppi, in ordine di priorità
  // (Clienti → Progetti → Interni → Categorie): un nome già visto in un gruppo
  // a priorità più alta non si ripete. Es. "Hammersud" resta solo in Clienti,
  // i deal omonimi ("DICAR"×2) si fondono in una voce.
  var seen = {};
  var groups = [];
  var total = 0;
  for (var i = 0; i < GROUP_ORDER.length && total < 100; i++) {
    var g = GROUP_ORDER[i];
    var raw = buckets[g.tipo] || [];
    var opts = [];
    for (var j = 0; j < raw.length && total < 100; j++) {
      var key = norm(raw[j].text && raw[j].text.text);
      if (seen[key]) continue;
      seen[key] = true;
      opts.push(raw[j]);
      total++;
    }
    if (opts.length === 0) continue;
    groups.push({ label: { type: 'plain_text', text: g.label }, options: opts });
  }

  if (groups.length >= 2) return { option_groups: groups };
  // Un solo gruppo (o nessuno) → options flat.
  return { options: projectOptions(projects) };
}

// ─── Builder righe ───────────────────────────────────────────────────────────

// Aggrega una lista flat di task dei daily ({project_id, hours, minutes}) in
// righe di prefill [{project_id, hours}] ordinate per ore decrescenti. Usata
// dal check-in serale (task del giorno) e dal weekly planner (task dell'intera
// settimana). minHours = minimo del number_input (0.5), maxHours = cap riga.
function prefillRowsFromTasks(tasks, maxRows, maxHoursPerRow) {
  var byProject = {};
  (tasks || []).forEach(function(t) {
    if (!t || !t.project_id) return;
    var h = (parseInt(t.hours, 10) || 0) + (parseInt(t.minutes, 10) || 0) / 60;
    byProject[t.project_id] = (byProject[t.project_id] || 0) + h;
  });
  return Object.keys(byProject)
    .map(function(pid) {
      var hours = Math.max(0.5, Math.round(byProject[pid] * 100) / 100);
      if (maxHoursPerRow) hours = Math.min(hours, maxHoursPerRow);
      return { project_id: pid, hours: hours };
    })
    .sort(function(a, b) { return b.hours - a.hours; })
    .slice(0, maxRows);
}

// Trova l'option del select con un dato value (serve per initial_option:
// Slack esige l'oggetto option esatto, non basta il value).
function findOptionByValue(selectSource, value) {
  if (!value) return null;
  var pools = selectSource.option_groups
    ? selectSource.option_groups.map(function(g) { return g.options; })
    : [selectSource.options || []];
  for (var i = 0; i < pools.length; i++) {
    for (var j = 0; j < pools[i].length; j++) {
      if (pools[i][j].value === String(value)) return pools[i][j];
    }
  }
  return null;
}

function buildRowBlocks(prefix, i, selectSource, prefillRow) {
  // Il check-in è un giorno solo (max 24h); il planner copre l'intera
  // settimana su un progetto, quindi ammette fino a 60h per riga.
  var maxHours = prefix === 'wp' ? '60' : '24';
  var selectElement = Object.assign({
    type: 'static_select', action_id: 'project_select',
    placeholder: { type: 'plain_text', text: 'Scegli un progetto...' },
  }, selectSource);
  var hoursElement = {
    type: 'number_input', action_id: 'hours_input',
    is_decimal_allowed: true, min_value: '0.5', max_value: maxHours,
    placeholder: { type: 'plain_text', text: 'Es. 4 o 4.5' },
  };
  // Prefill dal daily del mattino: progetto e ore stimate già selezionati,
  // l'utente conferma o corregge (leva principale per l'adozione del check-in).
  if (prefillRow) {
    var initialOption = findOptionByValue(selectSource, prefillRow.project_id);
    if (initialOption) selectElement.initial_option = initialOption;
    var h = parseFloat(prefillRow.hours);
    if (h >= 0.5) hoursElement.initial_value = String(Math.min(h, parseFloat(maxHours)));
  }
  return [
    {
      type: 'input', block_id: prefix + '_project_' + i, optional: i > 1,
      label: { type: 'plain_text', text: 'Progetto ' + i },
      element: selectElement,
    },
    {
      type: 'input', block_id: prefix + '_hours_' + i, optional: i > 1,
      label: { type: 'plain_text', text: '⏱ Ore' },
      element: hoursElement,
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

function buildPlannerBlocks(projects, rowCount, weekStart, prefill) {
  var selectSource = buildProjectSelectSource(projects);
  var blocks = [];
  blocks.push({ type: 'header', text: { type: 'plain_text', text: '🗓  Pianifica la prossima settimana' } });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: 'Ore stimate per progetto per la settimana che inizia *' + (weekStart || '') + '*. Aggiungi una riga per ogni progetto.' }],
  });
  if (prefill && prefill.length > 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '✨ Precompilato dai tuoi daily di questa settimana — conferma o aggiusta per la prossima.' }],
    });
  }
  for (var i = 1; i <= rowCount; i++) {
    buildRowBlocks('wp', i, selectSource, prefill && prefill[i - 1]).forEach(function(b) { blocks.push(b); });
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
    blocks: buildPlannerBlocks(projects, meta.rows || 2, meta.week_start, meta.prefill),
  };
}

// ─── Daily Check-in ──────────────────────────────────────────────────────────

function buildCheckinBlocks(projects, rowCount, logDate, prefill) {
  var selectSource = buildProjectSelectSource(projects);
  var blocks = [];
  blocks.push({ type: 'header', text: { type: 'plain_text', text: '⏱  Check-in giornaliero' } });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: 'Ore effettivamente lavorate il *' + (logDate || 'oggi') + '*, progetto per progetto.' }],
  });
  if (prefill && prefill.length > 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '✨ Precompilato dal tuo daily di stamattina — conferma o correggi le ore reali.' }],
    });
  }
  for (var i = 1; i <= rowCount; i++) {
    buildRowBlocks('tt', i, selectSource, prefill && prefill[i - 1]).forEach(function(b) { blocks.push(b); });
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
    blocks: buildCheckinBlocks(projects, meta.rows || 2, meta.log_date, meta.prefill),
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
  findOptionByValue: findOptionByValue,
  prefillRowsFromTasks: prefillRowsFromTasks,
  getActiveProjectsCached: getActiveProjectsCached,
  projectOptions: projectOptions,
  buildProjectSelectSource: buildProjectSelectSource,
  buildPlannerBlocks: buildPlannerBlocks,
  buildPlannerView: buildPlannerView,
  buildCheckinBlocks: buildCheckinBlocks,
  buildCheckinView: buildCheckinView,
  extractRows: extractRows,
  extractNote: extractNote,
};
