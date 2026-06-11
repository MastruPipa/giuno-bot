// ─── Proactive Gate ──────────────────────────────────────────────────────────
// Gate comune per TUTTI i sistemi proattivi (follow-up agent, proactive
// followups, digest, monitor). Tre responsabilità:
//   1. opt-out per utente (user_prefs.notifiche_enabled)
//   2. dedup/cooldown condiviso su followup_log — un item ricordato da un
//      sistema non deve essere ri-ricordato da un altro
//   3. hash canonico degli item
// Prima di questo gate ogni job aveva il suo dedup (o nessuno): stessa cosa
// ricordata due volte da due sistemi diversi = "reminder casuali".
'use strict';

var crypto = require('crypto');
var db = require('../../supabase');

var COOLDOWN_DAYS = 3;
var MAX_ATTEMPTS = 3;

// Opt-out: rispetta user_prefs.notifiche_enabled per ogni DM proattivo.
function notificheEnabled(userId) {
  var p = db.getPrefsCache()[userId] || {};
  return p.notifiche_enabled !== false;
}

// Hash canonico di un item (testo normalizzato): stessa chiave per lo stesso
// contenuto a prescindere da spazi/maiuscole e dal sistema che lo genera.
function itemHash(text) {
  return crypto.createHash('sha1')
    .update(String(text || '').toLowerCase().replace(/\s+/g, ' ').trim())
    .digest('hex').slice(0, 16);
}

// Verifica su followup_log se possiamo (ri)mandare un reminder per l'item.
// Ritorna { allowed, attempts }.
async function followupAllowed(supabase, userId, hash, opts) {
  opts = opts || {};
  var cooldownMs = (opts.cooldownDays || COOLDOWN_DAYS) * 86400000;
  var maxAttempts = opts.maxAttempts || MAX_ATTEMPTS;
  try {
    var res = await supabase.from('followup_log')
      .select('sent_at, attempts')
      .eq('slack_user_id', userId)
      .eq('item_hash', hash)
      .maybeSingle();
    var log = res && res.data;
    if (!log) return { allowed: true, attempts: 0 };
    if ((log.attempts || 1) >= maxAttempts) return { allowed: false, attempts: log.attempts };
    if (Date.now() - new Date(log.sent_at).getTime() < cooldownMs) {
      return { allowed: false, attempts: log.attempts };
    }
    return { allowed: true, attempts: log.attempts || 0 };
  } catch(e) {
    // In dubbio non spammare
    return { allowed: false, attempts: 0 };
  }
}

async function recordFollowup(supabase, userId, hash, description, prevAttempts) {
  try {
    await supabase.from('followup_log').upsert({
      slack_user_id: userId,
      item_hash: hash,
      item_description: String(description || '').substring(0, 300),
      sent_at: new Date().toISOString(),
      attempts: (prevAttempts || 0) + 1,
    }, { onConflict: 'slack_user_id,item_hash' });
  } catch(e) { /* non-blocking */ }
}

module.exports = {
  notificheEnabled: notificheEnabled,
  itemHash: itemHash,
  followupAllowed: followupAllowed,
  recordFollowup: recordFollowup,
  COOLDOWN_DAYS: COOLDOWN_DAYS,
  MAX_ATTEMPTS: MAX_ATTEMPTS,
};
