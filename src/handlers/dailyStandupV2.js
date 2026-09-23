// ─── Daily Standup V2 — daily unico pomeridiano ─────────────────────────────
// Workflow: 17:30 stima in DM → 18:00 promemoria → 18:30 recap (orari in
// DAILY_TIMES, override via env). Struttura: FATTO OGGI (ore
// reali → alimentano anche time_logs via project match) + DOMANI (piano) +
// BLOCCHI. Sostituisce il vecchio daily mattutino e il check-in serale.
'use strict';

var logger = require('../utils/logger');
var { formatPerSlack } = require('../utils/slackFormat');
var { app, getUtenti } = require('../services/slackService');
var db = require('../../supabase');
var { acquireCronLock, releaseCronLock } = require('../../supabase');

var DAILY_CHANNEL_ID = process.env.DAILY_CHANNEL_ID || 'C05846AEV6D';

// Orari del daily: src/config/dailyTimes.js (li legge anche il prompt).
var dailyTimesConfig = require('../config/dailyTimes');
var DAILY_TIMES = dailyTimesConfig.DAILY_TIMES;
var cronExprFor = dailyTimesConfig.cronExprFor;

// ─── Exclusions ──────────────────────────────────────────────────────────────
// Persone che NON partecipano al daily (niente richiesta, niente push, niente
// "mancano all'appello"). Lista condivisa col check-in serale in
// config/tracking (override via env TRACKING_EXCLUDED_NAMES).
var trackingConfig = require('../config/tracking');

function isExcludedFromDaily(utente) {
  return trackingConfig.isExcludedName(utente && utente.name);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPrefs(userId) {
  return Object.assign({ standup_enabled: true }, db.getPrefsCache()[userId] || {});
}

function getStandupInAttesa() {
  return require('./slackHandlers').standupInAttesa;
}

// YYYY-MM-DD in Europe/Rome — the standup cron schedule is Rome TZ, so the
// storage key must match; otherwise a response submitted late at night (Rome)
// can be written under the next UTC day and silently wipe sd.risposte.
function oggi() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date());
}

// ─── Invio — Send DM (stima o modulo) to all team members ───────────────────

// Invio singolo del DM col bottone "Compila daily": usato dal cron dell'invio
// e dal tool admin trigger_daily_request (test on-demand). Aggiunge l'utente
// a standupInAttesa così anche una risposta testuale in DM viene riconosciuta.
// persistInAttesa=true (invii fuori cron) salva subito lo stato: il cron lo
// fa già in blocco a fine loop.
async function sendDailyRequestTo(utente, persistInAttesa, deps) {
  deps = deps || {};
  var standupInAttesa = deps.inattesa || getStandupInAttesa();
  standupInAttesa.add(utente.id);
  if (persistInAttesa) {
    try {
      var sd = db.getStandupCache();
      if (sd.oggi !== oggi()) { sd.oggi = oggi(); sd.risposte = {}; }
      sd.inattesa = Array.from(standupInAttesa);
      await db.saveStandup(sd);
    } catch(e) { logger.warn('[DAILY-V2] persist inattesa fallito:', e.message); }
  }
  var nome = (utente.name || '').split(' ')[0] || 'ciao';
  // Senza tracce per la stima, la scorciatoia: le commesse recenti della
  // persona come bottoni; un tap apre il modulo con la riga già intestata.
  var quick = await quickProjectButtons(utente.id, deps.quickDeps);
  var client = (deps.app || app).client;
  try {
    await client.chat.postMessage(dailyRequestMessage(utente, nome, quick));
  } catch(e) {
    if (!quick.length) throw e;
    // I bottoni rapidi sono un extra: se Slack rifiuta il messaggio (blocchi
    // non validi, nome di commessa strano) il modulo deve arrivare lo stesso.
    // 14/9: al primo giro con i bottoni il DM non è arrivato a qualcuno e
    // nessuno se n'è accorto fino alla domanda in #daily.
    logger.warn('[DAILY-V2] DM con bottoni rapidi rifiutato per', utente.id + ':', e.message, '— rimando il modulo semplice');
    await client.chat.postMessage(dailyRequestMessage(utente, nome, []));
  }
}

function dailyRequestMessage(utente, nome, quick) {
  return {
    channel: utente.id,
    text: 'Ciao ' + nome + ', è il momento del daily!',
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: 'Ciao *' + nome + '*, com\'è andata oggi? Registra cosa hai fatto (con le ore), il piano di domani e gli eventuali blocchi.' },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'Compila il form o rispondi con un messaggio. Le ore contano come consuntivo. Il recap esce alle ' + DAILY_TIMES.recap + '.' }],
      },
    ].concat(quick.length ? [
      { type: 'section', text: { type: 'mrkdwn', text: 'Oggi hai lavorato su una di queste? Un tap e ti apro il modulo già intestato:' } },
      { type: 'actions', elements: quick },
    ] : []).concat([
      {
        type: 'actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: '✏️ Compila daily', emoji: true },
          style: 'primary',
          action_id: 'open_daily_modal',
        }, FREE_TEXT_BUTTON],
      },
    ]),
  };
}

// Bottoni con le commesse recenti della persona (max 4): value = project id.
// action_id diverso per ogni bottone: Slack chiede id univoci dentro lo stesso
// blocco e con id ripetuti può rifiutare l'intero messaggio (invalid_blocks).
async function quickProjectButtons(userId, deps) {
  deps = deps || {};
  try {
    var ctx = deps.context || require('../services/projectContext');
    var recent = await ctx.recentProjectsFor(userId, { deps: deps });
    var out = [];
    for (var i = 0; i < recent.length && out.length < 4; i++) {
      var p = await (deps.db || db).getProject(recent[i].id);
      if (!p || !p.name) continue;
      out.push({ type: 'button', text: { type: 'plain_text', text: String(p.name).substring(0, 30), emoji: true }, action_id: 'daily_quick_project_' + out.length, value: String(p.id) });
    }
    return out;
  } catch(e) { logger.debug('[DAILY-V2] bottoni rapidi saltati:', e.message); return []; }
}

async function sendDailyRequests() {
  var locked = await acquireCronLock('daily_standup_v2_send', 10);
  if (!locked) return;
  try {
    var todayStr = oggi();
    logger.info('[DAILY-V2] Invio richieste daily per', todayStr);

    var sd = db.getStandupCache();
    // Only reset risposte when we're starting a genuinely new day.
    // sd.oggi is persisted in standup_data, so it survives restarts — use it
    // as the source of truth instead of sd.lastDay (which is process-local
    // and always undefined on restart, causing accidental wipes).
    if (sd.oggi !== todayStr) {
      sd.risposte = {};
      sd.inattesa = [];
    }
    sd.oggi = todayStr;
    sd.risposte = sd.risposte || {};
    sd.inattesa = Array.isArray(sd.inattesa) ? sd.inattesa : [];
    await db.saveStandup(sd);

    var utenti = await getUtenti();
    var inviati = 0;
    var standupInAttesa = getStandupInAttesa();

    var precompilati = 0;
    var falliti = [];
    for (var i = 0; i < utenti.length; i++) {
      var utente = utenti[i];
      if (!getPrefs(utente.id).standup_enabled) continue;
      if (isExcludedFromDaily(utente)) continue;
      try {
        // Daily "al contrario": Giuno lo compila da calendario, Slack e mail,
        // la persona conferma con un tap o lo corregge. Il modulo vuoto resta
        // solo quando non c'è abbastanza da ricostruire.
        var proposed = null;
        if (ESTIMATES_ENABLED && PREFILL_ENABLED) {
          try { proposed = await buildEstimateFor(utente, todayStr); }
          catch(e) { logger.warn('[DAILY-V2] daily precompilato fallito per', utente.id + ':', e.message); }
        }
        if (proposed) {
          standupInAttesa.add(utente.id);
          await sendEstimateProposal(utente, proposed, { mode: 'daily' });
          precompilati++;
        } else {
          await sendDailyRequestTo(utente);
        }
        inviati++;
      } catch(e) {
        logger.error('[DAILY-V2] Errore invio a', utente.id + ':', e.message);
        falliti.push({ id: utente.id, name: utente.name, error: e.message });
      }
    }
    logger.info('[DAILY-V2] Daily precompilati:', precompilati, 'su', inviati);
    sd.inattesa = Array.from(standupInAttesa);
    await db.saveStandup(sd);
    logger.info('[DAILY-V2] Richieste inviate a', inviati, 'utenti.');
    if (falliti.length) {
      try { await notifySendFailures(falliti, todayStr); }
      catch(e) { logger.warn('[DAILY-V2] avviso invii falliti non mandato:', e.message); }
    }
  } finally {
    await releaseCronLock('daily_standup_v2_send');
  }
}

// Se il DM del daily non parte per qualcuno, gli admin lo sanno subito in
// DM: prima restava solo nei log di Railway e alle 18:00 la persona risultava
// "mancante" senza aver mai ricevuto la richiesta.
async function notifySendFailures(failed, dateStr, deps) {
  deps = deps || {};
  if (!failed || !failed.length) return 0;
  var roles = deps.roles || await require('../../rbac').getAllRoles();
  var admins = roles.filter(function(r) { return r.role === 'admin'; }).map(function(r) { return r.slack_user_id; });
  if (!admins.length) return 0;
  var lines = ['*Daily del ' + dateStr + ': la richiesta delle ' + DAILY_TIMES.send + ' non è partita per ' + failed.length + (failed.length === 1 ? ' persona' : ' persone') + ':*'];
  failed.forEach(function(f) { lines.push('• <@' + f.id + '>: ' + String(f.error || 'errore sconosciuto').substring(0, 160)); });
  lines.push('_Per rimandarla: "manda la richiesta daily a <nome>" qui in DM. La persona può comunque scrivermi il daily in DM o postarlo in #daily._');
  var client = (deps.app || app).client;
  var sent = 0;
  for (var a = 0; a < admins.length; a++) {
    try { await client.chat.postMessage({ channel: admins[a], text: lines.join('\n') }); sent++; }
    catch(e) { logger.debug('[DAILY-V2] avviso invii falliti a ' + admins[a] + ' fallito:', e.message); }
  }
  return sent;
}

// ─── Daily stimato ───────────────────────────────────────────────────────────
// Proposte generate all'invio (DAILY_TIMES.send) per tutti: userId → structured.
// Chi non conferma né corregge riceve il daily stimato al recap come tutti gli altri.
var _pendingEstimates = {}; // userId -> { date, structured }
var ESTIMATES_ENABLED = String(process.env.DAILY_ESTIMATES_ENABLED || 'true') !== 'false';
// All'invio il daily arriva già compilato (stima) invece del modulo vuoto.
var PREFILL_ENABLED = String(process.env.DAILY_PREFILL_ENABLED || 'true') !== 'false';

// Memoria prima, poi lo stato persistito (standup_data.stime): sopravvive
// a un deploy tra l'invio e il recap.
function getPendingEstimate(userId, dateStr) {
  var p = _pendingEstimates[userId];
  if (p && p.date === dateStr) return p.structured;
  var sd = db.getStandupCache();
  var q = sd.stime && sd.stime[userId];
  if (q && q.date === dateStr && q.structured) { _pendingEstimates[userId] = q; return q.structured; }
  return null;
}
// Come getPendingEstimate, ma se la memoria non ce l'ha rilegge lo stato dal
// DB: il bottone può arrivare a un'istanza diversa da quella che ha mandato
// la proposta (23/9: due bot in produzione), o dopo un riavvio.
async function getPendingEstimateFresh(userId, dateStr, deps) {
  var inMemory = getPendingEstimate(userId, dateStr);
  if (inMemory) return inMemory;
  var d = (deps && deps.db) || db;
  if (typeof d.loadPendingEstimateFor !== 'function') return null;
  var q = await d.loadPendingEstimateFor(userId);
  if (q && q.date === dateStr && q.structured) { _pendingEstimates[userId] = q; return q.structured; }
  return null;
}
function clearPendingEstimate(userId) {
  delete _pendingEstimates[userId];
  var sd = db.getStandupCache();
  if (sd.stime && sd.stime[userId]) delete sd.stime[userId];
}
function rememberPendingEstimate(userId, dateStr, structured) {
  _pendingEstimates[userId] = { date: dateStr, structured: structured };
  var sd = db.getStandupCache();
  sd.stime = sd.stime || {};
  sd.stime[userId] = { date: dateStr, structured: structured };
}

// Chi ha già un daily VERO oggi, letto dal DB: è la fonte di verità per
// l'appello. La cache in memoria (sd.risposte) può essere vecchia quando
// due istanze si sovrappongono durante un deploy (Gianna, 10/9: compilato
// alle 17:16, contata assente alle 18:00).
async function respondedFromDb(dateStr) {
  var out = {};
  try {
    var supabase = require('../services/db/client').getClient();
    if (!supabase) return out;
    var res = await supabase.from('standup_entries').select('slack_user_id, source').eq('date', dateStr).limit(500);
    (res.data || []).forEach(function(r) { if (r.source !== 'estimate') out[r.slack_user_id] = { source: r.source, fromDb: true }; });
  } catch(e) { logger.warn('[DAILY-V2] lettura risposte dal DB fallita:', e.message); }
  return out;
}

// Se per (utente, giorno) c'era una stima di Giuno (in sospeso o già pubblicata)
// e arriva il daily vero, le ore stimate e quelle reali finiscono in
// daily_estimate_calibration: Giuno impara se per quella persona stima basso o alto.
async function recordEstimateCorrection(userId, dateStr, structured, confirmed) {
  try {
    var pending = getPendingEstimate(userId, dateStr);
    var estimatedTasks = pending ? pending.oggi : null;
    var sources = pending && pending.estimate ? pending.estimate.sources : null;
    if (!estimatedTasks) {
      var prior = await getExistingEntry(userId, dateStr);
      if (prior && prior.source === 'estimate') estimatedTasks = prior.oggi_tasks || [];
    }
    if (!estimatedTasks || !estimatedTasks.length) return false;
    var actualTasks = structured && Array.isArray(structured.oggi) ? structured.oggi : [];
    return await require('../services/estimateCalibration').recordCorrection(userId, dateStr, estimatedTasks, actualTasks, { confirmed: !!confirmed, sources: sources });
  } catch(e) { logger.debug('[DAILY-V2] calibrazione saltata:', e.message); return false; }
}

// DM agli admin con la diagnosi per persona: quale fonte era vuota e perché.
async function notifyMissingEstimates(users, dateStr, deps) {
  deps = deps || {};
  var estimator = deps.estimator || require('../agents/dailyEstimator');
  var roles = deps.roles || await require('../../rbac').getAllRoles();
  var admins = roles.filter(function(r) { return r.role === 'admin'; }).map(function(r) { return r.slack_user_id; });
  if (!admins.length || !users.length) return 0;
  var lines = ['*Stime del daily mancanti oggi (' + users.length + '):* per ognuno, cosa ho controllato e perché era vuoto.'];
  for (var i = 0; i < users.length; i++) {
    var why = [];
    try { why = await estimator.explainMissing(users[i].id, dateStr, deps.estimatorDeps); } catch(e) { why = ['diagnosi non disponibile: ' + e.message]; }
    lines.push('• *' + (users[i].name || users[i].id) + '*: ' + (why.length ? why.join('; ') : 'nessuna fonte vuota registrata'));
  }
  lines.push('_Le fonti si sbloccano così: Google collegato da un admin (Drive e inviti per tutti), Giuno invitato nei canali di lavoro, `SLACK_USER_TOKEN` su Railway._');
  var client = (deps.app || app).client;
  var sent = 0;
  for (var a = 0; a < admins.length; a++) {
    try { await client.chat.postMessage({ channel: admins[a], text: lines.join('\n') }); sent++; }
    catch(e) { logger.debug('[DAILY-V2] diagnosi a ' + admins[a] + ' fallita:', e.message); }
  }
  return sent;
}

// Invio on-demand come lo farebbe il cron: prima la stima (se ci sono
// tracce), altrimenti il modulo. Usato dal tool admin trigger_daily_request
// ("mandami la stima del daily") quando il cron è passato o è stato saltato.
async function sendDailyRequestWithEstimate(utente, deps) {
  deps = deps || {};
  var todayStr = oggi();
  var proposed = null;
  if (ESTIMATES_ENABLED) {
    try { proposed = await (deps.buildEstimateFor || buildEstimateFor)(utente, todayStr); }
    catch(e) { logger.warn('[DAILY-V2] stima on-demand fallita per', utente.id + ':', e.message); }
  }
  if (proposed) {
    var standupInAttesa = deps.inattesa || getStandupInAttesa();
    standupInAttesa.add(utente.id);
    try {
      var sd = (deps.db || db).getStandupCache();
      if (sd.oggi !== todayStr) { sd.oggi = todayStr; sd.risposte = {}; }
      sd.inattesa = Array.from(standupInAttesa);
      await (deps.db || db).saveStandup(sd);
    } catch(e) { logger.warn('[DAILY-V2] persist inattesa (stima on-demand) fallito:', e.message); }
    await sendEstimateProposal(utente, proposed, { mode: 'daily' }, deps);
    return { estimate: true };
  }
  await sendDailyRequestTo(utente, true, deps);
  return { estimate: false };
}

async function buildEstimateFor(utente, dateStr) {
  var estimator = require('../agents/dailyEstimator');
  var structured = await estimator.estimateDaily(utente.id, dateStr);
  if (!structured || !structured.oggi || structured.oggi.length === 0) return null;
  rememberPendingEstimate(utente.id, dateStr, structured);
  return structured;
}

// DM con la proposta. La persona può: approvarla (bottone), correggerla nel
// modulo già compilato (bottone), compilare da zero (bottone) o scrivere qui
// cosa aggiungere/cambiare (testo → amendPendingEstimate → nuova proposta).
// mode: 'daily' (invio), 'amended' (dopo una modifica a parole), 'reminder'
// (promemoria), 'push' (ricostruita al promemoria).
function estimateProposalMessage(utente, structured, opts, deps) {
  opts = opts || {};
  var estimator = (deps && deps.estimator) || require('../agents/dailyEstimator');
  var nome = (utente.name || '').split(' ')[0] || 'ciao';
  var body = estimator.formatEstimateBody(structured);
  var intro = opts.mode === 'daily'
    ? 'Ciao *' + nome + '*, è il momento del daily. Te l\'ho già compilato da calendario, Slack, Drive e mail:'
    : opts.mode === 'amended'
      ? 'Ok *' + nome + '*, aggiornato così:'
      : opts.mode === 'reminder'
        ? 'Ehi *' + nome + '*, manca solo la conferma del daily di oggi. Se torna, un tap e siamo a posto:'
        : 'Ehi *' + nome + '*, manca il tuo daily. Da quello che vedo della tua giornata l\'ho ricostruito così:';
  var howTo = 'Va bene così? *Approva* con il bottone, *modifica* nel modulo già compilato, *scrivi* tutta la giornata a testo libero (ci penso io a dividere task e ore), ' +
    'oppure *scrivimi qui* cosa aggiungere o cambiare ("aggiungi 1h di call con Elios", "la grafica erano 3h", "togli la revisione") e ti rimando la proposta aggiornata.';
  var plain = (opts.mode === 'daily' ? 'È il momento del daily: te l\'ho compilato io, approvi?' : opts.mode === 'amended' ? 'Daily aggiornato: approvi?' : 'Manca il tuo daily: ho provato a ricostruirlo io.');
  return {
    channel: utente.id,
    text: plain + '\n' + body,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: intro } },
      { type: 'section', text: { type: 'mrkdwn', text: formatPerSlack(body) } },
      { type: 'section', text: { type: 'mrkdwn', text: howTo } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: estimator.formatSourcesLine(structured) + '\nSe alle ' + DAILY_TIMES.recap + ' non ho tue notizie lo pubblico come *stima* in #daily e le ore entrano nel consuntivo come stimate; puoi correggerlo anche dopo, compilando il daily.' }] },
      { type: 'actions', elements: [
        { type: 'button', text: { type: 'plain_text', text: '✅ Approvo', emoji: true }, style: 'primary', action_id: 'daily_estimate_confirm', value: structured.estimate ? structured.estimate.generated_at : 'x' },
        { type: 'button', text: { type: 'plain_text', text: '✏️ Modifico nel modulo', emoji: true }, action_id: 'open_daily_modal' },
        { type: 'button', text: { type: 'plain_text', text: '📝 Compilo da zero', emoji: true }, action_id: 'open_daily_modal_blank' },
        FREE_TEXT_BUTTON,
      ] },
    ],
  };
}

// Bottone "a testo libero": un modale con una sola area di testo dove la
// persona scrive tutta la giornata di fila, anche in un blocco solo; il
// parser AI (dailyParser) la divide in task e ore e il matcher aggancia i
// progetti. Stesso bottone nella proposta stimata e nel modulo semplice.
var FREE_TEXT_BUTTON = { type: 'button', text: { type: 'plain_text', text: '🖊️ Scrivo a testo libero', emoji: true }, action_id: 'open_daily_modal_text' };

function dailyTextModal() {
  return {
    type: 'modal', callback_id: 'daily_text_submit',
    title: { type: 'plain_text', text: 'Daily a testo libero' },
    submit: { type: 'plain_text', text: '✅ Invia' },
    close: { type: 'plain_text', text: 'Chiudi' },
    blocks: [
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Scrivi tutto di fila, anche in un blocco solo e senza formato: ci penso io a dividere task, ore e progetti. Le ore contano come consuntivo.' }] },
      {
        type: 'input', block_id: 'daily_text',
        label: { type: 'plain_text', text: 'La tua giornata' },
        element: { type: 'plain_text_input', action_id: 'daily_text_input', multiline: true, min_length: 10, max_length: 3000,
          placeholder: { type: 'plain_text', text: 'Es. Mattina call con Elios 1h e revisione grafiche 2h, poi 3h sul sito Aitho. Domani mockup e riunione team. Bloccato dal cliente sui testi.' } },
      },
    ],
  };
}

// Daily scritto nel modale a testo libero: lo salva come daily VERO (source
// modal_text: parser AI + aggancio progetti dentro handleDailyResponse) e
// restituisce com'è stato letto, così la persona vede cosa ha capito Giuno e
// può correggerlo nel modulo, che ora si apre già compilato dalla entry.
async function saveFreeTextDaily(userId, text, deps) {
  deps = deps || {};
  text = String(text || '').trim();
  if (!text) return { saved: false, structured: null };
  var saved = await (deps.handleDailyResponse || handleDailyResponse)(userId, text, null, { source: 'modal_text' });
  var structured = null;
  if (saved) {
    var entry = await (deps.getTodayEntry || getTodayEntry)(userId, oggi());
    if (entry && ((entry.oggi_tasks && entry.oggi_tasks.length) || (entry.domani_tasks && entry.domani_tasks.length))) {
      structured = { oggi: entry.oggi_tasks || [], domani: entry.domani_tasks || [], blocchi: entry.blocchi || null };
    }
  }
  return { saved: saved, structured: structured };
}

async function sendEstimateProposal(utente, structured, opts, deps) {
  var client = ((deps && deps.app) || app).client;
  await client.chat.postMessage(estimateProposalMessage(utente, structured, opts, deps));
}

// Risposta testuale alla proposta in DM: approvazione a parole, oppure una
// modifica ("aggiungi…", "togli…", "erano 3h") da applicare alla stima.
// null = non è una risposta alla proposta (daily intero, o altro).
// Solo le approvazioni sono deterministiche: ESPLICITA ("approvo",
// "confermo") vale sempre; NUDA ("ok", "sì", "va bene") solo se l'ultimo
// messaggio di Giuno nel DM è la proposta (il 17/9 un "ok" a un consiglio ha
// sovrascritto il daily buono). Le correzioni ("togli quella cosa", "la
// seconda voce erano 2h") le capisce il modello dal contesto e le applica
// con il tool daily_estimate_amend: l'elenco di verbi di prima non reggeva
// ("leva il meeting…" non era previsto).
var APPROVE_EXPLICIT_RE = /^(approv[oa]t?[oa]?|conferm[oa]t?[oa]?|confermo cos[iì]|approvo cos[iì]|approva(la)?|conferma(la)?)[\s!.👍✅]*$/i;
var APPROVE_BARE_RE = /^(ok(ay)?|va bene|vabbe'?|s[iì]|yes|perfetto|giusto|corretto|esatto|tutto (ok|giusto|corretto)|(va bene|ok) cos[iì]|cos[iì] va bene)[\s!.👍✅]*$/i;

function classifyEstimateReply(txt) {
  txt = String(txt || '').trim();
  if (!txt) return null;
  if (APPROVE_EXPLICIT_RE.test(txt)) return 'approve';
  if (APPROVE_BARE_RE.test(txt)) return 'approve_bare';
  return null;
}

// La proposta in sospeso, per il contesto del modello: così "togli quella
// cosa" o "la seconda erano 2h" hanno un riferimento e finiscono nel tool.
function pendingProposalSection(userId, deps) {
  var todayStr = oggi();
  var structured = getPendingEstimate(userId, todayStr);
  if (!structured) return null;
  var estimator = (deps && deps.estimator) || require('../agents/dailyEstimator');
  return 'PROPOSTA DI DAILY IN ATTESA (inviata all\'utente in DM con i bottoni Approvo / Modifico nel modulo / Compilo da zero / Scrivo a testo libero; data ' + todayStr + '):\n' +
    estimator.formatEstimateBody(structured) + '\n' +
    'Se l\'utente chiede di cambiarla (togliere, aggiungere, correggere ore o nomi, anche con riferimenti impliciti come "quella cosa", "la seconda", "il meeting saltato") → daily_estimate_amend con un\'istruzione precisa che nomina la voce e le ore. ' +
    'Se la approva → daily_estimate_approve. Non riscrivere la proposta nel testo: il tool la rimanda già con i bottoni. Non fingere di aver modificato senza chiamare il tool.';
}

// L'ultimo messaggio di Giuno nel DM (prima di quello dell'utente) è la
// proposta con i bottoni? Serve per dare un senso a un "ok" nudo.
async function lastBotMessageIsProposal(channelId, beforeTs, deps) {
  deps = deps || {};
  var client = ((deps.app) || app).client;
  try {
    var res = await client.conversations.history({ channel: channelId, latest: beforeTs, inclusive: false, limit: 5 });
    var msgs = (res && res.messages) || [];
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (!m.bot_id && !(m.subtype === 'bot_message')) continue;
      var blocks = m.blocks || [];
      return blocks.some(function(b) { return b.type === 'actions' && (b.elements || []).some(function(e) { return e.action_id === 'daily_estimate_confirm'; }); });
    }
  } catch(e) { logger.debug('[DAILY-V2] history per approvazione nuda non letta:', e.message); }
  return false;
}

// Applica la modifica a parole alla stima in sospeso e rimanda la proposta.
// Ritorna la stima aggiornata, o null se non c'era una proposta valida oggi.
async function amendPendingEstimate(userId, instruction, deps) {
  deps = deps || {};
  var todayStr = oggi();
  var current = getPendingEstimate(userId, todayStr);
  if (!current) return null;
  var estimator = deps.estimator || require('../agents/dailyEstimator');
  var updated = await estimator.amendEstimate(current, instruction, { userId: userId, date: todayStr, client: deps.client });
  if (!updated) return null;
  rememberPendingEstimate(userId, todayStr, updated);
  try { await (deps.db || db).saveStandup((deps.db || db).getStandupCache()); } catch(e) { logger.debug('[DAILY-V2] stima modificata non persistita:', e.message); }
  var utenti = deps.utenti || await getUtenti();
  var utente = utenti.find(function(u) { return u.id === userId; }) || { id: userId, name: '' };
  await sendEstimateProposal(utente, updated, { mode: 'amended' }, deps);
  return updated;
}

// Righe per il modale dalla stima: {oggi:[{task,hours}], domani:[...], blocchi}
// dove hours è decimale (1.5) da abbinare alle opzioni di durata.
function prefillFromEstimate(structured) {
  if (!structured) return null;
  function rows(list) {
    return (list || []).slice(0, 10).map(function(t) {
      var h = (Number(t.hours) || 0) + (Number(t.minutes) || 0) / 60;
      // La stima appena generata ha `project`; dopo il matcher (e nelle
      // entry salvate) il nome sta in `project_name`.
      var project = t.project || t.project_name || null;
      var task = String(t.task || '').substring(0, 150);
      if (project && task.indexOf('[' + project + ']') === -1) task += ' [' + project + ']';
      return { task: task, hours: Math.round(h * 4) / 4 };
    }).filter(function(r) { return r.task; });
  }
  var out = { oggi: rows(structured.oggi), domani: rows(structured.domani), blocchi: structured.blocchi || null };
  return (out.oggi.length || out.domani.length) ? out : null;
}

// La entry di oggi con tutto quello che serve a ricompilare il modulo.
async function getTodayEntry(userId, dateStr) {
  try {
    var supabase = require('../services/db/client').getClient();
    if (!supabase) return null;
    var res = await supabase.from('standup_entries')
      .select('oggi_tasks, domani_tasks, blocchi, source')
      .eq('slack_user_id', userId).eq('date', dateStr).limit(1);
    return (res.data && res.data[0]) || null;
  } catch(e) { logger.debug('[DAILY-V2] entry di oggi non letta per il prefill:', e.message); return null; }
}

// Cosa mettere nel modulo di "Modifico nel modulo": la proposta in sospeso
// se c'è, altrimenti il daily di oggi già salvato (stima approvata, stima
// pubblicata al recap, daily compilato o scritto). Prima il modulo si
// riempiva solo con la proposta in sospeso: dopo "Approvo" o dopo il recap
// la proposta è consumata e il modulo si apriva vuoto (Antonio, 22/9).
// Ritorna { prefill, from: 'estimate' | 'entry' | null }.
async function prefillForModal(userId, dateStr, deps) {
  deps = deps || {};
  var pending = deps.getPendingEstimate ? deps.getPendingEstimate(userId, dateStr) : await getPendingEstimateFresh(userId, dateStr, deps);
  var fromEstimate = prefillFromEstimate(pending);
  if (fromEstimate) return { prefill: fromEstimate, from: 'estimate' };
  var entry = await (deps.getTodayEntry || getTodayEntry)(userId, dateStr);
  if (!entry) return { prefill: null, from: null };
  var fromEntry = prefillFromEstimate({ oggi: entry.oggi_tasks || [], domani: entry.domani_tasks || [], blocchi: entry.blocchi || null });
  return fromEntry ? { prefill: fromEntry, from: 'entry' } : { prefill: null, from: null };
}

// Conferma dal bottone: la stima diventa il daily della persona a tutti gli
// effetti (source estimate_confirmed → alimenta anche il consuntivo).
async function confirmEstimate(userId) {
  var todayStr = oggi();
  var structured = await getPendingEstimateFresh(userId, todayStr);
  if (!structured) return false;
  var estimator = require('../agents/dailyEstimator');
  var text = estimator.formatEstimateBody(structured);
  var saved = await handleDailyResponse(userId, text, structured, { source: 'estimate_confirmed' });
  if (saved) clearPendingEstimate(userId);
  return saved;
}

// 18:00: chi non ha risposto e ha una stima in sospeso riceve una entry
// source='estimate' — visibile a tutti, marcata — e le ore stimate entrano
// nel consuntivo time_logs (marcate come stima), finché un daily vero non le
// rimpiazza.
async function saveEstimateAsEntry(utente, dateStr, structured) {
  var estimator = require('../agents/dailyEstimator');
  var text = estimator.formatEstimateBody(structured);
  var supabase = require('../services/db/client').getClient();
  if (!supabase) return false;
  var entry = {
    slack_user_id: utente.id, date: dateStr, raw_text: text, source: 'estimate',
    oggi_tasks: structured.oggi || [], domani_tasks: structured.domani || [],
    blocchi: structured.blocchi || null,
    total_hours_oggi: structured.totalOggi || 0, total_hours_domani: structured.totalDomani || 0,
  };
  // Non sovrascrivere mai un daily vero arrivato nel frattempo.
  var existing = await getExistingEntry(utente.id, dateStr);
  if (existing && existing.source && existing.source !== 'estimate') return false;
  var res = await supabase.from('standup_entries').upsert(entry, { onConflict: 'slack_user_id,date' });
  if (res && res.error) { logger.warn('[DAILY-V2] upsert stima fallito:', res.error.message); return false; }
  await syncTimeLogsFromDaily(utente.id, dateStr, structured, {
    estimate: true,
    confidence: structured.estimate && structured.estimate.confidence,
    sources: structured.estimate && structured.estimate.sources,
  });
  try {
    await app.client.chat.postMessage({
      channel: DAILY_CHANNEL_ID, unfurl_links: false,
      text: formatPerSlack('*Daily di <@' + utente.id + '>* — ⚠️ _stima di Giuno, non confermata_\n\n' + text +
        '\n\n_' + estimator.formatSourcesLine(structured) + '. <@' + utente.id + '>, se non torna compila il daily e la sostituisco._'),
    });
  } catch(e) { logger.warn('[DAILY-V2] post stima in #daily fallito:', e.message); }
  return true;
}

async function pushMissingResponders(pushNumber) {
  var locked = await acquireCronLock('daily_standup_v2_push_' + pushNumber, 5);
  if (!locked) return;
  try {
    var todayStr = oggi();
    var sd = db.getStandupCache();
    if (sd.oggi !== todayStr) return;

    var utenti = await getUtenti();
    var standupInAttesa = getStandupInAttesa();
    var pushed = 0;
    var respondedDb = await respondedFromDb(todayStr);

    for (var i = 0; i < utenti.length; i++) {
      var utente = utenti[i];
      if (!getPrefs(utente.id).standup_enabled) continue;
      if (isExcludedFromDaily(utente)) continue;
      if ((sd.risposte && sd.risposte[utente.id]) || respondedDb[utente.id]) continue; // Already responded

      try {
        standupInAttesa.add(utente.id);
        var proposed = null;
        var alreadyProposed = getPendingEstimate(utente.id, todayStr);
        if (alreadyProposed) {
          // Proposta già mandata all'invio: solo un promemoria con i bottoni.
          proposed = alreadyProposed;
        } else if (ESTIMATES_ENABLED && pushNumber === 1) {
          try { proposed = await buildEstimateFor(utente, todayStr); }
          catch(e) { logger.warn('[DAILY-V2] stima daily fallita per', utente.id + ':', e.message); }
        }
        if (proposed) {
          await sendEstimateProposal(utente, proposed, { mode: alreadyProposed ? 'reminder' : 'push' });
        } else {
          var pushMsg = 'Ehi ' + utente.name.split(' ')[0] + ', manca il tuo daily! Il recap esce alle ' + DAILY_TIMES.recap + ' — ci vogliono 2 minuti.';
          await app.client.chat.postMessage({ channel: utente.id, text: pushMsg });
        }
        pushed++;
      } catch(e) {
        logger.error('[DAILY-V2] Errore push a', utente.id + ':', e.message);
      }
    }
    sd.inattesa = Array.from(standupInAttesa);
    await db.saveStandup(sd);
    logger.info('[DAILY-V2] Push #' + pushNumber + ' inviato a', pushed, 'utenti.');
  } finally {
    await releaseCronLock('daily_standup_v2_push_' + pushNumber);
  }
}

// ─── Classificazione daily testuali ──────────────────────────────────────────
// Euristiche condivise tra DM (slackHandlers app.message) e menzioni in
// #daily (app_mention): decidono se un testo È un daily da registrare o una
// richiesta al bot. Vivono qui per non avere due copie che divergono.

function classifyDailyText(txt) {
  txt = (txt || '').trim();
  var txtLow = txt.toLowerCase();
  var looksStructured = /^\s*\*?(ieri|oggi|domani|blocchi|cosa (hai fatto|farai))\*?\s*[:?]/im.test(txt);
  var keywordHits = (txtLow.match(/\b(ieri|oggi|domani|fatto|far[oò]|bloccat|blocco|blocchi|task|consegn|finito|iniziato|call|meeting|ore\b|min\b|h\b|\d+\s*h\b|\d+\s*min\b)/g) || []).length;
  var isDaily = looksStructured || keywordHits >= 2;
  var startsLikeRequest = /^(per favore|ciao giuno|ehi giuno|hey giuno|giuno[,:\s!]|assicurati|puoi |potresti |scusa|aiuto|non (hai|ho|funziona|va))/i.test(txt);
  var hasQuestionMark = /[?¿]/.test(txt);
  var isRequest = startsLikeRequest || (hasQuestionMark && !looksStructured);
  return { isDaily: isDaily, isRequest: isRequest, isStructured: looksStructured };
}

// Daily scritto a mano CON la richiesta esplicita di postarlo ("Giuno, posta
// questo daily: …", "ecco il mio daily, pubblicalo in #daily:", oppure il
// daily seguito da "postalo come daily"). classifyDailyText lo scarta come
// richiesta (inizia con "giuno,") e il modello non aveva modo di pubblicarlo.
// Ritorna il corpo del daily senza la frase di richiesta, o null.
var DAILY_REQUEST_VERB = /\b(post\w*|pubblic\w*|registr\w*|mand\w*|mett\w*|inser\w*|caric\w*|invi\w*)\b/i;
var DAILY_REQUEST_WORD = /\bdaily\b|\bstandup\b/i;
// "manda il daily a Marco" è una richiesta di test (trigger_daily_request), non un daily.
var DAILY_REQUEST_FOR_OTHERS = /\b(a|ad|per)\s+(<@[A-Z0-9]+>|[A-ZÀ-Ü][a-zà-ü]+)\b/;

function looksLikeDailyRequestLine(line) {
  line = (line || '').trim();
  if (!line || line.length > 140) return false;
  return DAILY_REQUEST_WORD.test(line) && DAILY_REQUEST_VERB.test(line) && !DAILY_REQUEST_FOR_OTHERS.test(line);
}

function extractDailyFromRequest(txt) {
  txt = String(txt || '').replace(/\r/g, '').trim();
  if (!txt) return null;
  var body = null;
  // Richiesta in testa: tutto fino al primo ":" o a capo, poi il daily.
  var head = txt.match(/^([^\n:]{1,140})[:\n]\s*([\s\S]+)$/);
  if (head && looksLikeDailyRequestLine(head[1])) body = head[2];
  // Richiesta in coda: ultima riga ("postalo come daily", "puoi pubblicarlo in #daily?").
  if (!body) {
    var tail = txt.match(/^([\s\S]+)\n([^\n]{1,140})$/);
    if (tail && looksLikeDailyRequestLine(tail[2])) body = tail[1];
  }
  if (!body) return null;
  body = body.trim();
  if (body.length < 10) return null;
  var cls = classifyDailyText(body);
  if (!cls.isDaily) return null;
  return body;
}

// La entry esistente di (utente, giorno) ha già task strutturati? Serve per il
// merge non distruttivo: un daily testuale che arriva DOPO il modale non deve
// degradare la entry a solo raw_text.
async function getExistingEntry(userId, dateStr) {
  try {
    var supabase = require('../services/db/client').getClient();
    if (!supabase) return null;
    var res = await supabase.from('standup_entries')
      .select('ieri_tasks, oggi_tasks, source')
      .eq('slack_user_id', userId).eq('date', dateStr).limit(1);
    return (res.data && res.data[0]) || null;
  } catch(e) { return null; }
}

function hasStructuredTasks(entry) {
  return !!(entry && ((entry.ieri_tasks && entry.ieri_tasks.length > 0) ||
    (entry.oggi_tasks && entry.oggi_tasks.length > 0)));
}

// ─── Consuntivo automatico (time_logs) ───────────────────────────────────────
// Il daily unico pomeridiano ha ore REALI sui task "oggi": quelle agganciate
// a un progetto dal matcher diventano time_logs (log_type='daily') — il
// vecchio check-in serale separato è stato ritirato. Replace semantics: un
// daily ricompilato sovrascrive il consuntivo del giorno.
async function syncTimeLogsFromDaily(userId, dateStr, structured, opts) {
  opts = opts || {};
  try {
    if (!structured || !Array.isArray(structured.oggi)) return;
    var workloadService = require('../services/workloadService');
    var rows = workloadService.deriveTimeLogRows(structured.oggi, userId, dateStr);
    if (opts.estimate) {
      // Ore STIMATE da Giuno: entrano nel consuntivo (scelta esplicita di
      // Antonio, 10/9/2026) ma restano riconoscibili: la compilazione vera
      // della persona le rimpiazza (replace semantics di replaceTimeLogs).
      rows.forEach(function(r) {
        r.notes = 'stima Giuno (daily non compilato)';
        r.validation = { status: 'estimate', confidence: opts.confidence || 'bassa', sources: opts.sources || [] };
      });
    }
    // An unresolved task is not evidence that an earlier project disappeared.
    // Only a fully matched snapshot (including an explicitly empty one) may delete.
    var unresolved = structured.oggi.some(function(t) {
      return t && !t.project_id && ((Number(t.hours) || 0) + (Number(t.minutes) || 0) / 60 > 0);
    });
    var res;
    if (unresolved) {
      var saved = await db.saveTimeLogs(rows);
      res = saved === null ? null : { saved: saved, removedProjectIds: [] };
      logger.warn('[DAILY-V2] Attribuzione incompleta: conservate le ore degli altri progetti');
    } else {
      res = await db.replaceTimeLogs(userId, dateStr, 'daily', rows, { estimate: !!opts.estimate });
    }
    if (res === null) {
      logger.warn('[DAILY-V2] Consuntivo time_logs non scritto per', userId, dateStr);
      return;
    }
    var touched = rows.map(function(r) { return r.project_id; })
      .concat((res && res.removedProjectIds) || []);
    for (var i = 0; i < touched.length; i++) {
      await db.syncAllocationHoursLogged(userId, touched[i], dateStr);
    }
    logger.info('[DAILY-V2] Consuntivo derivato dal daily:', rows.length, 'progetti per', userId, dateStr);
  } catch(e) {
    logger.warn('[DAILY-V2] syncTimeLogsFromDaily fallito:', e.message);
  }
}

// ─── Handle daily response from DM ──────────────────────────────────────────

async function handleDailyResponse(userId, text, structured, opts) {
  opts = opts || {};
  var viaModal = !!structured;

  // Daily testuale (DM): prima si salvava solo raw_text — zero ore, zero task,
  // e la persona risultava "scarica" nel calcolo carico. Ora il parser AI
  // estrae task e durate; se fallisce si degrada al comportamento precedente.
  if (!structured) {
    try {
      structured = await require('../services/dailyParser').parseDailyText(text);
    } catch(e) { logger.warn('[DAILY-V2] Parser AI fallito:', e.message); }
  }

  // Aggancio ai progetti veri (project_id/project_name dentro ogni task)
  if (structured) {
    try {
      await require('../services/projectMatcher').enrichStructured(structured, { userId: userId });
    } catch(e) { logger.warn('[DAILY-V2] Project match fallito:', e.message); }
  }

  var todayStr = oggi();
  var sd = db.getStandupCache();
  // Self-heal: if sd.oggi is stale (bot restart after the send cron, etc.),
  // bootstrap today in-place instead of silently dropping the submission.
  if (sd.oggi !== todayStr) {
    logger.warn('[DAILY-V2] sd.oggi stale (' + (sd.oggi || 'null') + '), self-heal a ' + todayStr);
    sd.oggi = todayStr;
    sd.risposte = {};
    sd.inattesa = [];
  }

  sd.risposte = sd.risposte || {};
  sd.risposte[userId] = { testo: text, timestamp: Date.now() };

  var standupInAttesa = getStandupInAttesa();
  standupInAttesa.delete(userId);
  sd.inattesa = Array.from(standupInAttesa);
  await db.saveStandup(sd);

  // Stima di Giuno confermata o corretta → coppia stimato/reale per la calibrazione
  await recordEstimateCorrection(userId, todayStr, structured, opts.source === 'estimate_confirmed');
  // La proposta è consumata: via anche dallo stato persistito, altrimenti un
  // riavvio la ricarica e il vecchio "Confermo così" sovrascrive il daily vero.
  if (getPendingEstimate(userId, todayStr)) { clearPendingEstimate(userId); await db.saveStandup(sd); }

  // Save permanently to standup_entries
  try {
    var dbClient = require('../services/db/client');
    var supabase = dbClient.getClient();
    if (supabase) {
      var entry = {
        slack_user_id: userId,
        date: todayStr,
        raw_text: text,
        source: opts.source || (viaModal ? 'modal' : 'dm'),
      };
      if (structured) {
        // Daily unico pomeridiano: oggi = FATTO (ore reali), domani = piano.
        entry.oggi_tasks = structured.oggi || [];
        entry.domani_tasks = structured.domani || [];
        entry.blocchi = structured.blocchi || null;
        entry.total_hours_oggi = structured.totalOggi || 0;
        entry.total_hours_domani = structured.totalDomani || 0;
      } else {
        var existingEntry = await getExistingEntry(userId, todayStr);
        if (hasStructuredTasks(existingEntry) && existingEntry.source !== 'estimate') {
          // Merge non distruttivo: esiste già una entry VERA con task strutturati
          // e questo testo non è parsabile — non degradarla a raw-only. Una
          // stima di Giuno invece si sovrascrive sempre.
          logger.info('[DAILY-V2] Entry strutturata già presente per', userId, todayStr, '— skip overwrite raw-only');
          return true;
        }
      }
      var saveRes = await supabase.from('standup_entries')
        .upsert(entry, { onConflict: 'slack_user_id,date' });
      if (saveRes && saveRes.error) {
        logger.warn('[DAILY-V2] Upsert standup_entries fallito:', saveRes.error.message);
      } else {
        clearPendingEstimate(userId);
        logger.info('[DAILY-V2] Entry salvata per', userId, todayStr,
          '(source:', entry.source + (structured && !viaModal ? '+ai-parse' : '') + ')');
        await syncTimeLogsFromDaily(userId, todayStr, structured);
      }
    }
  } catch(e) { logger.warn('[DAILY-V2] Save entry error:', e.message); }

  logger.info('[DAILY-V2] Risposta ricevuta da:', userId);

  // Post individual response to #daily channel immediately (replaces the old workflow bot)
  try {
    var { formatPerSlack } = require('../utils/slackFormat');
    var userInfo = null;
    try { userInfo = await app.client.users.info({ user: userId }); } catch(e) { /* ignore */ }
    var userName = userInfo && userInfo.user ? (userInfo.user.real_name || userInfo.user.name) : userId;

    var dailyMsg = '*Daily di <@' + userId + '>*' + (opts.source === 'estimate_confirmed' ? ' _(ricostruito da Giuno, confermato)_' : '') + '\n\n';
    if (structured && structured.oggi && structured.oggi.length > 0) {
      dailyMsg += '*Cosa hai fatto oggi?*\n';
      structured.oggi.forEach(function(t) {
        dailyMsg += t.task;
        if (t.hours || t.minutes) dailyMsg += ' ' + (t.hours ? t.hours + 'h' : '') + (t.minutes ? t.minutes + 'min' : '');
        dailyMsg += '\n';
      });
      dailyMsg += '\n';
    }
    if (structured && structured.domani && structured.domani.length > 0) {
      dailyMsg += '*Cosa farai domani?*\n';
      structured.domani.forEach(function(t) {
        dailyMsg += t.task;
        if (t.hours || t.minutes) dailyMsg += ' ' + (t.hours ? t.hours + 'h' : '') + (t.minutes ? t.minutes + 'min' : '');
        dailyMsg += '\n';
      });
      dailyMsg += '\n';
    }
    if (!structured) {
      // Text-based response — post as-is
      dailyMsg += text + '\n\n';
    }
    if (structured && structured.blocchi) {
      dailyMsg += '*Qualcosa ti blocca?*\n' + structured.blocchi + '\n';
    }

    try {
      await app.client.conversations.join({ channel: DAILY_CHANNEL_ID });
    } catch(e) { /* already joined */ }

    await app.client.chat.postMessage({
      channel: DAILY_CHANNEL_ID,
      text: formatPerSlack(dailyMsg.trim()),
      unfurl_links: false,
    });
  } catch(e) {
    logger.warn('[DAILY-V2] Errore post in #daily:', e.message);
  }

  return true;
}

// ─── Cattura daily scritti a mano nel canale #daily ────────────────────────
// Oltre a DM e modale, molti scrivono il daily direttamente in #daily: prima
// non venivano agganciati e risultavano "mancanti" pur avendo risposto. Lo
// user_id del messaggio è autorevole, quindi questo risolve anche le
// attribuzioni sbagliate. Non ripubblica nulla (il messaggio è già nel canale).
async function recordChannelDaily(userId, text, channelId) {
  if (!userId || channelId !== DAILY_CHANNEL_ID) return false;
  var clean = (text || '').trim();
  if (clean.length < 10) return false;

  var todayStr = oggi();
  var sd = db.getStandupCache();
  if (sd.oggi !== todayStr) { sd.oggi = todayStr; sd.risposte = {}; sd.inattesa = []; }
  sd.risposte = sd.risposte || {};
  sd.risposte[userId] = { testo: clean, timestamp: Date.now(), source: 'channel' };
  var standupInAttesa = getStandupInAttesa();
  standupInAttesa.delete(userId);
  sd.inattesa = Array.from(standupInAttesa);
  await db.saveStandup(sd);

  // Parser AI + aggancio progetti: il daily scritto in canale vale quanto
  // quello da modale (prima: solo raw_text, ore perse).
  var structured = null;
  try {
    structured = await require('../services/dailyParser').parseDailyText(clean);
    if (structured) await require('../services/projectMatcher').enrichStructured(structured, { userId: userId });
  } catch(e) { logger.warn('[DAILY-V2] Parse daily da canale fallito:', e.message); }
  await recordEstimateCorrection(userId, todayStr, structured, false);
  if (getPendingEstimate(userId, todayStr)) { clearPendingEstimate(userId); try { await db.saveStandup(sd); } catch(e) { logger.debug('[DAILY-V2] stima consumata non persistita:', e.message); } }

  try {
    var supabase = require('../services/db/client').getClient();
    if (supabase) {
      var entry = { slack_user_id: userId, date: todayStr, raw_text: clean, source: 'channel' };
      if (structured) {
        entry.oggi_tasks = structured.oggi || [];
        entry.domani_tasks = structured.domani || [];
        entry.blocchi = structured.blocchi || null;
        entry.total_hours_oggi = structured.totalOggi || 0;
        entry.total_hours_domani = structured.totalDomani || 0;
      } else {
        var existingCh = await getExistingEntry(userId, todayStr);
        if (hasStructuredTasks(existingCh) && existingCh.source !== 'estimate') {
          // Merge non distruttivo: non degradare una entry VERA già strutturata.
          logger.info('[DAILY-V2] Entry strutturata già presente per', userId, todayStr, '— skip overwrite da canale');
          return true;
        }
      }
      clearPendingEstimate(userId);
      var saveRes = await supabase.from('standup_entries')
        .upsert(entry, { onConflict: 'slack_user_id,date' });
      if (saveRes && saveRes.error) logger.warn('[DAILY-V2] Upsert daily da canale fallito:', saveRes.error.message);
      else {
        logger.info('[DAILY-V2] Daily da canale registrato per', userId, todayStr,
          structured ? '(con ' + ((structured.oggi || []).length + (structured.domani || []).length) + ' task strutturati)' : '(solo testo)');
        await syncTimeLogsFromDaily(userId, todayStr, structured);
      }
    }
  } catch(e) { logger.warn('[DAILY-V2] recordChannelDaily error:', e.message); }
  return true;
}

// ─── Recap — Publish unified summary in #daily ───────────────────────────────

async function publishDailySummary() {
  var locked = await acquireCronLock('daily_standup_v2_recap', 10);
  if (!locked) return;
  try {
    var todayStr = oggi();
    var sd = db.getStandupCache();
    if (sd.oggi !== todayStr) {
      logger.info('[DAILY-V2] Nessun dato standup per oggi, skip recap.');
      return;
    }

    var risposte = Object.assign({}, await respondedFromDb(todayStr), sd.risposte || {});

    // Get all team members (excluded users are out of the daily flow entirely)
    var utenti = await getUtenti();
    var enabledUsers = utenti.filter(function(u) {
      return getPrefs(u.id).standup_enabled && !isExcludedFromDaily(u);
    });
    var missingUsers = enabledUsers.filter(function(u) { return !risposte[u.id]; });

    // Chi ha una stima in sospeso la riceve come daily stimato (marcato);
    // resta comunque nell'appello dei mancanti. Senza stima in sospeso la si
    // ricostruisce QUI: il 17/9 quattro deploy avevano svuotato la memoria
    // e il recap ha detto "nessuna traccia" a persone con la giornata piena.
    var estimatedUsers = [];
    if (ESTIMATES_ENABLED) {
      for (var ei = 0; ei < missingUsers.length; ei++) {
        var est = getPendingEstimate(missingUsers[ei].id, todayStr);
        if (!est) {
          try { est = await buildEstimateFor(missingUsers[ei], todayStr); }
          catch(e) { logger.warn('[DAILY-V2] stima al recap fallita per', missingUsers[ei].id + ':', e.message); }
          if (est) logger.info('[DAILY-V2] stima ricostruita al recap per', missingUsers[ei].id);
        }
        if (!est) continue;
        try {
          if (await saveEstimateAsEntry(missingUsers[ei], todayStr, est)) estimatedUsers.push(missingUsers[ei]);
        } catch(e) { logger.warn('[DAILY-V2] salvataggio stima fallito per', missingUsers[ei].id + ':', e.message); }
        clearPendingEstimate(missingUsers[ei].id);
      }
    }
    _pendingEstimates = {};
    sd.stime = {};

    // Clear standup state (both in-memory Set and persisted list)
    getStandupInAttesa().clear();
    sd.inattesa = [];
    await db.saveStandup(sd);

    // If everyone responded, nothing to do — individual responses are already
    // in #daily (posted by handleDailyResponse) so no recap is needed.
    if (missingUsers.length === 0) {
      logger.info('[DAILY-V2] Tutti hanno risposto, nessun follow-up necessario.');
      return;
    }

    // Public tag in #daily
    var publicMsg = '*Mancano all\'appello per il daily di ' + todayStr + ':* ' +
      missingUsers.map(function(u) { return '<@' + u.id + '>'; }).join(', ');
    if (estimatedUsers.length > 0) {
      publicMsg += '\n_Per ' + estimatedUsers.map(function(u) { return '<@' + u.id + '>'; }).join(', ') +
        ' ho pubblicato una stima: correggetela compilando il daily quando potete._';
    }
    var noTrace = missingUsers.filter(function(u) { return estimatedUsers.indexOf(u) === -1; });
    if (ESTIMATES_ENABLED && noTrace.length > 0) {
      publicMsg += '\n_Per ' + noTrace.map(function(u) { return '<@' + u.id + '>'; }).join(', ') +
        ' non ho trovato tracce di giornata (calendario, Drive, canali, email): niente stima._';
      // Agli admin, in DM: perché ogni fonte era vuota, così si vede cosa manca
      // (Google non collegato, Giuno fuori dai canali, token assenti).
      try { await notifyMissingEstimates(noTrace, todayStr); } catch(e) { logger.debug('[DAILY-V2] diagnosi stime saltata:', e.message); }
    }

    try {
      try { await app.client.conversations.join({ channel: DAILY_CHANNEL_ID }); } catch(e) {
        logger.debug('[DAILY-V2] join canale ignorato:', e.message);
      }
      await app.client.chat.postMessage({
        channel: DAILY_CHANNEL_ID,
        text: formatPerSlack(publicMsg),
        unfurl_links: false,
        unfurl_media: false,
      });
      logger.info('[DAILY-V2] Push pubblico inviato per', missingUsers.length, 'mancanti.');
    } catch(e) {
      logger.error('[DAILY-V2] Errore push pubblico:', e.message);
      try {
        var channelsRes = await app.client.conversations.list({ limit: 200, types: 'public_channel,private_channel' });
        var target = (channelsRes.channels || []).find(function(c) { return c.name === 'daily' || c.id === DAILY_CHANNEL_ID; });
        if (target) {
          await app.client.chat.postMessage({
            channel: target.id,
            text: formatPerSlack(publicMsg),
            unfurl_links: false,
            unfurl_media: false,
          });
          logger.info('[DAILY-V2] Push pubblico inviato in #' + target.name + ' (fallback).');
        }
      } catch(e2) {
        logger.error('[DAILY-V2] Errore fallback push pubblico:', e2.message);
      }
    }

    // Private DM to each missing user
    var dmSent = 0;
    for (var pi = 0; pi < missingUsers.length; pi++) {
      var u = missingUsers[pi];
      var primo = (u.name || '').split(' ')[0] || 'ciao';
      try {
        await app.client.chat.postMessage({
          channel: u.id,
          text: 'Ehi ' + primo + ', non ho ancora ricevuto il tuo daily. Quando hai un momento mandamelo — anche solo 2 righe vanno bene.',
        });
        dmSent++;
      } catch(e) {
        logger.warn('[DAILY-V2] DM follow-up fallito per', u.id, ':', e.message);
      }
    }
    logger.info('[DAILY-V2] DM follow-up inviati:', dmSent, '/', missingUsers.length);
  } finally {
    await releaseCronLock('daily_standup_v2_recap');
  }
}

// ─── Schedule all daily cron jobs ────────────────────────────────────────────
// Daily unico pomeridiano: alle 16 la giornata è quasi chiusa, quindi le ore
// dichiarate sono REALI (consuntivo) e non stime — sostituisce sia il vecchio
// daily mattutino (ieri/oggi contati due volte) sia il check-in delle 17:30.

function scheduleDailyJobs(cron) {
  // Mon-Fri — la stima (o il modulo) a tutti
  cron.schedule(cronExprFor(DAILY_TIMES.send), function() {
    return sendDailyRequests();
  }, { timezone: 'Europe/Rome', name: 'daily_send', lockTtl: 15 });

  // Mon-Fri — promemoria a chi non ha risposto
  cron.schedule(cronExprFor(DAILY_TIMES.push), function() {
    return pushMissingResponders(1);
  }, { timezone: 'Europe/Rome', name: 'daily_push', lockTtl: 5 });

  // Mon-Fri — recap: stime pubblicate, appello dei mancanti
  cron.schedule(cronExprFor(DAILY_TIMES.recap), function() {
    return publishDailySummary();
  }, { timezone: 'Europe/Rome', name: 'daily_recap', lockTtl: 15 });

  logger.info('[DAILY-V2] Cron jobs schedulati: ' + DAILY_TIMES.send + ' send, ' + DAILY_TIMES.push + ' push, ' + DAILY_TIMES.recap + ' recap');
}

module.exports = {
  DAILY_CHANNEL_ID: DAILY_CHANNEL_ID,
  DAILY_TIMES: DAILY_TIMES,
  cronExprFor: cronExprFor,
  estimateProposalMessage: estimateProposalMessage,
  sendEstimateProposal: sendEstimateProposal,
  classifyEstimateReply: classifyEstimateReply,
  pendingProposalSection: pendingProposalSection,
  getExistingEntry: getExistingEntry,
  lastBotMessageIsProposal: lastBotMessageIsProposal,
  amendPendingEstimate: amendPendingEstimate,
  scheduleDailyJobs: scheduleDailyJobs,
  handleDailyResponse: handleDailyResponse,
  recordChannelDaily: recordChannelDaily,
  classifyDailyText: classifyDailyText,
  extractDailyFromRequest: extractDailyFromRequest,
  sendDailyRequests: sendDailyRequests,
  sendDailyRequestTo: sendDailyRequestTo,
  buildEstimateFor: buildEstimateFor,
  sendDailyRequestWithEstimate: sendDailyRequestWithEstimate,
  notifySendFailures: notifySendFailures,
  pushMissingResponders: pushMissingResponders,
  publishDailySummary: publishDailySummary,
  respondedFromDb: respondedFromDb,
  recordEstimateCorrection: recordEstimateCorrection,
  confirmEstimate: confirmEstimate,
  getPendingEstimate: getPendingEstimate,
  getPendingEstimateFresh: getPendingEstimateFresh,
  syncTimeLogsFromDaily: syncTimeLogsFromDaily,
  clearPendingEstimate: clearPendingEstimate,
  rememberPendingEstimate: rememberPendingEstimate,
  prefillFromEstimate: prefillFromEstimate,
  prefillForModal: prefillForModal,
  getTodayEntry: getTodayEntry,
  dailyTextModal: dailyTextModal,
  saveFreeTextDaily: saveFreeTextDaily,
  FREE_TEXT_BUTTON: FREE_TEXT_BUTTON,
  quickProjectButtons: quickProjectButtons,
  notifyMissingEstimates: notifyMissingEstimates,
  oggi: oggi,
};
