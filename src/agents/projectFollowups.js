// ─── Follow-up proattivi sui progetti ────────────────────────────────────────
// Tre cose, tutte con throttle su followup_log e rispetto delle preferenze:
//  1. il giorno dopo una call, a chi ha un'azione a carico: "dalla call X
//     risulta che devi…", con bottoni Fatto / Ok / Non è mio;
//  2. promemoria per azioni e scadenze di progetto in arrivo (2-3 giorni);
//  3. sezione "Scadenze progetti" nel briefing del mattino.

'use strict';

var logger = require('../utils/logger');

function _db() { return require('../../supabase'); }
function _dossiers() { return require('../services/db/dossiers'); }
function _gate() { return require('../utils/proactiveGate'); }
function _supabase() { try { return require('../services/db/client').getClient(); } catch(_) { return null; } }
function _app() { try { return require('../services/slackService').app; } catch(_) { return null; } }
function _roles() { return require('../../rbac').getAllRoles(); }

function isoDate(d) { return new Date(d).toISOString().slice(0, 10); }
function addDays(dateStr, n) { var d = new Date(dateStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

// "2026-09-19", "19/09/2026", "19/09" → ISO; altrimenti null.
function parseDateLoose(s, today) {
  var t = String(s || '').trim();
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = /(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/.exec(t);
  if (m) {
    var y = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : String(today || isoDate(Date.now())).slice(0, 4);
    return y + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  }
  return null;
}

function actionLine(a) {
  return a.description + (a.due_date ? ' — entro ' + a.due_date : '') + (a.project_name ? ' _(' + a.project_name + ')_' : '');
}

function buildActionBlocks(assigneeId, actions, intro) {
  var ids = actions.map(function(a) { return a.id; }).join(',');
  var text = intro + '\n' + actions.map(function(a) { return '• ' + actionLine(a); }).join('\n');
  return {
    text: text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: text } },
      { type: 'actions', elements: [
        { type: 'button', action_id: 'project_actions_done', text: { type: 'plain_text', text: '✅ Fatto' }, style: 'primary', value: ids },
        { type: 'button', action_id: 'project_actions_ack', text: { type: 'plain_text', text: '👍 Ok, lo tengo' }, value: ids },
        { type: 'button', action_id: 'project_actions_dismiss', text: { type: 'plain_text', text: '✖ Non è mio' }, value: ids },
      ] },
    ],
  };
}

function groupBy(list, keyFn) {
  var out = {};
  list.forEach(function(x) { var k = keyFn(x); if (!k) return; (out[k] = out[k] || []).push(x); });
  return out;
}

async function projectNames(db, actions) {
  var names = {};
  var ids = {};
  actions.forEach(function(a) { if (a.project_id) ids[a.project_id] = true; });
  for (var id in ids) { try { var p = await db.getProject(id); if (p) names[id] = p.name; } catch(_) {} }
  actions.forEach(function(a) { a.project_name = a.project_id ? names[a.project_id] || null : null; });
}

// 1. Azioni emerse dalle call di ieri/oggi non ancora comunicate.
async function sendMeetingActionFollowups(deps) {
  deps = deps || {};
  var db = deps.db || _db(), dossiers = deps.dossiers || _dossiers(), gate = deps.gate || _gate(), app = deps.app !== undefined ? deps.app : _app();
  if (!app || !app.client) return 0;
  var since = new Date(Date.now() - 36 * 3600000).toISOString();
  var actions = (await dossiers.listProjectActions({ status: 'open', notNotified: true, createdAfter: since })).filter(function(a) { return a.assignee_slack_id; });
  if (!actions.length) return 0;
  await projectNames(db, actions);
  var byUser = groupBy(actions, function(a) { return a.assignee_slack_id; });
  var sent = 0;
  for (var uid in byUser) {
    if (!gate.notificheEnabled(uid)) continue;
    var mine = byUser[uid];
    var bySource = groupBy(mine, function(a) { return a.source_title || 'riunione'; });
    for (var title in bySource) {
      var list = bySource[title];
      var when = list[0].meeting_date ? ' del ' + list[0].meeting_date : '';
      var msg = buildActionBlocks(uid, list, 'Dagli appunti della call *' + title + '*' + when + ' risulta a tuo carico:');
      try {
        await app.client.chat.postMessage({ channel: uid, text: msg.text, blocks: msg.blocks });
        sent++;
        for (var i = 0; i < list.length; i++) await dossiers.updateProjectAction(list[i].id, { notified_at: new Date().toISOString() });
      } catch(e) { logger.warn('[FOLLOWUP] DM azioni a ' + uid + ' fallita:', e.message); }
    }
  }
  return sent;
}

// 2. Promemoria: azioni con scadenza entro 2 giorni (o scadute da ≤3) e
// scadenze di progetto dal dossier entro 3 giorni.
async function sendDueReminders(deps) {
  deps = deps || {};
  var db = deps.db || _db(), dossiers = deps.dossiers || _dossiers(), gate = deps.gate || _gate(), app = deps.app !== undefined ? deps.app : _app();
  var supabase = deps.supabase !== undefined ? deps.supabase : _supabase();
  if (!app || !app.client) return 0;
  var today = deps.today || isoDate(Date.now());
  var sent = 0;

  // 2a. azioni personali
  var due = (await dossiers.listProjectActions({ status: 'open', dueBefore: addDays(today, 2) })).filter(function(a) {
    return a.assignee_slack_id && a.due_date >= addDays(today, -3);
  });
  await projectNames(db, due);
  var byUser = groupBy(due, function(a) { return a.assignee_slack_id; });
  for (var uid in byUser) {
    if (!gate.notificheEnabled(uid)) continue;
    var fresh = [];
    for (var i = 0; i < byUser[uid].length; i++) {
      var a = byUser[uid][i];
      var hash = gate.itemHash('action-due:' + a.id);
      var ok = supabase ? await gate.followupAllowed(supabase, uid, hash, { cooldownDays: 2, maxAttempts: 2 }) : { allowed: true, attempts: 0 };
      if (ok.allowed) fresh.push({ a: a, hash: hash, attempts: ok.attempts });
    }
    if (!fresh.length) continue;
    var msg = buildActionBlocks(uid, fresh.map(function(f) { return f.a; }), '⏰ In scadenza (dalle call recenti):');
    try {
      await app.client.chat.postMessage({ channel: uid, text: msg.text, blocks: msg.blocks });
      sent++;
      for (var k = 0; k < fresh.length; k++) if (supabase) await gate.recordFollowup(supabase, uid, fresh[k].hash, fresh[k].a.description, fresh[k].attempts);
    } catch(e) { logger.warn('[FOLLOWUP] promemoria a ' + uid + ' fallito:', e.message); }
  }

  // 2b. scadenze di progetto (dossier) → responsabile o admin
  var upcoming = await upcomingProjectDeadlines({ db: db, dossiers: dossiers, today: today, days: 3 });
  var roles = null;
  var byRecipient = {};
  for (var j = 0; j < upcoming.length; j++) {
    var item = upcoming[j];
    var recips = item.project.owner_slack_id ? [item.project.owner_slack_id] : null;
    if (!recips) {
      if (!roles) { try { roles = deps.roles || await _roles(); } catch(_) { roles = []; } }
      recips = roles.filter(function(r) { return r.role === 'admin'; }).map(function(r) { return r.slack_user_id; });
    }
    recips.forEach(function(r) { (byRecipient[r] = byRecipient[r] || []).push(item); });
  }
  for (var rid in byRecipient) {
    if (!gate.notificheEnabled(rid)) continue;
    var lines = [];
    var toRecord = [];
    for (var m = 0; m < byRecipient[rid].length; m++) {
      var it = byRecipient[rid][m];
      var h = gate.itemHash('deadline:' + it.project.id + ':' + it.cosa + ':' + it.date);
      var allowed = supabase ? await gate.followupAllowed(supabase, rid, h, { cooldownDays: 7, maxAttempts: 1 }) : { allowed: true, attempts: 0 };
      if (!allowed.allowed) continue;
      lines.push('• *' + it.project.name + '*: ' + it.cosa + ' — ' + it.date + (it.chi ? ' (' + it.chi + ')' : ''));
      toRecord.push({ hash: h, attempts: allowed.attempts, desc: it.project.name + ': ' + it.cosa });
    }
    if (!lines.length) continue;
    try {
      await app.client.chat.postMessage({ channel: rid, text: '📅 Scadenze di progetto nei prossimi 3 giorni:\n' + lines.join('\n') + '\n_Dalle schede progetto. "A che punto è <progetto>?" per il dettaglio._' });
      sent++;
      for (var n = 0; n < toRecord.length; n++) if (supabase) await gate.recordFollowup(supabase, rid, toRecord[n].hash, toRecord[n].desc, toRecord[n].attempts);
    } catch(e) { logger.warn('[FOLLOWUP] scadenze a ' + rid + ' fallite:', e.message); }
  }
  return sent;
}

// Scadenze con data parsabile entro N giorni, da tutti i dossier attivi.
async function upcomingProjectDeadlines(opts) {
  var db = opts.db || _db(), dossiers = opts.dossiers || _dossiers();
  var today = opts.today || isoDate(Date.now());
  var until = addDays(today, opts.days || 7);
  var rows = await dossiers.listDossiers();
  var projects = await db.searchProjects({ statuses: ['active', 'planning'], limit: 400 });
  var byId = {};
  projects.forEach(function(p) { byId[p.id] = p; });
  var out = [];
  rows.forEach(function(r) {
    var p = byId[r.project_id];
    if (!p || !r.dossier) return;
    (r.dossier.scadenze || []).forEach(function(s) {
      if (!s || s.stato === 'fatta') return;
      var d = parseDateLoose(s.quando, today);
      if (!d || d < addDays(today, -1) || d > until) return;
      out.push({ project: p, cosa: s.cosa, date: d, chi: s.chi || null });
    });
  });
  return out.sort(function(a, b) { return a.date.localeCompare(b.date); });
}

// 3. Sezione per il briefing del mattino: scadenze della settimana (tutte
// per admin/manager; per gli altri solo i progetti di cui sono owner o
// allocati) + azioni personali in scadenza.
async function morningDeadlinesSection(userId, opts) {
  opts = opts || {};
  var db = opts.db || _db(), dossiers = opts.dossiers || _dossiers();
  var today = opts.today || isoDate(Date.now());
  var role = opts.role || 'member';
  var wide = role === 'admin' || role === 'manager' || role === 'finance';
  var deadlines = await upcomingProjectDeadlines({ db: db, dossiers: dossiers, today: today, days: 7 });
  if (!wide) {
    var mine = {};
    try { (await db.getUserAllocations(userId)).forEach(function(a) { mine[a.project_id] = true; }); } catch(_) {}
    deadlines = deadlines.filter(function(d) { return d.project.owner_slack_id === userId || mine[d.project.id]; });
  }
  var actions = (await dossiers.listProjectActions({ status: 'open', assignee: userId, dueBefore: addDays(today, 7) })).filter(function(a) { return a.due_date >= addDays(today, -3); });
  await projectNames(db, actions);
  if (!deadlines.length && !actions.length) return null;
  var lines = ['*Scadenze progetti (7 giorni):*'];
  deadlines.slice(0, 8).forEach(function(d) { lines.push('• ' + d.date + ' — *' + d.project.name + '*: ' + d.cosa + (d.chi ? ' (' + d.chi + ')' : '')); });
  actions.slice(0, 6).forEach(function(a) { lines.push('• ' + a.due_date + ' — tuo: ' + a.description + (a.project_name ? ' _(' + a.project_name + ')_' : '')); });
  return lines.join('\n');
}

async function runDailyFollowups(deps) {
  var a = await sendMeetingActionFollowups(deps);
  var b = await sendDueReminders(deps);
  logger.info('[FOLLOWUP] azioni dalle call: ' + a + ' DM, promemoria: ' + b + ' DM');
  return { actions: a, reminders: b };
}

// Bottoni: value = id azioni separati da virgola.
async function handleActionButton(actionId, value, userId, deps) {
  deps = deps || {};
  var dossiers = deps.dossiers || _dossiers();
  var status = actionId === 'project_actions_done' ? 'done' : actionId === 'project_actions_dismiss' ? 'dismissed' : 'acknowledged';
  var ids = String(value || '').split(',').filter(Boolean);
  for (var i = 0; i < ids.length; i++) {
    var fields = { status: status };
    if (status === 'done') fields.done_at = new Date().toISOString();
    await dossiers.updateProjectAction(ids[i], fields);
  }
  return status === 'done' ? 'Segnato come fatto ✅' : status === 'dismissed' ? 'Ok, tolto dalla tua lista. Se sai di chi è, dimmelo e lo riassegno.' : 'Perfetto, te lo ricordo a ridosso della scadenza.';
}

module.exports = {
  parseDateLoose: parseDateLoose,
  buildActionBlocks: buildActionBlocks,
  sendMeetingActionFollowups: sendMeetingActionFollowups,
  sendDueReminders: sendDueReminders,
  upcomingProjectDeadlines: upcomingProjectDeadlines,
  morningDeadlinesSection: morningDeadlinesSection,
  runDailyFollowups: runDailyFollowups,
  handleActionButton: handleActionButton,
};
