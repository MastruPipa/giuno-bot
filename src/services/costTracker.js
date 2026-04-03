// ─── API Cost Tracker ───────────────────────────────────────────────────────
// Tracks API calls, tokens, and estimated costs per provider/model/day.
// Aggregates in-memory, flushes to DB every 5 minutes.
'use strict';

var logger = require('../utils/logger');

// Pricing per 1M tokens (USD) — update as needed
var PRICING = {
  'claude-sonnet-4-20250514':    { input: 3.00, output: 15.00 },
  'claude-haiku-4-5-20251001':   { input: 0.80, output: 4.00 },
  'text-embedding-3-small':      { input: 0.02, output: 0 },
};

// In-memory buffer
var _buffer = {}; // key: "date|provider|model" -> { input_tokens, output_tokens, calls }

function getKey(provider, model) {
  var date = new Date().toISOString().slice(0, 10);
  return date + '|' + provider + '|' + model;
}

function trackCall(provider, model, inputTokens, outputTokens) {
  var key = getKey(provider, model);
  if (!_buffer[key]) {
    _buffer[key] = { input_tokens: 0, output_tokens: 0, calls: 0 };
  }
  _buffer[key].input_tokens += inputTokens || 0;
  _buffer[key].output_tokens += outputTokens || 0;
  _buffer[key].calls++;
}

function estimateCost(model, inputTokens, outputTokens) {
  var pricing = PRICING[model];
  if (!pricing) return 0;
  return ((inputTokens || 0) / 1000000 * pricing.input) + ((outputTokens || 0) / 1000000 * pricing.output);
}

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
      var buf = _buffer[keys[i]];
      var cost = estimateCost(model, buf.input_tokens, buf.output_tokens);

      // Simple approach: try insert, if fails (duplicate) then update
      try {
        var insertRes = await supabase.from('api_usage').insert({
          date: date, provider: provider, model: model,
          input_tokens: buf.input_tokens, output_tokens: buf.output_tokens,
          calls: buf.calls, estimated_cost_usd: cost,
        });
        if (insertRes.error) {
          // Duplicate — update existing row by adding to current values
          var { data: existing } = await supabase.from('api_usage')
            .select('input_tokens, output_tokens, calls, estimated_cost_usd')
            .eq('date', date).eq('provider', provider).eq('model', model).single();
          if (existing) {
            await supabase.from('api_usage').update({
              input_tokens: (existing.input_tokens || 0) + buf.input_tokens,
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

    var fromDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
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
    });

    var avgDailyCost = totalCost / Math.max(Object.keys(byDay).length, 1);

    return {
      period: days + ' giorni',
      total_cost_usd: Math.round(totalCost * 100) / 100,
      total_calls: totalCalls,
      total_tokens: { input: totalInputTokens, output: totalOutputTokens },
      avg_daily_cost_usd: Math.round(avgDailyCost * 100) / 100,
      projected_monthly_usd: Math.round(avgDailyCost * 30 * 100) / 100,
      by_provider: byProvider,
      recent_days: Object.entries(byDay).slice(0, 7).map(function(d) {
        return { date: d[0], cost_usd: Math.round(d[1].cost * 100) / 100, calls: d[1].calls };
      }),
    };
  } catch(e) {
    return { error: e.message };
  }
}

// Auto-flush every 5 minutes
setInterval(flushToDb, 5 * 60 * 1000);

module.exports = { trackCall: trackCall, flushToDb: flushToDb, getCostSummary: getCostSummary, estimateCost: estimateCost };
