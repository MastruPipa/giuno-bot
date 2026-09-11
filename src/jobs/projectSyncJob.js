// Import won deals as candidates; operational lifecycle is verified separately.
'use strict';

var logger = require('../utils/logger');
var attio = require('../services/attioService');
var db = require('../../supabase');
var filters = require('./projectFilters');

// Only a completed sale enters the project catalogue. Operational activity
// needs separate evidence; the CRM pipeline does not track project completion.
var ACTIVE_STAGES = ['won', 'won 🎉'];
function firstOf(v) { return Array.isArray(v) ? v[0] : v; }
function normStage(s) { return String(firstOf(s) || '').toLowerCase().trim(); }
function isActiveStage(stage) { return ACTIVE_STAGES.includes(normStage(stage)); }
function isWonStage(stage) { return isActiveStage(stage); }

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
      throw e;
    }
    if (!Array.isArray(batch)) throw new Error('Risposta Attio non valida');
    if (batch.length === 0) return active;
    for (var i = 0; i < batch.length; i++) {
      var d = batch[i];
      var v = d.values || {};
      if (!isActiveStage(v.stage)) continue;
      var name = cleanName(v.name);
      if (name.length < 2) continue;
      if (filters.isJunkProjectName(name)) continue;
      active.push({ record_id: d.record_id, name: name, values: v, isWon: isWonStage(v.stage) });
    }
    if (batch.length < pageSize) return active;
  }
  throw new Error('Scansione Attio incompleta: limite pagine raggiunto');
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
    status: 'planning',
    budget_quoted: budget,
    service_category: serviceCategory ? serviceCategory.substring(0, 200) : null,
    tags: ['attio-sync', 'tipo:cliente', 'sales:won'],
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
  var wonDropped = 0;
  for (var i = 0; i < deals.length; i++) {
    var deal = deals[i];
    var row = dealToProjectRow(deal);
    activeIds.push(row.id);
    var res = await db.upsertSyncedProject(row);
    if (!res) throw new Error('Sincronizzazione progetto fallita: ' + row.id);
    synced++;
  }
  var archived = await db.archiveStaleSyncedProjects('attio_%', activeIds);
  logger.info('[PROJECT-SYNC] Sincronizzati', synced, 'progetti attivi da Attio,',
    wonDropped, 'Won senza canale attivo esclusi,', archived, 'archiviati.');
  return { synced: synced, archived: archived, wonDropped: wonDropped };
}

module.exports = {
  syncActiveProjectsFromAttio: syncActiveProjectsFromAttio,
  ACTIVE_STAGES: ACTIVE_STAGES,
  isActiveStage: isActiveStage,
};
