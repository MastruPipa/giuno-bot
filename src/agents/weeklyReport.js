// ─── Weekly Report Agent ─────────────────────────────────────────────────────
// Runs every Friday at 17:00. Sends personalized weekly summary to each team member.
// Admin gets full KPI view, team gets personal view.
'use strict';

var logger = require('../utils/logger');
var db = require('../../supabase');
var { acquireCronLock, releaseCronLock } = require('../../supabase');
var { app, getUtenti } = require('../services/slackService');
var { formatPerSlack } = require('../utils/slackFormat');
var { getUserRole } = require('../../rbac');

async function buildWeeklyReport(userId, userRole) {
  var parts = [];
  var isAdmin = userRole === 'admin' || userRole === 'finance';
  var now = new Date();
  var weekStart = new Date(now);
  weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7)); // Monday
  weekStart.setHours(0, 0, 0, 0);

  // 1. Projects summary
  try {
    var projects = await db.searchProjects({ status: 'active', limit: 30 });
    if (isAdmin) {
      // Admin: all projects with budget health
      var projLines = [];
      for (var i = 0; i < projects.length; i++) {
        var p = projects[i];
        var line = '• *' + p.name + '*';
        if (p.client_name) line += ' [' + p.client_name + ']';
        if (p.budget_quoted && p.budget_actual) {
          var pct = Math.round(((parseFloat(p.budget_actual) - parseFloat(p.budget_quoted)) / parseFloat(p.budget_quoted)) * 100);
          var icon = pct > 25 ? '🔴' : (pct > 10 ? '🟡' : '🟢');
          line += ' ' + icon + ' ' + (pct > 0 ? '+' : '') + pct + '%';
        }
        if (p.end_date) {
          var daysLeft = Math.ceil((new Date(p.end_date) - now) / 86400000);
          if (daysLeft < 0) line += ' ⚠️ scaduto';
          else if (daysLeft <= 7) line += ' ⏰ ' + daysLeft + 'gg';
        }
        projLines.push(line);
      }
      if (projLines.length > 0) parts.push('*Progetti attivi (' + projLines.length + '):*\n' + projLines.join('\n'));
    } else {
      // Team: only their projects
      var userAllocs = await db.getUserAllocations(userId);
      var myProjectIds = {};
      (userAllocs || []).forEach(function(a) { myProjectIds[a.project_id] = a; });
      var myProjects = projects.filter(function(p) { return myProjectIds[p.id]; });
      if (myProjects.length > 0) {
        var myLines = myProjects.map(function(p) {
          var alloc = myProjectIds[p.id];
          var line = '• *' + p.name + '*';
          if (alloc && alloc.hours_allocated) {
            line += ' — ' + Math.round(alloc.hours_logged || 0) + '/' + Math.round(alloc.hours_allocated) + 'h';
          }
          return line;
        });
        parts.push('*I tuoi progetti:*\n' + myLines.join('\n'));
      }
    }
  } catch(e) { logger.warn('[WEEKLY] Projects error:', e.message); }

  // 2. CRM (admin only)
  if (isAdmin) {
    try {
      var pipeline = await db.getLeadsPipeline();
      if (pipeline) {
        var crmLine = '*Pipeline CRM:* ' + (pipeline.total || 0) + ' lead totali';
        if (pipeline.byStatus) {
          var statusParts = [];
          if (pipeline.byStatus.won) statusParts.push(pipeline.byStatus.won + ' won');
          if (pipeline.byStatus.negotiating) statusParts.push(pipeline.byStatus.negotiating + ' in trattativa');
          if (pipeline.byStatus.proposal_sent) statusParts.push(pipeline.byStatus.proposal_sent + ' proposta inviata');
          if (statusParts.length > 0) crmLine += ' (' + statusParts.join(', ') + ')';
        }
        parts.push(crmLine);
      }
    } catch(e) { /* ignore */ }
  }

  // 3. Team workload (admin only)
  if (isAdmin) {
    try {
      var workload = await db.getTeamWorkload();
      if (workload.length > 0) {
        var wLines = workload.map(function(w) {
          var pct = w.total_allocated > 0 ? Math.round((w.total_logged / w.total_allocated) * 100) : 0;
          var icon = pct > 110 ? '🔴' : (pct > 85 ? '🟡' : '🟢');
          return '• <@' + w.slack_user_id + '> ' + icon + ' ' + Math.round(w.total_logged) + '/' + Math.round(w.total_allocated) + 'h (' + pct + '%)';
        });
        parts.push('*Carico team:*\n' + wLines.join('\n'));
      }
    } catch(e) { /* ignore */ }
  }

  // 4. Slack activity this week
  try {
    var weekOldest = String(Math.floor(weekStart.getTime() / 1000));
    var channelsRes = await app.client.conversations.list({ limit: 50, types: 'public_channel,private_channel' });
    var channels = (channelsRes.channels || []).filter(function(c) { return !c.is_archived; });
    var channelActivity = {};
    var userMsgCount = 0;
    for (var ci = 0; ci < channels.length; ci++) {
      try {
        var hist = await app.client.conversations.history({ channel: channels[ci].id, oldest: weekOldest, limit: 200 });
        var msgs = (hist.messages || []).filter(function(m) { return !m.bot_id && m.type === 'message'; });
        if (msgs.length > 0) channelActivity[channels[ci].name] = msgs.length;
        if (!isAdmin) {
          userMsgCount += msgs.filter(function(m) { return m.user === userId; }).length;
        }
      } catch(e) { /* skip */ }
    }
    var topChannels = Object.entries(channelActivity).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 5);
    if (topChannels.length > 0) {
      parts.push('*Canali più attivi:*\n' + topChannels.map(function(c) { return '• #' + c[0] + ' (' + c[1] + ' msg)'; }).join('\n'));
    }
    if (!isAdmin && userMsgCount > 0) {
      parts.push('_I tuoi messaggi questa settimana: ' + userMsgCount + '_');
    }
  } catch(e) { logger.warn('[WEEKLY] Slack activity error:', e.message); }

  return parts;
}

async function sendWeeklyReports() {
  var locked = await acquireCronLock('weekly_report_v2', 15);
  if (!locked) return;
  try {
    logger.info('[WEEKLY] Avvio report settimanale...');
    var utenti = await getUtenti();
    var sent = 0;
    for (var i = 0; i < utenti.length; i++) {
      var u = utenti[i];
      try {
        var prefs = Object.assign({ routine_enabled: true }, db.getPrefsCache()[u.id] || {});
        if (!prefs.routine_enabled) continue;
        var role = await getUserRole(u.id);
        var parts = await buildWeeklyReport(u.id, role);
        if (parts.length === 0) continue;
        var nome = u.name.split(' ')[0];
        var msg = '*Recap settimanale — ' + nome + '*\n\n' + parts.join('\n\n') + '\n\n_Buon weekend, mbare._';
        await app.client.chat.postMessage({ channel: u.id, text: formatPerSlack(msg), unfurl_links: false });
        sent++;
      } catch(e) { logger.error('[WEEKLY] Errore per', u.id + ':', e.message); }
    }
    logger.info('[WEEKLY] Report inviato a', sent, 'utenti.');
  } finally { await releaseCronLock('weekly_report_v2'); }
}

module.exports = { sendWeeklyReports: sendWeeklyReports };
