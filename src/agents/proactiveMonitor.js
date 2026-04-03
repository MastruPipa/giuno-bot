// ─── Proactive Monitor ──────────────────────────────────────────────────────
// Runs every 3 hours (work hours). Scans for issues and DMs relevant people.
// Checks: budget overruns, stale leads, silent channels, overdue deadlines.
'use strict';

var logger = require('../utils/logger');
var db = require('../../supabase');
var { acquireCronLock, releaseCronLock } = require('../../supabase');
var { app } = require('../services/slackService');
var { formatPerSlack } = require('../utils/slackFormat');

// ─── Alert checkers ─────────────────────────────────────────────────────────

async function checkBudgetOverruns() {
  var alerts = [];
  try {
    var projects = await db.searchProjects({ status: 'active', limit: 50 });
    for (var i = 0; i < projects.length; i++) {
      var p = projects[i];
      if (!p.budget_quoted || !p.budget_actual) continue;
      var quoted = parseFloat(p.budget_quoted);
      var actual = parseFloat(p.budget_actual);
      if (quoted <= 0) continue;
      var overrun = ((actual - quoted) / quoted) * 100;
      if (overrun > 15) {
        alerts.push({
          type: 'budget_overrun',
          severity: overrun > 30 ? 'critical' : 'warning',
          project: p.name,
          client: p.client_name,
          owner: p.owner_slack_id,
          detail: '€' + Math.round(actual) + '/€' + Math.round(quoted) + ' (+' + Math.round(overrun) + '%)',
          suggestion: overrun > 30 ? 'Considera di rivedere lo scope o negoziare extra budget col cliente.' : 'Monitora le prossime ore — potrebbe rientrare.',
        });
      }
    }
  } catch(e) { logger.warn('[PROACTIVE] Budget check error:', e.message); }
  return alerts;
}

async function checkStaleLeads() {
  var alerts = [];
  try {
    var supabase = db.getClient();
    if (!supabase) return alerts;
    var fiveDaysAgo = new Date(Date.now() - 5 * 86400000).toISOString();
    var res = await supabase.from('leads')
      .select('id, company_name, status, owner_slack_id, updated_at')
      .eq('is_active', true)
      .in('status', ['contacted', 'proposal_sent', 'negotiating'])
      .lt('updated_at', fiveDaysAgo)
      .limit(10);
    if (res.data) {
      res.data.forEach(function(lead) {
        var daysSince = Math.floor((Date.now() - new Date(lead.updated_at).getTime()) / 86400000);
        alerts.push({
          type: 'stale_lead',
          severity: daysSince > 10 ? 'critical' : 'warning',
          lead: lead.company_name,
          status: lead.status,
          owner: lead.owner_slack_id,
          detail: 'Nessun aggiornamento da ' + daysSince + ' giorni',
          suggestion: daysSince > 10 ? 'Rischio di perdere il lead. Manda un messaggio di check-in.' : 'Un follow-up rapido potrebbe riattivare la conversazione.',
        });
      });
    }
  } catch(e) { logger.warn('[PROACTIVE] Stale leads check error:', e.message); }
  return alerts;
}

async function checkOverdueProjects() {
  var alerts = [];
  try {
    var today = new Date().toISOString().slice(0, 10);
    var projects = await db.searchProjects({ status: 'active', limit: 50 });
    projects.forEach(function(p) {
      if (!p.end_date) return;
      var daysLeft = Math.ceil((new Date(p.end_date) - new Date()) / 86400000);
      if (daysLeft < 0) {
        alerts.push({
          type: 'overdue_project',
          severity: 'critical',
          project: p.name,
          client: p.client_name,
          owner: p.owner_slack_id,
          detail: 'Scaduto da ' + Math.abs(daysLeft) + ' giorni (deadline: ' + p.end_date + ')',
        });
      } else if (daysLeft <= 3) {
        alerts.push({
          type: 'deadline_soon',
          severity: 'warning',
          project: p.name,
          client: p.client_name,
          owner: p.owner_slack_id,
          detail: daysLeft + ' giorni alla deadline (' + p.end_date + ')',
        });
      }
    });
  } catch(e) { logger.warn('[PROACTIVE] Overdue check error:', e.message); }
  return alerts;
}

async function checkOverloadedTeam() {
  var alerts = [];
  try {
    var workload = await db.getTeamWorkload();
    workload.forEach(function(w) {
      if (w.total_allocated > 0 && w.total_logged > w.total_allocated * 1.2) {
        alerts.push({
          type: 'overloaded',
          severity: 'warning',
          owner: w.slack_user_id,
          detail: Math.round(w.total_logged) + 'h lavorate / ' + Math.round(w.total_allocated) + 'h allocate (' + Math.round((w.total_logged / w.total_allocated) * 100) + '%)',
          projects: w.projects.map(function(p) { return p.project_name; }).join(', '),
        });
      }
    });
  } catch(e) { logger.warn('[PROACTIVE] Workload check error:', e.message); }
  return alerts;
}

// ─── Send alerts ────────────────────────────────────────────────────────────

async function sendAlert(userId, alerts) {
  if (!alerts || alerts.length === 0) return;

  var msg = '*⚡ Alert proattivo da Giuno*\n\n';
  var criticals = alerts.filter(function(a) { return a.severity === 'critical'; });
  var warnings = alerts.filter(function(a) { return a.severity === 'warning'; });

  if (criticals.length > 0) {
    msg += '*🔴 Critici:*\n';
    criticals.forEach(function(a) {
      msg += '• ';
      if (a.type === 'budget_overrun') msg += '*Budget sfora* — ' + a.project + (a.client ? ' (' + a.client + ')' : '') + ': ' + a.detail;
      else if (a.type === 'overdue_project') msg += '*Progetto scaduto* — ' + a.project + ': ' + a.detail;
      else if (a.type === 'stale_lead') msg += '*Lead fermo* — ' + a.lead + ' [' + a.status + ']: ' + a.detail;
      else if (a.type === 'overloaded') msg += '*Sovraccarico* — ' + a.detail;
      if (a.suggestion) msg += '\n  _→ ' + a.suggestion + '_';
      msg += '\n';
    });
  }

  if (warnings.length > 0) {
    msg += '*🟡 Attenzione:*\n';
    warnings.forEach(function(a) {
      msg += '• ';
      if (a.type === 'budget_overrun') msg += 'Budget ' + a.project + ': ' + a.detail;
      else if (a.type === 'deadline_soon') msg += 'Deadline ' + a.project + ': ' + a.detail;
      else if (a.type === 'stale_lead') msg += 'Lead ' + a.lead + ': ' + a.detail;
      else if (a.type === 'overloaded') msg += 'Carico alto: ' + a.detail;
      if (a.suggestion) msg += '\n  _→ ' + a.suggestion + '_';
      msg += '\n';
    });
  }

  msg += '\n_Chiedimi dettagli su qualsiasi punto._';

  try {
    await app.client.chat.postMessage({
      channel: userId,
      text: formatPerSlack(msg),
      unfurl_links: false,
    });
    logger.info('[PROACTIVE] Alert inviato a', userId, '—', alerts.length, 'issues');
  } catch(e) {
    logger.error('[PROACTIVE] Errore invio alert a', userId + ':', e.message);
  }
}

// ─── Main scan ──────────────────────────────────────────────────────────────

async function runProactiveScan() {
  var locked = await acquireCronLock('proactive_monitor', 10);
  if (!locked) return;
  try {
    logger.info('[PROACTIVE] Avvio scan proattivo...');

    var allAlerts = [];
    var results = await Promise.all([
      checkBudgetOverruns(),
      checkStaleLeads(),
      checkOverdueProjects(),
      checkOverloadedTeam(),
    ]);
    results.forEach(function(r) { allAlerts = allAlerts.concat(r); });

    if (allAlerts.length === 0) {
      logger.info('[PROACTIVE] Nessun alert trovato.');
      return;
    }

    logger.info('[PROACTIVE] Trovati', allAlerts.length, 'alert.');

    // Group alerts by owner
    var byOwner = {};
    var adminAlerts = [];
    allAlerts.forEach(function(a) {
      if (a.owner) {
        if (!byOwner[a.owner]) byOwner[a.owner] = [];
        byOwner[a.owner].push(a);
      }
      // Admin always gets critical alerts
      if (a.severity === 'critical') adminAlerts.push(a);
    });

    // Send to owners
    for (var ownerId in byOwner) {
      await sendAlert(ownerId, byOwner[ownerId]);
    }

    // Send all criticals to admins (if not already the owner)
    if (adminAlerts.length > 0) {
      try {
        var rbac = require('../../rbac');
        var { getUtenti } = require('../services/slackService');
        var utenti = await getUtenti();
        for (var ui = 0; ui < utenti.length; ui++) {
          var role = await rbac.getUserRole(utenti[ui].id);
          if (role === 'admin' && !byOwner[utenti[ui].id]) {
            await sendAlert(utenti[ui].id, adminAlerts);
          }
        }
      } catch(e) { logger.warn('[PROACTIVE] Admin alert error:', e.message); }
    }

    logger.info('[PROACTIVE] Scan completato.');
  } catch(e) {
    logger.error('[PROACTIVE] Errore generale:', e.message);
  } finally {
    await releaseCronLock('proactive_monitor');
  }
}

module.exports = { runProactiveScan: runProactiveScan };
