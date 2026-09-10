// ─── Daily Standup V2 — daily unico pomeridiano ─────────────────────────────
// Workflow: 16:00 DM → 17:30 push → 18:00 recap. Struttura: FATTO OGGI (ore
// reali → alimentano anche time_logs via project match) + DOMANI (piano) +
// BLOCCHI. Sostituisce il vecchio daily mattutino e il check-in serale.
'use strict';

var logger = require('../utils/logger');
var { formatPerSlack } = require('../utils/slackFormat');
var { app, getUtenti } = require('../services/slackService');
var db = require('../../supabase');
var { acquireCronLock, releaseCronLock } = require('../../supabase');

var DAILY_CHANNEL_ID = process.env.DAILY_CHANNEL_ID || 'C05846AEV6D';

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

// ─── 16:00 — Send DM to all team members ────────────────────────────────────

// Invio singolo del DM col bottone "Compila daily": usato dal cron delle 16:00
// e dal tool admin trigger_daily_request (test on-demand). Aggiunge l'utente
// a standupInAttesa così anche una risposta testuale in DM viene riconosciuta.
// persistInAttesa=true (invii fuori cron) salva subito lo stato: il cron lo
// fa già in blocco a fine loop.
async function sendDailyRequestTo(utente, persistInAttesa) {
  var standupInAttesa = getStandupInAttesa();
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
  await app.client.chat.postMessage({
    channel: utente.id,
    text: 'Ciao ' + nome + ', è il momento del daily!',
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: 'Ciao *' + nome + '*, com\'è andata oggi? Registra cosa hai fatto (con le ore), il piano di domani e gli eventuali blocchi.' },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'Compila il form o rispondi con un messaggio. Le ore contano come consuntivo. Il recap esce alle 18:00.' }],
      },
      {
        type: 'actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: '✏️ Compila daily', emoji: true },
          style: 'primary',
          action_id: 'open_daily_modal',
        }],
      },
    ],
  });
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
      }
    }
    logger.info('[DAILY-V2] Daily precompilati:', precompilati, 'su', inviati);
    sd.inattesa = Array.from(standupInAttesa);
    await db.saveStandup(sd);
    logger.info('[DAILY-V2] Richieste inviate a', inviati, 'utenti.');
  } finally {
    await releaseCronLock('daily_standup_v2_send');
  }
}

// ─── 17:30 — Push to missing responders ──────────────────────────────────────

// ─── Daily stimato ───────────────────────────────────────────────────────────
// Proposte generate alle 17:30 per chi non ha compilato: userId → structured.
// In memoria (una giornata): se il processo riparte, chi non ha confermato
// riceve semplicemente il daily stimato alle 18:00 come tutti gli altri.
var _pendingEstimates = {}; // userId -> { date, structured }
var ESTIMATES_ENABLED = String(process.env.DAILY_ESTIMATES_ENABLED || 'true') !== 'false';
// Alle 16:00 il daily arriva già compilato (stima) invece del modulo vuoto.
var PREFILL_ENABLED = String(process.env.DAILY_PREFILL_ENABLED || 'true') !== 'false';

function getPendingEstimate(userId, dateStr) {
  var p = _pendingEstimates[userId];
  return p && p.date === dateStr ? p.structured : null;
}
function clearPendingEstimate(userId) { delete _pendingEstimates[userId]; }

async function buildEstimateFor(utente, dateStr) {
  var estimator = require('../agents/dailyEstimator');
  var structured = await estimator.estimateDaily(utente.id, dateStr);
  if (!structured || !structured.oggi || structured.oggi.length === 0) return null;
  _pendingEstimates[utente.id] = { date: dateStr, structured: structured };
  return structured;
}

// DM con la proposta: la persona conferma con un bottone o compila da sé.
async function sendEstimateProposal(utente, structured, opts) {
  opts = opts || {};
  var estimator = require('../agents/dailyEstimator');
  var nome = (utente.name || '').split(' ')[0] || 'ciao';
  var body = estimator.formatEstimateBody(structured);
  var intro = opts.mode === 'daily'
    ? 'Ciao *' + nome + '*, è il momento del daily. Te l\'ho già compilato da calendario, Slack e mail: confermi così o lo correggi?'
    : opts.mode === 'reminder'
      ? 'Ehi *' + nome + '*, manca solo la conferma del daily di oggi. Se torna, un tap e siamo a posto:'
      : 'Ehi *' + nome + '*, manca il tuo daily. Da quello che vedo della tua giornata l\'ho ricostruito così:';
  await app.client.chat.postMessage({
    channel: utente.id,
    text: (opts.mode === 'daily' ? 'È il momento del daily: te l\'ho compilato io, confermi?' : 'Manca il tuo daily: ho provato a ricostruirlo io.') + '\n' + body,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: intro } },
      { type: 'section', text: { type: 'mrkdwn', text: formatPerSlack(body) } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: estimator.formatSourcesLine(structured) + '\nSe alle 18:00 non ho tue notizie lo pubblico come *stima* in #daily e le ore entrano nel consuntivo come stimate; puoi correggerlo anche dopo, compilando il daily.' }] },
      { type: 'actions', elements: [
        { type: 'button', text: { type: 'plain_text', text: '✅ Confermo così', emoji: true }, style: 'primary', action_id: 'daily_estimate_confirm', value: structured.estimate ? structured.estimate.generated_at : 'x' },
        { type: 'button', text: { type: 'plain_text', text: '✏️ Correggo io', emoji: true }, action_id: 'open_daily_modal' },
      ] },
    ],
  });
}

// Righe per il modale dalla stima: {oggi:[{task,hours}], domani:[...], blocchi}
// dove hours è decimale (1.5) da abbinare alle opzioni di durata.
function prefillFromEstimate(structured) {
  if (!structured) return null;
  function rows(list) {
    return (list || []).slice(0, 10).map(function(t) {
      var h = (Number(t.hours) || 0) + (Number(t.minutes) || 0) / 60;
      return { task: String(t.task || '').substring(0, 150) + (t.project ? ' [' + t.project + ']' : ''), hours: Math.round(h * 4) / 4 };
    }).filter(function(r) { return r.task; });
  }
  var out = { oggi: rows(structured.oggi), domani: rows(structured.domani), blocchi: structured.blocchi || null };
  return (out.oggi.length || out.domani.length) ? out : null;
}

// Conferma dal bottone: la stima diventa il daily della persona a tutti gli
// effetti (source estimate_confirmed → alimenta anche il consuntivo).
async function confirmEstimate(userId) {
  var todayStr = oggi();
  var structured = getPendingEstimate(userId, todayStr);
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

    for (var i = 0; i < utenti.length; i++) {
      var utente = utenti[i];
      if (!getPrefs(utente.id).standup_enabled) continue;
      if (isExcludedFromDaily(utente)) continue;
      if (sd.risposte && sd.risposte[utente.id]) continue; // Already responded

      try {
        standupInAttesa.add(utente.id);
        var proposed = null;
        var alreadyProposed = getPendingEstimate(utente.id, todayStr);
        if (alreadyProposed) {
          // Proposta già mandata alle 16:00: solo un promemoria con i bottoni.
          proposed = alreadyProposed;
        } else if (ESTIMATES_ENABLED && pushNumber === 1) {
          try { proposed = await buildEstimateFor(utente, todayStr); }
          catch(e) { logger.warn('[DAILY-V2] stima daily fallita per', utente.id + ':', e.message); }
        }
        if (proposed) {
          await sendEstimateProposal(utente, proposed, { mode: alreadyProposed ? 'reminder' : 'push' });
        } else {
          var pushMsg = 'Ehi ' + utente.name.split(' ')[0] + ', manca il tuo daily! Il recap esce alle 18:00 — ci vogliono 2 minuti.';
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
  return { isDaily: isDaily, isRequest: isRequest };
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
// Il daily unico delle 16:00 ha ore REALI sui task "oggi": quelle agganciate
// a un progetto dal matcher diventano time_logs (log_type='daily') — il
// vecchio check-in serale separato è stato ritirato. Replace semantics: un
// daily ricompilato sovrascrive il consuntivo del giorno.
async function syncTimeLogsFromDaily(userId, dateStr, structured, opts) {
  opts = opts || {};
  try {
    if (!structured || !structured.oggi || structured.oggi.length === 0) return;
    var workloadService = require('../services/workloadService');
    var rows = workloadService.deriveTimeLogRows(structured.oggi, userId, dateStr);
    if (rows.length === 0) return;
    if (opts.estimate) {
      // Ore STIMATE da Giuno: entrano nel consuntivo (scelta esplicita di
      // Antonio, 10/9/2026) ma restano riconoscibili: la compilazione vera
      // della persona le rimpiazza (replace semantics di replaceTimeLogs).
      rows.forEach(function(r) {
        r.notes = 'stima Giuno (daily non compilato)';
        r.validation = { status: 'estimate', confidence: opts.confidence || 'bassa', sources: opts.sources || [] };
      });
    }
    var res = await db.replaceTimeLogs(userId, dateStr, 'daily', rows);
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
      await require('../services/projectMatcher').enrichStructured(structured);
    } catch(e) { logger.warn('[DAILY-V2] Project match fallito:', e.message); }
  }

  var todayStr = oggi();
  var sd = db.getStandupCache();
  // Self-heal: if sd.oggi is stale (bot restart after 16:00 cron, etc.),
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
        // Daily unico delle 16:00: oggi = FATTO (ore reali), domani = piano.
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
    if (structured) await require('../services/projectMatcher').enrichStructured(structured);
  } catch(e) { logger.warn('[DAILY-V2] Parse daily da canale fallito:', e.message); }

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

// ─── 18:00 — Publish unified summary in #daily ──────────────────────────────

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

    var risposte = sd.risposte || {};

    // Get all team members (excluded users are out of the daily flow entirely)
    var utenti = await getUtenti();
    var enabledUsers = utenti.filter(function(u) {
      return getPrefs(u.id).standup_enabled && !isExcludedFromDaily(u);
    });
    var missingUsers = enabledUsers.filter(function(u) { return !risposte[u.id]; });

    // Chi ha una stima in sospeso la riceve come daily stimato (marcato,
    // senza consuntivo); resta comunque nell'appello dei mancanti.
    var estimatedUsers = [];
    if (ESTIMATES_ENABLED) {
      for (var ei = 0; ei < missingUsers.length; ei++) {
        var est = getPendingEstimate(missingUsers[ei].id, todayStr);
        if (!est) continue;
        try {
          if (await saveEstimateAsEntry(missingUsers[ei], todayStr, est)) estimatedUsers.push(missingUsers[ei]);
        } catch(e) { logger.warn('[DAILY-V2] salvataggio stima fallito per', missingUsers[ei].id + ':', e.message); }
        clearPendingEstimate(missingUsers[ei].id);
      }
    }
    _pendingEstimates = {};

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
  // 16:00 Mon-Fri — Send daily requests
  cron.schedule('0 16 * * 1-5', function() {
    sendDailyRequests().catch(function(e) { logger.error('[DAILY-V2] Errore invio:', e.message); });
  }, { timezone: 'Europe/Rome', name: 'daily_send', lockTtl: 15 });

  // 17:30 Mon-Fri — Push to missing responders
  cron.schedule('30 17 * * 1-5', function() {
    pushMissingResponders(1).catch(function(e) { logger.error('[DAILY-V2] Errore push:', e.message); });
  }, { timezone: 'Europe/Rome', name: 'daily_push', lockTtl: 15 });

  // 18:00 Mon-Fri — Publish unified summary
  cron.schedule('0 18 * * 1-5', function() {
    publishDailySummary().catch(function(e) { logger.error('[DAILY-V2] Errore recap:', e.message); });
  }, { timezone: 'Europe/Rome', name: 'daily_recap', lockTtl: 15 });

  logger.info('[DAILY-V2] Cron jobs schedulati: 16:00 send, 17:30 push, 18:00 recap');
}

module.exports = {
  DAILY_CHANNEL_ID: DAILY_CHANNEL_ID,
  scheduleDailyJobs: scheduleDailyJobs,
  handleDailyResponse: handleDailyResponse,
  recordChannelDaily: recordChannelDaily,
  classifyDailyText: classifyDailyText,
  sendDailyRequests: sendDailyRequests,
  sendDailyRequestTo: sendDailyRequestTo,
  pushMissingResponders: pushMissingResponders,
  publishDailySummary: publishDailySummary,
  confirmEstimate: confirmEstimate,
  getPendingEstimate: getPendingEstimate,
  prefillFromEstimate: prefillFromEstimate,
  oggi: oggi,
};
