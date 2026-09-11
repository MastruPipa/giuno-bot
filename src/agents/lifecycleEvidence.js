// ─── Evidenze operative dei progetti (ciclo di vita) ─────────────────────────
// Dopo la PR #136 un progetto importato (deal Attio, canale Slack) è solo un
// candidato ("acquisito", status planning) finché non c'è un'evidenza datata
// che il lavoro è in corso: projects.lifecycle_evidence = { state:'active',
// source_url (https), observed_on, valid_until }. Nessuno la compilava.
//
// Qui Giuno la ricostruisce dalle fonti che già legge, ogni mattina:
//   • kick-off su Drive (project_documents, ruolo kickoff)  → vale 90 giorni
//   • recap di call su quella commessa (ruolo recap)          → vale 30 giorni
//   • azioni aperte emerse dalle call, con link alla fonte    → fino a scadenza + 14
//   • riunioni in calendario con il nome del progetto/cliente → fino al giorno + 7
//   • decisione esplicita di admin/PM (bottone o comando)     → 60 giorni
// Le ore dichiarate nel daily sono un indizio, non una prova: se sono l'unica
// cosa che c'è, Giuno CHIEDE al PM (o agli admin) con tre bottoni e la
// risposta diventa l'evidenza (permalink Slack). Il volume dei messaggi nei
// canali non conta mai. Sospensioni e chiusure sono sempre proposte, mai
// automatiche: l'ultima parola resta al PM.

'use strict';

var logger = require('../utils/logger');

var VALIDITY_DAYS = { kickoff: 90, recap: 30, admin: 60, calendar: 7, action_open: 14 };
var HOURS_WINDOW_DAYS = 21;
var HOURS_MIN_DAYS = 2;
var PRIMARY = { kickoff: true, recap: true, action_open: true, calendar: true, admin: true };
var OPEN_STATUSES = ['active', 'planning', 'on_hold'];

function _db() { return require('../../supabase'); }
function _dossiers() { return require('../services/db/dossiers'); }
function _client() { return require('../services/db/client'); }

function iso(d) { return new Date(d).toISOString().slice(0, 10); }
function addDays(dateStr, n) { var d = new Date(dateStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s; }
function isHttps(u) { return typeof u === 'string' && /^https:\/\//.test(u); }
function norm(s) { return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

// Data di un documento collegato: prefisso "YYYY-MM-DD" nelle note (lo mette
// lo scanner Gemini), altrimenti la data di collegamento.
function docDate(doc) {
  var m = /(\d{4}-\d{2}-\d{2})/.exec(String(doc.notes || ''));
  if (m) return m[1];
  return doc.created_at ? iso(doc.created_at) : null;
}

function projectNeedles(project) {
  return [project.name, project.client_name].concat(Array.isArray(project.aliases) ? project.aliases : [])
    .map(norm).filter(function(n) { return n && n.length >= 4; });
}

function textMentionsProject(text, project) {
  var t = ' ' + norm(text) + ' ';
  return projectNeedles(project).some(function(n) { return t.indexOf(' ' + n + ' ') !== -1; });
}

// ── Raccolta ────────────────────────────────────────────────────────────────
// ctx: { today, docs, actions, logs, calendar, dossier, existing }
function evidenceFromSources(project, ctx) {
  var today = ctx.today;
  var out = [];
  (ctx.docs || []).forEach(function(d) {
    if (!isHttps(d.drive_link)) return;
    var date = docDate(d);
    if (!isDate(date) || date > today) return;
    if (d.doc_role === 'kickoff') out.push({ kind: 'kickoff', observed_on: date, valid_until: addDays(date, VALIDITY_DAYS.kickoff), source_url: d.drive_link, detail: 'kick-off "' + (d.file_name || '') + '"' });
    else if (d.doc_role === 'recap') out.push({ kind: 'recap', observed_on: date, valid_until: addDays(date, VALIDITY_DAYS.recap), source_url: d.drive_link, detail: 'recap "' + (d.file_name || '') + '"' });
  });
  (ctx.actions || []).forEach(function(a) {
    if (a.project_id !== project.id || (a.status && a.status !== 'open' && a.status !== 'acknowledged')) return;
    if (!isHttps(a.source_link)) return;
    var observed = isDate(a.meeting_date) ? a.meeting_date : (a.created_at ? iso(a.created_at) : null);
    if (!isDate(observed) || observed > today) return;
    var until = isDate(a.due_date) ? addDays(a.due_date, VALIDITY_DAYS.action_open) : addDays(observed, 30);
    out.push({ kind: 'action_open', observed_on: observed, valid_until: until, source_url: a.source_link, detail: 'azione aperta: ' + String(a.description || '').substring(0, 80) });
  });
  (ctx.calendar || []).forEach(function(ev) {
    if (!isHttps(ev.htmlLink) || !isDate(ev.date)) return;
    if (!textMentionsProject((ev.summary || '') + ' ' + (ev.description || ''), project)) return;
    if (ev.date < today) return;
    out.push({ kind: 'calendar', observed_on: today, valid_until: addDays(ev.date, VALIDITY_DAYS.calendar), source_url: ev.htmlLink, detail: 'in calendario il ' + ev.date + ': ' + String(ev.summary || '').substring(0, 60) });
  });
  var ex = ctx.existing;
  if (ex && ex.kind === 'admin' && ex.state === 'active' && isHttps(ex.source_url) && isDate(ex.observed_on) && isDate(ex.valid_until)) {
    out.push({ kind: 'admin', observed_on: ex.observed_on, valid_until: ex.valid_until, source_url: ex.source_url, detail: 'confermato da ' + (ex.decided_by || 'admin') });
  }
  // Ore dichiarate (non stimate) su almeno HOURS_MIN_DAYS giorni distinti
  var days = {};
  (ctx.logs || []).forEach(function(l) {
    if (l.log_type && l.log_type !== 'daily') return;
    if (l.validation && l.validation.status === 'estimate') return;
    if (!(Number(l.hours) > 0) || !isDate(l.log_date)) return;
    days[l.log_date] = (days[l.log_date] || 0) + Number(l.hours);
  });
  var dayKeys = Object.keys(days).sort();
  if (dayKeys.length >= HOURS_MIN_DAYS) {
    var tot = dayKeys.reduce(function(s, k) { return s + days[k]; }, 0);
    out.push({ kind: 'hours_declared', observed_on: dayKeys[dayKeys.length - 1], valid_until: addDays(dayKeys[dayKeys.length - 1], HOURS_WINDOW_DAYS), source_url: null, detail: Math.round(tot * 10) / 10 + 'h dichiarate su ' + dayKeys.length + ' giorni' });
  }
  return out;
}

// ── Valutazione ─────────────────────────────────────────────────────────────
// Ritorna { state, evidence, primary, hints, reason }
//   state: operativo | operativo? | sospeso? | concluso? | acquisito | invariato
function assess(project, evidences, ctx) {
  var today = ctx.today;
  var d = (ctx.dossier && ctx.dossier.dossier) || {};
  var hints = { fase: d.fase || null, da_consegnare: (Array.isArray(d.deliverable) ? d.deliverable : []).filter(function(x) { return x && x.stato && x.stato !== 'consegnato'; }).length, prossimi_passi: (d.prossimi_passi || []).length };
  var valid = evidences.filter(function(e) { return isDate(e.observed_on) && isDate(e.valid_until) && e.observed_on <= today && today <= e.valid_until; });
  var primary = valid.filter(function(e) { return PRIMARY[e.kind] && isHttps(e.source_url); })
    .sort(function(a, b) { return b.valid_until.localeCompare(a.valid_until); });
  var hours = valid.find(function(e) { return e.kind === 'hours_declared'; });
  var imported = /^(attio_|chan_)/.test(String(project.id)) || (project.tags || []).some(function(t) { return t === 'attio-sync' || t === 'channel-sync'; });
  var closedPhase = /chiuso|conclus|complet/i.test(hints.fase || '');
  var stoppedPhase = /fermo|sospes|stand-?by/i.test(hints.fase || '');
  var adminDecision = primary.find(function(e) { return e.kind === 'admin'; });

  if (closedPhase && !adminDecision && project.status !== 'completed') {
    return { state: 'concluso?', primary: primary, hints: hints, reason: 'la scheda dice "' + hints.fase + '"' };
  }
  // Sospensione decisa da una persona: il refresh non la ribalta mai da solo.
  // Solo evidenze NUOVE (osservate dopo la decisione) fanno riproporre la domanda.
  var ex = ctx.existing;
  if (project.status === 'on_hold') {
    var decidedOn = ex && ex.state === 'on_hold' && isDate(ex.observed_on) ? ex.observed_on : null;
    var fresh = primary.filter(function(e) { return e.kind !== 'admin' && (!decidedOn || e.observed_on > decidedOn); });
    if (fresh.length) return { state: 'operativo?', primary: primary, hints: hints, reason: 'sospeso' + (decidedOn ? ' dal ' + decidedOn : '') + ', ma trovo evidenze nuove: ' + fresh[0].detail };
    return { state: 'invariato', primary: primary, hints: hints, reason: 'sospeso da una persona' + (decidedOn ? ' il ' + decidedOn : '') };
  }
  if (primary.length) {
    var best = primary[0];
    return { state: 'operativo', primary: primary, hints: hints, reason: best.detail,
      evidence: { state: 'active', source_url: best.source_url, observed_on: best.observed_on, valid_until: best.valid_until, kind: best.kind, detail: best.detail, decided_by: best.kind === 'admin' ? ((ctx.existing && ctx.existing.decided_by) || 'admin') : 'giuno',
        evidences: primary.slice(0, 5).map(function(e) { return { kind: e.kind, observed_on: e.observed_on, valid_until: e.valid_until, source_url: e.source_url, detail: e.detail }; }),
        updated_at: new Date(ctx.now || Date.now()).toISOString() } };
  }
  if (stoppedPhase && project.status !== 'on_hold') return { state: 'sospeso?', primary: primary, hints: hints, reason: 'la scheda dice "' + hints.fase + '"' };
  if (hours) return { state: 'operativo?', primary: primary, hints: hints, reason: hours.detail + ' negli ultimi ' + HOURS_WINDOW_DAYS + ' giorni, ma nessuna fonte documentale' };
  // Evidenza scaduta: vale anche se la sync ha già riportato il progetto a
  // planning (gira prima del refresh); il PM va comunque interpellato.
  if (ex && ex.state === 'active' && isDate(ex.valid_until) && ex.valid_until < today) {
    return { state: 'sospeso?', primary: primary, hints: hints, reason: 'l\'ultima evidenza (' + (ex.kind || 'n/d') + ') è scaduta il ' + ex.valid_until + ' e non ne trovo di nuove' };
  }
  if (imported && project.status !== 'active') return { state: 'acquisito', primary: primary, hints: hints, reason: 'nessuna evidenza operativa' };
  return { state: 'invariato', primary: primary, hints: hints, reason: 'nessuna evidenza nuova' };
}

// ── Calendario (opzionale): eventi dei prossimi 30 giorni dei calendari admin ─
async function loadCalendarEvents(deps, today) {
  if (deps.calendarEvents) return deps.calendarEvents;
  var gauth;
  try { gauth = require('../services/googleAuthService'); } catch(_) { return []; }
  var tokens = gauth.getUserTokens ? (gauth.getUserTokens() || {}) : {};
  var roles = deps.roles || [];
  var admins = roles.filter(function(r) { return r.role === 'admin' || r.role === 'manager'; }).map(function(r) { return r.slack_user_id; });
  var users = admins.filter(function(id) { return tokens[id]; }).slice(0, 3);
  var out = [];
  for (var i = 0; i < users.length; i++) {
    try {
      var cal = gauth.getCalendarPerUtente(users[i]);
      if (!cal) continue;
      var res = await cal.events.list({ calendarId: 'primary', timeMin: new Date(today + 'T00:00:00Z').toISOString(), timeMax: new Date(addDays(today, 30) + 'T00:00:00Z').toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 100 });
      ((res.data && res.data.items) || []).forEach(function(ev) {
        var start = ev.start && (ev.start.date || (ev.start.dateTime && ev.start.dateTime.slice(0, 10)));
        if (start) out.push({ date: start, summary: ev.summary || '', description: ev.description || '', htmlLink: ev.htmlLink || null });
      });
    } catch(e) { logger.debug('[LIFECYCLE] calendario ' + users[i] + ' non leggibile:', e.message); }
  }
  return out;
}

async function loadRecentLogs(supabase, projectId, since) {
  if (!supabase) return [];
  try {
    var res = await supabase.from('time_logs').select('slack_user_id, log_date, log_type, hours, validation').eq('project_id', projectId).gte('log_date', since).limit(500);
    return res.error ? [] : (res.data || []);
  } catch(_) { return []; }
}

function buildProposalBlocks(project, a, today) {
  var q = a.state === 'concluso?' ? 'risulta concluso' : a.state === 'sospeso?' ? 'sembra fermo' : 'sembra in lavorazione';
  var text = '*' + project.name + '* ' + q + ': ' + a.reason + '.' +
    (a.hints.da_consegnare ? ' Consegne ancora aperte nella scheda: ' + a.hints.da_consegnare + '.' : '') +
    '\nLa dashboard lo conta tra gli attivi solo con una tua conferma (vale 60 giorni). Com\'è messo?';
  return [
    { type: 'section', text: { type: 'mrkdwn', text: text } },
    { type: 'actions', elements: [
      { type: 'button', text: { type: 'plain_text', text: '▶️ È operativo' }, style: 'primary', action_id: 'lifecycle_active', value: project.id },
      { type: 'button', text: { type: 'plain_text', text: '⏸ Sospeso' }, action_id: 'lifecycle_hold', value: project.id },
      { type: 'button', text: { type: 'plain_text', text: '✅ Concluso' }, action_id: 'lifecycle_done', value: project.id },
    ] },
  ];
}

// ── Corsa completa ──────────────────────────────────────────────────────────
// opts: { apply, notify, projects, deps }
async function refreshLifecycle(opts) {
  opts = opts || {};
  var deps = opts.deps || {};
  var db = deps.db || _db();
  var dossiers = deps.dossiers || _dossiers();
  var supabase = deps.supabase !== undefined ? deps.supabase : _client().getClient();
  var now = deps.now ? deps.now() : Date.now();
  var today = deps.today || new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
  var report = { considered: 0, activated: 0, extended: 0, proposals: 0, notified: 0, items: [] };
  var roles = deps.roles;
  if (!roles) { try { roles = await require('../../rbac').getAllRoles(); } catch(_) { roles = []; } }
  deps.roles = roles;
  var projects = opts.projects || (await db.searchProjects({ statuses: OPEN_STATUSES, limit: 400 }));
  projects = (projects || []).filter(function(p) { return p && p.id && !/^cat_/.test(p.id) && !p.merged_into; });
  var actions = deps.actions || await dossiers.listProjectActions({ limit: 500 });
  var calendar = await loadCalendarEvents(deps, today);
  var since = addDays(today, -HOURS_WINDOW_DAYS);
  for (var i = 0; i < projects.length; i++) {
    var p = projects[i];
    report.considered++;
    var ctx = { today: today, now: now, existing: p.lifecycle_evidence || null, actions: actions, calendar: calendar };
    try { ctx.docs = await dossiers.getProjectDocuments(p.id); } catch(_) { ctx.docs = []; }
    try { ctx.dossier = await dossiers.getDossier(p.id); } catch(_) { ctx.dossier = null; }
    ctx.logs = deps.logsFor ? await deps.logsFor(p.id, since) : await loadRecentLogs(supabase, p.id, since);
    var evidences = evidenceFromSources(p, ctx);
    var a = assess(p, evidences, ctx);
    var item = { project: p.name, id: p.id, status: p.status, state: a.state, reason: a.reason, valid_until: a.evidence ? a.evidence.valid_until : null, applied: false };
    if (a.state === 'operativo') {
      var ex = ctx.existing || {};
      var changed = p.status !== 'active' || ex.state !== 'active' || ex.source_url !== a.evidence.source_url || ex.valid_until !== a.evidence.valid_until;
      if (changed) {
        if (p.status !== 'active') report.activated++; else report.extended++;
        if (opts.apply) {
          try {
            var written = await db.updateProject(p.id, { status: 'active', lifecycle_evidence: a.evidence });
            if (!written) throw new Error('updateProject ha restituito null');
            item.applied = true;
          } catch(e) { item.error = e.message; logger.warn('[LIFECYCLE] scrittura ' + p.name + ' fallita:', e.message); }
        }
      } else item.state = 'operativo (invariato)';
    } else if (/\?$/.test(a.state)) {
      report.proposals++;
      if (opts.notify) item.notified = await notifyProposal(p, a, { deps: deps, supabase: supabase, today: today });
      if (item.notified) report.notified++;
    }
    report.items.push(item);
  }
  logger.info('[LIFECYCLE] ' + report.considered + ' progetti: ' + report.activated + ' attivati, ' + report.extended + ' evidenze aggiornate, ' + report.proposals + ' da confermare' + (opts.apply ? '' : ' (anteprima)'));
  return report;
}

// DM al PM (owner) o agli admin, con i tre bottoni. Gate: 14 giorni per progetto+stato.
async function notifyProposal(project, a, o) {
  var deps = o.deps || {};
  var gate = deps.gate || require('../utils/proactiveGate');
  var app = deps.app !== undefined ? deps.app : (function() { try { return require('../services/slackService').app; } catch(_) { return null; } })();
  if (!app || !app.client) return false;
  var recipients = project.owner_slack_id ? [project.owner_slack_id] : (deps.roles || []).filter(function(r) { return r.role === 'admin'; }).map(function(r) { return r.slack_user_id; });
  var sent = false;
  for (var i = 0; i < recipients.length; i++) {
    var uid = recipients[i];
    if (!gate.notificheEnabled(uid)) continue;
    var hash = gate.itemHash('lifecycle:' + project.id + ':' + a.state);
    var allowed = o.supabase ? await gate.followupAllowed(o.supabase, uid, hash, { cooldownDays: 14, maxAttempts: 2 }) : { allowed: true, attempts: 0 };
    if (!allowed.allowed) continue;
    try {
      await app.client.chat.postMessage({ channel: uid, text: project.name + ': ' + a.reason, blocks: buildProposalBlocks(project, a, o.today) });
      sent = true;
      if (o.supabase) await gate.recordFollowup(o.supabase, uid, hash, 'stato progetto ' + project.name, allowed.attempts);
    } catch(e) { logger.warn('[LIFECYCLE] DM a ' + uid + ' fallito:', e.message); }
  }
  return sent;
}

// ── Decisione esplicita (bottone o comando) ─────────────────────────────────
// source: permalink https del messaggio Slack in cui la decisione è stata presa.
async function recordDecision(projectId, decision, o) {
  o = o || {};
  var deps = o.deps || {};
  var db = deps.db || _db();
  var today = o.today || new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
  if (!isHttps(o.source_url)) return { error: 'Serve il permalink Slack della decisione (https).' };
  var project = await db.getProject(projectId);
  if (!project) return { error: 'Progetto non trovato.' };
  var map = { active: { status: 'active', state: 'active', days: VALIDITY_DAYS.admin, label: 'operativo' }, hold: { status: 'on_hold', state: 'on_hold', days: 180, label: 'sospeso' }, done: { status: 'completed', state: 'completed', days: 3650, label: 'concluso' } };
  var m = map[decision];
  if (!m) return { error: 'Decisione sconosciuta: ' + decision };
  var evidence = { state: m.state, source_url: o.source_url, observed_on: today, valid_until: addDays(today, m.days), kind: 'admin', detail: 'decisione di <@' + o.by + '>', decided_by: o.by || 'admin', updated_at: new Date().toISOString() };
  var updates = { status: m.status, lifecycle_evidence: evidence };
  if (decision === 'done') updates.end_date = today;
  var row = await db.updateProject(projectId, updates);
  if (!row) return { error: 'Aggiornamento fallito.' };
  try { require('../services/projectMatcher').invalidateCatalog && require('../services/projectMatcher').invalidateCatalog(); } catch(_) {}
  return { success: true, project: project.name, label: m.label, valid_until: evidence.valid_until,
    message: decision === 'active' ? project.name + ' segnato operativo fino al ' + evidence.valid_until + ' (poi te lo richiedo se non trovo evidenze nuove).' :
      decision === 'hold' ? project.name + ' sospeso: esce dagli attivi, le ore restano nei consuntivi.' : project.name + ' concluso in data ' + today + '.' };
}

// Bottoni: value = project id; body → canale e ts del messaggio per il permalink.
async function handleLifecycleButton(actionId, projectId, userId, body, deps) {
  deps = deps || {};
  var app = deps.app || require('../services/slackService').app;
  var decision = actionId === 'lifecycle_active' ? 'active' : actionId === 'lifecycle_hold' ? 'hold' : 'done';
  var role = deps.role || (await require('../../rbac').getUserRole(userId));
  var project = await (deps.db || _db()).getProject(projectId);
  if (!project) return 'Progetto non trovato.';
  if (['admin', 'manager'].indexOf(role) === -1 && project.owner_slack_id !== userId) return 'Solo il PM del progetto, un manager o un admin possono decidere lo stato.';
  var permalink = null;
  try {
    var pl = await app.client.chat.getPermalink({ channel: body.channel.id, message_ts: body.message.ts });
    permalink = pl && pl.permalink;
  } catch(e) { logger.warn('[LIFECYCLE] permalink non disponibile:', e.message); }
  var res = await recordDecision(projectId, decision, { source_url: permalink, by: userId, deps: deps });
  return res.error ? '⚠️ ' + res.error : '✅ ' + res.message;
}

function formatReport(r, applied) {
  var lines = ['*Evidenze operative* — ' + r.considered + ' progetti aperti: ' + r.activated + ' da attivare, ' + r.extended + ' evidenze da aggiornare, ' + r.proposals + ' da confermare col PM' + (applied ? ' (applicato)' : ' (anteprima)')];
  var groups = { 'operativo': '▶️ Operativi (evidenza documentale)', 'operativo?': '❓ Probabilmente operativi: chiedo conferma', 'sospeso?': '⏸ Forse fermi', 'concluso?': '✅ Forse conclusi', 'acquisito': '📋 Acquisiti senza evidenze (restano candidati)' };
  Object.keys(groups).forEach(function(k) {
    var its = r.items.filter(function(it) { return it.state === k; });
    if (!its.length) return;
    lines.push('*' + groups[k] + '* (' + its.length + ')');
    its.slice(0, 15).forEach(function(it) { lines.push('• ' + it.project + (it.valid_until ? ' → fino al ' + it.valid_until : '') + ' — _' + it.reason + '_' + (it.error ? ' ⚠️ non scritto: ' + it.error : '')); });
    if (its.length > 15) lines.push('_… e altri ' + (its.length - 15) + '_');
  });
  lines.push('`/giuno admin progetti stato <nome> operativo|sospeso|concluso` decide a mano; `progetti evidenze apply` scrive le attivazioni.');
  return lines.join('\n');
}

module.exports = {
  VALIDITY_DAYS: VALIDITY_DAYS, OPEN_STATUSES: OPEN_STATUSES,
  docDate: docDate, textMentionsProject: textMentionsProject, evidenceFromSources: evidenceFromSources, assess: assess,
  buildProposalBlocks: buildProposalBlocks, refreshLifecycle: refreshLifecycle, notifyProposal: notifyProposal,
  recordDecision: recordDecision, handleLifecycleButton: handleLifecycleButton, formatReport: formatReport,
};
