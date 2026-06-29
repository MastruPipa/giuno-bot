// ─── Slack Service ─────────────────────────────────────────────────────────────
// Slack App initialisation, user helpers, message reading, mention resolution.

'use strict';

var BoltApp = require('@slack/bolt').App;
var logger = require('../utils/logger');
var runtimeConfig = require('../config/runtime');
var { withTimeout, withRetry } = require('../utils/retryPolicy');
var { shouldRetrySlackError } = require('./slackRetry');

runtimeConfig.validateEnv([
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_APP_TOKEN',
], 'SLACK_SERVICE');

// ─── App singleton ─────────────────────────────────────────────────────────────

var app = new BoltApp({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

// Handler globale Bolt: un errore che sfugge da un listener (app.event /
// app.message / app.command) altrimenti diventa una unhandled rejection e,
// senza la rete di sicurezza in index.js, tirerebbe giù il processo. Qui lo
// logghiamo e lo assorbiamo così la singola interazione fallisce ma il bot
// resta in piedi.
app.error(function (error) {
  logger.error('[BOLT-ERROR] Errore non gestito da un listener:',
    (error && error.stack) || (error && error.message) || error);
  return Promise.resolve();
});

async function slackCall(label, fn, options) {
  options = options || {};
  var timeoutMs = options.timeoutMs || 4000;
  var retries = options.retries == null ? 1 : options.retries;

  return withRetry(function() {
    return withTimeout(fn, timeoutMs, label);
  }, {
    retries: retries,
    baseDelayMs: 150,
    shouldRetry: shouldRetrySlackError,
  });
}

// ─── User helpers ──────────────────────────────────────────────────────────────

async function getUtenti() {
  var res = await slackCall('SLACK.users.list', function() {
    return app.client.users.list();
  }, { timeoutMs: 5000, retries: 2 });

  return (res.members || [])
    .filter(function(u) { return !u.is_bot && u.id !== 'USLACKBOT' && !u.deleted; })
    .map(function(u) {
      return {
        id: u.id,
        name: u.real_name || u.name,
        email: (u.profile && u.profile.email) || null,
      };
    });
}

async function resolveSlackMentions(text) {
  var pattern = /<@([A-Z0-9]+)>/g;
  var ids = [];
  var m;
  while ((m = pattern.exec(text)) !== null) {
    if (!ids.includes(m[1])) ids.push(m[1]);
  }
  if (ids.length === 0) return text;
  var resolved = text;
  for (var i = 0; i < ids.length; i++) {
    var slackId = ids[i];
    try {
      var res = await slackCall('SLACK.users.info', function() {
        return app.client.users.info({ user: slackId });
      }, { timeoutMs: 3500, retries: 1 });

      var u = res.user;
      var name = u.real_name || u.name;
      var email = (u.profile && u.profile.email) || '';
      resolved = resolved.split('<@' + slackId + '>').join('@' + name + (email ? ' (' + email + ')' : ''));
    } catch (e) {
      logger.debug('[SLACK-SVC] operazione Slack ignorata:', e.message);
    }
  }
  return resolved;
}

async function leggiCanaleSlack(channelId, limit) {
  limit = limit || 10;

  try {
    await slackCall('SLACK.conversations.join', function() {
      return app.client.conversations.join({ channel: channelId });
    }, { timeoutMs: 3000, retries: 1 });
  } catch (e) {
    logger.debug('[SLACK-SVC] join canale ignorato:', e.message);
  }

  var res = await slackCall('SLACK.conversations.history', function() {
    return app.client.conversations.history({ channel: channelId, limit: limit });
  }, { timeoutMs: 5000, retries: 1 });

  return res.messages || [];
}

// ─── Channel activity ────────────────────────────────────────────────────────
// Verifica se un canale ha avuto attività (almeno un messaggio) negli ultimi
// `days` giorni. Chiamata leggera: conversations.history con oldest=now-Ndays
// e limit basso. Ritorna { active: bool, count: number } — count è il numero
// di messaggi nel batch (≤ limit), utile solo come segnale grezzo. Non fa
// join al canale: se il bot non è membro di un canale privato, ritorna
// active=false silenziosamente.
async function channelActivity(channelId, days, limit) {
  days = days || 60;
  limit = limit || 1;
  var oldest = String(Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000));
  try {
    var res = await slackCall('SLACK.conversations.history.activity', function() {
      return app.client.conversations.history({ channel: channelId, oldest: oldest, limit: limit });
    }, { timeoutMs: 5000, retries: 1 });
    var msgs = (res.messages || []).filter(function(m) {
      return m && m.type === 'message' && !m.subtype;
    });
    return { active: msgs.length > 0, count: msgs.length };
  } catch (e) {
    logger.debug('[SLACK-SVC] channelActivity ignorato per ' + channelId + ':', e.message);
    return { active: false, count: 0 };
  }
}

// ─── Get channel map helper ────────────────────────────────────────────────────
// Lazily imported to avoid circular dep with db.

function getChannelMapEntry(channelId) {
  var db = require('../../supabase');
  return db.getChannelMapCache()[channelId] || null;
}

module.exports = {
  app: app,
  getUtenti: getUtenti,
  resolveSlackMentions: resolveSlackMentions,
  leggiCanaleSlack: leggiCanaleSlack,
  channelActivity: channelActivity,
  getChannelMapEntry: getChannelMapEntry,
};
