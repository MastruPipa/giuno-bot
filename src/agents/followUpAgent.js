// ─── Follow-Up Agent ────────────────────────────────────────────────────────
// Scans for things that need follow-up and sends reminders.
// Runs every 4 hours during work hours.
// Checks: "ci penso domani" promises, stale tasks, silent channels.
'use strict';

var logger = require('../utils/logger');
var db = require('../../supabase');
var { acquireCronLock, releaseCronLock } = require('../../supabase');
var { app } = require('../services/slackService');
var { formatPerSlack } = require('../utils/slackFormat');

// ─── Check pending follow-ups from memories ─────────────────────────────────

async function checkPendingFollowups() {
  var followups = [];
  var supabase = db.getClient();
  if (!supabase) return followups;

  try {
    var now = new Date();
    // Find intent memories that are expired or about to expire
    var res = await supabase.from('memories')
      .select('id, slack_user_id, content, created_at, memory_type, tags')
      .eq('memory_type', 'intent')
      .is('superseded_by', null)
      .lt('created_at', new Date(now.getTime() - 24 * 3600000).toISOString()) // older than 24h
      .order('created_at', { ascending: false })
      .limit(20);

    if (res.data) {
      res.data.forEach(function(m) {
        var ageHours = Math.round((now.getTime() - new Date(m.created_at).getTime()) / 3600000);
        if (ageHours >= 24 && ageHours <= 120) { // 1-5 days old
          // Skip system/internal memories — not real user actions
          var content = m.content || '';
          if (/^precall_|^TOOL:|briefing inviato|^FEEDBACK_|^CORREZIONE|^\[TOOL:|^tool_result/i.test(content)) return;
          // Skip very short/generic content
          if (content.length < 15) return;
          // Skip system tags
          var tags = m.tags || [];
          if (tags.indexOf('precall') !== -1 || tags.indexOf('system') !== -1 || tags.indexOf('tool_result') !== -1 || tags.indexOf('search_pattern') !== -1) return;

          followups.push({
            type: 'pending_intent',
            userId: m.slack_user_id,
            content: content,
            ageHours: ageHours,
            memoryId: m.id,
          });
        }
      });
    }
  } catch(e) { logger.warn('[FOLLOWUP] Pending intents error:', e.message); }
  return followups;
}

// ─── Check leads needing follow-up ──────────────────────────────────────────

async function checkLeadFollowups() {
  var followups = [];
  var supabase = db.getClient();
  if (!supabase) return followups;

  try {
    // Leads with next_followup_date in the past or today
    var today = new Date().toISOString().slice(0, 10);
    var res = await supabase.from('leads')
      .select('id, company_name, status, owner_slack_id, next_followup_date')
      .eq('is_active', true)
      .not('next_followup_date', 'is', null)
      .lte('next_followup_date', today)
      .limit(10);

    if (res.data) {
      res.data.forEach(function(lead) {
        followups.push({
          type: 'lead_followup',
          userId: lead.owner_slack_id,
          lead: lead.company_name,
          status: lead.status,
          dueDate: lead.next_followup_date,
        });
      });
    }
  } catch(e) { logger.warn('[FOLLOWUP] Lead followups error:', e.message); }
  return followups;
}

// ─── Check silent project channels ──────────────────────────────────────────

async function checkSilentChannels() {
  var alerts = [];
  try {
    var channelMap = db.getChannelMapCache();
    var digests = db.getChannelDigestCache();
    var now = Date.now();
    var threeDaysAgo = String(Math.floor((now - 3 * 86400000) / 1000));

    for (var chId in channelMap) {
      var mapping = channelMap[chId];
      if (!mapping.cliente) continue; // Only client channels

      var digest = digests[chId];
      var lastTs = digest ? digest.last_ts : null;
      if (lastTs && parseFloat(lastTs) < parseFloat(threeDaysAgo)) {
        var daysSilent = Math.floor((now - parseFloat(lastTs) * 1000) / 86400000);
        if (daysSilent >= 3 && daysSilent <= 30) { // 3-30 days
          alerts.push({
            type: 'silent_channel',
            channelName: mapping.channel_name,
            cliente: mapping.cliente,
            daysSilent: daysSilent,
          });
        }
      }
    }
  } catch(e) { logger.warn('[FOLLOWUP] Silent channels error:', e.message); }
  return alerts;
}

// ─── Send follow-up reminders ───────────────────────────────────────────────

async function sendFollowups(userId, items) {
  if (!items || items.length === 0) return;

  var intents = items.filter(function(i) { return i.type === 'pending_intent'; });
  var leads = items.filter(function(i) { return i.type === 'lead_followup'; });

  // Don't send if nothing substantial
  if (intents.length === 0 && leads.length === 0) return;

  var msg = '*📋 Follow-up da Giuno*\n\n';

  if (intents.length > 0) {
    msg += '*Azioni in sospeso:*\n';
    intents.forEach(function(i) {
      var days = Math.round(i.ageHours / 24);
      msg += '• ' + i.content.substring(0, 120) + ' _(' + days + 'gg fa)_\n';
    });
    msg += '\n';
  }

  if (leads.length > 0) {
    msg += '*Lead da ricontattare:*\n';
    leads.forEach(function(l) {
      msg += '• *' + l.lead + '* [' + l.status + '] — followup previsto: ' + l.dueDate + '\n';
    });
    msg += '\n';
  }

  // Quality gate: don't send garbage
  if (msg.length < 80 || (intents.length === 0 && leads.length === 0)) return;

  msg += '_Rispondi "fatto" per qualsiasi punto completato._';

  try {
    await app.client.chat.postMessage({
      channel: userId,
      text: formatPerSlack(msg),
      unfurl_links: false,
    });
  } catch(e) { logger.error('[FOLLOWUP] Errore invio a', userId + ':', e.message); }
}

// ─── Main run ───────────────────────────────────────────────────────────────

async function runFollowups() {
  var locked = await acquireCronLock('followup_agent', 10);
  if (!locked) return;
  try {
    logger.info('[FOLLOWUP] Avvio scan follow-up...');

    var pendingIntents = await checkPendingFollowups();
    var leadFollowups = await checkLeadFollowups();
    var silentChannels = await checkSilentChannels();

    // Group by user
    var byUser = {};
    pendingIntents.forEach(function(i) {
      if (!i.userId) return;
      if (!byUser[i.userId]) byUser[i.userId] = [];
      byUser[i.userId].push(i);
    });
    leadFollowups.forEach(function(l) {
      if (!l.userId) return;
      if (!byUser[l.userId]) byUser[l.userId] = [];
      byUser[l.userId].push(l);
    });

    // Send personal follow-ups
    var sentCount = 0;
    for (var uid in byUser) {
      if (byUser[uid].length > 0) {
        await sendFollowups(uid, byUser[uid]);
        sentCount++;
      }
    }

    // Silent channels → send to admins
    if (silentChannels.length > 0) {
      try {
        var rbac = require('../../rbac');
        var { getUtenti } = require('../services/slackService');
        var utenti = await getUtenti();
        for (var ui = 0; ui < utenti.length; ui++) {
          var role = await rbac.getUserRole(utenti[ui].id);
          if (role === 'admin') {
            var silentMsg = '*🔇 Canali cliente silenti*\n\n';
            silentChannels.forEach(function(s) {
              silentMsg += '• #' + s.channelName + ' (' + s.cliente + ') — ' + s.daysSilent + ' giorni silenzioso\n';
            });
            silentMsg += '\n_Vuoi che prepari un messaggio di follow-up per qualcuno?_';
            await app.client.chat.postMessage({ channel: utenti[ui].id, text: formatPerSlack(silentMsg), unfurl_links: false });
          }
        }
      } catch(e) { logger.warn('[FOLLOWUP] Admin silent channels error:', e.message); }
    }

    logger.info('[FOLLOWUP] Completato.', sentCount, 'utenti notificati,', silentChannels.length, 'canali silenti.');
  } finally { await releaseCronLock('followup_agent'); }
}

module.exports = { runFollowups: runFollowups };
