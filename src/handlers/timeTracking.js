// ─── Daily Check-in (time tracking) ──────────────────────────────────────────
// Consuntivo giornaliero delle ore lavorate per progetto.
// Workflow: 17:30 DM con bottone → modale (progetto + ore + nota) →
// gate di validazione Giuno → time_logs (log_type='daily') → sync allocations.
// Chi non compila può farlo/correggerlo la mattina dopo entro le 09:30
// (reminder 09:05, solo ai mancanti). 2 giorni lavorativi consecutivi senza
// log → escalation nel canale ops (#ops-alerts).
//
// NB: flusso separato dal Daily Standup V2 (callback_id e DM distinti) —
// lo standup resta focalizzato su task e blocchi, qui si tracciano solo ore.
'use strict';

var logger = require('../utils/logger');
var { app, getUtenti } = require('../services/slackService');
var db = require('../../supabase');
var { acquireCronLock, releaseCronLock } = require('../../supabase');
var { withTimeout, withRetry } = require('../utils/retryPolicy');
var modals = require('./timeTrackingModals');
var validator = require('../agents/timeLogValidator');
var dates = require('../utils/trackingDates');

var OPS_ALERTS_CHANNEL_ID = process.env.OPS_ALERTS_CHANNEL_ID || null;

// Kill switch: TIME_TRACKING_ENABLED=false disattiva i cron (le action
// restano registrate, ma senza DM automatici nessuno apre le modali).
function trackingActive() {
  return String(process.env.TIME_TRACKING_ENABLED || 'true') !== 'false';
}

// ─── Partecipanti ────────────────────────────────────────────────────────────
// Fonte primaria: team_members (roster autorevole, già filtrato su active).
// Fallback: lista utenti Slack. Esclusioni condivise col daily standup in
// config/tracking (override via env TRACKING_EXCLUDED_NAMES).
var trackingConfig = require('../config/tracking');

function trackingEnabled(userId) {
  var p = db.getPrefsCache()[userId] || {};
  return p.tracking_enabled !== false;
}

async function getParticipants() {
  var roster = db.getTeamRoster();
  if (roster && roster.length > 0) {
    return roster
      .filter(function(m) {
        // Roster = tutti, ma le stesse esclusioni del daily valgono per il
        // check-in: leadership (Antonio/Gloria/Corrado) e numeri di servizio
        // restano nel roster ma non ricevono la richiesta di tracciamento ore.
        return !trackingConfig.isExcludedName(m.canonical_name);
      })
      .map(function(m) { return { id: m.slack_user_id, name: m.canonical_name || m.slack_user_id }; })
      .filter(function(u) { return trackingEnabled(u.id); });
  }
  var utenti = await getUtenti();
  return utenti.filter(function(u) {
    if (trackingConfig.isExcludedName(u.name)) return false;
    return trackingEnabled(u.id);
  }).map(function(u) { return { id: u.id, name: u.name }; });
}

// ─── Prefill dal daily del mattino ───────────────────────────────────────────
// Il ponte tra i due sistemi: i task "oggi" del daily (con project_id dal
// projectMatcher) diventano righe precompilate del check-in serale. L'utente
// conferma o corregge le ore reali in pochi secondi.

async function buildPrefillFromDaily(userId, logDate) {
  try {
    var supabase = db.getClient ? db.getClient() : null;
    if (!supabase) return null;
    var res = await supabase.from('standup_entries')
      .select('oggi_tasks')
      .eq('slack_user_id', userId).eq('date', logDate).limit(1);
    var tasks = (res.data && res.data[0] && res.data[0].oggi_tasks) || [];
    var byProject = {};
    tasks.forEach(function(t) {
      if (!t || !t.project_id) return;
      var h = (parseInt(t.hours, 10) || 0) + (parseInt(t.minutes, 10) || 0) / 60;
      byProject[t.project_id] = (byProject[t.project_id] || 0) + h;
    });
    var prefill = Object.keys(byProject)
      .map(function(pid) {
        // number_input ha min 0.5: stime più piccole si arrotondano al minimo
        var hours = Math.max(0.5, Math.round(byProject[pid] * 100) / 100);
        return { project_id: pid, hours: hours };
      })
      .sort(function(a, b) { return b.hours - a.hours; })
      .slice(0, modals.MAX_ROWS_CHECKIN);
    return prefill.length > 0 ? prefill : null;
  } catch(e) {
    logger.debug('[CHECKIN] prefill dal daily non disponibile:', e.message);
    return null;
  }
}

// ─── Apertura modale (pattern open_daily_modal: timeout+retry+fallback) ─────

async function openCheckinModal(triggerId, userId, logDate) {
  var ackStart = Date.now();
  try {
    var projects = await modals.getActiveProjectsCached();
    // Budget stretto: il trigger_id scade in ~3s, il prefill non deve bruciarlo.
    // Se il DB è lento si apre il modale vuoto come prima.
    var prefill = null;
    try {
      prefill = await withTimeout(function() {
        return buildPrefillFromDaily(userId, logDate);
      }, 800, 'checkin prefill');
    } catch(e) { logger.debug('[CHECKIN] prefill saltato:', e.message); }
    var rows = Math.max(2, (prefill || []).length);
    await withTimeout(function() {
      return withRetry(function() {
        return app.client.views.open({
          trigger_id: triggerId,
          view: modals.buildCheckinView(projects, { rows: rows, log_date: logDate, prefill: prefill }),
        });
      }, {
        retries: 1,
        baseDelayMs: 100,
        shouldRetry: function(err) {
          var code = err && ((err.data && err.data.error) || err.code || '');
          if (/expired_trigger_id|invalid_trigger_id|invalid_blocks/i.test(String(code))) return false;
          return true;
        },
      });
    }, 2500, 'views.open checkin modal');
  } catch(e) {
    var slackCode = e && ((e.data && e.data.error) || e.code || e.name || '');
    logger.error('[CHECKIN] views.open fallita', {
      code: String(slackCode), message: e && e.message,
      triggerIdPresent: !!triggerId, elapsedMs: Date.now() - ackStart,
    });
    try {
      await app.client.chat.postMessage({
        channel: userId,
        text: 'Non riesco ad aprire il modulo del check-in in questo momento. Riprova tra un attimo cliccando di nuovo il bottone.',
      });
    } catch(e2) { logger.debug('[CHECKIN] fallback DM error:', e2 && e2.message); }
  }
}

// ─── 17:30 lun-ven — Richiesta check-in ──────────────────────────────────────

async function sendCheckinRequests() {
  var locked = await acquireCronLock('daily_checkin_send', 10);
  if (!locked) return;
  try {
    var todayStr = dates.oggiRome();
    logger.info('[CHECKIN] Invio richieste check-in per', todayStr);
    var participants = await getParticipants();
    var inviati = 0;
    for (var i = 0; i < participants.length; i++) {
      var u = participants[i];
      try {
        var nome = (u.name || '').split(' ')[0] || 'ciao';
        await app.client.chat.postMessage({
          channel: u.id,
          text: 'Ciao ' + nome + '! È il momento del check-in giornaliero.',
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: 'Ciao *' + nome + '*! È il momento del check-in giornaliero: quante ore hai lavorato oggi, e su cosa?' } },
            { type: 'context', elements: [{ type: 'mrkdwn', text: 'Se non riesci ora, puoi compilarlo domattina entro le 09:30.' }] },
            { type: 'actions', elements: [{
              type: 'button', style: 'primary',
              text: { type: 'plain_text', text: '⏱ Traccia le ore di oggi', emoji: true },
              action_id: 'tt_open_modal', value: todayStr,
            }] },
          ],
        });
        inviati++;
      } catch(e) {
        logger.error('[CHECKIN] Errore invio a', u.id + ':', e.message);
      }
    }
    logger.info('[CHECKIN] Richieste inviate a', inviati, 'utenti.');
  } finally {
    await releaseCronLock('daily_checkin_send');
  }
}

// ─── 09:05 lun-ven — Reminder correzione (solo ai mancanti di ieri) ─────────

async function sendMorningCorrection() {
  var locked = await acquireCronLock('daily_checkin_correction', 5);
  if (!locked) return;
  try {
    var todayStr = dates.oggiRome();
    var prevDay = dates.previousWorkingDay(todayStr);
    var withLog = await db.getUsersWithDailyLog(prevDay);
    var hasLog = {};
    withLog.forEach(function(id) { hasLog[id] = true; });

    var participants = await getParticipants();
    var inviati = 0;
    for (var i = 0; i < participants.length; i++) {
      var u = participants[i];
      if (hasLog[u.id]) continue;
      try {
        await app.client.chat.postMessage({
          channel: u.id,
          text: 'Ehi, manca ancora il tuo inserimento dei tempi. Clicca qui per completarlo ora.',
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: 'Ehi, manca ancora il tuo inserimento dei tempi di *' + prevDay + '*. Puoi compilarlo o correggerlo *entro le 09:30*.' } },
            { type: 'actions', elements: [{
              type: 'button', style: 'primary',
              text: { type: 'plain_text', text: '⏱ Completa ora', emoji: true },
              action_id: 'tt_open_modal', value: prevDay,
            }] },
          ],
        });
        inviati++;
      } catch(e) {
        logger.error('[CHECKIN] Errore reminder a', u.id + ':', e.message);
      }
    }
    logger.info('[CHECKIN] Reminder correzione inviati a', inviati, 'utenti (per', prevDay + ').');
  } finally {
    await releaseCronLock('daily_checkin_correction');
  }
}

// ─── 09:30 lun-ven — Chiusura finestra + escalation 2 giorni ────────────────

async function closeCorrectionWindow() {
  var locked = await acquireCronLock('daily_checkin_close', 5);
  if (!locked) return;
  try {
    var todayStr = dates.oggiRome();
    var day1 = dates.previousWorkingDay(todayStr);          // ieri lavorativo
    var day2 = dates.previousWorkingDay(day1);              // il lavorativo prima
    var withLog1 = await db.getUsersWithDailyLog(day1);
    var withLog2 = await db.getUsersWithDailyLog(day2);
    var has1 = {}; withLog1.forEach(function(id) { has1[id] = true; });
    var has2 = {}; withLog2.forEach(function(id) { has2[id] = true; });

    var participants = await getParticipants();
    var missing2Days = participants.filter(function(u) { return !has1[u.id] && !has2[u.id]; });

    if (missing2Days.length === 0) {
      logger.info('[CHECKIN] Finestra chiusa, nessuna escalation necessaria.');
      return;
    }
    logger.warn('[CHECKIN] Escalation: ' + missing2Days.length + ' utenti senza log da 2 giorni (' + day2 + ', ' + day1 + ')');
    if (!OPS_ALERTS_CHANNEL_ID) {
      logger.warn('[CHECKIN] OPS_ALERTS_CHANNEL_ID non configurato, escalation solo nei log.');
      return;
    }
    var msg = '⚠️ *Time tracking — escalation:* nessun check-in da 2 giorni lavorativi (' + day2 + ' e ' + day1 + ') per: ' +
      missing2Days.map(function(u) { return '<@' + u.id + '>'; }).join(', ');
    try {
      try { await app.client.conversations.join({ channel: OPS_ALERTS_CHANNEL_ID }); } catch(e) { /* canale privato o già dentro */ }
      await app.client.chat.postMessage({ channel: OPS_ALERTS_CHANNEL_ID, text: msg, unfurl_links: false });
    } catch(e) {
      logger.error('[CHECKIN] Errore escalation ops:', e.message);
    }
  } finally {
    await releaseCronLock('daily_checkin_close');
  }
}

// ─── Anomalie post-persist (mai bloccanti) ───────────────────────────────────

async function notifyAnomalies(userId, anomalies, logDate) {
  if (!anomalies || anomalies.length === 0) return;
  var high = anomalies.filter(function(a) { return a.severity === 'high'; });
  try {
    var lines = anomalies.map(function(a) { return '• ' + a.reason; }).join('\n');
    await app.client.chat.postMessage({
      channel: userId,
      text: 'Ho registrato le tue ore, ma ho notato qualcosa di anomalo:\n' + lines +
        '\nSe è tutto corretto ignora pure questo messaggio, altrimenti puoi correggere domattina entro le 09:30.',
    });
  } catch(e) { logger.debug('[CHECKIN] DM anomalie fallito:', e.message); }
  if (high.length > 0 && OPS_ALERTS_CHANNEL_ID) {
    try {
      var opsLines = high.map(function(a) { return '• ' + a.reason; }).join('\n');
      await app.client.chat.postMessage({
        channel: OPS_ALERTS_CHANNEL_ID,
        text: '🔎 *Scostamento anomalo* nel check-in di <@' + userId + '> (' + logDate + '):\n' + opsLines,
        unfurl_links: false,
      });
    } catch(e) { logger.debug('[CHECKIN] ops alert anomalie fallito:', e.message); }
  }
}

// ─── Registrazione action/view handlers ──────────────────────────────────────

function register(appInstance) {
  var a = appInstance || app;

  a.action('tt_open_modal', async function(args) {
    await args.ack();
    var requested = args.actions && args.actions[0] ? args.actions[0].value : null;
    var logDate = /^\d{4}-\d{2}-\d{2}$/.test(String(requested || '')) ? requested : dates.oggiRome();
    await openCheckinModal(args.body.trigger_id, args.body.user.id, logDate);
  });

  a.action('tt_add_row', async function(args) {
    await args.ack();
    var meta = JSON.parse(args.body.view.private_metadata || '{}');
    meta.rows = Math.min((meta.rows || 2) + 1, modals.MAX_ROWS_CHECKIN);
    try {
      var projects = await modals.getActiveProjectsCached();
      await app.client.views.update({
        view_id: args.body.view.id,
        view: modals.buildCheckinView(projects, meta),
      });
    } catch(e) { logger.error('[CHECKIN] Errore aggiungi riga:', e.message); }
  });

  a.view('tt_submit', async function(args) {
    var userId = args.body.user.id;
    var meta = JSON.parse(args.view.private_metadata || '{}');
    var todayStr = dates.oggiRome();
    var logDate = meta.log_date || todayStr;

    // Finestra temporale server-side: oggi, oppure il giorno lavorativo
    // precedente ma solo entro le 09:30 (la data nel metadata non basta).
    var isToday = logDate === todayStr;
    var isCorrection = logDate === dates.previousWorkingDay(todayStr) && dates.oraRome() <= '09:30';
    if (!isToday && !isCorrection) {
      await args.ack({
        response_action: 'errors',
        errors: { tt_project_1: 'La finestra per il ' + logDate + ' è chiusa (correzioni entro le 09:30 del giorno dopo). Parla con un PM se devi sistemare le ore.' },
      });
      return;
    }

    var rows = modals.extractRows(args.view.state.values, 'tt');
    var note = modals.extractNote(args.view.state.values);
    var projects = await modals.getActiveProjectsCached();
    var projectsById = {};
    projects.forEach(function(p) { projectsById[p.id] = p; });

    // Contesto settimanale per gate AI e anomalie
    var weekStart = dates.weekStartOf(logDate);
    var planned = await db.getWeekPlanned(userId, weekStart);
    var actuals = await db.getWeekActuals(userId, weekStart);

    var result = await validator.validateSubmission(rows, {
      prefix: 'tt', logType: 'daily', projectsById: projectsById,
      context: { planned: planned, actuals: actuals, logDate: logDate },
    });
    if (!result.ok) {
      await args.ack({ response_action: 'errors', errors: result.errors });
      return;
    }
    await args.ack();

    var logRows = rows.map(function(r) {
      return {
        slack_user_id: userId, project_id: r.project_id,
        log_date: logDate, log_type: 'daily',
        hours: r.hours, notes: note, validation: result.validation,
      };
    });
    // Replace, non semplice upsert: una correzione che omette un progetto
    // loggato in precedenza deve rimuoverlo dai consuntivi.
    var replaceRes = await db.replaceTimeLogs(userId, logDate, 'daily', logRows);
    if (replaceRes === null && db.isSupabase()) {
      try {
        await app.client.chat.postMessage({
          channel: userId,
          text: 'Non sono riuscito a registrare le ore — riprova tra un attimo. Se il problema persiste avvisa Antonio.',
        });
      } catch(e) { /* ignore */ }
      logger.error('[CHECKIN] Save fallito per', userId, logDate);
      return;
    }

    // Aggiorna gli aggregati derivati, inclusi i progetti rimossi dalla
    // correzione (le loro hours_logged vanno ricalcolate a ribasso).
    var removedIds = (replaceRes && replaceRes.removedProjectIds) || [];
    var syncIds = rows.map(function(r) { return r.project_id; }).concat(removedIds);
    var syncedSeen = {};
    for (var si = 0; si < syncIds.length; si++) {
      if (syncedSeen[syncIds[si]]) continue;
      syncedSeen[syncIds[si]] = true;
      await db.syncAllocationHoursLogged(userId, syncIds[si], logDate);
    }

    var total = 0;
    rows.forEach(function(r) { total += r.hours; });
    var recap = isToday
      ? 'Oggi hai tracciato *' + total + ' ore* totali su *' + rows.length + ' progett' + (rows.length === 1 ? 'o' : 'i') + '*. Ottimo lavoro! ✅'
      : 'Registrate *' + total + ' ore* su *' + rows.length + ' progett' + (rows.length === 1 ? 'o' : 'i') + '* per il ' + logDate + '. ✅';
    try {
      await app.client.chat.postMessage({ channel: userId, text: recap });
    } catch(e) { logger.debug('[CHECKIN] recap DM fallito:', e.message); }
    logger.info('[CHECKIN] Log salvato:', userId, logDate, total + 'h su', rows.length, 'progetti');

    // Anomalie: unione gate AI + check deterministico (post-ack, mai bloccante).
    // Il consuntivo aggiornato include le righe appena salvate.
    var freshActuals = await db.getWeekActuals(userId, weekStart);
    var anomalies = (result.validation && result.validation.anomalies) || [];
    anomalies = anomalies.concat(validator.detectAnomalies({
      rows: rows, planned: planned, actuals: freshActuals, projectsById: projectsById,
    }));
    // dedup per (row, reason simile): teniamo la prima occorrenza per riga+severity
    var seenKey = {};
    anomalies = anomalies.filter(function(an) {
      var k = (an.row || '') + '|' + (an.severity || '');
      if (seenKey[k]) return false;
      seenKey[k] = true;
      return true;
    });
    await notifyAnomalies(userId, anomalies, logDate);
  });
}

// ─── Cron jobs ───────────────────────────────────────────────────────────────

function scheduleCheckinJobs(cron) {
  if (!trackingActive()) {
    logger.info('[CHECKIN] TIME_TRACKING_ENABLED=false, cron check-in non schedulati');
    return;
  }
  // 17:30 lun-ven — richiesta check-in
  cron.schedule('30 17 * * 1-5', function() {
    sendCheckinRequests().catch(function(e) { logger.error('[CHECKIN] Errore invio:', e.message); });
  }, { timezone: 'Europe/Rome' });

  // 09:05 lun-ven — reminder correzione ai soli mancanti
  cron.schedule('5 9 * * 1-5', function() {
    sendMorningCorrection().catch(function(e) { logger.error('[CHECKIN] Errore reminder:', e.message); });
  }, { timezone: 'Europe/Rome' });

  // 09:30 lun-ven — chiusura finestra + escalation 2 giorni
  cron.schedule('30 9 * * 1-5', function() {
    closeCorrectionWindow().catch(function(e) { logger.error('[CHECKIN] Errore chiusura:', e.message); });
  }, { timezone: 'Europe/Rome' });

  logger.info('[CHECKIN] Cron jobs schedulati: 17:30 send, 09:05 reminder, 09:30 close');
}

module.exports = {
  register: register,
  scheduleCheckinJobs: scheduleCheckinJobs,
  sendCheckinRequests: sendCheckinRequests,
  sendMorningCorrection: sendMorningCorrection,
  closeCorrectionWindow: closeCorrectionWindow,
  getParticipants: getParticipants,
  trackingActive: trackingActive,
};
