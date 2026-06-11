// ─── Proactive Monitor ──────────────────────────────────────────────────────
// Runs every 3 hours (work hours). Scans for issues and DMs relevant people.
// Checks: budget overruns, stale leads, silent channels, overdue deadlines.
'use strict';

var logger = require('../utils/logger');
var dates = require('../utils/dates');
var db = require('../../supabase');
var { acquireCronLock, releaseCronLock } = require('../../supabase');
var { app } = require('../services/slackService');
var { formatPerSlack } = require('../utils/slackFormat');
var gate = require('../utils/proactiveGate');

// Dedup: cooldown PERSISTENTE per alert+destinatario sul gate condiviso
// (followup_log). Il vecchio dedup in-memory si azzerava ogni giorno e a ogni
// riavvio: la stessa lista di alert tornava identica tutti i giorni.
var ALERT_COOLDOWN_DAYS = 7;
var ALERT_MAX_SENDS = 3;

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
    // Finestra di azionabilità: oltre 45 giorni un lead non è più "critico",
    // è freddo — segnalarlo come urgente ogni giorno per mesi è solo rumore.
    var coldCutoff = new Date(Date.now() - 45 * 86400000).toISOString();
    var res = await supabase.from('leads')
      .select('id, company_name, status, owner_slack_id, updated_at')
      .eq('is_active', true)
      .in('status', ['contacted', 'proposal_sent', 'negotiating'])
      .lt('updated_at', fiveDaysAgo)
      .gte('updated_at', coldCutoff)
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
    var today = dates.todayISO();
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
  if (!gate.notificheEnabled(userId)) return;

  // Cooldown per destinatario: ogni alert al massimo una volta ogni 7 giorni
  // e non più di 3 volte in totale (poi è rumore, non un alert).
  var supabase = db.getClient && db.getClient();
  var deliverable = [];
  for (var di = 0; di < alerts.length; di++) {
    var al = alerts[di];
    if (!al._hash) {
      var idn = al.project || al.lead || al.user || al.channel || String(al.message || '').substring(0, 60) || 'generic';
      al._hash = gate.itemHash('alert:' + al.type + ':' + idn);
    }
    var check = supabase
      ? await gate.followupAllowed(supabase, userId, al._hash, { cooldownDays: ALERT_COOLDOWN_DAYS, maxAttempts: ALERT_MAX_SENDS })
      : { allowed: true, attempts: 0 };
    if (!check.allowed) continue;
    al._attempts = check.attempts;
    deliverable.push(al);
  }
  if (deliverable.length === 0) {
    logger.info('[PROACTIVE] Tutti gli alert per', userId, 'in cooldown — skip.');
    return;
  }

  var msg = '*⚡ Alert proattivo da Giuno*\n\n';
  var criticals = deliverable.filter(function(a) { return a.severity === 'critical'; });
  var warnings = deliverable.filter(function(a) { return a.severity === 'warning'; });
  // Tetto per messaggio: una muraglia di 10 bullet non è leggibile né azionabile
  var moreCriticals = Math.max(0, criticals.length - 6);
  var moreWarnings = Math.max(0, warnings.length - 4);
  criticals = criticals.slice(0, 6);
  warnings = warnings.slice(0, 4);

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

  if (moreCriticals > 0 || moreWarnings > 0) {
    msg += '_…e altri ' + (moreCriticals + moreWarnings) + ' punti minori (chiedimeli se ti servono)._\n';
  }

  msg += '\n_Chiedimi dettagli su qualsiasi punto._';

  try {
    await app.client.chat.postMessage({
      channel: userId,
      text: formatPerSlack(msg),
      unfurl_links: false,
    });
    // Registra nel log condiviso SOLO dopo l'invio riuscito (il vecchio codice
    // marcava "inviato" anche quando poi la soglia bloccava il messaggio).
    if (supabase) {
      for (var ri = 0; ri < deliverable.length; ri++) {
        var rec = deliverable[ri];
        await gate.recordFollowup(supabase, userId, rec._hash,
          rec.type + ': ' + (rec.project || rec.lead || rec.detail || '').toString().substring(0, 100),
          rec._attempts);
      }
    }
    logger.info('[PROACTIVE] Alert inviato a', userId, '—', deliverable.length, 'issues');
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

    // Dedup: filter out alerts already sent today
    // Chiave stabile per il cooldown: tipo + identità dell'alert. NON include
    // il detail (contiene "da N giorni": cambierebbe ogni giorno riaprendo il
    // dedup — era così che la stessa lista tornava tutti i giorni).
    allAlerts.forEach(function(a) {
      var identity = a.project || a.lead || a.user || a.channel ||
        String(a.message || '').substring(0, 60) || 'generic';
      a._hash = gate.itemHash('alert:' + a.type + ':' + identity);
    });

    // Threshold: only send if there's at least 1 critical OR 3+ warnings
    var criticalCount = allAlerts.filter(function(a) { return a.severity === 'critical'; }).length;
    var warningCount = allAlerts.filter(function(a) { return a.severity === 'warning'; }).length;
    if (criticalCount === 0 && warningCount < 3) {
      logger.info('[PROACTIVE] Sotto soglia (' + warningCount + ' warning, 0 critical) — skip.');
      return;
    }

    // Group alerts by owner
    var byOwner = {};
    var adminAlerts = [];
    allAlerts.forEach(function(a) {
      if (a.owner) {
        if (!byOwner[a.owner]) byOwner[a.owner] = [];
        byOwner[a.owner].push(a);
      }
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
