// ─── Calibrazione delle stime dalle correzioni ───────────────────────────────
// Ogni volta che una persona conferma o corregge il daily stimato da Giuno
// abbiamo una coppia (ore stimate, ore reali). Conservata qui, dice a Giuno
// se per quella persona tende a stimare basso o alto, e di quanto. Tabella
// daily_estimate_calibration (migrazione in supabase_migration.sql); se
// manca, tutto degrada in silenzio.

'use strict';

var logger = require('../utils/logger');

function _client() { return require('./db/client').getClient(); }

function hoursOf(tasks) {
  return Math.round((tasks || []).reduce(function(s, t) { return s + (Number(t && t.hours) || 0) + (Number(t && t.minutes) || 0) / 60; }, 0) * 100) / 100;
}

// estimated/actual: array di task (oggi) o numero di ore.
async function recordCorrection(userId, dateStr, estimated, actual, opts) {
  opts = opts || {};
  var supabase = opts.supabase !== undefined ? opts.supabase : _client();
  if (!supabase || !userId || !dateStr) return false;
  var est = Array.isArray(estimated) ? hoursOf(estimated) : Number(estimated) || 0;
  var act = Array.isArray(actual) ? hoursOf(actual) : Number(actual) || 0;
  if (!(est > 0)) return false;
  var row = { slack_user_id: userId, date: dateStr, estimated_hours: est, actual_hours: act,
    estimated_tasks: Array.isArray(estimated) ? estimated.length : null, actual_tasks: Array.isArray(actual) ? actual.length : null,
    confirmed: !!opts.confirmed, sources: opts.sources || null, created_at: new Date().toISOString() };
  try {
    var res = await supabase.from('daily_estimate_calibration').upsert(row, { onConflict: 'slack_user_id,date' });
    if (res && res.error) throw res.error;
    logger.info('[CALIBRATION] ' + userId + ' ' + dateStr + ': stimate ' + est + 'h, reali ' + act + 'h' + (opts.confirmed ? ' (confermato)' : ''));
    return true;
  } catch(e) { logger.debug('[CALIBRATION] scrittura saltata:', e.message); return false; }
}

// Ritorna { n, ratio (reale/stimato mediano), bias: 'basso'|'alto'|'ok', hint } o null.
async function getCalibration(userId, opts) {
  opts = opts || {};
  var supabase = opts.supabase !== undefined ? opts.supabase : _client();
  if (!supabase) return null;
  var rows;
  try {
    var res = await supabase.from('daily_estimate_calibration').select('estimated_hours, actual_hours, confirmed, date')
      .eq('slack_user_id', userId).order('date', { ascending: false }).limit(opts.limit || 30);
    if (res.error) throw res.error;
    rows = res.data || [];
  } catch(e) { return null; }
  return summarize(rows);
}

function summarize(rows) {
  var ratios = (rows || []).filter(function(r) { return Number(r.estimated_hours) > 0 && Number(r.actual_hours) > 0; })
    .map(function(r) { return Number(r.actual_hours) / Number(r.estimated_hours); }).sort(function(a, b) { return a - b; });
  if (ratios.length < 3) return null;
  var mid = Math.floor(ratios.length / 2);
  var ratio = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
  ratio = Math.round(ratio * 100) / 100;
  var bias = ratio >= 1.2 ? 'basso' : ratio <= 0.8 ? 'alto' : 'ok';
  var pct = Math.round(Math.abs(ratio - 1) * 100);
  var hint = bias === 'ok' ? 'negli ultimi ' + ratios.length + ' daily corretti le stime tornavano (scarto sotto il 20%).'
    : 'negli ultimi ' + ratios.length + ' daily corretti le ore stimate erano ' + (bias === 'basso' ? 'più basse' : 'più alte') + ' del reale di circa il ' + pct + '%: ' + (bias === 'basso' ? 'alza' : 'abbassa') + ' le durate dedotte di conseguenza (non quelle da calendario).';
  return { n: ratios.length, ratio: ratio, bias: bias, hint: hint };
}

module.exports = { hoursOf: hoursOf, recordCorrection: recordCorrection, getCalibration: getCalibration, summarize: summarize };
