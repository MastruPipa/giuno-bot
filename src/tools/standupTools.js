// ─── Standup Tools ────────────────────────────────────────────────────────────
// Query aggregati sui daily standup archiviati in standup_entries.
// Risponde a domande tipo:
//   "quanto ha lavorato Giusy su Aitho nelle ultime 2 settimane?"
//   "quanto ha lavorato il team su Aitho nelle ultime settimane?"
//   "che ha fatto Nicolò la settimana scorsa?"

'use strict';

var logger = require('../utils/logger');
var dates = require('../utils/dates');
var dbClient = require('../services/db/client');

// ─── Tool definitions ────────────────────────────────────────────────────────

var definitions = [
  {
    name: 'query_standup',
    description: 'Interroga i daily standup archiviati per ottenere ore lavorate e task svolti. ' +
      'Usa SEMPRE questo tool per domande del tipo "quanto ha lavorato X su Y?", "che ha fatto X questa settimana?", ' +
      '"quante ore ha fatto il team su progetto Z?", "chi è sovraccarico?". Il match sul progetto è substring case-insensitive ' +
      'sul testo del task (es. project: "aitho" trova "Aitho - Documento Strategico 3h"). ' +
      'Se non specifichi intervallo di date, default = ultimi 14 giorni. ' +
      'ATTENZIONE ORE: i task "ieri" e "oggi" di daily consecutivi descrivono in gran parte le STESSE ore ' +
      '(il lavoro di lunedì è "oggi" nel daily di lunedì e di nuovo "ieri" nel daily di martedì): per calcolare ' +
      'carico/effort usa lo scope di default "oggi" e MAI "entrambi". Il risultato include periodo, giorni lavorativi, ' +
      'capacità e SOPRATTUTTO la valutazione già fatta per utente: campo "carico" (ok / pieno / sovraccarico, ' +
      'calcolato sui giorni con daily compilato), pct_of_tracked_days, pct_of_capacity e missing_dailies. ' +
      'USA il campo "carico" così com\'è: non ricalcolare percentuali, non inventare basi orarie, non definire ' +
      '"sovraccarico" chi ha semplicemente la settimana piena. Riporta sempre il periodo (campo "periodo").',
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
          description: 'Cosa considerare: "oggi" (default — i task pianificati nel giorno di ogni daily, ogni giornata ' +
            'contata una volta sola), "ieri" (solo i consuntivi del giorno prima), "entrambi" (SOLO per leggere le liste ' +
            'task, MAI per sommare ore: ieri+oggi contano le stesse giornate due volte).',
          enum: ['oggi', 'ieri', 'entrambi'],
        },
      },
    },
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isoDaysAgo(n) {
  return dates.daysFromTodayISO(-n);
}

function todayIso() {
  return dates.todayISO();
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

// Giorni lavorativi (lun-ven) tra due date ISO incluse. Serve a dare al
// modello una capacità corretta sul periodo reale invece del "40h/settimana"
// inventato quando il periodo è più corto o più lungo di una settimana.
function workdaysBetween(fromIso, toIso) {
  var from = new Date(fromIso + 'T00:00:00Z');
  var to = new Date(toIso + 'T00:00:00Z');
  if (isNaN(from) || isNaN(to) || from > to) return 0;
  var count = 0;
  for (var d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    var dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
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

  return aggregateStandupRows(rows, input, dateFrom, dateTo);
}

// Aggregazione pura (testabile senza DB). Il default scope è "oggi": sommare
// ieri+oggi conta due volte le stesse giornate (il lavoro di lunedì compare
// come "oggi" nel daily di lunedì e come "ieri" in quello di martedì) — è il
// bug che il 6/7 mostrava Giusy a 74h/186% quando era a ~38h/95%.
function aggregateStandupRows(rows, input, dateFrom, dateTo) {
  var projLower = input.project ? input.project.toLowerCase() : null;
  var scope = input.scope || 'oggi';
  var byUser = {};
  var byProject = {};
  var totalMinutes = 0;
  var sampleTasks = [];

  rows.forEach(function(r) {
    var uid = r.slack_user_id;
    if (!byUser[uid]) {
      byUser[uid] = { slack_user_id: uid, minutes: 0, days_count: 0, projects: {}, entryDates: {} };
    }
    // Giorni in cui la persona HA compilato un daily (indipendente dal filtro
    // progetto): è la base giusta per valutare il carico — chi ha 3 daily su 5
    // giorni va valutato su 3×8h, non sull'intera settimana, altrimenti i
    // daily mancanti "diluiscono" il carico e nascondono i sovraccarichi.
    byUser[uid].entryDates[r.date] = true;
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

  // Capacità sul periodo: 8h × giorni lavorativi (lun-ven) del range richiesto.
  // Con scope "entrambi" le ore sono gonfiate (giornate doppie) quindi la
  // percentuale sarebbe fuorviante: in quel caso non la calcoliamo.
  var workdays = workdaysBetween(dateFrom, dateTo);
  var capacityMinutes = workdays * 8 * 60;
  var doubleCounted = scope === 'entrambi';

  // Format output
  var userList = Object.keys(byUser).map(function(uid) {
    var u = byUser[uid];
    var projList = Object.keys(u.projects).map(function(p) {
      return { project: p, hours_formatted: formatHours(u.projects[p]), minutes: u.projects[p] };
    }).sort(function(a, b) { return b.minutes - a.minutes; });
    var daysWithDaily = Object.keys(u.entryDates).length;
    var entry = {
      slack_user_id: uid,
      hours_formatted: formatHours(u.minutes),
      minutes: u.minutes,
      days_count: u.days_count,
      days_with_daily: daysWithDaily,
      projects: projList.slice(0, 10),
    };
    if (!doubleCounted && capacityMinutes > 0) {
      entry.pct_of_capacity = Math.round((u.minutes / capacityMinutes) * 100);
    }
    // Valutazione carico calcolata QUI, non lasciata al modello: percentuale
    // sui giorni effettivamente tracciati (8h/giorno con daily compilato).
    // Una settimana piena (~100%) è normale, non un'emergenza: rosso solo
    // quando le ore dichiarate superano chiaramente le disponibili.
    //   ok < 85% · pieno 85–105% · sovraccarico > 105%
    // Con filtro progetto le ore sono un sottoinsieme → il giudizio non ha senso.
    if (!doubleCounted && !projLower && daysWithDaily > 0) {
      var trackedCapacity = daysWithDaily * 8 * 60;
      var pctTracked = Math.round((u.minutes / trackedCapacity) * 100);
      entry.pct_of_tracked_days = pctTracked;
      entry.carico = pctTracked > 105 ? 'sovraccarico' : (pctTracked >= 85 ? 'pieno' : 'ok');
      entry.missing_dailies = Math.max(0, workdays - daysWithDaily);
    }
    delete u.entryDates;
    return entry;
  }).sort(function(a, b) { return b.minutes - a.minutes; });

  var projectList = Object.values(byProject).map(function(p) {
    return { project: p.project, hours_formatted: formatHours(p.minutes), minutes: p.minutes, tasks: p.tasks };
  }).sort(function(a, b) { return b.minutes - a.minutes; });

  var result = {
    found: rows.length,
    date_from: dateFrom,
    date_to: dateTo,
    periodo: 'dal ' + dateFrom + ' al ' + dateTo + ' (' + workdays + ' giorni lavorativi)',
    workdays_in_range: workdays,
    capacity_minutes_per_person: capacityMinutes,
    capacity_hours_per_person_formatted: formatHours(capacityMinutes),
    criteri_valutazione: 'campo "carico" per utente, calcolato su 8h × giorni con daily compilato ' +
      '(days_with_daily): ok <85%, pieno 85–105% (settimana piena, normale), ' +
      'sovraccarico >105% (ore dichiarate oltre le disponibili). ' +
      'missing_dailies = giorni lavorativi del periodo senza daily.',
    project_filter: input.project || null,
    scope: scope,
    total_hours_formatted: formatHours(totalMinutes),
    total_minutes: totalMinutes,
    by_user: userList,
    by_project: projectList.slice(0, 15),
    sample_tasks: sampleTasks.slice(0, 20),
  };
  if (doubleCounted) {
    result.warning = 'Scope "entrambi": le ore ieri+oggi si sovrappongono (stesse giornate contate due volte). ' +
      'NON usare questi totali come carico/effort — rifai la query con scope "oggi".';
  }
  return result;
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
  aggregateStandupRows: aggregateStandupRows,
  workdaysBetween: workdaysBetween,
};
