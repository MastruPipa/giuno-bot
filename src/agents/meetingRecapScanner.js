// ─── Meeting Recap Scanner ──────────────────────────────────────────────────
// Scans Gmail for meeting recap emails (from Gemini/Google Meet) and saves
// key information to KB and memories.
'use strict';

var logger = require('../utils/logger');
var db = require('../../supabase');
var { acquireCronLock, releaseCronLock } = require('../../supabase');
var { getGmailPerUtente, getCalendarPerUtente, getUserTokens } = require('../services/googleAuthService');
var { withTimeout } = require('../utils/timeout');

// Patterns that identify meeting recap emails
var RECAP_SUBJECTS = [
  'meeting notes', 'recap', 'summary', 'riassunto', 'notes from',
  'action items', 'minutes', 'meeting summary',
];

var RECAP_SENDERS = [
  'calendar-notification@google.com',
  'gemini', 'meet', 'google meet',
  'noreply@google.com',
];

async function scanMeetingRecaps() {
  var locked = await acquireCronLock('meeting_recap_scan', 15);
  if (!locked) return;
  try {
    var tokens = getUserTokens();
    var userIds = Object.keys(tokens);
    var totalSaved = 0;

    for (var ui = 0; ui < userIds.length; ui++) {
      var userId = userIds[ui];
      var gmail = getGmailPerUtente(userId);
      if (!gmail) continue;

      try {
        // Search for meeting recap emails from last 24h
        var query = 'newer_than:1d (subject:(recap OR summary OR "meeting notes" OR riassunto OR "action items") OR from:(gemini OR meet))';
        var listRes = await withTimeout(
          gmail.users.messages.list({ userId: 'me', maxResults: 10, q: query }),
          8000, 'recap_gmail_list'
        );

        var messages = (listRes.data.messages || []);
        if (messages.length === 0) continue;

        for (var mi = 0; mi < messages.length; mi++) {
          var msgId = messages[mi].id;

          // Check if already processed (by msgId in KB tags)
          var existingKB = db.searchKB('gmail_recap_' + msgId);
          if (existingKB && existingKB.some(function(k) { return (k.tags || []).indexOf('gmail_id:' + msgId) !== -1; })) continue;

          // Read the email
          try {
            var msgRes = await withTimeout(
              gmail.users.messages.get({ userId: 'me', id: msgId, format: 'full' }),
              8000, 'recap_gmail_get'
            );

            var headers = msgRes.data.payload.headers || [];
            function getHeader(name) {
              var h = headers.find(function(h) { return h.name.toLowerCase() === name.toLowerCase(); });
              return h ? h.value : '';
            }

            var subject = getHeader('Subject');
            var from = getHeader('From');
            var date = getHeader('Date');

            // Extract body text
            var bodyText = '';
            var payload = msgRes.data.payload;
            if (payload.body && payload.body.data) {
              bodyText = Buffer.from(payload.body.data, 'base64').toString('utf-8');
            } else if (payload.parts) {
              for (var pi = 0; pi < payload.parts.length; pi++) {
                var part = payload.parts[pi];
                if (part.mimeType === 'text/plain' && part.body && part.body.data) {
                  bodyText = Buffer.from(part.body.data, 'base64').toString('utf-8');
                  break;
                }
              }
            }

            if (!bodyText || bodyText.length < 50) continue;

            // Check if it's actually a meeting recap (not just any email with "recap" in subject)
            var isRecap = /meeting|call|riunione|recap|summary|action item|decisioni|prossimi step|partecipanti/i.test(bodyText);
            if (!isRecap) continue;

            // Summarize with LLM
            var Anthropic = require('@anthropic-ai/sdk');
            var client = new Anthropic();
            var summaryRes = await client.messages.create({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 300,
              system: 'Riassumi questo recap di meeting per un\'agenzia di marketing. Estrai:\n' +
                '• Partecipanti\n• Decisioni prese\n• Action items (chi fa cosa)\n• Prossimi step\n• Scadenze menzionate\n' +
                'Max 8 righe. Se non è un vero recap di meeting, rispondi "SKIP".',
              messages: [{ role: 'user', content: 'Oggetto: ' + subject + '\nDa: ' + from + '\n\n' + bodyText.substring(0, 3000) }],
            });

            var summary = summaryRes.content[0].text.trim();
            if (summary === 'SKIP' || summary.startsWith('SKIP')) continue;

            // Save to KB
            var kbContent = '[RECAP MEETING] ' + subject + ' (' + date + ')\n' + summary;
            var tags = ['tipo:meeting_recap', 'gmail_id:' + msgId, 'fonte:gmail'];

            // Try to extract client name from subject
            var clientMatch = subject.match(/(?:con|×|x|per|@)\s*(\w+)/i);
            if (clientMatch) tags.push('cliente:' + clientMatch[1].toLowerCase());

            db.addKBEntry(kbContent, tags, userId, {
              confidenceTier: 'drive_indexed',
              sourceType: 'gmail_recap',
            });

            // Also save as memory for the user
            db.addMemory(userId, kbContent.substring(0, 300), ['meeting_recap', 'data:' + new Date().toISOString().slice(0, 10)], {
              memory_type: 'episodic',
              confidence_score: 0.8,
            });

            totalSaved++;
            logger.info('[RECAP-SCAN] Salvato recap:', subject.substring(0, 60));
          } catch(e) {
            logger.debug('[RECAP-SCAN] Errore email', msgId + ':', e.message);
          }
        }
      } catch(e) {
        logger.debug('[RECAP-SCAN] Errore per user', userId + ':', e.message);
      }
    }

    // ─── PHASE 2: Scan Calendar events for Gemini meeting notes ────────────
    for (var ci = 0; ci < userIds.length; ci++) {
      var calUserId = userIds[ci];
      var cal = getCalendarPerUtente(calUserId);
      if (!cal) continue;

      try {
        // Get events from last 24h that have ended
        var dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        var nowISO = new Date().toISOString();
        var calRes = await withTimeout(
          cal.events.list({
            calendarId: 'primary',
            timeMin: dayAgo,
            timeMax: nowISO,
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 10,
          }),
          8000, 'recap_cal_list'
        );

        var calEvents = (calRes.data.items || []);
        for (var ei = 0; ei < calEvents.length; ei++) {
          var calEvent = calEvents[ei];
          var eventId = calEvent.id;

          // Check if already processed
          var existingCal = db.searchKB('cal_recap_' + eventId);
          if (existingCal && existingCal.some(function(k) { return (k.tags || []).indexOf('cal_event_id:' + eventId) !== -1; })) continue;

          // Look for Gemini notes in: description, attachments, conferenceData.notes
          var notesContent = '';
          var eventTitle = calEvent.summary || 'Meeting';

          // 1. Check description for notes
          if (calEvent.description && calEvent.description.length > 50) {
            notesContent = calEvent.description;
          }

          // 2. Check attachments (Gemini meeting notes appear as Drive attachments)
          if (calEvent.attachments && calEvent.attachments.length > 0) {
            for (var ai = 0; ai < calEvent.attachments.length; ai++) {
              var att = calEvent.attachments[ai];
              if (/appunti|notes|recap|meeting/i.test(att.title || '')) {
                // Try to read the Google Doc attachment
                try {
                  var { getDocsPerUtente } = require('../services/googleAuthService');
                  var docs = getDocsPerUtente(calUserId);
                  if (docs && att.fileId) {
                    var { extractDocText } = require('../tools/driveTools');
                    var docRes = await withTimeout(
                      docs.documents.get({ documentId: att.fileId }),
                      8000, 'recap_doc_get'
                    );
                    var docText = extractDocText(docRes.data.body.content);
                    if (docText && docText.length > 50) {
                      notesContent = docText.substring(0, 3000);
                    }
                  }
                } catch(e) {
                  logger.debug('[RECAP-SCAN] Errore lettura doc allegato:', e.message);
                }
              }
            }
          }

          if (!notesContent || notesContent.length < 50) continue;

          // Summarize with LLM
          try {
            var Anthropic = require('@anthropic-ai/sdk');
            var client = new Anthropic();
            var summaryRes = await client.messages.create({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 300,
              system: 'Riassumi questi appunti di meeting. Estrai: partecipanti, decisioni, action items, prossimi step, scadenze. Max 8 righe. Se non è un vero recap, rispondi "SKIP".',
              messages: [{ role: 'user', content: 'Meeting: ' + eventTitle + '\n\n' + notesContent.substring(0, 2500) }],
            });

            var summary = summaryRes.content[0].text.trim();
            if (summary === 'SKIP' || summary.startsWith('SKIP')) continue;

            var kbContent = '[RECAP MEETING] ' + eventTitle + ' (' + (calEvent.start.dateTime || calEvent.start.date || '') + ')\n' + summary;
            var tags = ['tipo:meeting_recap', 'cal_event_id:' + eventId, 'fonte:calendar'];

            // Extract client name from title
            var clientMatch = eventTitle.match(/(?:con|×|x|per|@|<>)\s*(\w+)/i);
            if (clientMatch) tags.push('cliente:' + clientMatch[1].toLowerCase());

            db.addKBEntry(kbContent, tags, calUserId, {
              confidenceTier: 'drive_indexed',
              sourceType: 'calendar_recap',
            });

            db.addMemory(calUserId, kbContent.substring(0, 300), ['meeting_recap', 'data:' + new Date().toISOString().slice(0, 10)], {
              memory_type: 'episodic', confidence_score: 0.8,
            });

            totalSaved++;
            logger.info('[RECAP-SCAN] Salvato recap calendar:', eventTitle.substring(0, 50));
          } catch(e) {
            logger.debug('[RECAP-SCAN] Errore LLM recap cal:', e.message);
          }
        }
      } catch(e) {
        logger.debug('[RECAP-SCAN] Errore calendar per user', calUserId + ':', e.message);
      }
    }

    if (totalSaved > 0) logger.info('[RECAP-SCAN] Completato:', totalSaved, 'recap salvati');
  } finally {
    await releaseCronLock('meeting_recap_scan');
  }
}

module.exports = { scanMeetingRecaps: scanMeetingRecaps };
