// ─── Time Tracking Tools ─────────────────────────────────────────────────────
// Query sul workload & progress tracking (tabella time_logs).
// Risponde a domande tipo:
//   "quante ore ho tracciato questa settimana?"
//   "quanto ha lavorato Giusy su Dicar questa settimana?"
//   "com'è messo il team rispetto al pianificato?"
'use strict';

var logger = require('../utils/logger');
var db = require('../../supabase');
var dates = require('../utils/trackingDates');

// ─── Tool definitions ────────────────────────────────────────────────────────

var definitions = [
  {
    name: 'query_time_logs',
    description: 'Interroga i time log del workload tracking (ore pianificate con il Weekly Planner e ore ' +
      'effettive dal Daily Check-in). Usa questo tool per domande su ore tracciate/pianificate/consuntivate ' +
      'per persona, progetto o settimana: "quante ore ho tracciato?", "quanto ha lavorato X su Y?", ' +
      '"pianificato vs effettivo del team". Ritorna totali per utente e per progetto della settimana indicata. ' +
      'NB: per le ore dichiarate nei daily standup testuali usa invece query_standup.',
    input_schema: {
      type: 'object',
      properties: {
        week: {
          type: 'string',
          description: 'Una data YYYY-MM-DD qualsiasi dentro la settimana da analizzare (default: oggi → settimana corrente). Es. per la settimana scorsa passa la data di 7 giorni fa.',
        },
        user_name: {
          type: 'string',
          description: 'Nome (parziale, case-insensitive) del membro del team per filtrare. Se ometti, tutto il team.',
        },
        slack_user_id: {
          type: 'string',
          description: 'Slack user ID, alternativa a user_name. Usa l\'ID di chi chiede per domande in prima persona ("quante ore ho...").',
        },
        project: {
          type: 'string',
          description: 'Substring del nome progetto per filtrare (es. "dicar"). Se ometti, tutti i progetti.',
        },
      },
    },
  },
];

// ─── Implementation ──────────────────────────────────────────────────────────

function round1(n) { return Math.round((n || 0) * 10) / 10; }

function resolveUserFilter(input) {
  if (input.slack_user_id) return input.slack_user_id;
  if (!input.user_name) return null;
  var m = db.findTeamMemberByName(input.user_name);
  if (m) return m.slack_user_id;
  // fallback: substring sul roster
  var needle = String(input.user_name).toLowerCase();
  var roster = db.getTeamRoster();
  for (var i = 0; i < roster.length; i++) {
    if ((roster[i].canonical_name || '').toLowerCase().indexOf(needle) !== -1) return roster[i].slack_user_id;
  }
  return null;
}

function userLabel(uid) {
  var m = db.findTeamMemberById(uid);
  return m && m.canonical_name ? m.canonical_name : uid;
}

async function queryTimeLogs(input) {
  var anchor = /^\d{4}-\d{2}-\d{2}$/.test(String(input.week || '')) ? input.week : dates.oggiRome();
  var weekStart = dates.weekStartOf(anchor);
  var uidFilter = resolveUserFilter(input);
  if (input.user_name && !uidFilter) {
    return { error: 'Utente "' + input.user_name + '" non trovato nel roster del team.' };
  }
  var projNeedle = input.project ? String(input.project).toLowerCase() : null;

  var pva = await db.getPlannedVsActual(weekStart);
  var byUser = pva.byUser || {};

  var users = Object.keys(byUser).filter(function(uid) {
    return !uidFilter || uid === uidFilter;
  });

  var totalPlanned = 0, totalActual = 0;
  var userList = users.map(function(uid) {
    var u = byUser[uid];
    var projects = Object.keys(u.projects).map(function(pid) { return u.projects[pid]; })
      .filter(function(p) { return !projNeedle || String(p.name).toLowerCase().indexOf(projNeedle) !== -1; });
    var planned = 0, actual = 0;
    projects.forEach(function(p) { planned += p.planned; actual += p.actual; });
    totalPlanned += planned;
    totalActual += actual;
    return {
      slack_user_id: uid,
      name: userLabel(uid),
      hours_planned: round1(planned),
      hours_actual: round1(actual),
      projects: projects.map(function(p) {
        return { project: p.name, hours_planned: round1(p.planned), hours_actual: round1(p.actual) };
      }).sort(function(a, b) { return b.hours_actual - a.hours_actual; }),
    };
  }).filter(function(u) { return u.hours_planned > 0 || u.hours_actual > 0; })
    .sort(function(a, b) { return b.hours_actual - a.hours_actual; });

  return {
    week_start: weekStart,
    week_end: dates.addDays(weekStart, 6),
    user_filter: uidFilter,
    project_filter: input.project || null,
    total_hours_planned: round1(totalPlanned),
    total_hours_actual: round1(totalActual),
    by_user: userList,
    note: userList.length === 0 ? 'Nessun time log trovato per questa settimana/filtri.' : undefined,
  };
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

async function execute(toolName, input) {
  if (toolName === 'query_time_logs') {
    try {
      return await queryTimeLogs(input || {});
    } catch(e) {
      logger.error('[TT-TOOL] error:', e.message);
      return { error: 'Errore query time logs: ' + e.message };
    }
  }
  return { error: 'Tool sconosciuto in timeTrackingTools: ' + toolName };
}

module.exports = {
  definitions: definitions,
  execute: execute,
  queryTimeLogs: queryTimeLogs,
};
