// ─── API Cost Tracker ───────────────────────────────────────────────────────
// Tracks API calls, tokens, and estimated costs per provider/model/day.
// Aggregates in-memory, flushes to DB every 5 minutes.
'use strict';

var logger = require('../utils/logger');
var dates = require('../utils/dates');

// Pricing per 1M tokens (USD) — update as needed
var PRICING = {
  'claude-opus-5':               { input: 5.00, output: 25.00 },
  'claude-sonnet-5':             { input: 2.00, output: 10.00 },
  'claude-haiku-4-5':            { input: 1.00, output: 5.00 },
  'claude-opus-4-8':             { input: 5.00, output: 25.00 },
  'claude-haiku-4-5-20251001':   { input: 1.00, output: 5.00 },
  'text-embedding-3-small':      { input: 0.02, output: 0 },
};

// Letture dalla cache: un decimo del prezzo input; scritture: 1,25 volte.
var CACHE_READ_FACTOR = 0.1;
var CACHE_WRITE_FACTOR = 1.25;

// In-memory buffer
var _buffer = {}; // key: "date|provider|model|feature" -> { input_tokens, output_tokens, cache_read, cache_write, calls }

function getKey(provider, model, feature) {
  var date = dates.todayISO();
  return date + '|' + provider + '|' + model + '|' + (feature || 'chat');
}

// opts: { feature, cacheRead, cacheWrite } — inputTokens sono i token NON in
// cache; i token letti/scritti in cache viaggiano a parte e costano diverso.
// Prima (fino al 17/9) la chat contava tutto a prezzo pieno e le 21 chiamate
// utility non venivano contate affatto.
function trackCall(provider, model, inputTokens, outputTokens, opts) {
  opts = opts || {};
  var key = getKey(provider, model, opts.feature);
  if (!_buffer[key]) {
    _buffer[key] = { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, calls: 0 };
  }
  _buffer[key].input_tokens += inputTokens || 0;
  _buffer[key].output_tokens += outputTokens || 0;
  _buffer[key].cache_read += opts.cacheRead || 0;
  _buffer[key].cache_write += opts.cacheWrite || 0;
  _buffer[key].calls++;
}

function estimateCost(model, inputTokens, outputTokens, cacheRead, cacheWrite) {
  var pricing = PRICING[model];
  if (!pricing) return 0;
  return ((inputTokens || 0) / 1000000 * pricing.input) + ((outputTokens || 0) / 1000000 * pricing.output) +
    ((cacheRead || 0) / 1000000 * pricing.input * CACHE_READ_FACTOR) + ((cacheWrite || 0) / 1000000 * pricing.input * CACHE_WRITE_FACTOR);
}

function bufferSnapshot() { return JSON.parse(JSON.stringify(_buffer)); }

async function flushToDb() {
  try {
    var dbClient = require('./db/client');
    var supabase = dbClient.getClient();
    if (!supabase) return;

    var keys = Object.keys(_buffer);
    if (keys.length === 0) return;

    for (var i = 0; i < keys.length; i++) {
      var parts = keys[i].split('|');
      var date = parts[0];
      var provider = parts[1];
      var model = parts[2];
      var feature = parts[3] || 'chat';
      var buf = _buffer[keys[i]];
      var cost = estimateCost(model, buf.input_tokens, buf.output_tokens, buf.cache_read, buf.cache_write);
      // input_tokens in tabella = tutto l'input (cache compresa), come prima.
      var totalInput = buf.input_tokens + (buf.cache_read || 0) + (buf.cache_write || 0);

      // Simple approach: try insert, if fails (duplicate) then update
      try {
        var row = {
          date: date, provider: provider, model: model, feature: feature,
          input_tokens: totalInput, output_tokens: buf.output_tokens,
          calls: buf.calls, estimated_cost_usd: cost,
        };
        var insertRes = await supabase.from('api_usage').insert(row);
        if (insertRes.error && /feature/.test(String(insertRes.error.message || ''))) {
          // Colonna non ancora applicata: si salva senza la funzione.
          delete row.feature;
          insertRes = await supabase.from('api_usage').insert(row);
        }
        if (insertRes.error) {
          // Duplicate — update existing row by adding to current values
          var { data: existing } = await supabase.from('api_usage')
            .select('input_tokens, output_tokens, calls, estimated_cost_usd')
            .eq('date', date).eq('provider', provider).eq('model', model).single();
          if (existing) {
            await supabase.from('api_usage').update({
              input_tokens: (existing.input_tokens || 0) + totalInput,
              output_tokens: (existing.output_tokens || 0) + buf.output_tokens,
              calls: (existing.calls || 0) + buf.calls,
              estimated_cost_usd: (parseFloat(existing.estimated_cost_usd) || 0) + cost,
              updated_at: new Date().toISOString(),
            }).eq('date', date).eq('provider', provider).eq('model', model);
          }
        }
      } catch(e2) { logger.debug('[COST-TRACKER] Entry error:', e2.message); }
    }

    _buffer = {};
  } catch(e) {
    logger.debug('[COST-TRACKER] Flush error:', e.message);
  }
}

// Get cost summary
async function getCostSummary(days) {
  days = days || 30;
  try {
    var dbClient = require('./db/client');
    var supabase = dbClient.getClient();
    if (!supabase) return null;

    var fromDate = dates.daysFromTodayISO(-days);
    var { data } = await supabase.from('api_usage')
      .select('*')
      .gte('date', fromDate)
      .order('date', { ascending: false });

    if (!data || data.length === 0) return { message: 'Nessun dato di costo disponibile.' };

    // Aggregate
    var totalCost = 0;
    var totalCalls = 0;
    var totalInputTokens = 0;
    var totalOutputTokens = 0;
    var byProvider = {};
    var byDay = {};
    var byFeature = {};
    var byModel = {};

    data.forEach(function(row) {
      totalCost += parseFloat(row.estimated_cost_usd) || 0;
      totalCalls += row.calls || 0;
      totalInputTokens += row.input_tokens || 0;
      totalOutputTokens += row.output_tokens || 0;

      if (!byProvider[row.provider]) byProvider[row.provider] = { cost: 0, calls: 0 };
      byProvider[row.provider].cost += parseFloat(row.estimated_cost_usd) || 0;
      byProvider[row.provider].calls += row.calls || 0;

      if (!byDay[row.date]) byDay[row.date] = { cost: 0, calls: 0 };
      byDay[row.date].cost += parseFloat(row.estimated_cost_usd) || 0;
      byDay[row.date].calls += row.calls || 0;

      var feat = row.feature || 'chat';
      if (!byFeature[feat]) byFeature[feat] = { cost: 0, calls: 0 };
      byFeature[feat].cost += parseFloat(row.estimated_cost_usd) || 0;
      byFeature[feat].calls += row.calls || 0;
      if (!byModel[row.model]) byModel[row.model] = { cost: 0, calls: 0 };
      byModel[row.model].cost += parseFloat(row.estimated_cost_usd) || 0;
      byModel[row.model].calls += row.calls || 0;
    });
    function rounded(map) { var o = {}; Object.keys(map).sort(function(a, b) { return map[b].cost - map[a].cost; }).forEach(function(k) { o[k] = { cost_usd: Math.round(map[k].cost * 100) / 100, calls: map[k].calls }; }); return o; }

    var avgDailyCost = totalCost / Math.max(Object.keys(byDay).length, 1);

    return {
      period: days + ' giorni',
      total_cost_usd: Math.round(totalCost * 100) / 100,
      total_calls: totalCalls,
      total_tokens: { input: totalInputTokens, output: totalOutputTokens },
      avg_daily_cost_usd: Math.round(avgDailyCost * 100) / 100,
      projected_monthly_usd: Math.round(avgDailyCost * 30 * 100) / 100,
      by_provider: byProvider,
      by_feature: rounded(byFeature),
      by_model: rounded(byModel),
      recent_days: Object.entries(byDay).slice(0, 7).map(function(d) {
        return { date: d[0], cost_usd: Math.round(d[1].cost * 100) / 100, calls: d[1].calls };
      }),
    };
  } catch(e) {
    return { error: e.message };
  }
}

// Auto-flush every 5 minutes
var _flushTimer = setInterval(flushToDb, 5 * 60 * 1000);
if (_flushTimer.unref) _flushTimer.unref(); // non tiene vivo il processo (test, shutdown)

module.exports = { trackCall: trackCall, flushToDb: flushToDb, getCostSummary: getCostSummary, estimateCost: estimateCost, bufferSnapshot: bufferSnapshot, PRICING: PRICING };
