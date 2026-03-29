// ─── Slack Service ─────────────────────────────────────────────────────────────
// Slack App initialisation, user helpers, message reading, mention resolution.

'use strict';

require('dotenv').config();

var BoltApp = require('@slack/bolt').App;
var logger = require('../utils/logger');

// ─── App singleton ─────────────────────────────────────────────────────────────

var app = new BoltApp({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

// ─── User helpers ──────────────────────────────────────────────────────────────

async function getUtenti() {
  var res = await app.client.users.list();
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
      var res = await app.client.users.info({ user: slackId });
      var u = res.user;
      var name  = u.real_name || u.name;
      var email = (u.profile && u.profile.email) || '';
      resolved = resolved.split('<@' + slackId + '>').join('@' + name + (email ? ' (' + email + ')' : ''));
    } catch(e) {
      logger.debug('[SLACK-SVC] operazione Slack ignorata:', e.message);
    }
  }
  return resolved;
}

async function leggiCanaleSlack(channelId, limit) {
  limit = limit || 10;
  try { await app.client.conversations.join({ channel: channelId }); } catch(e) {
    logger.debug('[SLACK-SVC] join canale ignorato:', e.message);
  }
  var res = await app.client.conversations.history({ channel: channelId, limit: limit });
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
