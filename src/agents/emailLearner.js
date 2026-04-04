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
                userId: 'me', id: msgId, format: 'metadata',
                metadataHeaders: ['From', 'To', 'Subject', 'Date', 'Cc'],
              }),
              5000, 'email_learn_get'
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
