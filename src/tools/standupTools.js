// ─── Standup Tools ────────────────────────────────────────────────────────────
// Query aggregati sui daily standup archiviati in standup_entries.
// Risponde a domande tipo:
//   "quanto ha lavorato Giusy su Aitho nelle ultime 2 settimane?"
//   "quanto ha lavorato il team su Aitho nelle ultime settimane?"
//   "che ha fatto Nicolò la settimana scorsa?"

'use strict';

var logger = require('../utils/logger');
var dbClient = require('../services/db/client');

// ─── Tool definitions ────────────────────────────────────────────────────────

var definitions = [
  {
    name: 'query_standup',
    description: 'Interroga i daily standup archiviati per ottenere ore lavorate e task svolti. ' +
      'Usa SEMPRE questo tool per domande del tipo "quanto ha lavorato X su Y?", "che ha fatto X questa settimana?", ' +
      '"quante ore ha fatto il team su progetto Z?". Il match sul progetto è substring case-insensitive sul testo del task ' +
      '(es. project: "aitho" trova "Aitho - Documento Strategico 3h"). ' +
      'Se non specifichi intervallo di date, default = ultimi 14 giorni.',
    input_schema: {
      type: 'object',
      properties: {
        user_name: {
          type: 'string',
          description: 'Nome (parziale, case-insensitive) dell\'utente. Es: "giusy", "nicolò". Se ometti, aggrega su tutto il team.',
        },
        slack_user_id: {
          type: 'string',
          description: 'Slack user ID alternativa a user_name.',
        },
        project: {
          type: 'string',
          description: 'Substring del nome progetto/cliente da cercare nei task (es. "aitho", "elfo"). Se ometti, conta tutte le ore.',
        },
        date_from: { type: 'string', description: 'Data inizio inclusa YYYY-MM-DD.' },
        date_to: { type: 'string', description: 'Data fine inclusa YYYY-MM-DD.' },
        days: {
          type: 'integer',
          description: 'Shortcut: ultimi N giorni rispetto ad oggi (override date_from/date_to). Es: 7 = ultima settimana, 14 = ultime due settimane.',
        },
        scope: {
          type: 'string',
          description: 'Cosa considerare: "oggi" (solo task "oggi" delle entry), "ieri" (solo task "ieri"), "entrambi" (default).',
          enum: ['oggi', 'ieri', 'entrambi'],
        },
      },
    },
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isoDaysAgo(n) {
  var d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function toMinutes(task) {
  var h = Number(task && task.hours) || 0;
  var m = Number(task && task.minutes) || 0;
  return h * 60 + m;
}

function formatHours(minutes) {
  if (!minutes) return '0h';
  var h = Math.floor(minutes / 60);
  var m = minutes % 60;
  if (h === 0) return m + 'min';
  if (m === 0) return h + 'h';
  return h + 'h ' + m + 'min';
}

async function resolveUser(input) {
  if (input.slack_user_id) return input.slack_user_id;
  if (!input.user_name) return null;
  try {
    var { getUtenti } = require('../services/slackService');
    var utenti = await getUtenti();
    var q = input.user_name.toLowerCase();
    var match = utenti.find(function(u) {
      return (u.name || '').toLowerCase().indexOf(q) !== -1;
    });
    return match ? match.id : null;
  } catch(e) {
    logger.warn('[STANDUP-TOOL] resolveUser error:', e.message);
    return null;
  }
}

// ─── Core query ───────────────────────────────────────────────────────────────

async function queryStandup(input) {
  var supabase = dbClient.getClient();
  if (!supabase) return { error: 'Database non disponibile.' };

  // Date range
  var dateFrom, dateTo;
  if (input.days && input.days > 0) {
    dateFrom = isoDaysAgo(input.days);
    dateTo = todayIso();
  } else {
    dateFrom = input.date_from || isoDaysAgo(14);
    dateTo = input.date_to || todayIso();
  }

  // User filter
  var uidFilter = await resolveUser(input);
  if (input.user_name && !uidFilter) {
    return { error: 'Utente "' + input.user_name + '" non trovato in Slack.' };
  }

  // Query
  var q = supabase.from('standup_entries')
    .select('slack_user_id, date, ieri_tasks, oggi_tasks, blocchi, raw_text, total_hours_ieri, total_hours_oggi')
    .gte('date', dateFrom)
    .lte('date', dateTo)
    .order('date', { ascending: true });
  if (uidFilter) q = q.eq('slack_user_id', uidFilter);

  var res = await q;
  if (res.error) return { error: 'Errore query: ' + res.error.message };
  var rows = res.data || [];
  if (rows.length === 0) {
    return {
      found: 0,
      date_from: dateFrom,
      date_to: dateTo,
      message: 'Nessun daily archiviato nel periodo ' + dateFrom + ' — ' + dateTo +
        (uidFilter ? ' per questo utente.' : '.'),
    };
  }

  // Aggregate
  var projLower = input.project ? input.project.toLowerCase() : null;
  var scope = input.scope || 'entrambi';
  var byUser = {};
  var byProject = {};
  var totalMinutes = 0;
  var sampleTasks = [];

  rows.forEach(function(r) {
    var uid = r.slack_user_id;
    if (!byUser[uid]) {
      byUser[uid] = { slack_user_id: uid, minutes: 0, days_count: 0, projects: {} };
    }
    var daySet = {};
    var pickLists = [];
    if (scope === 'oggi' || scope === 'entrambi') pickLists.push({ tag: 'oggi', list: r.oggi_tasks || [] });
    if (scope === 'ieri' || scope === 'entrambi') pickLists.push({ tag: 'ieri', list: r.ieri_tasks || [] });

    pickLists.forEach(function(pl) {
      pl.list.forEach(function(t) {
        if (!t || !t.task) return;
        var taskText = String(t.task);
        if (projLower && taskText.toLowerCase().indexOf(projLower) === -1) return;

        var mins = toMinutes(t);
        byUser[uid].minutes += mins;
        totalMinutes += mins;
        daySet[r.date] = true;

        // Project bucket: extract prefix before ' - ' if available
        var projKey = projLower || (taskText.split(/\s+[-–—]\s+/)[0] || 'generico').toLowerCase().trim();
        if (!byProject[projKey]) byProject[projKey] = { project: projKey, minutes: 0, tasks: 0 };
        byProject[projKey].minutes += mins;
        byProject[projKey].tasks++;

        if (!byUser[uid].projects[projKey]) byUser[uid].projects[projKey] = 0;
        byUser[uid].projects[projKey] += mins;

        if (sampleTasks.length < 30) {
          sampleTasks.push({
            user: uid,
            date: r.date,
            scope: pl.tag,
            task: taskText,
            hours_formatted: formatHours(mins),
          });
        }
      });
    });

    byUser[uid].days_count += Object.keys(daySet).length;
  });

  // Resolve user IDs to names for the response
  var { getUtenti } = require('../services/slackService');
  var nameMap = {};
  try {
    var utenti = await getUtenti();
    utenti.forEach(function(u) { nameMap[u.id] = u.name; });
  } catch(e) {
    logger.warn('[STANDUP-TOOL] getUtenti failed, user names will be missing:', e.message);
  }

  // Format output
  var userList = Object.keys(byUser).map(function(uid) {
    var u = byUser[uid];
    var projList = Object.keys(u.projects).map(function(p) {
      return { project: p, hours_formatted: formatHours(u.projects[p]), minutes: u.projects[p] };
    }).sort(function(a, b) { return b.minutes - a.minutes; });
    return {
      slack_user_id: uid,
      user_name: nameMap[uid] || uid,
      hours_formatted: formatHours(u.minutes),
      minutes: u.minutes,
      days_count: u.days_count,
      projects: projList.slice(0, 10),
    };
  }).sort(function(a, b) { return b.minutes - a.minutes; });

  var projectList = Object.values(byProject).map(function(p) {
    return { project: p.project, hours_formatted: formatHours(p.minutes), minutes: p.minutes, tasks: p.tasks };
  }).sort(function(a, b) { return b.minutes - a.minutes; });

  // Add user names to sample tasks
  var namedTasks = sampleTasks.slice(0, 20).map(function(t) {
    return {
      user: t.user,
      user_name: nameMap[t.user] || t.user,
      date: t.date,
      scope: t.scope,
      task: t.task,
      hours_formatted: t.hours_formatted,
    };
  });

  return {
    found: rows.length,
    date_from: dateFrom,
    date_to: dateTo,
    user_filter: uidFilter,
    project_filter: input.project || null,
    scope: scope,
    total_hours_formatted: formatHours(totalMinutes),
    total_minutes: totalMinutes,
    by_user: userList,
    by_project: projectList.slice(0, 15),
    sample_tasks: namedTasks,
  };
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

async function execute(toolName, input) {
  if (toolName === 'query_standup') {
    try {
      return await queryStandup(input || {});
    } catch(e) {
      logger.error('[STANDUP-TOOL] error:', e.message);
      return { error: 'Errore query standup: ' + e.message };
    }
  }
  return { error: 'Tool sconosciuto in standupTools: ' + toolName };
}

module.exports = {
  definitions: definitions,
  execute: execute,
  queryStandup: queryStandup,
};
