// ─── Personal Daily Digest ───────────────────────────────────────────────────
// Morning DM to every active team member that shows what Giuno remembers
// about them: rolling 1:1 summary, sticky facts, open items. Dual purpose:
// (1) reinforce that the bot actually has memory, (2) implicit validation —
// if the user corrects something, the follow-up extracts an updated fact.

'use strict';

var logger = require('../utils/logger');
var db = require('../../supabase');
var { app, getUtenti } = require('../services/slackService');
var { formatPerSlack } = require('../utils/slackFormat');

// Honour the existing standup exclusion list — same humans who skip the daily
// also skip the personal digest.
var EXCLUDED_NAME_PATTERNS = ['antonio', 'gloria', 'corrado', 'cellulare', 'telefono'];

function isExcluded(utente) {
  var n = (utente && utente.name ? utente.name : '').toLowerCase();
  if (!n) return false;
  return EXCLUDED_NAME_PATTERNS.some(function(p) { return n.indexOf(p) !== -1; });
}

function getPrefs(userId) {
  return Object.assign({ personal_digest_enabled: true }, db.getPrefsCache()[userId] || {});
}

async function buildDigestForUser(userId, userName) {
  var supabase = db.getClient && db.getClient();
  if (!supabase) return null;

  // Sticky facts
  var facts = [];
  try { facts = await db.getUserFacts(userId, 8); } catch(e) { /* table may be missing */ }

  // Rolling summary
  var summaryRow = null;
  try {
    var r = await supabase.from('conversation_summaries')
      .select('summary, updated_at, messages_count, proposed_actions')
      .eq('conv_key', userId)
      .limit(1);
    if (r.data && r.data.length > 0) summaryRow = r.data[0];
  } catch(e) { /* non-blocking */ }

  var hasAnything = (facts && facts.length > 0) || (summaryRow && summaryRow.summary);
  if (!hasAnything) return null;

  var firstName = (userName || '').split(' ')[0] || 'ciao';
  var parts = ['*Buongiorno ' + firstName + '!* Questo è quello che ricordo di te stamattina:'];

  if (facts && facts.length > 0) {
    var byCat = {};
    facts.forEach(function(f) { (byCat[f.category] = byCat[f.category] || []).push(f.fact); });
    var catLines = Object.keys(byCat).map(function(cat) {
      return '*' + cat + ':* ' + byCat[cat].join('; ');
    });
    parts.push('\n' + catLines.join('\n'));
  }

  if (summaryRow && summaryRow.summary) {
    parts.push('\n*In breve:* ' + summaryRow.summary);

    var openItems = (summaryRow.proposed_actions || []).filter(function(a) {
      return a && a.type === 'open_item' && a.description;
    });
    if (openItems.length > 0) {
      parts.push('\n*Cose aperte tra noi:*\n' + openItems.slice(0, 5).map(function(a) { return '• ' + a.description; }).join('\n'));
    }
  }

  parts.push('\n_Se qualcosa è sbagliato o vecchio, scrivimi in DM — aggiorno._');
  return parts.join('\n');
}

async function sendPersonalDigests() {
  var { acquireCronLock, releaseCronLock } = require('../../supabase');
  var locked = await acquireCronLock('personal_digest', 20);
  if (!locked) return;
  try {
    var utenti = await getUtenti();
    var sent = 0;
    var skipped = 0;

    for (var i = 0; i < utenti.length; i++) {
      var utente = utenti[i];
      if (isExcluded(utente)) { skipped++; continue; }
      if (getPrefs(utente.id).personal_digest_enabled === false) { skipped++; continue; }

      try {
        var text = await buildDigestForUser(utente.id, utente.name);
        if (!text) { skipped++; continue; } // nothing remembered yet

        await app.client.chat.postMessage({
          channel: utente.id,
          text: formatPerSlack(text),
          unfurl_links: false,
        });
        sent++;
      } catch(e) {
        logger.warn('[PERSONAL-DIGEST] send failed per', utente.id, ':', e.message);
      }
    }
    logger.info('[PERSONAL-DIGEST] inviati:', sent, '| skip:', skipped, '/', utenti.length);
  } catch(e) {
    logger.error('[PERSONAL-DIGEST] Errore:', e.message);
  } finally { await releaseCronLock('personal_digest'); }
}

module.exports = {
  sendPersonalDigests: sendPersonalDigests,
  buildDigestForUser: buildDigestForUser,
};
