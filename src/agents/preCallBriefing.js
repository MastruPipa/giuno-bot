// ─── Pre-Call Briefing Agent ────────────────────────────────────────────────
// Runs every 30 minutes during work hours.
// Checks calendar for meetings starting in 15-45 minutes.
// Sends DM with briefing: attendees, client status, recent slack activity, docs.
'use strict';

var logger = require('../utils/logger');
var db = require('../../supabase');
var { acquireCronLock, releaseCronLock } = require('../../supabase');
var { app, getUtenti } = require('../services/slackService');
var { getCalendarPerUtente } = require('../services/googleAuthService');
var { formatPerSlack } = require('../utils/slackFormat');
var { withTimeout } = require('../utils/timeout');

async function buildBriefing(userId, event) {
  var parts = [];
  var title = event.summary || 'Meeting senza titolo';
  var startTime = event.start.dateTime
    ? new Date(event.start.dateTime).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' })
    : 'tutto il giorno';

  parts.push('*📞 Briefing pre-call: ' + title + '*');
  parts.push('_Inizio: ' + startTime + '_\n');

  // Attendees
  if (event.attendees && event.attendees.length > 0) {
    var attendeeList = event.attendees
      .filter(function(a) { return !a.self; })
      .map(function(a) { return (a.displayName || a.email || '?') + (a.responseStatus === 'declined' ? ' ❌' : ''); });
    if (attendeeList.length > 0) {
      parts.push('*Partecipanti:* ' + attendeeList.join(', '));
    }
  }

  // Extract potential client/entity name from title
  var titleWords = (title || '').replace(/call|meeting|sync|check|×|x|-|con|per/gi, ' ').trim().split(/\s+/).filter(function(w) { return w.length > 2; });

  // Search for client info
  for (var wi = 0; wi < Math.min(titleWords.length, 3); wi++) {
    var word = titleWords[wi];
    try {
      // CRM search
      var leads = await db.searchLeads({ company_name: word, limit: 1 });
      if (leads && leads.length > 0) {
        var lead = leads[0];
        parts.push('\n*CRM — ' + lead.company_name + ':*');
        parts.push('• Status: ' + (lead.status || 'N/A'));
        if (lead.value) parts.push('• Valore: €' + lead.value);
        if (lead.services) parts.push('• Servizi: ' + lead.services);
        if (lead.updated_at) parts.push('• Ultimo update: ' + lead.updated_at.split('T')[0]);
        break; // Found a match, stop searching
      }
    } catch(e) { /* ignore */ }
  }

  // Search memories and KB for context
  for (var wi2 = 0; wi2 < Math.min(titleWords.length, 2); wi2++) {
    try {
      var mems = await db.searchMemories(userId, titleWords[wi2]);
      var relevant = (mems || []).slice(0, 3).filter(function(m) {
        return m.content && m.content.length > 20;
      });
      if (relevant.length > 0) {
        parts.push('\n*Ricordi:*');
        relevant.forEach(function(m) {
          parts.push('• ' + m.content.substring(0, 120));
        });
        break;
      }
    } catch(e) { /* ignore */ }
  }

  // Recent activity in related channel
  try {
    var channelMap = db.getChannelMapCache();
    for (var chId in channelMap) {
      var mapping = channelMap[chId];
      if (!mapping.cliente) continue;
      var isRelated = titleWords.some(function(w) {
        return (mapping.cliente || '').toLowerCase().includes(w.toLowerCase()) ||
               (mapping.channel_name || '').toLowerCase().includes(w.toLowerCase());
      });
      if (isRelated) {
        var digests = db.getChannelDigestCache();
        var digest = digests[chId];
        if (digest && digest.last_digest) {
          parts.push('\n*Ultimo update #' + mapping.channel_name + ':*');
          parts.push(digest.last_digest.substring(0, 200));
        }
        break;
      }
    }
  } catch(e) { /* ignore */ }

  if (event.hangoutLink || event.conferenceData) {
    var meetLink = event.hangoutLink || (event.conferenceData && event.conferenceData.entryPoints && event.conferenceData.entryPoints[0] ? event.conferenceData.entryPoints[0].uri : null);
    if (meetLink) parts.push('\n<' + meetLink + '|Entra nella call>');
  }

  return parts.join('\n');
}

async function checkUpcomingCalls() {
  var locked = await acquireCronLock('precall_briefing', 5);
  if (!locked) return;
  try {
    var utenti = await getUtenti();
    var now = new Date();
    var from = new Date(now.getTime() + 15 * 60000); // 15 min from now
    var to = new Date(now.getTime() + 45 * 60000);   // 45 min from now
    var sent = 0;

    for (var i = 0; i < utenti.length; i++) {
      var uid = utenti[i].id;
      var cal = getCalendarPerUtente(uid);
      if (!cal) continue;

      try {
        var res = await withTimeout(
          cal.events.list({
            calendarId: 'primary',
            timeMin: from.toISOString(),
            timeMax: to.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 3,
          }),
          8000, 'precall_calendar'
        );

        var events = (res.data.items || []).filter(function(ev) {
          var t = (ev.summary || '').toLowerCase();
          // Skip ALL recurring events (weekly 1:1, daily standups, etc.)
          if (ev.recurringEventId) return false;
          // Skip known routine patterns even if not marked recurring
          if (/stand-?up|daily|sync|check-?in|scrum|weekly|1[:-]1|one.on.one|retrospective|retro|planning|sprint|huddle|coffee|pranzo|lunch|pausa/i.test(t)) return false;
          // Skip events without other attendees (personal blocks, focus time)
          if (!ev.attendees || ev.attendees.length <= 1) return false;
          // Skip all-day events (not calls)
          if (ev.start && ev.start.date && !ev.start.dateTime) return false;
          // Only brief for events with external attendees or client-related titles
          var hasExternal = ev.attendees && ev.attendees.some(function(a) {
            return a.email && !a.email.endsWith('@kataniastudio.com');
          });
          var isClientRelated = /call|meeting|riunione|presentazione|brainstorm|kick.?off|review|demo/i.test(t);
          return hasExternal || isClientRelated;
        });

        for (var ei = 0; ei < events.length; ei++) {
          var ev = events[ei];
          // Check if we already sent a briefing for this event (use memory)
          var briefingKey = 'precall_' + uid + '_' + ev.id + '_' + now.toISOString().slice(0, 10);
          try {
            var existing = await db.searchMemories(uid, briefingKey);
            if (existing && existing.some(function(m) { return m.content && m.content.includes(briefingKey); })) continue;
          } catch(e) { /* proceed anyway */ }

          var briefing = await buildBriefing(uid, ev);
          await app.client.chat.postMessage({ channel: uid, text: formatPerSlack(briefing), unfurl_links: false });
          sent++;

          // Mark as sent
          db.addMemory(uid, briefingKey + ' — briefing inviato', ['precall', 'system'], {
            memory_type: 'intent',
            confidence_score: 0.3,
          }).catch(function() {});
        }
      } catch(e) {
        logger.debug('[PRECALL] Calendar error for', uid + ':', e.message);
      }
    }

    if (sent > 0) logger.info('[PRECALL] Inviati', sent, 'briefing pre-call.');
  } finally { await releaseCronLock('precall_briefing'); }
}

module.exports = { checkUpcomingCalls: checkUpcomingCalls };
