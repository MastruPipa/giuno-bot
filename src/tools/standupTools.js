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
      'SEMANTICA (daily unico delle 16:00): scope "oggi" (default) = lavoro FATTO con ore reali — è la fonte per ' +
      'carico/effort; "domani" = piano dichiarato per il giorno dopo; "ieri" e "entrambi" = solo dati storici del ' +
      'vecchio daily mattutino, MAI per sommare ore (giornate contate due volte). Il risultato include periodo, ' +
      'giorni lavorativi, capacità e SOPRATTUTTO la valutazione già fatta per utente: campo "carico" (ok / pieno / ' +
      'sovraccarico, calcolato sui giorni con daily compilato), pct_of_tracked_days, pct_of_capacity e missing_dailies. ' +
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
          description: 'Cosa considerare: "oggi" (default — lavoro FATTO nel giorno del daily, ore reali, ogni giornata ' +
            'contata una volta), "domani" (piano dichiarato per il giorno dopo), "ieri" (legacy del vecchio daily ' +
            'mattutino), "entrambi" (SOLO per leggere le liste task, MAI per sommare ore).',
          enum: ['oggi', 'domani', 'ieri', 'entrambi'],
        },
      },
    },
  },
  {
    name: 'daily_estimate_amend',
    description: 'Modifica la PROPOSTA DI DAILY IN ATTESA (la stima ricostruita da Giuno, nel contesto) secondo quello che chiede l\'utente e gliela rimanda in DM con i bottoni. ' +
      'Usalo per "togli X", "leva quella cosa", "aggiungi 1h di call con Y", "la seconda voce erano 2h", "senza il meeting saltato": scrivi in instruction un\'istruzione precisa e autonoma, con il nome della voce così com\'è nella proposta e le ore, risolvendo tu i riferimenti impliciti dal contesto. ' +
      'Dopo il tool rispondi con una riga sola: la proposta aggiornata è già arrivata con i bottoni.',
    input_schema: {
      type: 'object',
      properties: { instruction: { type: 'string', description: 'La modifica, precisa: es. "togli la voce Meet Fondazione con il Sud 30min" oppure "aggiungi Call con Elios 1h in oggi".' } },
      required: ['instruction'],
    },
  },
  {
    name: 'daily_estimate_approve',
    description: 'Approva la PROPOSTA DI DAILY IN ATTESA: diventa il daily di oggi dell\'utente (salvato, ore nel consuntivo, pubblicato in #daily). ' +
      'Usalo quando l\'utente la approva ("va bene così", "approvala", "ok la stima"). Se esiste già un daily vero di oggi, il tool si ferma e te lo dice: chiedi conferma prima di richiamarlo con replace_existing=true.',
    input_schema: {
      type: 'object',
      properties: { replace_existing: { type: 'boolean', description: 'true solo dopo che l\'utente ha confermato di voler sostituire il daily già registrato oggi.' } },
    },
  },
  {
    name: 'post_daily',
    description: 'Registra e pubblica in #daily il daily che l\'utente ha scritto a mano nel messaggio, quando chiede di ' +
      'postarlo/pubblicarlo/registrarlo ("posta il mio daily", "pubblicalo in #daily", "ecco il daily di oggi, ' +
      'registralo", "postalo" riferito al daily scritto nel messaggio prima). Passa in text SOLO il daily (cosa ha ' +
      'fatto oggi con le ore, cosa farà domani, blocchi), senza la frase di richiesta: viene salvato come daily di ' +
      'OGGI a nome della persona, le ore entrano nel consuntivo e il testo viene pubblicato in #daily. Non inventare ' +
      'né completare il daily: se il messaggio non lo contiene, chiedilo. Per conto di chi scrive; solo un admin può ' +
      'indicare user_id per registrarlo a nome di un altro.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Il testo del daily così come l\'ha scritto la persona (senza la richiesta).' },
        user_id: { type: 'string', description: 'Slack ID della persona a cui intestare il daily (solo admin; default: chi scrive).' },
      },
      required: ['text'],
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

// Giorni lavorativi lun-ven del periodo — implementazione condivisa in
// utils/dates (usata anche da workloadService e timeTrackingTools).
var workdaysBetween = dates.workdaysBetween;

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
    .select('slack_user_id, date, ieri_tasks, oggi_tasks, domani_tasks, blocchi, raw_text, total_hours_ieri, total_hours_oggi, total_hours_domani, source')
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

  // I daily STIMATI da Giuno contano nei totali come gli altri (scelta
  // esplicita) ma vanno dichiarati: il modello deve dire quali giorni sono
  // ricostruiti e non compilati dalla persona.
  var estimated = rows.filter(function(r) { return r.source === 'estimate'; });
  var out = aggregateStandupRows(rows, input, dateFrom, dateTo);
  if (estimated.length > 0 && out && typeof out === 'object') {
    out.daily_stimati = estimated.map(function(r) {
      return { slack_user_id: r.slack_user_id, date: r.date, ore_stimate: r.total_hours_oggi || 0 };
    });
    out.nota_stime = estimated.length + ' daily nel periodo sono STIME ricostruite da Giuno (la persona non ha compilato): sono incluse nei totali, dillo quando riporti le ore.';
  }
  return out;
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
    if (scope === 'domani') pickLists.push({ tag: 'domani', list: r.domani_tasks || [] });
    if (scope === 'ieri' || scope === 'entrambi') pickLists.push({ tag: 'ieri', list: r.ieri_tasks || [] });

    pickLists.forEach(function(pl) {
      pl.list.forEach(function(t) {
        if (!t || !t.task) return;
        var taskText = String(t.task);
        // Il filtro progetto matcha sia il testo del task sia il project_name
        // agganciato all'ingestion dal projectMatcher (più affidabile).
        var projectName = t.project_name ? String(t.project_name) : null;
        if (projLower &&
            taskText.toLowerCase().indexOf(projLower) === -1 &&
            (!projectName || projectName.toLowerCase().indexOf(projLower) === -1)) return;

        var mins = toMinutes(t);
        byUser[uid].minutes += mins;
        totalMinutes += mins;
        daySet[r.date] = true;

        // Bucket progetto: il project_name reale (dal matcher) vince sul
        // fallback testuale (prefisso prima di ' - ').
        var projKey = projLower || (projectName ? projectName.toLowerCase()
          : (taskText.split(/\s+[-–—]\s+/)[0] || 'generico').toLowerCase().trim());
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

async function execute(toolName, input, userId, userRole) {
  input = input || {};
  if (toolName === 'query_standup') {
    try {
      return await queryStandup(input);
    } catch(e) {
      logger.error('[STANDUP-TOOL] error:', e.message);
      return { error: 'Errore query standup: ' + e.message };
    }
  }
  if (toolName === 'post_daily') return postDaily(input, userId, userRole);
  if (toolName === 'daily_estimate_amend') return amendEstimateTool(input, userId);
  if (toolName === 'daily_estimate_approve') return approveEstimateTool(input, userId);
  return { error: 'Tool sconosciuto in standupTools: ' + toolName };
}

// ─── daily_estimate_amend / daily_estimate_approve ───────────────────────────
// La proposta in sospeso la modifica e la approva il modello, che ha il
// contesto della chat: "togli quella cosa" diventa un'istruzione precisa.
async function amendEstimateTool(input, userId) {
  var instruction = String(input.instruction || '').trim();
  if (!instruction) return { error: 'Manca l\'istruzione di modifica.' };
  if (!userId || userId === 'system') return { error: 'Nessun utente.' };
  try {
    var dailyV2 = require('../handlers/dailyStandupV2');
    if (!dailyV2.getPendingEstimate(userId, dailyV2.oggi())) return { error: 'Nessuna proposta di daily in attesa per oggi: la persona può compilare il daily con il bottone o scriverlo in testo.' };
    var updated = await dailyV2.amendPendingEstimate(userId, instruction);
    if (!updated) return { error: 'Modifica non applicata: riprova con un\'istruzione più precisa (nome della voce e ore).' };
    var estimator = require('../agents/dailyEstimator');
    return { success: true, proposal: estimator.formatEstimateBody(updated),
      nota: 'Proposta aggiornata già inviata in DM con i bottoni Approvo / Modifico / Compilo da zero. Rispondi con una riga sola, senza ripetere la proposta.' };
  } catch(e) { return { error: 'Errore nella modifica: ' + e.message }; }
}

async function approveEstimateTool(input, userId) {
  if (!userId || userId === 'system') return { error: 'Nessun utente.' };
  try {
    var dailyV2 = require('../handlers/dailyStandupV2');
    var todayStr = dailyV2.oggi();
    if (!dailyV2.getPendingEstimate(userId, todayStr)) return { error: 'Nessuna proposta di daily in attesa per oggi.' };
    var existing = await dailyV2.getExistingEntry(userId, todayStr);
    if (existing && existing.source && existing.source !== 'estimate' && !input.replace_existing) {
      return { requires_confirmation: true,
        message: 'Oggi esiste già un daily vero (fonte: ' + existing.source + '). Approvare la stima lo SOSTITUISCE, ore comprese. Chiedi conferma all\'utente e richiama il tool con replace_existing=true solo se dice sì.' };
    }
    var ok = await dailyV2.confirmEstimate(userId);
    if (!ok) return { error: 'Approvazione non riuscita: la proposta non è più valida.' };
    return { success: true, message: 'Stima approvata: è il daily di oggi, pubblicato in #daily, ore nel consuntivo.' };
  } catch(e) { return { error: 'Errore nell\'approvazione: ' + e.message }; }
}

// ─── post_daily ───────────────────────────────────────────────────────────────
// Il daily scritto a mano in chat, pubblicato su richiesta. Stessa strada del
// daily testuale in DM (handleDailyResponse: parser AI, aggancio commesse,
// standup_entries, consuntivo, post in #daily), ma raggiungibile dal modello
// quando la richiesta non è riconosciuta dalle euristiche dell'handler.
async function postDaily(input, userId, userRole) {
  var text = String(input.text || '').trim();
  if (text.length < 10) return { error: 'Testo del daily mancante o troppo corto: passa il daily così come l\'ha scritto la persona.' };
  var target = input.user_id || userId;
  if (!target || target === 'system') return { error: 'Nessuna persona a cui intestare il daily: specifica user_id.' };
  if (input.user_id && input.user_id !== userId && userRole !== 'admin') {
    return { error: 'Solo un admin può registrare il daily a nome di un altro.' };
  }
  try {
    var dailyV2 = require('../handlers/dailyStandupV2');
    var saved = await dailyV2.handleDailyResponse(target, text);
    if (!saved) return { error: 'Daily non registrato: riprova o usa il bottone "✏️ Compila daily".' };
    return { success: true, user_id: target, date: dailyV2.oggi(),
      message: 'Daily di oggi registrato e pubblicato in #daily' + (target !== userId ? ' a nome di <@' + target + '>' : '') + '.' };
  } catch(e) {
    logger.error('[STANDUP-TOOL] post_daily:', e.message);
    return { error: 'Errore nel registrare il daily: ' + e.message };
  }
}

module.exports = {
  definitions: definitions,
  execute: execute,
  queryStandup: queryStandup,
  postDaily: postDaily,
  aggregateStandupRows: aggregateStandupRows,
  workdaysBetween: workdaysBetween,
};
