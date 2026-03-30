// ─── PM Signals Job ──────────────────────────────────────────────────────────
// Nightly: detects stale channels, approaching deadlines, sends admin alerts.
'use strict';

var dbClient = require('../services/db/client');
var logger = require('../utils/logger');
var { safeParse } = require('../utils/safeCall');
var { isInternalProjectText, shouldExcludeText, extractExcludedPhrases } = require('../utils/briefingFilters');

async function detectStaleChannels(supabase) {
  var signals = [];
  var cutoff = new Date(Date.now() - 5 * 86400000).toISOString();
  var excludedPhrases = [];
  try {
    var resEx = await supabase.from('memories').select('content')
      .ilike('content', '%CORREZIONE_BRIEFING:%')
      .order('created_at', { ascending: false }).limit(20);
    excludedPhrases = extractExcludedPhrases((resEx && resEx.data) || []);
  } catch (_) {}
  try {
    var res = await supabase.from('channel_profiles')
      .select('channel_id, channel_name, cliente, progetto, project_phase, last_activity')
      .not('cliente', 'is', null).not('project_phase', 'eq', 'chiuso')
      .or('last_activity.is.null,last_activity.lt.' + cutoff).limit(20);
    if (res.data) res.data.forEach(function(ch) {
      var text = [ch.channel_name, ch.cliente, ch.progetto].filter(Boolean).join(' | ');
      if (isInternalProjectText(text)) return;
      if (shouldExcludeText(text, excludedPhrases)) return;
      if (!ch.last_activity) return; // evita falsi positivi "999gg" quando manca il dato
      var days = Math.round((Date.now() - new Date(ch.last_activity).getTime()) / 86400000);
      if (!Number.isFinite(days) || days < 0) return;
      signals.push({
        signal_type: 'stale_channel', severity: days > 10 ? 'high' : 'medium',
        channel_id: ch.channel_id, channel_name: ch.channel_name,
        description: '#' + ch.channel_name + ' (' + (ch.cliente || '') + ') silenzioso da ' + days + 'gg',
        metadata: { days_silent: days, cliente: ch.cliente },
      });
    });
  } catch(e) { logger.warn('[PM] Stale channels error:', e.message); }
  return signals;
}

async function detectDeadlines(supabase) {
  var signals = [];
  try {
    var res = await supabase.from('memories')
      .select('content, memory_type, entity_refs')
      .or('memory_type.eq.intent,content.ilike.%scadenza%,content.ilike.%deadline%,content.ilike.%entro il%')
      .is('superseded_by', null)
      .or('expires_at.is.null,expires_at.gt.' + new Date().toISOString())
      .order('created_at', { ascending: false }).limit(20);
    if (res.data && res.data.length > 0) {
      try {
        var Anthropic = require('@anthropic-ai/sdk');
        var client = new Anthropic();
        var texts = res.data.map(function(d) { return d.content; }).join('\n---\n');
        var aiRes = await client.messages.create({
          model: 'claude-haiku-4-5-20251001', max_tokens: 600,
          messages: [{ role: 'user', content: 'Oggi: ' + new Date().toISOString().slice(0, 10) + '.\nEstrai scadenze entro 7 giorni. JSON array:\n[{"deadline":"YYYY-MM-DD","who":"chi","what":"cosa","days_left":N,"severity":"high|medium|low"}]\nSe nessuna: []\n\nMEMORIE:\n' + texts }],
        });
        var match = aiRes.content[0].text.trim().replace(/```json|```/g, '').match(/\[[\s\S]*\]/);
        var pmData = safeParse('PM-SIGNALS.parse', match && match[0], null);
        if (pmData) pmData.forEach(function(d) {
          signals.push({
            signal_type: 'approaching_deadline', severity: d.severity || (d.days_left <= 1 ? 'high' : 'medium'),
            description: (d.who || '?') + ': ' + (d.what || '?') + ' — scadenza ' + (d.deadline || '?') + ' (' + (d.days_left || '?') + 'gg)',
            metadata: d,
          });
        });
      } catch(e) { logger.warn('[PM] Deadline AI error:', e.message); }
    }
  } catch(e) { logger.warn('[PM] Deadlines error:', e.message); }
  return signals;
}

async function saveSignals(supabase, signals) {
  for (var i = 0; i < signals.length; i++) {
    var s = signals[i];
    try {
      await supabase.from('pm_signals').insert({
        signal_type: s.signal_type, channel_id: s.channel_id || null,
        message_excerpt: s.description,
        urgency_score: s.severity === 'high' ? 5 : (s.severity === 'medium' ? 3 : 1),
        confidence: 0.75, status: 'open', detected_at: new Date().toISOString(),
      });
    } catch(e) {
      logger.warn('[PM-SIGNALS] operazione fallita:', e.message);
    }
  }
}

async function sendAlertToAdmin(signals) {
  var supabase = dbClient.getClient();
  if (!supabase) return;
  var admins = await supabase.from('user_roles').select('slack_user_id').eq('role', 'admin').limit(1);
  if (!admins.data || admins.data.length === 0) return;
  var adminId = admins.data[0].slack_user_id;
  var high = signals.filter(function(s) { return s.severity === 'high'; });
  var med = signals.filter(function(s) { return s.severity === 'medium'; });
  var msg = '*PM Alert — ' + new Date().toLocaleDateString('it-IT') + '*\n\n';
  if (high.length > 0) { msg += '*Alta priorità:*\n'; high.forEach(function(s) { msg += '• ' + s.description + '\n'; }); msg += '\n'; }
  if (med.length > 0) { msg += '*Attenzione:*\n'; med.slice(0, 5).forEach(function(s) { msg += '• ' + s.description + '\n'; }); }
  try {
    var { app } = require('../services/slackService');
    await app.client.chat.postMessage({ channel: adminId, text: msg });
    logger.info('[PM] Alert sent to admin');
  } catch(e) { logger.warn('[PM] Alert send error:', e.message); }
}

async function runPMSignals() {
  var supabase = dbClient.getClient();
  if (!supabase) { logger.error('[PM] No Supabase'); return; }
  logger.info('[PM] Starting nightly analysis...');
  var allSignals = [];
  allSignals = allSignals.concat(await detectStaleChannels(supabase));
  allSignals = allSignals.concat(await detectDeadlines(supabase));
  await saveSignals(supabase, allSignals);
  var alertable = allSignals.filter(function(s) { return s.severity === 'high' || s.severity === 'medium'; });
  if (alertable.length > 0) await sendAlertToAdmin(alertable);
  logger.info('[PM] Done. Signals:', allSignals.length);
  return allSignals;
}

module.exports = { runPMSignals: runPMSignals };
