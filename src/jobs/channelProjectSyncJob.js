// ─── Channel Project Sync Job ──────────────────────────────────────────────
// Sincronizza i canali Slack ATTIVI (≥1 messaggio negli ultimi ~60 giorni)
// nella tabella projects, così la casella progetti del weekly planner/check-in
// include anche clienti storici e progetti interni che NON sono su Attio.
//
// Mappatura: ogni canale attivo presente in channel_map → progetto attivo con
// id 'chan_<channel_id>' e tag 'channel-sync' + tipologia (tipo:cliente |
// tipo:progetto | tipo:interno) dedotta dai tag del canale. I progetti interni
// entrano "per nome" (uno per canale interno), non in un bucket unico.
//
// Dedup: un canale il cui cliente/nome coincide (normalizzato) con un progetto
// 'attio_%' attivo viene saltato — Attio è autorevole per quel cliente.
'use strict';

var logger = require('../utils/logger');
var db = require('../../supabase');
var slackService = require('../services/slackService');
var filters = require('./projectFilters');

var ACTIVITY_DAYS = filters.ACTIVITY_WINDOW_DAYS;
var norm = filters.norm;

// Tipologia dai tag del canale. Priorità: interno → cliente → progetto.
function deriveType(entry) {
  var tags = entry.tags || [];
  for (var i = 0; i < tags.length; i++) {
    if (/interno/i.test(String(tags[i]))) return 'tipo:interno';
  }
  if (entry.cliente) return 'tipo:cliente';
  for (var j = 0; j < tags.length; j++) {
    if (/^tipo:cliente|^cliente:/i.test(String(tags[j]))) return 'tipo:cliente';
  }
  return 'tipo:progetto';
}

// Insieme dei nomi/clienti (normalizzati) già coperti da progetti Attio attivi.
function attioNameSet(activeProjects) {
  var set = {};
  (activeProjects || []).forEach(function(p) {
    if (!p || String(p.id).indexOf('attio_') !== 0) return;
    if (p.name) set[norm(p.name)] = true;
    if (p.client_name) set[norm(p.client_name)] = true;
  });
  return set;
}

async function syncProjectsFromChannels() {
  if (!db.isSupabase || !db.isSupabase()) {
    logger.info('[CHANNEL-SYNC] Supabase non attivo, skip.');
    return { synced: 0, archived: 0, skipped: true };
  }

  var map = db.getChannelMapCache() || {};
  var channelIds = Object.keys(map);
  if (channelIds.length === 0) {
    logger.info('[CHANNEL-SYNC] channel_map vuota, skip.');
    return { synced: 0, archived: 0, skipped: true };
  }

  // Progetti Attio attivi per il dedup (Attio è autorevole per quei clienti).
  var activeProjects = await db.searchProjects({ status: 'active', limit: 200 });
  var attioNames = attioNameSet(activeProjects);

  var activeIds = [];
  var synced = 0;
  var skippedDedup = 0;

  for (var i = 0; i < channelIds.length; i++) {
    var channelId = channelIds[i];
    var entry = map[channelId] || {};
    var type = deriveType(entry);

    // Canali generici/di servizio (daily, generale, casuale, ...) → esclusi
    // anche se taggati "interno".
    if (filters.isGenericChannel(entry.channel_name)) continue;

    // Canali generici (no cliente, no progetto, non interno) → esclusi.
    if (type !== 'tipo:interno' && !entry.cliente && !entry.progetto) continue;

    // Verifica attività nella finestra (ultimi 30g).
    var activity = await slackService.channelActivity(channelId, ACTIVITY_DAYS, 1);
    if (!activity.active) continue;

    var name = entry.progetto || entry.cliente || entry.channel_name;
    name = String(name == null ? '' : name).replace(/\\/g, '').trim();
    if (name.length < 2) continue;
    if (filters.isJunkProjectName(name)) continue;

    // Dedup vs Attio: salta se cliente/nome coincide con un progetto Attio attivo.
    if (attioNames[norm(entry.cliente)] || attioNames[norm(name)]) {
      skippedDedup++;
      continue;
    }

    var row = {
      id: 'chan_' + channelId,
      name: name.substring(0, 200),
      client_name: entry.cliente ? String(entry.cliente).substring(0, 200) : null,
      status: 'active',
      tags: ['channel-sync', type],
    };
    activeIds.push(row.id);
    var res = await db.upsertSyncedProject(row);
    if (res) synced++;
  }

  var archived = await db.archiveStaleSyncedProjects('chan_%', activeIds);
  logger.info('[CHANNEL-SYNC] Sincronizzati', synced, 'progetti da canali attivi (' +
    ACTIVITY_DAYS + 'g),', skippedDedup, 'saltati per dedup Attio,', archived, 'archiviati.');
  return { synced: synced, archived: archived, skippedDedup: skippedDedup };
}

module.exports = {
  syncProjectsFromChannels: syncProjectsFromChannels,
  ACTIVITY_DAYS: ACTIVITY_DAYS,
};
