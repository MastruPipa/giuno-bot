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
var slackService = require('../services/slackService');
var filters = require('./projectFilters');

// Stage dei deal che corrispondono a progetti attivi. Deciso con il team:
// Contratto e In Progress (in lavorazione) + Won (firmati/in consegna) — un
// deal che passa a Contratto e poi a Won deve restare tra i progetti.
// Il match è per SOTTOSTRINGA perché lo stage reale può contenere emoji o
// suffissi (es. "Won 🎉"), quindi un confronto esatto fallirebbe.
var ACTIVE_STAGES = ['contratto', 'in progress', 'won'];

function firstOf(v) { return Array.isArray(v) ? v[0] : v; }

function normStage(s) {
  s = firstOf(s);
  return s == null ? '' : String(s).toLowerCase().trim();
}

// Attivo se lo stage normalizzato CONTIENE una delle keyword attive.
function isActiveStage(stage) {
  var n = normStage(stage);
  if (!n) return false;
  for (var i = 0; i < ACTIVE_STAGES.length; i++) {
    if (n.indexOf(ACTIVE_STAGES[i]) !== -1) return true;
  }
  return false;
}

// I Won non hanno una data di attività affidabile su Attio (import in blocco),
// quindi vengono "gateati" sull'attività del canale Slack del cliente.
function isWonStage(stage) {
  return normStage(stage).indexOf('won') !== -1;
}

// Indice inverso nome-canale → channel_id dalla channel_map, per agganciare un
// deal Won al suo canale Slack. Coppie [needle, channelId] con il nome cliente
// e il nome canale (entrambi normalizzati a valle via nameMatches).
function buildChannelIndex() {
  var map = db.getChannelMapCache() || {};
  var pairs = [];
  Object.keys(map).forEach(function(cid) {
    var e = map[cid] || {};
    if (e.cliente) pairs.push([e.cliente, cid]);
    if (e.channel_name) pairs.push([e.channel_name, cid]);
  });
  return pairs;
}

// Un deal Won è "vivo" se esiste un canale Slack che combacia col nome e che è
// stato attivo nella finestra. channelActivity è memoizzata per channel_id.
async function isWonBackedByActiveChannel(name, channelPairs, activityCache) {
  for (var i = 0; i < channelPairs.length; i++) {
    if (!filters.nameMatches(name, channelPairs[i][0])) continue;
    var cid = channelPairs[i][1];
    if (!(cid in activityCache)) {
      var act = await slackService.channelActivity(cid, filters.ACTIVITY_WINDOW_DAYS, 1);
      activityCache[cid] = !!(act && act.active);
    }
    if (activityCache[cid]) return true;
  }
  return false;
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
      if (!isActiveStage(v.stage)) continue;
      var name = cleanName(v.name);
      if (name.length < 2) continue;
      if (filters.isJunkProjectName(name)) continue;
      active.push({ record_id: d.record_id, name: name, values: v, isWon: isWonStage(v.stage) });
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
    tags: ['attio-sync', 'tipo:cliente'],
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

  // Gate dei Won sull'attività del canale Slack. Se non abbiamo dati canale
  // (channel_map vuota) non potiamo al buio: includiamo i Won.
  var channelPairs = buildChannelIndex();
  var haveChannelData = channelPairs.length > 0;
  var activityCache = {};

  var activeIds = [];
  var synced = 0;
  var wonDropped = 0;
  for (var i = 0; i < deals.length; i++) {
    var deal = deals[i];
    if (deal.isWon && haveChannelData) {
      var alive = await isWonBackedByActiveChannel(deal.name, channelPairs, activityCache);
      if (!alive) { wonDropped++; continue; }
    }
    var row = dealToProjectRow(deal);
    activeIds.push(row.id);
    var res = await db.upsertSyncedProject(row);
    if (res) synced++;
  }
  var archived = await db.archiveStaleSyncedProjects('attio_%', activeIds);
  logger.info('[PROJECT-SYNC] Sincronizzati', synced, 'progetti attivi da Attio,',
    wonDropped, 'Won senza canale attivo esclusi,', archived, 'archiviati.');
  return { synced: synced, archived: archived, wonDropped: wonDropped };
}

module.exports = {
  syncActiveProjectsFromAttio: syncActiveProjectsFromAttio,
  ACTIVE_STAGES: ACTIVE_STAGES,
};
