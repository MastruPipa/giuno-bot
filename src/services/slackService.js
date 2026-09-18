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

// opts.includeInactive: anche chi è uscito dal team (active=false nel roster)
// ma ha ancora l'account Slack. Serve solo per un destinatario nominato
// esplicitamente; i giri collettivi (daily, planner, "tutti") lo escludono.
// users.list è lenta e contingentata (Tier 2, 20/min): il daily la chiama
// decine di volte tra invio, stime e promemoria, e il 17/9 alle 18:00 andava
// in timeout ("mi mandi la stima?" → "la chiamata a Slack va in timeout").
// Cache di 5 minuti; se Slack non risponde si usa l'ultima lista buona
// (anche vecchia), e senza nemmeno quella il roster in DB.
var USERS_CACHE_MS = 5 * 60000;
var _usersCache = { at: 0, members: null };

async function listMembers(deps) {
  deps = deps || {};
  var now = deps.now ? deps.now() : Date.now();
  var ttl = deps.cacheMs != null ? deps.cacheMs : USERS_CACHE_MS;
  if (_usersCache.members && (now - _usersCache.at) < ttl) return _usersCache.members;
  try {
    var client = (deps.app || app).client;
    var res = await slackCall('SLACK.users.list', function() {
      return client.users.list();
    }, { timeoutMs: deps.timeoutMs || 5000, retries: 2 });
    _usersCache = { at: now, members: res.members || [] };
    return _usersCache.members;
  } catch(e) {
    if (_usersCache.members) {
      logger.warn('[SLACK-USERS] users.list fallita (' + e.message + '): uso la lista di ' + Math.round((now - _usersCache.at) / 60000) + ' min fa');
      return _usersCache.members;
    }
    var roster = [];
    try { roster = (deps.teamDb || require('./db/team')).getTeamRoster() || []; } catch(_) {}
    if (!roster.length) throw e;
    logger.warn('[SLACK-USERS] users.list fallita (' + e.message + ') e nessuna lista in cache: uso il roster in DB (' + roster.length + ')');
    return roster.map(function(r) { return { id: r.slack_user_id, real_name: r.canonical_name, profile: { email: r.email || null } }; });
  }
}

function invalidateUsersCache() { _usersCache = { at: 0, members: null }; }

async function getUtenti(opts) {
  opts = opts || {};
  var members = await listMembers(opts.deps);

  var isInactive = function() { return false; };
  try { var teamDb = require('./db/team'); if (teamDb.isTeamMemberInactive) isInactive = teamDb.isTeamMemberInactive; } catch(_) {}
  return members
    .filter(function(u) { return !u.is_bot && u.id !== 'USLACKBOT' && !u.deleted && (opts.includeInactive || !isInactive(u.id)); })
    .map(function(u) {
      return {
        id: u.id,
        name: u.real_name || u.name,
        email: (u.profile && u.profile.email) || null,
        inactive: isInactive(u.id) || undefined,
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
// e limit contenuto. Ritorna { active: bool, count: number } — count è il
// numero di messaggi validi nel batch (≤ limit). Non fa join al canale: se il
// bot non è membro di un canale privato, ritorna active=false silenziosamente.
// Con limit 1 bastava che l'ultimo evento fosse un join, un leave o un
// messaggio con subtype (thread_broadcast, bot_message, file_share) per
// dichiarare il canale inattivo (17/9: chan_C076AGC0L94 archiviato con
// messaggi di oggi). Ora si leggono più messaggi e si ignorano solo le
// notifiche di ingresso/uscita.
var ACTIVITY_BATCH = 20;
var INACTIVE_SUBTYPES = { channel_join: true, channel_leave: true, group_join: true, group_leave: true };
function isActivityMessage(m) {
  return !!(m && m.type === 'message' && !INACTIVE_SUBTYPES[m.subtype || '']);
}
async function channelActivity(channelId, days, limit) {
  days = days || 60;
  limit = limit || ACTIVITY_BATCH;
  var oldest = String(Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000));
  try {
    var res = await slackCall('SLACK.conversations.history.activity', function() {
      return app.client.conversations.history({ channel: channelId, oldest: oldest, limit: limit });
    }, { timeoutMs: 5000, retries: 1 });
    var msgs = (res.messages || []).filter(isActivityMessage);
    return { active: msgs.length > 0, count: msgs.length };
  } catch (e) {
    logger.debug('[SLACK-SVC] channelActivity ignorato per ' + channelId + ':', e.message);
    return { active: false, count: 0, error: e.message || 'Slack non disponibile' };
  }
}

// ─── Get channel map helper ────────────────────────────────────────────────────
// Lazily imported to avoid circular dep with db.

function getChannelMapEntry(channelId) {
  var db = require('../../supabase');
  return db.getChannelMapCache()[channelId] || null;
}

module.exports = {
  isActivityMessage: isActivityMessage,
  listMembers: listMembers,
  invalidateUsersCache: invalidateUsersCache,
  app: app,
  getUtenti: getUtenti,
  resolveSlackMentions: resolveSlackMentions,
  leggiCanaleSlack: leggiCanaleSlack,
  channelActivity: channelActivity,
  getChannelMapEntry: getChannelMapEntry,
};
