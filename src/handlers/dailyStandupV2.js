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

// ─── Exclusions ──────────────────────────────────────────────────────────────
// Persone che NON partecipano al daily (niente richiesta, niente push, niente
// "mancano all'appello"). Match case-insensitive su substring del real_name.
var DAILY_EXCLUDED_NAME_PATTERNS = ['antonio', 'gloria', 'corrado', 'cellulare', 'telefono'];

function isExcludedFromDaily(utente) {
  var n = (utente && utente.name ? utente.name : '').toLowerCase();
  if (!n) return false;
  return DAILY_EXCLUDED_NAME_PATTERNS.some(function(p) { return n.indexOf(p) !== -1; });
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

// ─── 09:00 — Send DM to all team members ────────────────────────────────────

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

    for (var i = 0; i < utenti.length; i++) {
      var utente = utenti[i];
      if (!getPrefs(utente.id).standup_enabled) continue;
      if (isExcludedFromDaily(utente)) continue;
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
    sd.inattesa = Array.from(standupInAttesa);
    await db.saveStandup(sd);
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
      if (isExcludedFromDaily(utente)) continue;
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
    sd.inattesa = Array.from(standupInAttesa);
    await db.saveStandup(sd);
    logger.info('[DAILY-V2] Push #' + pushNumber + ' inviato a', pushed, 'utenti.');
  } finally {
    await releaseCronLock('daily_standup_v2_push_' + pushNumber);
  }
}

// ─── Handle daily response from DM ──────────────────────────────────────────

async function handleDailyResponse(userId, text, structured) {
  var todayStr = oggi();
  var sd = db.getStandupCache();
  // Self-heal: if sd.oggi is stale (bot restart after 09:00 cron, etc.),
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
        source: structured ? 'modal' : 'dm',
      };
      if (structured) {
        entry.ieri_tasks = structured.ieri || [];
        entry.oggi_tasks = structured.oggi || [];
        entry.blocchi = structured.blocchi || null;
        entry.total_hours_ieri = structured.totalIeri || 0;
        entry.total_hours_oggi = structured.totalOggi || 0;
      }
      var saveRes = await supabase.from('standup_entries')
        .upsert(entry, { onConflict: 'slack_user_id,date' });
      if (saveRes && saveRes.error) {
        logger.warn('[DAILY-V2] Upsert standup_entries fallito:', saveRes.error.message);
      } else {
        logger.info('[DAILY-V2] Entry salvata per', userId, todayStr);
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

    var dailyMsg = '*Daily di <@' + userId + '>*\n\n';
    if (structured && structured.ieri && structured.ieri.length > 0) {
      dailyMsg += '*Cosa hai fatto ieri?*\n';
      structured.ieri.forEach(function(t) {
        dailyMsg += t.task;
        if (t.hours || t.minutes) dailyMsg += ' ' + (t.hours ? t.hours + 'h' : '') + (t.minutes ? t.minutes + 'min' : '');
        dailyMsg += '\n';
      });
      dailyMsg += '\n';
    }
    if (structured && structured.oggi && structured.oggi.length > 0) {
      dailyMsg += '*Cosa farai oggi?*\n';
      structured.oggi.forEach(function(t) {
        dailyMsg += t.task;
        if (t.hours || t.minutes) dailyMsg += ' ' + (t.hours ? t.hours + 'h' : '') + (t.minutes ? t.minutes + 'min' : '');
        dailyMsg += '\n';
      });
      dailyMsg += '\n';
    } else if (!structured) {
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

    // Get all team members (excluded users are out of the daily flow entirely)
    var utenti = await getUtenti();
    var enabledUsers = utenti.filter(function(u) {
      return getPrefs(u.id).standup_enabled && !isExcludedFromDaily(u);
    });
    var missingUsers = enabledUsers.filter(function(u) { return !risposte[u.id]; });

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
  oggi: oggi,
};
