// ─── Metrics Service (in-memory counters + local persistence) ────────────────

'use strict';

var fs = require('fs');
var path = require('path');
var logger = require('../utils/logger');
var dbClient = require('./db/client');

var METRICS_FILE = path.join(process.cwd(), '.metrics-cache.json');
var counters = Object.create(null);
var _dirtyWrites = 0;

function loadFromDisk() {
  try {
    if (!fs.existsSync(METRICS_FILE)) return;
    var raw = fs.readFileSync(METRICS_FILE, 'utf8');
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    Object.keys(parsed).forEach(function(k) {
      if (typeof parsed[k] === 'number' && !Number.isNaN(parsed[k])) counters[k] = parsed[k];
    });
  } catch (e) {
    logger.warn('[METRICS] load cache fallita:', e.message);
  }
}

function saveToDisk() {
  try {
    fs.writeFileSync(METRICS_FILE, JSON.stringify(counters, null, 2), 'utf8');
  } catch (e) {
    logger.warn('[METRICS] save cache fallita:', e.message);
  }
}


async function flushToSupabase() {
  if (!dbClient.useSupabase || !dbClient.getClient()) return false;
  try {
    var rows = Object.keys(counters).map(function(name) {
      return { metric_name: name, metric_value: counters[name], updated_at: new Date().toISOString() };
    });
    if (rows.length === 0) return true;
    await dbClient.getClient().from('runtime_metrics').upsert(rows, { onConflict: 'metric_name' });
    return true;
  } catch (e) {
    logger.warn('[METRICS] flush supabase fallita:', e.message);
    return false;
  }
}

function increment(name, by) {
  by = (typeof by === 'number' && !Number.isNaN(by)) ? by : 1;
  counters[name] = (counters[name] || 0) + by;
  saveToDisk();
  _dirtyWrites++;
  if (_dirtyWrites % 25 === 0) flushToSupabase();
  return counters[name];
}

function get(name) {
  return counters[name] || 0;
}

function snapshot() {
  return Object.assign({}, counters);
}

function reset() {
  Object.keys(counters).forEach(function(k) { delete counters[k]; });
  saveToDisk();
}

function getMetricsFilePath() {
  return METRICS_FILE;
}

loadFromDisk();

module.exports = {
  increment: increment,
  get: get,
  snapshot: snapshot,
  reset: reset,
  getMetricsFilePath: getMetricsFilePath,
  flushToSupabase: flushToSupabase,
};
