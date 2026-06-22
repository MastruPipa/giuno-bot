// ─── Project Sync Job ──────────────────────────────────────────────────────
// Sincronizza i deal Attio "in lavorazione" nella tabella projects di Supabase,
// così la casella progetti del weekly planner (e gli altri consumatori di
// searchProjects) riflette i progetti realmente attivi senza inserimento
// manuale. Attio è il CRM di riferimento; questa tabella ne è una proiezione.
//
// Mappatura: deal con stage ∈ ACTIVE_STAGES → progetto attivo. I progetti
// sincronizzati hanno id 'attio_<record_id>' e tag 'attio-sync', così non
// collidono con quelli creati a mano e possono essere archiviati quando il
// deal esce dagli stage attivi.
'use strict';

var logger = require('../utils/logger');
var attio = require('../services/attioService');
var db = require('../../supabase');

// Stage dei deal che corrispondono a progetti in lavorazione (confronto
// case-insensitive sul titolo). Deciso con il team: solo firmati/in corso.
var ACTIVE_STAGES = ['contratto', 'in progress'];

function firstOf(v) { return Array.isArray(v) ? v[0] : v; }

function normStage(s) {
  s = firstOf(s);
  return s == null ? '' : String(s).toLowerCase().trim();
}

// I nomi deal possono contenere caratteri spazzatura (es. "\\"): ripuliamo e
// scartiamo quelli vuoti.
function cleanName(n) {
  n = firstOf(n);
  return String(n == null ? '' : n).replace(/\\/g, '').trim();
}

async function fetchActiveDeals() {
  var active = [];
  var pageSize = 50;
  var maxPages = 10; // fino a 500 deal
  for (var page = 0; page < maxPages; page++) {
    var batch;
    try {
      batch = await attio.queryRecords('deals', null, pageSize, null, page * pageSize);
    } catch(e) {
      logger.warn('[PROJECT-SYNC] query deals fallita a pagina', page, '-', e && e.message);
      break;
    }
    if (!batch || batch.length === 0) break;
    for (var i = 0; i < batch.length; i++) {
      var d = batch[i];
      var v = d.values || {};
      if (ACTIVE_STAGES.indexOf(normStage(v.stage)) === -1) continue;
      var name = cleanName(v.name);
      if (name.length < 2) continue;
      active.push({ record_id: d.record_id, name: name, values: v });
    }
    if (batch.length < pageSize) break;
  }
  return active;
}

function dealToProjectRow(deal) {
  var v = deal.values || {};
  var val = firstOf(v.value);
  var budget = typeof val === 'number' ? val : null;
  var svc = v.servizio_proposto;
  var serviceCategory = Array.isArray(svc) ? svc.join(', ') : (svc != null ? String(svc) : null);
  return {
    id: 'attio_' + deal.record_id,
    name: deal.name.substring(0, 200),
    status: 'active',
    budget_quoted: budget,
    service_category: serviceCategory ? serviceCategory.substring(0, 200) : null,
    tags: ['attio-sync'],
  };
}

async function syncActiveProjectsFromAttio() {
  if (!attio.isConfigured()) {
    logger.info('[PROJECT-SYNC] Attio non configurato, skip.');
    return { synced: 0, archived: 0, skipped: true };
  }
  if (!db.isSupabase()) {
    logger.info('[PROJECT-SYNC] Supabase non attivo, skip.');
    return { synced: 0, archived: 0, skipped: true };
  }
  var deals = await fetchActiveDeals();
  var activeIds = [];
  var synced = 0;
  for (var i = 0; i < deals.length; i++) {
    var row = dealToProjectRow(deals[i]);
    activeIds.push(row.id);
    var res = await db.upsertSyncedProject(row);
    if (res) synced++;
  }
  var archived = await db.archiveStaleSyncedProjects(activeIds);
  logger.info('[PROJECT-SYNC] Sincronizzati', synced, 'progetti attivi da Attio,', archived, 'archiviati.');
  return { synced: synced, archived: archived };
}

module.exports = {
  syncActiveProjectsFromAttio: syncActiveProjectsFromAttio,
  ACTIVE_STAGES: ACTIVE_STAGES,
};
