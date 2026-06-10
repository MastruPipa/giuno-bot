// ─── Weekly Planner ──────────────────────────────────────────────────────────
// Raccolta delle allocazioni previsionali per la settimana successiva.
// Workflow: giovedì 15:00 DM con bottone "Pianifica la tua prossima settimana"
// → modale (progetti + ore stimate) → gate di validazione Giuno →
// time_logs (log_type='weekly', log_date = lunedì prossimo) →
// resource_allocations.hours_allocated della settimana target.
// Reminder 17:15 (i 17:00 sono già affollati dal follow-up agent),
// chiusura finestra 18:00.
'use strict';

var logger = require('../utils/logger');
var { app } = require('../services/slackService');
var db = require('../../supabase');
var { acquireCronLock, releaseCronLock } = require('../../supabase');
var { withTimeout, withRetry } = require('../utils/retryPolicy');
var modals = require('./timeTrackingModals');
var validator = require('../agents/timeLogValidator');
var dates = require('../utils/trackingDates');
var timeTracking = require('./timeTracking');

var OPS_ALERTS_CHANNEL_ID = process.env.OPS_ALERTS_CHANNEL_ID || null;

// ─── Apertura modale ─────────────────────────────────────────────────────────

async function openPlannerModal(triggerId, userId) {
  var ackStart = Date.now();
  var weekStart = dates.nextMonday(dates.oggiRome());
  try {
    var projects = await modals.getActiveProjectsCached();
    await withTimeout(function() {
      return withRetry(function() {
        return app.client.views.open({
          trigger_id: triggerId,
          view: modals.buildPlannerView(projects, { rows: 2, week_start: weekStart }),
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
    }, 2500, 'views.open planner modal');
  } catch(e) {
    var slackCode = e && ((e.data && e.data.error) || e.code || e.name || '');
    logger.error('[PLANNER] views.open fallita', {
      code: String(slackCode), message: e && e.message,
      triggerIdPresent: !!triggerId, elapsedMs: Date.now() - ackStart,
    });
    try {
      await app.client.chat.postMessage({
        channel: userId,
        text: 'Non riesco ad aprire il modulo di pianificazione in questo momento. Riprova tra un attimo cliccando di nuovo il bottone.',
      });
    } catch(e2) { logger.debug('[PLANNER] fallback DM error:', e2 && e2.message); }
  }
}

// ─── Giovedì 15:00 — Richiesta pianificazione ────────────────────────────────

async function sendPlannerRequests() {
  var locked = await acquireCronLock('weekly_planner_send', 10);
  if (!locked) return;
  try {
    var weekStart = dates.nextMonday(dates.oggiRome());
    logger.info('[PLANNER] Invio richieste pianificazione per settimana', weekStart);
    var participants = await timeTracking.getParticipants();
    var inviati = 0;
    for (var i = 0; i < participants.length; i++) {
      var u = participants[i];
      try {
        var nome = (u.name || '').split(' ')[0] || 'ciao';
        await app.client.chat.postMessage({
          channel: u.id,
          text: 'Ciao ' + nome + ', pianifica la tua prossima settimana!',
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: 'Ciao *' + nome + '*! Su quali progetti lavorerai la settimana che inizia il *' + weekStart + '*, e per quante ore?' } },
            { type: 'context', elements: [{ type: 'mrkdwn', text: 'Hai tempo fino alle 18:00 di oggi.' }] },
            { type: 'actions', elements: [{
              type: 'button', style: 'primary',
              text: { type: 'plain_text', text: '🗓 Pianifica la tua prossima settimana', emoji: true },
              action_id: 'wp_open_modal',
            }] },
          ],
        });
        inviati++;
      } catch(e) {
        logger.error('[PLANNER] Errore invio a', u.id + ':', e.message);
      }
    }
    logger.info('[PLANNER] Richieste inviate a', inviati, 'utenti.');
  } finally {
    await releaseCronLock('weekly_planner_send');
  }
}

// Utenti che hanno già pianificato la settimana target
async function getPlannedUserSet(weekStart) {
  var participants = await timeTracking.getParticipants();
  var planned = {};
  for (var i = 0; i < participants.length; i++) {
    var u = participants[i];
    var weekPlanned = await db.getWeekPlanned(u.id, weekStart);
    if (Object.keys(weekPlanned).length > 0) planned[u.id] = true;
  }
  return { participants: participants, planned: planned };
}

// ─── Giovedì 17:15 — Reminder ai mancanti ────────────────────────────────────

async function sendPlannerReminder() {
  var locked = await acquireCronLock('weekly_planner_reminder', 5);
  if (!locked) return;
  try {
    var weekStart = dates.nextMonday(dates.oggiRome());
    var state = await getPlannedUserSet(weekStart);
    var inviati = 0;
    for (var i = 0; i < state.participants.length; i++) {
      var u = state.participants[i];
      if (state.planned[u.id]) continue;
      try {
        await app.client.chat.postMessage({
          channel: u.id,
          text: 'Ehi, manca ancora il tuo inserimento dei tempi. Clicca qui per completarlo ora.',
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: 'Ehi, manca ancora la tua *pianificazione della prossima settimana*. La finestra chiude alle *18:00*.' } },
            { type: 'actions', elements: [{
              type: 'button', style: 'primary',
              text: { type: 'plain_text', text: '🗓 Completa ora', emoji: true },
              action_id: 'wp_open_modal',
            }] },
          ],
        });
        inviati++;
      } catch(e) {
        logger.error('[PLANNER] Errore reminder a', u.id + ':', e.message);
      }
    }
    logger.info('[PLANNER] Reminder inviati a', inviati, 'utenti.');
  } finally {
    await releaseCronLock('weekly_planner_reminder');
  }
}

// ─── Giovedì 18:00 — Chiusura finestra ───────────────────────────────────────

async function closePlannerWindow() {
  var locked = await acquireCronLock('weekly_planner_close', 5);
  if (!locked) return;
  try {
    var weekStart = dates.nextMonday(dates.oggiRome());
    var state = await getPlannedUserSet(weekStart);
    var missing = state.participants.filter(function(u) { return !state.planned[u.id]; });
    logger.info('[PLANNER] Finestra chiusa per', weekStart + ':', (state.participants.length - missing.length) + '/' + state.participants.length, 'hanno pianificato.');
    if (missing.length === 0 || !OPS_ALERTS_CHANNEL_ID) return;
    try {
      try { await app.client.conversations.join({ channel: OPS_ALERTS_CHANNEL_ID }); } catch(e) { /* canale privato o già dentro */ }
      await app.client.chat.postMessage({
        channel: OPS_ALERTS_CHANNEL_ID,
        text: '🗓 *Weekly planning ' + weekStart + ' — mancano:* ' +
          missing.map(function(u) { return '<@' + u.id + '>'; }).join(', '),
        unfurl_links: false,
      });
    } catch(e) {
      logger.error('[PLANNER] Errore notifica ops:', e.message);
    }
  } finally {
    await releaseCronLock('weekly_planner_close');
  }
}

// ─── Registrazione action/view handlers ──────────────────────────────────────

function register(appInstance) {
  var a = appInstance || app;

  a.action('wp_open_modal', async function(args) {
    await args.ack();
    await openPlannerModal(args.body.trigger_id, args.body.user.id);
  });

  a.action('wp_add_row', async function(args) {
    await args.ack();
    var meta = JSON.parse(args.body.view.private_metadata || '{}');
    meta.rows = Math.min((meta.rows || 2) + 1, modals.MAX_ROWS_PLANNER);
    try {
      var projects = await modals.getActiveProjectsCached();
      await app.client.views.update({
        view_id: args.body.view.id,
        view: modals.buildPlannerView(projects, meta),
      });
    } catch(e) { logger.error('[PLANNER] Errore aggiungi riga:', e.message); }
  });

  a.view('wp_submit', async function(args) {
    var userId = args.body.user.id;
    var meta = JSON.parse(args.view.private_metadata || '{}');
    // La settimana target viene ricalcolata: se la modale è rimasta aperta
    // oltre la mezzanotte di domenica il metadata sarebbe stantio.
    var weekStart = meta.week_start || dates.nextMonday(dates.oggiRome());

    var rows = modals.extractRows(args.view.state.values, 'wp');
    var projects = await modals.getActiveProjectsCached();
    var projectsById = {};
    projects.forEach(function(p) { projectsById[p.id] = p; });

    var result = await validator.validateSubmission(rows, {
      prefix: 'wp', logType: 'weekly', projectsById: projectsById,
      context: { logDate: weekStart },
    });
    if (!result.ok) {
      await args.ack({ response_action: 'errors', errors: result.errors });
      return;
    }
    await args.ack();

    var logRows = rows.map(function(r) {
      return {
        slack_user_id: userId, project_id: r.project_id,
        log_date: weekStart, log_type: 'weekly',
        hours: r.hours, notes: null, validation: result.validation,
      };
    });
    var saved = await db.saveTimeLogs(logRows);
    if (saved === null && db.isSupabase()) {
      try {
        await app.client.chat.postMessage({
          channel: userId,
          text: 'Non sono riuscito a registrare la pianificazione — riprova tra un attimo. Se il problema persiste avvisa Antonio.',
        });
      } catch(e) { /* ignore */ }
      logger.error('[PLANNER] Save fallito per', userId, weekStart);
      return;
    }

    // hours_allocated della settimana target
    for (var ai = 0; ai < rows.length; ai++) {
      await db.upsertWeeklyAllocation(userId, rows[ai].project_id, weekStart, rows[ai].hours);
    }

    var total = 0;
    rows.forEach(function(r) { total += r.hours; });
    var recapLines = rows.map(function(r) {
      var p = projectsById[r.project_id];
      return '• ' + (p ? p.name : r.project_id) + ': ' + r.hours + 'h';
    }).join('\n');
    try {
      await app.client.chat.postMessage({
        channel: userId,
        text: 'Settimana del *' + weekStart + '* pianificata: *' + total + 'h* totali ✅\n' + recapLines,
      });
    } catch(e) { logger.debug('[PLANNER] recap DM fallito:', e.message); }
    logger.info('[PLANNER] Pianificazione salvata:', userId, weekStart, total + 'h su', rows.length, 'progetti');
  });
}

// ─── Cron jobs ───────────────────────────────────────────────────────────────

function schedulePlannerJobs(cron) {
  if (!timeTracking.trackingActive()) {
    logger.info('[PLANNER] TIME_TRACKING_ENABLED=false, cron planner non schedulati');
    return;
  }
  // Giovedì 15:00 — richiesta pianificazione
  cron.schedule('0 15 * * 4', function() {
    sendPlannerRequests().catch(function(e) { logger.error('[PLANNER] Errore invio:', e.message); });
  }, { timezone: 'Europe/Rome' });

  // Giovedì 17:15 — reminder (non 17:00: già occupato da follow-up agent)
  cron.schedule('15 17 * * 4', function() {
    sendPlannerReminder().catch(function(e) { logger.error('[PLANNER] Errore reminder:', e.message); });
  }, { timezone: 'Europe/Rome' });

  // Giovedì 18:00 — chiusura finestra
  cron.schedule('0 18 * * 4', function() {
    closePlannerWindow().catch(function(e) { logger.error('[PLANNER] Errore chiusura:', e.message); });
  }, { timezone: 'Europe/Rome' });

  logger.info('[PLANNER] Cron jobs schedulati: gio 15:00 send, 17:15 reminder, 18:00 close');
}

module.exports = {
  register: register,
  schedulePlannerJobs: schedulePlannerJobs,
  sendPlannerRequests: sendPlannerRequests,
  sendPlannerReminder: sendPlannerReminder,
  closePlannerWindow: closePlannerWindow,
};
