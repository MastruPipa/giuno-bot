// ─── Email Learner ──────────────────────────────────────────────────────────
// Proactively scans Gmail for all team members. Extracts and saves:
// - Active email threads (who's talking to who about what)
// - Client communications (requests, decisions, feedback)
// - Important attachments/documents mentioned
// - Deadlines and action items from emails
// Runs every 2 hours during work hours.
'use strict';

var logger = require('../utils/logger');
var db = require('../../supabase');
var { acquireCronLock, releaseCronLock } = require('../../supabase');
var { getGmailPerUtente, getUserTokens } = require('../services/googleAuthService');
var { withTimeout } = require('../utils/timeout');

// Dedup: track processed email IDs
var _processedIds = new Set();

async function scanEmails() {
  var locked = await acquireCronLock('email_learner', 15);
  if (!locked) return;
  try {
    var tokens = getUserTokens();
    var userIds = Object.keys(tokens);
    var totalLearned = 0;

    for (var ui = 0; ui < userIds.length; ui++) {
      var userId = userIds[ui];
      var gmail = getGmailPerUtente(userId);
      if (!gmail) continue;

      try {
        // Get emails from last 4 hours, exclude newsletters/notifications
        var query = 'newer_than:4h -from:noreply -from:notifications -from:no-reply -from:newsletter ' +
          '-from:mailer-daemon -subject:OTP -subject:"codice di verifica" ' +
          '-label:spam -label:promotions is:inbox';

        var listRes = await withTimeout(
          gmail.users.messages.list({ userId: 'me', maxResults: 15, q: query }),
          8000, 'email_learn_list'
        );

        var messages = (listRes.data.messages || []);

        for (var mi = 0; mi < messages.length; mi++) {
          var msgId = messages[mi].id;
          if (_processedIds.has(msgId)) continue;
          _processedIds.add(msgId);

          try {
            var msgRes = await withTimeout(
              gmail.users.messages.get({
                userId: 'me', id: msgId, format: 'full',
              }),
              8000, 'email_learn_get'
            );

            var headers = msgRes.data.payload.headers || [];
            function getHeader(name) {
              var h = headers.find(function(x) { return x.name.toLowerCase() === name.toLowerCase(); });
              return h ? h.value : '';
            }

            var from = getHeader('From');
            var to = getHeader('To');
            var cc = getHeader('Cc');
            var subject = getHeader('Subject');
            var date = getHeader('Date');
            var snippet = msgRes.data.snippet || '';

            // Extract attachments info + read text attachments
            var attachmentsSummary = [];
            function scanParts(parts) {
              if (!parts) return;
              for (var pi2 = 0; pi2 < parts.length; pi2++) {
                var part = parts[pi2];
                if (part.filename && part.filename.length > 0 && part.body) {
                  var attSize = part.body.size || 0;
                  var attMime = part.mimeType || '';
                  // Skip very large files (>5MB) and media files
                  if (attSize > 5 * 1024 * 1024) continue;
                  if (/video|audio/i.test(attMime)) continue;

                  var attInfo = { name: part.filename, type: attMime, size: attSize };

                  // If it's a small text/csv/json file and has data inline, read it
                  if (part.body.data && attSize < 100000 && /text|csv|json/i.test(attMime)) {
                    try {
                      var attContent = Buffer.from(part.body.data, 'base64').toString('utf-8');
                      attInfo.content = attContent.substring(0, 500);
                    } catch(e) { /* ignore */ }
                  }

                  // If it's a Google Drive link in the attachment, note it
                  if (/google-apps/i.test(attMime)) {
                    attInfo.isDriveLink = true;
                  }

                  // For PDFs, images, docs — just save metadata
                  if (/pdf/i.test(attMime)) attInfo.type_label = 'PDF';
                  else if (/image/i.test(attMime)) attInfo.type_label = 'Immagine';
                  else if (/spreadsheet|excel/i.test(attMime)) attInfo.type_label = 'Foglio';
                  else if (/document|word/i.test(attMime)) attInfo.type_label = 'Documento';
                  else if (/presentation|powerpoint/i.test(attMime)) attInfo.type_label = 'Presentazione';

                  attachmentsSummary.push(attInfo);
                }
                // Recurse into nested parts
                if (part.parts) scanParts(part.parts);
              }
            }
            scanParts(msgRes.data.payload.parts);

            // Skip internal-only emails (all @kataniastudio.com)
            var isInternal = from.includes('@kataniastudio.com') &&
              to.includes('@kataniastudio.com') &&
              (!cc || cc.includes('@kataniastudio.com'));

            // Extract sender name/email
            var fromName = from.replace(/<[^>]+>/, '').trim().replace(/"/g, '');
            var fromEmail = (from.match(/<([^>]+)>/) || [])[1] || from;

            // Determine if this is client communication
            var isExternal = !fromEmail.endsWith('@kataniastudio.com');
            var hasClientContent = /preventivo|proposta|contratto|conferma|approvato|deadline|scadenza|urgente|progetto|deliverable/i.test(subject + ' ' + snippet);

            // Only save if it's meaningful (external or has business content)
            if (!isExternal && !hasClientContent) continue;

            // Build concise memory
            var emailSummary = '';
            if (isExternal) {
              emailSummary = fromName + ' ha scritto a KS: "' + subject + '"';
              if (snippet.length > 20) emailSummary += ' — ' + snippet.substring(0, 150);
              emailSummary += ' (' + new Date(date).toISOString().slice(0, 10) + ')';
            } else if (hasClientContent) {
              emailSummary = 'Email interna: "' + subject + '" — ' + snippet.substring(0, 150);
              emailSummary += ' (' + new Date(date).toISOString().slice(0, 10) + ')';
            }

            // Append attachment info to summary
            if (attachmentsSummary.length > 0) {
              emailSummary += ' | Allegati: ' + attachmentsSummary.map(function(a) {
                var desc = a.name;
                if (a.type_label) desc += ' (' + a.type_label + ')';
                if (a.content) desc += ' → ' + a.content.substring(0, 100);
                return desc;
              }).join(', ');

              // Save attachment details to KB separately if they have readable content
              for (var ai = 0; ai < attachmentsSummary.length; ai++) {
                var att = attachmentsSummary[ai];
                if (att.content && att.content.length > 30) {
                  var attKB = '[ALLEGATO EMAIL] ' + att.name + ' da "' + subject + '" (' + fromName + '): ' + att.content.substring(0, 400);
                  db.addKBEntry(attKB, ['fonte:email_allegato', 'file:' + att.name.toLowerCase(), 'data:' + new Date(date).toISOString().slice(0, 10)], userId, {
                    confidenceTier: 'auto_learn', sourceType: 'gmail_attachment',
                  });
                }
              }
            }

            if (!emailSummary || emailSummary.length < 30) continue;

            // Extract potential client name from email domain or subject
            var tags = ['fonte:email', 'data:' + new Date(date).toISOString().slice(0, 10)];
            if (isExternal) {
              var domain = fromEmail.split('@')[1];
              if (domain && !domain.includes('gmail') && !domain.includes('hotmail') && !domain.includes('yahoo')) {
                tags.push('azienda:' + domain.split('.')[0]);
              }
              tags.push('tipo:email_cliente');
            } else {
              tags.push('tipo:email_interna');
            }

            // Save as KB entry (not memory — emails are shared knowledge)
            db.addKBEntry(emailSummary, tags, userId, {
              confidenceTier: 'auto_learn',
              sourceType: 'gmail',
              sourceChannelType: 'email',
            });

            // If external: also try to save/update contact
            if (isExternal && fromName.length > 2) {
              try {
                var supabase = db.getClient ? db.getClient() : null;
                if (supabase) {
                  var { data: existContact } = await supabase.from('contacts')
                    .select('id').ilike('name', '%' + fromName.split(' ')[0] + '%').limit(1);
                  if (!existContact || existContact.length === 0) {
                    await supabase.from('contacts').insert({
                      name: fromName, email: fromEmail, created_by: userId,
                      last_contact_date: new Date(date).toISOString().slice(0, 10),
                    });
                  } else {
                    await supabase.from('contacts').update({
                      last_contact_date: new Date(date).toISOString().slice(0, 10),
                    }).eq('id', existContact[0].id);
                  }
                }
              } catch(e) { /* non-blocking */ }
            }

            totalLearned++;
          } catch(e) {
            logger.debug('[EMAIL-LEARN] Errore email', msgId + ':', e.message);
          }
        }
      } catch(e) {
        logger.debug('[EMAIL-LEARN] Errore per user', userId + ':', e.message);
      }
    }

    // Cleanup old processed IDs (keep last 500)
    if (_processedIds.size > 500) {
      var arr = Array.from(_processedIds);
      _processedIds = new Set(arr.slice(-300));
    }

    if (totalLearned > 0) logger.info('[EMAIL-LEARN] Appreso da', totalLearned, 'email');
  } finally {
    await releaseCronLock('email_learner');
  }
}

module.exports = { scanEmails: scanEmails };
