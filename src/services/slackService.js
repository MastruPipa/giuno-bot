// ─── Slack Service ─────────────────────────────────────────────────────────────
// Slack App initialisation, user helpers, message reading, mention resolution.

'use strict';

var BoltApp = require('@slack/bolt').App;
var logger = require('../utils/logger');
var runtimeConfig = require('../config/runtime');

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
  try { await app.client.conversations.join({ channel: channelId }); } catch (e) {
    logger.debug('[SLACK-SVC] join canale ignorato:', e.message);
  }

  var res = await slackCall('SLACK.conversations.history', function() {
    return app.client.conversations.history({ channel: channelId, limit: limit });
  }, { timeoutMs: 5000, retries: 1 });

  return res.messages || [];
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
  getChannelMapEntry: getChannelMapEntry,
};
