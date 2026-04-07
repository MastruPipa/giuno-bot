// ─── Daily Standup V2 ────────────────────────────────────────────────────────
// Complete workflow: 09:00 DM → 10:30 push → 11:00 push → 11:30 recap
// Fixes #13 (daily va aggiustato) and #14 (riepilogo unico, non singoli messaggi)
'use strict';

var logger = require('../utils/logger');
var { formatPerSlack } = require('../utils/slackFormat');
var { app, getUtenti } = require('../services/slackService');
var db = require('../../supabase');
var { acquireCronLock, releaseCronLock } = require('../../supabase');

var DAILY_CHANNEL_ID = process.env.DAILY_CHANNEL_ID || 'C05846AEV6D';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPrefs(userId) {
  return Object.assign({ standup_enabled: true }, db.getPrefsCache()[userId] || {});
}

function getStandupInAttesa() {
  return require('./slackHandlers').standupInAttesa;
}

function oggi() {
  return new Date().toISOString().slice(0, 10);
}

// ─── 09:00 — Send DM to all team members ────────────────────────────────────

async function sendDailyRequests() {
  var locked = await acquireCronLock('daily_standup_v2_send', 10);
  if (!locked) return;
  try {
    var todayStr = oggi();
    logger.info('[DAILY-V2] Invio richieste daily per', todayStr);

    var sd = db.getStandupCache();
    sd.oggi = todayStr;
    sd.risposte = sd.risposte || {};
    // Clear old responses if from a different day
    if (sd.lastDay !== todayStr) {
      sd.risposte = {};
      sd.lastDay = todayStr;
    }
    db.saveStandup(sd);

    var utenti = await getUtenti();
    var inviati = 0;
    var standupInAttesa = getStandupInAttesa();

    for (var i = 0; i < utenti.length; i++) {
      var utente = utenti[i];
      if (!getPrefs(utente.id).standup_enabled) continue;
      try {
        standupInAttesa.add(utente.id);
        var nome = utente.name.split(' ')[0];
        await app.client.chat.postMessage({
          channel: utente.id,
          text: 'Ciao ' + nome + ', è il momento del daily!',
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: 'Ciao *' + nome + '*, è il momento del daily!' },
            },
            {
              type: 'context',
              elements: [{ type: 'mrkdwn', text: 'Compila il form o rispondi con un messaggio. Il recap esce alle 11:30.' }],
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
        inviati++;
      } catch(e) {
        logger.error('[DAILY-V2] Errore invio a', utente.id + ':', e.message);
      }
    }
    logger.info('[DAILY-V2] Richieste inviate a', inviati, 'utenti.');
  } finally {
    await releaseCronLock('daily_standup_v2_send');
  }
}

// ─── 10:30 / 11:00 — Push to missing responders ─────────────────────────────

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
      if (sd.risposte && sd.risposte[utente.id]) continue; // Already responded

      try {
        standupInAttesa.add(utente.id);
        var pushMsg = pushNumber === 1
          ? 'Ehi ' + utente.name.split(' ')[0] + ', manca il tuo daily! Il riepilogo esce alle 11:30.'
          : utente.name.split(' ')[0] + ', ultimo reminder — il daily chiude tra 30 minuti!';
        await app.client.chat.postMessage({ channel: utente.id, text: pushMsg });
        pushed++;
      } catch(e) {
        logger.error('[DAILY-V2] Errore push a', utente.id + ':', e.message);
      }
    }
    logger.info('[DAILY-V2] Push #' + pushNumber + ' inviato a', pushed, 'utenti.');
  } finally {
    await releaseCronLock('daily_standup_v2_push_' + pushNumber);
  }
}

// ─── Handle daily response from DM ──────────────────────────────────────────

async function handleDailyResponse(userId, text, structured) {
  var todayStr = oggi();
  var sd = db.getStandupCache();
  if (sd.oggi !== todayStr) return false;

  sd.risposte = sd.risposte || {};
  sd.risposte[userId] = { testo: text, timestamp: Date.now() };
  db.saveStandup(sd);

  var standupInAttesa = getStandupInAttesa();
  standupInAttesa.delete(userId);

  // Save permanently to standup_entries
  try {
    var dbClient = require('../services/db/client');
    var supabase = dbClient.getClient();
    if (supabase) {
      var entry = {
        slack_user_id: userId,
        date: todayStr,
        raw_text: text,
        source: structured ? 'modal' : 'dm',
      };
      if (structured) {
        entry.ieri_tasks = structured.ieri || [];
        entry.oggi_tasks = structured.oggi || [];
        entry.blocchi = structured.blocchi || null;
        entry.total_hours_ieri = structured.totalIeri || 0;
        entry.total_hours_oggi = structured.totalOggi || 0;
      }
      await supabase.from('standup_entries').upsert(entry, { onConflict: 'slack_user_id,date' }).catch(function() {
        // If upsert fails (no unique constraint), just insert
        supabase.from('standup_entries').insert(entry).catch(function() {});
      });
    }
  } catch(e) { logger.debug('[DAILY-V2] Save entry error:', e.message); }

  logger.info('[DAILY-V2] Risposta ricevuta da:', userId);
  return true;
}

// ─── 11:30 — Publish unified summary in #daily ──────────────────────────────

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
    var respondedIds = Object.keys(risposte);

    // Get all team members to find who's missing
    var utenti = await getUtenti();
    var enabledUsers = utenti.filter(function(u) { return getPrefs(u.id).standup_enabled; });
    var missingUsers = enabledUsers.filter(function(u) { return !risposte[u.id]; });

    // Clear standup state
    getStandupInAttesa().clear();

    // Build unified message
    var msg = '*Daily Standup — ' + todayStr + '*\n\n';

    if (respondedIds.length > 0) {
      for (var i = 0; i < respondedIds.length; i++) {
        var uid = respondedIds[i];
        var r = risposte[uid];
        msg += '<@' + uid + '>:\n' + (r.testo || '_nessun dettaglio_') + '\n\n';
      }
    } else {
      msg += '_Nessuna risposta ricevuta oggi._\n\n';
    }

    // Tag missing users
    if (missingUsers.length > 0) {
      msg += '*Mancano all\'appello:* ' + missingUsers.map(function(u) {
        return '<@' + u.id + '>';
      }).join(', ') + '\n';
    }

    // Post to #daily channel
    try {
      // Try joining the channel first (in case bot was removed)
      try { await app.client.conversations.join({ channel: DAILY_CHANNEL_ID }); } catch(e) {
        logger.debug('[DAILY-V2] join canale ignorato:', e.message);
      }

      await app.client.chat.postMessage({
        channel: DAILY_CHANNEL_ID,
        text: formatPerSlack(msg),
        unfurl_links: false,
        unfurl_media: false,
      });
      logger.info('[DAILY-V2] Recap pubblicato in #daily con', respondedIds.length, 'risposte,', missingUsers.length, 'mancanti.');
    } catch(e) {
      logger.error('[DAILY-V2] Errore pubblicazione in #daily:', e.message);
      // Fallback: try finding channel by name
      try {
        var channelsRes = await app.client.conversations.list({ limit: 200, types: 'public_channel,private_channel' });
        var target = (channelsRes.channels || []).find(function(c) { return c.name === 'daily' || c.id === DAILY_CHANNEL_ID; });
        if (target) {
          await app.client.chat.postMessage({
            channel: target.id,
            text: formatPerSlack(msg),
            unfurl_links: false,
            unfurl_media: false,
          });
          logger.info('[DAILY-V2] Recap pubblicato in #' + target.name + ' (fallback).');
        }
      } catch(e2) {
        logger.error('[DAILY-V2] Errore fallback recap:', e2.message);
      }
    }
  } finally {
    await releaseCronLock('daily_standup_v2_recap');
  }
}

// ─── Schedule all daily cron jobs ────────────────────────────────────────────

function scheduleDailyJobs(cron) {
  // 09:00 Mon-Fri — Send daily requests
  cron.schedule('0 9 * * 1-5', function() {
    sendDailyRequests().catch(function(e) { logger.error('[DAILY-V2] Errore invio:', e.message); });
  }, { timezone: 'Europe/Rome' });

  // 10:30 Mon-Fri — First push
  cron.schedule('30 10 * * 1-5', function() {
    pushMissingResponders(1).catch(function(e) { logger.error('[DAILY-V2] Errore push 1:', e.message); });
  }, { timezone: 'Europe/Rome' });

  // 11:00 Mon-Fri — Second push
  cron.schedule('0 11 * * 1-5', function() {
    pushMissingResponders(2).catch(function(e) { logger.error('[DAILY-V2] Errore push 2:', e.message); });
  }, { timezone: 'Europe/Rome' });

  // 11:30 Mon-Fri — Publish unified summary
  cron.schedule('30 11 * * 1-5', function() {
    publishDailySummary().catch(function(e) { logger.error('[DAILY-V2] Errore recap:', e.message); });
  }, { timezone: 'Europe/Rome' });

  logger.info('[DAILY-V2] Cron jobs schedulati: 09:00 send, 10:30 push1, 11:00 push2, 11:30 recap');
}

module.exports = {
  scheduleDailyJobs: scheduleDailyJobs,
  handleDailyResponse: handleDailyResponse,
  sendDailyRequests: sendDailyRequests,
  pushMissingResponders: pushMissingResponders,
  publishDailySummary: publishDailySummary,
};
