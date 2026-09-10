// ─── Campagne di messaggi con conferma di lettura e solleciti ────────────────
// "Manda questo ai 7, chiedi di rispondere LETTO, se non rispondono entro
// un'ora sollecita, al terzo giro avvisami": prima Giuno non aveva un timer
// suo e la cosa restava a carico di Antonio. Qui: invio, attesa della
// risposta attesa (o di una reaction sul messaggio), solleciti a intervalli,
// report a chi ha lanciato la campagna a ogni giro e alla chiusura.

'use strict';

var logger = require('../utils/logger');

function _db() { return require('../services/db/campaigns'); }
function _app() { try { return require('../services/slackService').app; } catch(_) { return null; } }

function normReply(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9àèéìòù]+/g, ' ').trim(); }

// La risposta vale se contiene la parola attesa (o, senza parola attesa, se è
// una risposta qualsiasi). Ritorna { matched, consumed }: consumed = era solo
// la conferma, non serve passarla al modello.
function matchReply(text, expectedReply) {
  var t = normReply(text);
  if (!t) return { matched: false, consumed: false };
  if (!expectedReply) return { matched: true, consumed: t.split(' ').length <= 3 };
  var exp = normReply(expectedReply);
  if (t.indexOf(exp) === -1) return { matched: false, consumed: false };
  return { matched: true, consumed: t.split(' ').length <= 4 };
}

function pending(c) { return (c.recipients || []).filter(function(r) { return r.status === 'sent'; }); }
function replied(c) { return (c.recipients || []).filter(function(r) { return r.status === 'replied'; }); }
function unanswered(c) { return (c.recipients || []).filter(function(r) { return r.status === 'unanswered'; }); }

function formatStatus(c) {
  var head = '*' + (c.title || 'Campagna') + '* (' + c.id + ') — ' + (c.status === 'active' ? 'in corso' : c.status) +
    ': ' + replied(c).length + '/' + (c.recipients || []).length + ' hanno risposto' + (c.expected_reply ? ' "' + c.expected_reply + '"' : '');
  var lines = [head];
  if (replied(c).length) lines.push('✅ ' + replied(c).map(function(r) { return r.name || '<@' + r.user_id + '>'; }).join(', '));
  var p = pending(c);
  if (p.length) lines.push('⏳ in attesa: ' + p.map(function(r) { return (r.name || '<@' + r.user_id + '>') + (r.pushes ? ' (' + r.pushes + ' sollecit' + (r.pushes === 1 ? 'o' : 'i') + ')' : ''); }).join(', '));
  var u = unanswered(c);
  if (u.length) lines.push('❌ nessuna risposta dopo ' + c.max_pushes + ' solleciti: ' + u.map(function(r) { return '<@' + r.user_id + '>'; }).join(', ') + ' — tocca a te');
  return lines.join('\n');
}

function pushText(c, r) {
  var base = c.push_message || ('Promemoria: non ho ancora la tua risposta' + (c.expected_reply ? ' "' + c.expected_reply + '"' : '') + ' al messaggio qui sopra' +
    (c.created_by_name ? ' (lo chiede ' + c.created_by_name + ')' : '') + '. Due secondi e siamo a posto.');
  return base;
}

async function startCampaign(opts) {
  var app = opts.app || _app();
  var db = opts.db || _db();
  if (!app || !app.client) throw new Error('Slack non disponibile');
  var recipients = [];
  var failed = [];
  for (var i = 0; i < opts.recipients.length; i++) {
    var r = opts.recipients[i];
    try {
      var open = await app.client.conversations.open({ users: r.id });
      var post = await app.client.chat.postMessage({ channel: open.channel.id, text: opts.message });
      recipients.push({ user_id: r.id, name: r.name || null, channel: open.channel.id, ts: post.ts, status: 'sent', pushes: 0, sent_at: new Date().toISOString() });
    } catch(e) { failed.push({ user_id: r.id, name: r.name || null, error: e.message }); }
  }
  if (!recipients.length) throw new Error('Nessun DM inviato' + (failed.length ? ': ' + failed.map(function(f) { return (f.name || f.user_id) + ' (' + f.error + ')'; }).join(', ') : ''));
  var interval = Math.max(5, Number(opts.checkAfterMinutes) || 60);
  var now = opts.now ? opts.now() : Date.now();
  var campaign = await db.createCampaign({
    created_by: opts.createdBy, created_by_name: opts.createdByName || null,
    title: opts.title || String(opts.message).split('\n')[0].substring(0, 80),
    message: opts.message, expected_reply: opts.expectedReply || null, push_message: opts.pushMessage || null,
    check_interval_min: interval, max_pushes: Number(opts.maxPushes) >= 0 ? Number(opts.maxPushes) : 2,
    recipients: recipients, next_check_at: new Date(now + interval * 60000).toISOString(),
  });
  logger.info('[CAMPAIGN] ' + campaign.id + ' avviata da ' + opts.createdBy + ': ' + recipients.length + ' destinatari, check tra ' + interval + ' min');
  return { campaign: campaign, failed: failed };
}

// Chiamata dal DM handler per ogni messaggio in DM. Ritorna null o
// { campaign, consumed }.
async function registerReply(userId, text, deps) {
  deps = deps || {};
  var db = deps.db || _db();
  var active = await db.listCampaigns({ status: 'active' });
  for (var i = 0; i < active.length; i++) {
    var c = active[i];
    var r = (c.recipients || []).find(function(x) { return x.user_id === userId && x.status === 'sent'; });
    if (!r) continue;
    var m = matchReply(text, c.expected_reply);
    if (!m.matched) continue;
    r.status = 'replied'; r.replied_at = new Date().toISOString(); r.reply_text = String(text || '').substring(0, 200);
    await db.updateCampaign(c.id, { recipients: c.recipients });
    logger.info('[CAMPAIGN] ' + c.id + ': risposta di ' + userId);
    await maybeComplete(c, deps);
    return { campaign: c, consumed: m.consumed };
  }
  return null;
}

// Reaction su un messaggio della campagna = letto.
async function registerReaction(userId, ts, deps) {
  deps = deps || {};
  var db = deps.db || _db();
  var active = await db.listCampaigns({ status: 'active' });
  for (var i = 0; i < active.length; i++) {
    var c = active[i];
    var r = (c.recipients || []).find(function(x) { return x.user_id === userId && x.status === 'sent' && x.ts === ts; });
    if (!r) continue;
    r.status = 'replied'; r.replied_at = new Date().toISOString(); r.reply_text = '(reaction)';
    await db.updateCampaign(c.id, { recipients: c.recipients });
    await maybeComplete(c, deps);
    return c;
  }
  return null;
}

async function report(c, text, deps) {
  var app = deps.app || _app();
  if (!app || !app.client || !c.created_by) return;
  try { await app.client.chat.postMessage({ channel: c.created_by, text: text }); } catch(e) { logger.warn('[CAMPAIGN] report fallito:', e.message); }
}

async function maybeComplete(c, deps) {
  if (pending(c).length > 0) return false;
  var db = deps.db || _db();
  c.status = 'completed';
  c.completed_at = new Date().toISOString();
  await db.updateCampaign(c.id, { status: 'completed', completed_at: c.completed_at, recipients: c.recipients });
  await report(c, '🏁 Campagna chiusa.\n' + formatStatus(c), deps);
  return true;
}

// Cron: per ogni campagna attiva scaduta, sollecita chi non ha risposto
// (finché pushes < max) o lo marca senza risposta; report a chi l'ha lanciata.
async function runChecks(deps) {
  deps = deps || {};
  var db = deps.db || _db();
  var app = deps.app || _app();
  var now = deps.now ? deps.now() : Date.now();
  var active = await db.listCampaigns({ status: 'active' });
  var handled = 0;
  for (var i = 0; i < active.length; i++) {
    var c = active[i];
    if (!c.next_check_at || new Date(c.next_check_at).getTime() > now) continue;
    handled++;
    var p = pending(c);
    if (!p.length) { await maybeComplete(c, deps); continue; }
    var pushed = [], exhausted = [];
    for (var j = 0; j < p.length; j++) {
      var r = p[j];
      if ((r.pushes || 0) >= (c.max_pushes || 0)) { r.status = 'unanswered'; exhausted.push(r); continue; }
      try {
        if (app && app.client) await app.client.chat.postMessage({ channel: r.channel || r.user_id, text: pushText(c, r) });
        r.pushes = (r.pushes || 0) + 1; r.last_push_at = new Date(now).toISOString();
        pushed.push(r);
      } catch(e) { logger.warn('[CAMPAIGN] sollecito a ' + r.user_id + ' fallito:', e.message); }
    }
    var stillPending = pending(c).length > 0;
    var fields = { recipients: c.recipients, next_check_at: stillPending ? new Date(now + (c.check_interval_min || 60) * 60000).toISOString() : null };
    await db.updateCampaign(c.id, fields);
    var lines = ['⏱️ Giro di controllo su *' + (c.title || 'campagna') + '*: ' + replied(c).length + '/' + c.recipients.length + ' hanno risposto.'];
    if (pushed.length) lines.push('Sollecito inviato a: ' + pushed.map(function(r) { return r.name || '<@' + r.user_id + '>'; }).join(', ') + (stillPending ? ' — ricontrollo tra ' + c.check_interval_min + ' min.' : ''));
    if (exhausted.length) lines.push('❌ Dopo ' + c.max_pushes + ' solleciti ancora niente da: ' + exhausted.map(function(r) { return '<@' + r.user_id + '>'; }).join(', ') + ' — tocca a te.');
    await report(c, lines.join('\n'), deps);
    if (!stillPending) await maybeComplete(c, deps);
  }
  return handled;
}

async function cancelCampaign(id, userId, deps) {
  deps = deps || {};
  var db = deps.db || _db();
  var c = await db.getCampaign(id);
  if (!c) return { error: 'Campagna non trovata.' };
  if (c.status !== 'active') return { error: 'La campagna è già ' + c.status + '.' };
  await db.updateCampaign(id, { status: 'cancelled', next_check_at: null });
  logger.info('[CAMPAIGN] ' + id + ' annullata da ' + userId);
  return { success: true, message: 'Campagna "' + (c.title || id) + '" annullata: niente più solleciti.' };
}

module.exports = {
  matchReply: matchReply,
  formatStatus: formatStatus,
  startCampaign: startCampaign,
  registerReply: registerReply,
  registerReaction: registerReaction,
  runChecks: runChecks,
  cancelCampaign: cancelCampaign,
  pending: pending,
};
