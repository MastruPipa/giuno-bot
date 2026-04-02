// ─── Behavioral Tracker ─────────────────────────────────────────────────────
// Tracks user behavior patterns: activity hours, communication style,
// topics of interest, response times. Updated on every interaction.
'use strict';

var logger = require('../utils/logger');
var dbClient = require('./db/client');

// In-memory buffer — flushed to DB every 5 minutes
var _buffer = {}; // userId -> { messages: [], hours: {}, channels: {} }
var FLUSH_INTERVAL = 5 * 60 * 1000;

function trackInteraction(userId, message, context) {
  context = context || {};
  if (!userId || !message || message.length < 5) return;

  if (!_buffer[userId]) {
    _buffer[userId] = { messageCount: 0, totalLength: 0, hours: {}, channels: {}, topics: [] };
  }
  var buf = _buffer[userId];
  buf.messageCount++;
  buf.totalLength += message.length;

  // Track hour of activity (Europe/Rome)
  var now = new Date();
  var hour = parseInt(now.toLocaleTimeString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Europe/Rome' }));
  buf.hours[hour] = (buf.hours[hour] || 0) + 1;

  // Track channels
  if (context.channelId) {
    buf.channels[context.channelId] = (buf.channels[context.channelId] || 0) + 1;
  }

  // Extract topics (simple keyword extraction)
  var msgLow = message.toLowerCase();
  var topicPatterns = [
    { topic: 'crm', pattern: /crm|lead|pipeline|cliente|prospect/i },
    { topic: 'design', pattern: /design|grafica|logo|brand|visual/i },
    { topic: 'social', pattern: /social|instagram|tiktok|linkedin|post|content/i },
    { topic: 'video', pattern: /video|reel|montaggio|shooting/i },
    { topic: 'web', pattern: /sito|web|landing|app|sviluppo/i },
    { topic: 'finance', pattern: /fattur|budget|costi|pagament|preventiv/i },
    { topic: 'planning', pattern: /progetto|deadline|scadenza|planning|task/i },
    { topic: 'email', pattern: /email|mail|inbox|thread/i },
  ];
  topicPatterns.forEach(function(tp) {
    if (tp.pattern.test(msgLow) && buf.topics.indexOf(tp.topic) === -1) {
      buf.topics.push(tp.topic);
    }
  });
}

// Classify communication style from message patterns
function classifyStyle(avgLength, msgCount) {
  if (avgLength < 30) return 'conciso';          // Short, to the point
  if (avgLength < 80) return 'diretto';           // Normal, direct
  if (avgLength < 150) return 'dettagliato';      // Detailed
  return 'elaborato';                              // Verbose
}

async function flushToDb() {
  var supabase = dbClient.getClient();
  if (!supabase) return;

  var userIds = Object.keys(_buffer);
  if (userIds.length === 0) return;

  for (var i = 0; i < userIds.length; i++) {
    var userId = userIds[i];
    var buf = _buffer[userId];
    if (buf.messageCount === 0) continue;

    try {
      // Read existing profile
      var existing = {};
      try {
        var res = await supabase.from('user_behavior').select('*').eq('slack_user_id', userId).maybeSingle();
        if (res.data) existing = res.data;
      } catch(e) { /* new user */ }

      // Merge hours
      var hours = existing.active_hours || {};
      for (var h in buf.hours) {
        hours[h] = (hours[h] || 0) + buf.hours[h];
      }

      // Find peak hour
      var peakHour = 9;
      var peakCount = 0;
      for (var hr in hours) {
        if (hours[hr] > peakCount) { peakCount = hours[hr]; peakHour = parseInt(hr); }
      }

      // Merge channels
      var channels = existing.preferred_channels || [];
      for (var ch in buf.channels) {
        if (channels.indexOf(ch) === -1) channels.push(ch);
      }

      // Merge topics
      var topics = existing.topics_of_interest || [];
      buf.topics.forEach(function(t) {
        if (topics.indexOf(t) === -1) topics.push(t);
      });

      // Calculate running averages
      var oldMsgPerDay = parseFloat(existing.messages_per_day) || 0;
      var newMsgPerDay = oldMsgPerDay > 0 ? (oldMsgPerDay * 0.8 + buf.messageCount * 0.2) : buf.messageCount;
      var avgLength = Math.round(buf.totalLength / buf.messageCount);
      var oldAvgLength = existing.avg_message_length || avgLength;
      var blendedLength = Math.round(oldAvgLength * 0.7 + avgLength * 0.3);

      var style = classifyStyle(blendedLength, newMsgPerDay);

      await supabase.from('user_behavior').upsert({
        slack_user_id: userId,
        active_hours: hours,
        peak_hour: peakHour,
        messages_per_day: Math.round(newMsgPerDay * 10) / 10,
        preferred_channels: channels.slice(0, 10),
        communication_style: style,
        topics_of_interest: topics.slice(0, 15),
        avg_message_length: blendedLength,
        last_active_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      logger.debug('[BEHAVIOR] Flushed profile for', userId, '| msgs:', buf.messageCount, '| style:', style);
    } catch(e) {
      logger.warn('[BEHAVIOR] Flush error for', userId + ':', e.message);
    }
  }

  _buffer = {};
}

// Get behavioral context for a user (used in system prompt injection)
async function getBehaviorContext(userId) {
  var supabase = dbClient.getClient();
  if (!supabase) return null;
  try {
    var res = await supabase.from('user_behavior').select('*').eq('slack_user_id', userId).maybeSingle();
    return res.data || null;
  } catch(e) { return null; }
}

// Start periodic flush
setInterval(flushToDb, FLUSH_INTERVAL);

module.exports = {
  trackInteraction: trackInteraction,
  getBehaviorContext: getBehaviorContext,
  flushToDb: flushToDb,
};
