// ─── Daily Estimator ─────────────────────────────────────────────────────────
// Chi non compila il daily non sparisce dal quadro: Giuno ricostruisce una
// PROPOSTA di daily dalle tracce della giornata e la manda in DM alla persona
// con un bottone "Confermo". Se nemmeno così arriva una risposta, alle 18:00
// la proposta viene salvata come daily STIMATO (source = 'estimate'), ben
// marcato in #daily, e sovrascritta appena la persona compila davvero.
//
// Fonti, in ordine di affidabilità:
//   1. il piano che la persona stessa aveva scritto nel daily precedente
//      ("domani" di ieri) e la pianificazione settimanale (time_logs weekly);
//   2. il calendario di oggi: quello della persona se ha collegato Google,
//      altrimenti i calendari degli admin dove lei risulta invitata;
//   3. i documenti su Drive creati o modificati oggi dalla persona (output
//      prodotti): letti con i token degli admin, quindi valgono per tutti;
//   4. i messaggi scritti oggi nei canali dove c'è Giuno (token del bot) e,
//      se c'è SLACK_USER_TOKEN, la ricerca globale;
//   5. email inviate e ricevute oggi (solo se il Google della persona è collegato).
// Le fonti mancanti si saltano in silenzio: la stima dice da cosa deriva.
// Le fonti di giornata (Drive, Figma, canali, calendari admin) si leggono una
// volta per corsa e valgono per tutte le persone.
//
// Le ORE non le indovina il modello: ogni artefatto ha un orario (revisioni
// Drive, versioni Figma, messaggi, riunioni) e src/agents/activitySessions.js
// li raggruppa in sessioni di lavoro per persona; il modello dà un nome alle
// sessioni e distribuisce le loro durate sui task. Le correzioni della persona
// (src/services/estimateCalibration.js) dicono se per lei tendiamo a stimare
// basso o alto.
//
// Regole ferree per il modello: mai inventare task senza una traccia; ogni
// task ha una durata stimata (riunione = calendario, documento = 1-2h,
// scambio/supporto = 30-60 min), totale ≤ 8h. Le ore stimate entrano nel
// consuntivo marcate come stima finché la persona non conferma o ricompila.

'use strict';

var logger = require('../utils/logger');
var { MODELS } = require('../config/models');
var { safeParse, safeCall } = require('../utils/safeCall');
var { withTimeout } = require('../utils/retryPolicy');
var trackingDates = require('../utils/trackingDates');

var SOURCE_TIMEOUT_MS = 8000;
var REVISION_TIMEOUT_MS = 4000;
var REVISIONS_BUDGET_MS = 60000;
var MODEL_TIMEOUT_MS = 25000;

// ─── Raccolta evidenze ───────────────────────────────────────────────────────

function previousWorkingDay(dateStr) {
  var d = new Date(dateStr + 'T12:00:00Z');
  do { d.setUTCDate(d.getUTCDate() - 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().substring(0, 10);
}

// Inizio/fine del giorno (Europe/Rome) in ISO con offset, per Drive/Calendar/Slack.
function romeDayBounds(dateStr) {
  var probe = new Date(dateStr + 'T12:00:00Z');
  var romeHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false }).format(probe));
  var offset = romeHour - 12; // +1 o +2
  var sign = offset >= 0 ? '+' : '-';
  var off = sign + String(Math.abs(offset)).padStart(2, '0') + ':00';
  var next = new Date(dateStr + 'T12:00:00Z'); next.setUTCDate(next.getUTCDate() + 1);
  return { start: dateStr + 'T00:00:00' + off, end: next.toISOString().slice(0, 10) + 'T00:00:00' + off, offset: off };
}

function emailKey(e) { return String(e || '').toLowerCase().trim(); }
function nameKey(n) { return String(n || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]+/g, ' ').trim(); }

// ─── Contesto di giornata (condiviso tra le persone della stessa corsa) ──────
var _day = { date: null, at: 0, ctx: null };
var DAY_CACHE_MS = 15 * 60000;

async function dayContext(dateStr, deps) {
  deps = deps || {};
  if (deps.dayContext) return deps.dayContext;
  var now = Date.now();
  if (_day.date === dateStr && _day.ctx && (now - _day.at) < DAY_CACHE_MS) return _day.ctx;
  var app = deps.app || require('../services/slackService').app;
  var ctx = { users: [], slackByUser: {}, driveByEmail: {}, driveByName: {}, driveEvents: { byEmail: {}, byName: {} }, figmaByEmail: {}, figmaByName: {}, figmaEvents: { byEmail: {}, byName: {} }, adminEvents: [] };
  await safeCall('ESTIMATE.day.users', async function() {
    var svc = deps.slackService || require('../services/slackService');
    ctx.users = await withTimeout(function() { return svc.getUtenti(); }, SOURCE_TIMEOUT_MS, 'estimate.users');
  });
  await safeCall('ESTIMATE.day.slack_channels', async function() { ctx.slackByUser = await collectSlackChannelActivity(app, dateStr); });
  var scanners = await pickScanners(deps);
  await safeCall('ESTIMATE.day.drive', async function() { var r = await collectDriveActivity(dateStr, scanners, deps); ctx.driveByEmail = r.byEmail; ctx.driveByName = r.byName; ctx.driveEvents = r.events; });
  await safeCall('ESTIMATE.day.figma', async function() { var f = await collectFigmaActivity(dateStr, deps); ctx.figmaByEmail = f.byEmail; ctx.figmaByName = f.byName; ctx.figmaEvents = f.events; });
  await safeCall('ESTIMATE.day.admin_calendar', async function() { ctx.adminEvents = await collectAdminCalendar(dateStr, scanners, deps); });
  // Registro delle posizioni: cartella → progetto, canale → progetto, file Figma → progetto
  await safeCall('ESTIMATE.day.locations', async function() {
    var loc = require('../services/projectLocations');
    var locRowsAll = deps.locations !== undefined ? null : await loc.loadRegistry();
    ctx.locationRows = locRowsAll || [];
    ctx.locations = deps.locations !== undefined ? deps.locations : loc.index(locRowsAll);
  });
  _day = { date: dateStr, at: now, ctx: ctx };
  return ctx;
}

// Chi presta il proprio Google per leggere Drive e calendario di tutti: gli
// admin/manager con token (max 3), altrimenti chiunque abbia il token.
async function pickScanners(deps) {
  var gauth = deps.gauth || require('../services/googleAuthService');
  var tokens = gauth.getUserTokens ? (gauth.getUserTokens() || {}) : {};
  var roles = deps.roles;
  if (!roles) { try { roles = await require('../../rbac').getAllRoles(); } catch(_) { roles = []; } }
  var withToken = Object.keys(tokens);
  var lead = roles.filter(function(r) { return (r.role === 'admin' || r.role === 'manager') && tokens[r.slack_user_id]; }).map(function(r) { return r.slack_user_id; });
  var picked = lead.length ? lead : withToken;
  return picked.slice(0, 3);
}

// Messaggi di oggi nei canali dove Giuno è membro, per autore (token del bot:
// funziona anche senza SLACK_USER_TOKEN). Allegati inclusi come "output".
async function collectSlackChannelActivity(app, dateStr) {
  var byUser = {};
  if (!app || !app.client || !app.client.conversations || !app.client.conversations.list) return byUser;
  var b = romeDayBounds(dateStr);
  var oldest = String(Date.parse(b.start) / 1000), latest = String(Date.parse(b.end) / 1000);
  var channels = [], cursor;
  do {
    var res = await withTimeout(function() { return app.client.conversations.list({ limit: 200, types: 'public_channel,private_channel', exclude_archived: true, cursor: cursor }); }, SOURCE_TIMEOUT_MS, 'estimate.channels');
    channels = channels.concat((res.channels || []).filter(function(c) { return c.is_member; }));
    cursor = res.response_metadata && res.response_metadata.next_cursor;
  } while (cursor && channels.length < 150);
  for (var i = 0; i < channels.length && i < 120; i++) {
    var ch = channels[i];
    try {
      var hist = await withTimeout(function() { return app.client.conversations.history({ channel: ch.id, oldest: oldest, latest: latest, limit: 200, inclusive: true }); }, SOURCE_TIMEOUT_MS, 'estimate.history');
      (hist.messages || []).forEach(function(m) {
        if (!m.user || m.bot_id || (m.subtype && m.subtype !== 'file_share' && m.subtype !== 'thread_broadcast')) return;
        var text = String(m.text || '').replace(/\s+/g, ' ').trim();
        var files = (m.files || []).map(function(f) { return f.title || f.name; }).filter(Boolean);
        if (!text && !files.length) return;
        (byUser[m.user] = byUser[m.user] || []).push({ channel: ch.name || ch.id, channel_id: ch.id, text: text.substring(0, 220), files: files.slice(0, 5), at: m.ts ? new Date(Number(m.ts) * 1000).toISOString() : null });
      });
    } catch(e) { logger.debug('[DAILY-ESTIMATE] history ' + (ch.name || ch.id) + ':', e.message); }
  }
  return byUser;
}

// File su Drive creati/modificati oggi, per ultimo autore (email e nome).
async function collectDriveActivity(dateStr, scanners, deps) {
  var gauth = deps.gauth || require('../services/googleAuthService');
  var b = romeDayBounds(dateStr);
  var seen = {}, byEmail = {}, byName = {}, events = { byEmail: {}, byName: {} };
  var filesForRevisions = [];
  function pushEvent(u, ev) {
    if (u.emailAddress) (events.byEmail[emailKey(u.emailAddress)] = events.byEmail[emailKey(u.emailAddress)] || []).push(ev);
    if (u.displayName) (events.byName[nameKey(u.displayName)] = events.byName[nameKey(u.displayName)] || []).push(ev);
  }
  for (var i = 0; i < scanners.length; i++) {
    var drive = deps.drives ? deps.drives[scanners[i]] : gauth.getDrivePerUtente(scanners[i]);
    if (!drive) continue;
    try {
      var res = await withTimeout(function() {
        return drive.files.list({
          q: "modifiedTime >= '" + b.start + "' and modifiedTime < '" + b.end + "' and trashed = false",
          fields: 'files(id,name,mimeType,modifiedTime,createdTime,webViewLink,parents,lastModifyingUser(emailAddress,displayName))',
          pageSize: 200, orderBy: 'modifiedTime desc', supportsAllDrives: true, includeItemsFromAllDrives: true, corpora: 'allDrives',
        });
      }, SOURCE_TIMEOUT_MS, 'estimate.drive');
      ((res.data && res.data.files) || []).forEach(function(f) {
        if (seen[f.id]) return;
        seen[f.id] = true;
        var u = f.lastModifyingUser || {};
        var item = { name: f.name, type: String(f.mimeType || '').replace(/^application\/vnd\.google-apps\./, '').replace(/^application\//, ''), created_today: String(f.createdTime || '').slice(0, 10) === dateStr, modified_at: f.modifiedTime, link: f.webViewLink || null, folder: (f.parents || [])[0] || null };
        if (u.emailAddress) (byEmail[emailKey(u.emailAddress)] = byEmail[emailKey(u.emailAddress)] || []).push(item);
        if (u.displayName) (byName[nameKey(u.displayName)] = byName[nameKey(u.displayName)] || []).push(item);
        filesForRevisions.push({ drive: drive, file: f, item: item });
      });
    } catch(e) { logger.debug('[DAILY-ESTIMATE] drive ' + scanners[i] + ':', e.message); }
  }
  // Revisioni di oggi per file: ogni salvataggio è un evento con autore e ora
  // (anche chi non è l'ultimo autore). Senza revisions.list resta la sola
  // modifica finale. Limiti: 60 file, 5 richieste in parallelo, 4 s l'una,
  // tutta la scansione entro REVISIONS_BUDGET_MS: il daily delle 16:00 non
  // può aspettare Drive.
  var startMs = Date.parse(b.start), endMs = Date.parse(b.end);
  var deadline = Date.now() + (deps.revisionsBudgetMs != null ? deps.revisionsBudgetMs : REVISIONS_BUDGET_MS);
  var queue = filesForRevisions.slice(0, 60);
  async function scanOne(fr) {
    var revs = [];
    if (fr.drive.revisions && fr.drive.revisions.list && Date.now() < deadline) {
      try {
        var rr = await withTimeout(function() { return fr.drive.revisions.list({ fileId: fr.file.id, fields: 'revisions(id,modifiedTime,lastModifyingUser(emailAddress,displayName))', pageSize: 200 }); }, REVISION_TIMEOUT_MS, 'estimate.revisions');
        revs = ((rr.data && rr.data.revisions) || []).filter(function(v) { var t = Date.parse(v.modifiedTime); return isFinite(t) && t >= startMs && t < endMs; });
      } catch(e) { logger.debug('[DAILY-ESTIMATE] revisions ' + fr.file.name + ':', e.message); }
    }
    if (!revs.length && fr.file.modifiedTime) revs = [{ modifiedTime: fr.file.modifiedTime, lastModifyingUser: fr.file.lastModifyingUser }];
    revs.forEach(function(v) { pushEvent(v.lastModifyingUser || {}, { at: v.modifiedTime, kind: 'drive', name: fr.file.name, link: fr.item.link, folder: fr.item.folder }); });
  }
  for (var q = 0; q < queue.length; q += 5) {
    await Promise.all(queue.slice(q, q + 5).map(scanOne));
  }
  return { byEmail: byEmail, byName: byName, events: events };
}

// Unione di due bucket (per email e per nome) senza doppioni.
function unionBy(a, b, keyFn) {
  var seen = {}, out = [];
  (a || []).concat(b || []).forEach(function(x) { var k = keyFn(x); if (seen[k]) return; seen[k] = true; out.push(x); });
  return out;
}
function itemKey(x) { return (x.kind || x.type || '') + '|' + (x.name || '') + '|' + (x.modified_at || ''); }
function eventKey(x) { return (x.kind || '') + '|' + (x.at || '') + '|' + (x.name || x.channel || ''); }

// File Figma modificati oggi e le loro versioni (autore + ora). Serve
// FIGMA_TOKEN (personal access token) e FIGMA_TEAM_ID; senza, si salta.
async function collectFigmaActivity(dateStr, deps) {
  var token = (deps.env || process.env).FIGMA_TOKEN;
  var teamId = (deps.env || process.env).FIGMA_TEAM_ID;
  var out = { byEmail: {}, byName: {}, events: { byEmail: {}, byName: {} }, files: [] };
  if (!token || !teamId) return out;
  var doFetch = deps.fetch || global.fetch;
  var b = romeDayBounds(dateStr);
  var startMs = Date.parse(b.start), endMs = Date.parse(b.end);
  async function api(path) {
    var res = await withTimeout(function() { return doFetch('https://api.figma.com/v1' + path, { headers: { 'X-Figma-Token': token } }); }, SOURCE_TIMEOUT_MS, 'estimate.figma');
    if (!res.ok) throw new Error('Figma ' + res.status + ' su ' + path);
    return res.json();
  }
  var projects = ((await api('/teams/' + encodeURIComponent(teamId) + '/projects')).projects || []).slice(0, 40);
  var files = [];
  for (var i = 0; i < projects.length; i++) {
    try {
      var pf = (await api('/projects/' + projects[i].id + '/files')).files || [];
      pf.forEach(function(f) { var t = Date.parse(f.last_modified); if (t >= startMs && t < endMs) files.push({ key: f.key, name: f.name, project: projects[i].name, project_id: String(projects[i].id), last_modified: f.last_modified }); });
    } catch(e) { logger.debug('[DAILY-ESTIMATE] figma project ' + projects[i].name + ':', e.message); }
  }
  for (var j = 0; j < files.length && j < 40; j++) {
    var f = files[j];
    var link = 'https://www.figma.com/file/' + f.key;
    try {
      var versions = ((await api('/files/' + f.key + '/versions')).versions || []).filter(function(v) { var t = Date.parse(v.created_at); return t >= startMs && t < endMs; });
      versions.forEach(function(v) {
        var u = v.user || {};
        var item = { name: f.name, project: f.project, figma_project_id: f.project_id, file_key: f.key, type: 'figma', modified_at: v.created_at, link: link };
        var ev = { at: v.created_at, kind: 'figma', name: f.name, link: link, figma_project_id: f.project_id, file_key: f.key };
        if (u.email) { var ek = emailKey(u.email); (out.byEmail[ek] = out.byEmail[ek] || []); if (!out.byEmail[ek].some(function(x) { return x.name === f.name; })) out.byEmail[ek].push(item); (out.events.byEmail[ek] = out.events.byEmail[ek] || []).push(ev); }
        if (u.handle) { var nk = nameKey(u.handle); (out.byName[nk] = out.byName[nk] || []); if (!out.byName[nk].some(function(x) { return x.name === f.name; })) out.byName[nk].push(item); (out.events.byName[nk] = out.events.byName[nk] || []).push(ev); }
      });
      out.files.push(f);
    } catch(e) { logger.debug('[DAILY-ESTIMATE] figma versions ' + f.name + ':', e.message); }
  }
  return out;
}

// Eventi di oggi nei calendari degli admin: chi è invitato (email) li eredita
// anche senza avere collegato il proprio Google.
async function collectAdminCalendar(dateStr, scanners, deps) {
  var gauth = deps.gauth || require('../services/googleAuthService');
  var b = romeDayBounds(dateStr);
  var seen = {}, out = [];
  for (var i = 0; i < scanners.length; i++) {
    var cal = deps.calendars ? deps.calendars[scanners[i]] : gauth.getCalendarPerUtente(scanners[i]);
    if (!cal) continue;
    try {
      var res = await withTimeout(function() { return cal.events.list({ calendarId: 'primary', timeMin: new Date(b.start).toISOString(), timeMax: new Date(b.end).toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 50 }); }, SOURCE_TIMEOUT_MS, 'estimate.admin_calendar');
      ((res.data && res.data.items) || []).forEach(function(e) {
        var key = e.iCalUID || e.id;
        if (!key || seen[key] || !e.start || !e.end || !e.start.dateTime) return;
        seen[key] = true;
        out.push({ title: e.summary || '(senza titolo)', start: e.start.dateTime, end: e.end.dateTime,
          minutes: Math.round((Date.parse(e.end.dateTime) - Date.parse(e.start.dateTime)) / 60000),
          attendees: (e.attendees || []).filter(function(a) { return a.responseStatus !== 'declined'; }).map(function(a) { return emailKey(a.email); }) });
      });
    } catch(e) { logger.debug('[DAILY-ESTIMATE] calendario admin ' + scanners[i] + ':', e.message); }
  }
  return out;
}

function findUser(ctx, userId) { return (ctx.users || []).find(function(u) { return u.id === userId; }) || null; }

async function collectEvidence(userId, dateStr, deps) {
  deps = deps || {};
  var db = deps.db || require('../../supabase');
  var app = deps.app || require('../services/slackService').app;
  var evidence = { date: dateStr, sources: [], plan_yesterday: [], weekly_plan: [], calendar: [], slack: [], channels: [], drive: [], figma: [], emails: [], sent: [], sessions: [], calibration: null };
  var ctx = await dayContext(dateStr, deps);
  var me = findUser(ctx, userId);
  var myEmail = me && me.email ? emailKey(me.email) : null;
  var myName = me ? nameKey(me.name) : null;

  // 1a. "Domani" scritto nel daily precedente
  await safeCall('ESTIMATE.plan_yesterday', async function() {
    var supabase = require('../services/db/client').getClient();
    if (!supabase) return;
    var prev = previousWorkingDay(dateStr);
    var res = await withTimeout(function() {
      return supabase.from('standup_entries').select('domani_tasks, source')
        .eq('slack_user_id', userId).eq('date', prev).limit(1);
    }, SOURCE_TIMEOUT_MS, 'estimate.plan_yesterday');
    var row = res && res.data && res.data[0];
    if (row && Array.isArray(row.domani_tasks) && row.domani_tasks.length > 0 && row.source !== 'estimate') {
      evidence.plan_yesterday = row.domani_tasks.map(function(t) {
        return { task: t.task, hours: t.hours || 0, minutes: t.minutes || 0, project: t.project_name || null };
      });
      evidence.sources.push('piano di ieri');
    }
  });

  // 1b. Pianificazione settimanale (ore per progetto)
  await safeCall('ESTIMATE.weekly_plan', async function() {
    var weekStart = trackingDates.weekStartOf(dateStr);
    var logs = await withTimeout(function() { return db.getLogsForUserDate(userId, weekStart, 'weekly'); }, SOURCE_TIMEOUT_MS, 'estimate.weekly');
    if (!logs || logs.length === 0) return;
    var rows = [];
    for (var i = 0; i < logs.length && i < 12; i++) {
      var name = logs[i].project_id;
      try { var p = await db.getProject(logs[i].project_id); if (p && p.name) name = p.name; } catch(_) {}
      rows.push({ project: name, hours_week: Number(logs[i].hours) || 0 });
    }
    if (rows.length) { evidence.weekly_plan = rows; evidence.sources.push('pianificazione settimanale'); }
  });

  // 2. Calendario di oggi
  await safeCall('ESTIMATE.calendar', async function() {
    var calendarTools = require('../tools/calendarTools');
    var res = await withTimeout(function() {
      return calendarTools.execute('find_event', { date_from: dateStr + 'T00:00:00', date_to: dateStr + 'T23:59:59' }, userId);
    }, SOURCE_TIMEOUT_MS, 'estimate.calendar');
    if (!res || res.error || !Array.isArray(res.events) || res.events.length === 0) return;
    evidence.calendar = res.events.slice(0, 12).map(function(e) {
      var start = e.start ? new Date(e.start) : null;
      var end = e.end ? new Date(e.end) : null;
      var mins = (start && end && !isNaN(start) && !isNaN(end)) ? Math.round((end - start) / 60000) : null;
      return { title: e.title, start: e.start, minutes: mins, attendees: (e.attendees || []).length };
    });
    evidence.sources.push('calendario');
  });
  // 2b. Senza Google collegato: riunioni degli admin dove la persona è invitata
  if (!evidence.calendar.length && myEmail && (ctx.adminEvents || []).length) {
    evidence.calendar = ctx.adminEvents.filter(function(e) { return e.attendees.indexOf(myEmail) !== -1; }).slice(0, 12)
      .map(function(e) { return { title: e.title, start: e.start, minutes: e.minutes, attendees: e.attendees.length }; });
    if (evidence.calendar.length) evidence.sources.push('calendario (inviti)');
  }

  // 2c. Documenti su Drive creati/modificati oggi dalla persona (output prodotti)
  var mine = unionBy(myEmail && ctx.driveByEmail[myEmail], myName && ctx.driveByName[myName], itemKey);
  if (mine.length) {
    evidence.drive = mine.slice(0, 15);
    evidence.sources.push('documenti Drive');
  }

  // 2d. Messaggi di oggi nei canali con Giuno (token del bot)
  var chan = ctx.slackByUser[userId] || [];
  if (chan.length) {
    evidence.channels = chan.slice(0, 40);
    evidence.sources.push('messaggi nei canali');
  }

  // 2e. File Figma con versioni salvate oggi dalla persona
  var fig = unionBy(myEmail && ctx.figmaByEmail && ctx.figmaByEmail[myEmail], myName && ctx.figmaByName && ctx.figmaByName[myName], itemKey);
  if (fig.length) {
    evidence.figma = fig.slice(0, 15);
    evidence.sources.push('file Figma');
  }

  // 2f. Progetto per POSIZIONE (registro cartelle/canali/Figma) su documenti, messaggi e file
  var locations = ctx.locations || null;
  var lookup = require('../services/projectLocations').lookup;
  function projectOf(kind, ref) { var p = locations && ref ? lookup(locations, kind, ref) : null; return p && p.name ? p.name : null; }
  evidence.drive.forEach(function(d) { d.project = d.project || projectOf('drive_folder', d.folder); });
  evidence.channels.forEach(function(m) { m.project = m.project || projectOf('slack_channel', m.channel_id); });
  evidence.figma.forEach(function(d) { d.project_hint = projectOf('figma_file', d.file_key) || projectOf('figma_project', d.figma_project_id) || null; });
  evidence.locationRows = ctx.locationRows || [];
  // Riunioni: prima il cliente/commessa nel titolo ("Riunione con Antonio per Elios" → Elios),
  // poi le attività trasversali (daily, management, team building…); altrimenti nessun tag.
  var matcherSvc = require('../services/projectMatcher');
  var catalogForCal = deps.catalog || ctx.catalog || [];
  if (!deps.catalog && !ctx.catalog) { try { catalogForCal = await matcherSvc.getCatalog(); ctx.catalog = catalogForCal; } catch(_) {} }
  evidence.calendar.forEach(function(e) { if (!e.project) { var r = matcherSvc.resolveTask(e.title, catalogForCal); if (r) e.project = r.name; } });

  // 2g. Sessioni di lavoro dai timestamp di tutto quanto sopra
  var sessions = require('./activitySessions');
  var events = [];
  var dEv = ctx.driveEvents || { byEmail: {}, byName: {} };
  var fEv = ctx.figmaEvents || { byEmail: {}, byName: {} };
  unionBy(myEmail && dEv.byEmail[myEmail], myName && dEv.byName[myName], eventKey).forEach(function(e) { events.push(Object.assign({}, e, { project: projectOf('drive_folder', e.folder) })); });
  unionBy(myEmail && fEv.byEmail[myEmail], myName && fEv.byName[myName], eventKey).forEach(function(e) { events.push(Object.assign({}, e, { project: projectOf('figma_file', e.file_key) || projectOf('figma_project', e.figma_project_id) })); });
  chan.forEach(function(m) { if (m.at) events.push({ at: m.at, kind: 'slack', channel: m.channel, name: null, project: m.project || null }); });
  evidence.calendar.forEach(function(e) { if (e.start && e.minutes) events.push({ at: e.start, kind: 'calendar', name: e.title, minutes: e.minutes, project: e.project || null }); });
  evidence.sessions = sessions.buildSessions(events);
  if (evidence.sessions.length) evidence.sources.push('sessioni di lavoro');

  // 2h. Storico delle correzioni della persona
  await safeCall('ESTIMATE.calibration', async function() {
    var cal = deps.calibration !== undefined ? deps.calibration : await require('../services/estimateCalibration').getCalibration(userId);
    if (cal) evidence.calibration = cal;
  });

  // 3. Messaggi Slack scritti oggi dalla persona
  await safeCall('ESTIMATE.slack', async function() {
    var token = process.env.SLACK_USER_TOKEN;
    if (!token || !app || !app.client) return;
    var res = await withTimeout(function() {
      return app.client.search.messages({
        token: token, query: 'from:<@' + userId + '> on:' + dateStr, count: 40, sort: 'timestamp', sort_dir: 'desc',
      });
    }, SOURCE_TIMEOUT_MS, 'estimate.slack');
    var matches = (res && res.messages && res.messages.matches) || [];
    if (matches.length === 0) return;
    evidence.slack = matches.slice(0, 40).map(function(m) {
      return { channel: (m.channel && m.channel.name) || '?', text: String(m.text || '').replace(/\s+/g, ' ').substring(0, 220) };
    });
    evidence.sources.push('messaggi Slack');
  });

  // 4. Email di oggi (solo oggetto/mittente)
  await safeCall('ESTIMATE.emails', async function() {
    var gmailTools = require('../tools/gmailTools');
    var res = await withTimeout(function() {
      return gmailTools.execute('find_emails', { query: 'newer_than:1d -category:promotions', max: 15 }, userId);
    }, SOURCE_TIMEOUT_MS, 'estimate.emails');
    if (!res || res.error || !Array.isArray(res.emails) || res.emails.length === 0) return;
    evidence.emails = res.emails.map(function(e) {
      return { subject: String(e.subject || '').substring(0, 120), from: String(e.from || '').substring(0, 60) };
    });
    evidence.sources.push('email');
  });
  // 4b. Email INVIATE oggi: sono output, pesano più di quelle ricevute
  await safeCall('ESTIMATE.sent', async function() {
    var gmailTools = require('../tools/gmailTools');
    var res = await withTimeout(function() {
      return gmailTools.execute('find_emails', { query: 'in:sent newer_than:1d', max: 15 }, userId);
    }, SOURCE_TIMEOUT_MS, 'estimate.sent');
    if (!res || res.error || !Array.isArray(res.emails) || res.emails.length === 0) return;
    evidence.sent = res.emails.map(function(e) {
      return { subject: String(e.subject || '').substring(0, 120), to: String(e.to || '').substring(0, 60) };
    });
    evidence.sources.push('email inviate');
  });

  return evidence;
}

function hasUsableEvidence(evidence) {
  if (!evidence) return false;
  return ['plan_yesterday', 'weekly_plan', 'calendar', 'slack', 'channels', 'drive', 'figma', 'emails', 'sent'].some(function(k) { return Array.isArray(evidence[k]) && evidence[k].length > 0; });
}

// ─── Stima col modello ───────────────────────────────────────────────────────

var SYSTEM_PROMPT =
  'Ricostruisci il daily di un membro di un\'agenzia creativa italiana che NON lo ha compilato, a partire dalle tracce della sua giornata. ' +
  'Il daily ha tre parti: "oggi" (lavoro FATTO oggi con ore), "domani" (piano), "blocchi".\n' +
  'Rispondi SOLO con JSON valido:\n' +
  '{"oggi":[{"task":"descrizione breve","hours":N,"minutes":N,"project":"nome del progetto o null","basis":"da dove viene"}],"domani":[{"task":"...","hours":0,"minutes":0,"project":null}],"blocchi":null,"confidence":"alta|media|bassa","note":"una frase su cosa manca"}\n' +
  'Regole:\n' +
  '- Ogni task in "oggi" deve avere una traccia concreta (riunione in calendario, documento creato o modificato su Drive, allegato o messaggio Slack, email inviata, piano scritto ieri). Niente task inventati.\n' +
  '- Se ci sono SESSIONI DI LAVORO ricostruite dai timestamp, le ore vengono da lì: la somma delle durate dei task deve avvicinarsi al totale delle sessioni, e ogni sessione va attribuita al task che le sue tracce indicano (documento, file Figma, canale, riunione). Le sessioni non coperte da alcuna traccia leggibile diventano un task generico sul progetto del canale o del file.\n' +
  '- Ore: OGNI task in "oggi" ha una durata stimata, mai 0. Riunioni: la durata del calendario. Documento creato oggi: 2h (presentazioni, fogli, video) o 1h (doc brevi); documento solo modificato: 1h. Email inviata o scambio Slack su un tema: 30 min; supporto/troubleshooting: 1h. Task dal piano di ieri: le ore pianificate. Raggruppa le tracce dello stesso tema in un solo task.\n' +
  '- Totale "oggi" mai sopra 8 ore: se lo superi, riduci in proporzione. Preferisci poche righe solide a molte righe deboli.\n' +
  '- Il numero dei messaggi non misura il lavoro: conta il tema e l\'output, non il volume.\n' +
  '- Se c\'è uno STORICO DELLE STIME per la persona, correggi le durate dedotte nella direzione indicata.\n' +
  '- "project": quando una traccia porta l\'indicazione [progetto: X] (cartella, canale o file di quel progetto), copia X nel campo project del task; altrimenti null. Non dedurre il progetto dal solo nome se c\'è un\'indicazione di posizione diversa.\n' +
  '- "domani": solo se emerge da piano settimanale o messaggi; altrimenti lista vuota.\n' +
  '- "blocchi": solo se un messaggio lo dice esplicitamente.\n' +
  '- confidence "alta" solo con calendario o documenti che confermano; "media" con messaggi o email; "bassa" se hai solo piano/settimanale o se le durate sono dedotte.\n' +
  '- Se le tracce non bastano per nessun task: {"oggi":[],"domani":[],"blocchi":null,"confidence":"bassa","note":"..."}.';

function buildPrompt(evidence) {
  var parts = ['DATA: ' + evidence.date];
  if (evidence.plan_yesterday.length) {
    parts.push('PIANO SCRITTO IERI PER OGGI:\n' + evidence.plan_yesterday.map(function(t) {
      return '- ' + t.task + (t.hours || t.minutes ? ' (' + (t.hours ? t.hours + 'h' : '') + (t.minutes ? t.minutes + 'min' : '') + ')' : '') + (t.project ? ' [' + t.project + ']' : '');
    }).join('\n'));
  }
  if (evidence.weekly_plan.length) {
    parts.push('PIANIFICAZIONE DELLA SETTIMANA (ore totali per progetto):\n' + evidence.weekly_plan.map(function(r) {
      return '- ' + r.project + ': ' + r.hours_week + 'h';
    }).join('\n'));
  }
  if (evidence.calendar.length) {
    parts.push('CALENDARIO DI OGGI:\n' + evidence.calendar.map(function(e) {
      return '- ' + (e.title || '(senza titolo)') + (e.minutes ? ' — ' + e.minutes + ' min' : '') + (e.attendees ? ', ' + e.attendees + ' partecipanti' : '') + (e.project ? ' [progetto: ' + e.project + ']' : '');
    }).join('\n'));
  }
  if (evidence.drive && evidence.drive.length) {
    parts.push('DOCUMENTI SU DRIVE CREATI O MODIFICATI OGGI DALLA PERSONA (output prodotti):\n' + evidence.drive.map(function(d) {
      return '- ' + d.name + ' (' + (d.type || 'file') + (d.created_today ? ', creato oggi' : ', modificato') + (d.modified_at ? ' alle ' + String(d.modified_at).slice(11, 16) : '') + ')' + (d.project ? ' [progetto: ' + d.project + ']' : '');
    }).join('\n'));
  }
  if (evidence.figma && evidence.figma.length) {
    parts.push('FILE FIGMA CON VERSIONI SALVATE OGGI DALLA PERSONA:\n' + evidence.figma.map(function(d) {
      return '- ' + d.name + (d.project ? ' (progetto Figma: ' + d.project + ')' : '') + (d.project_hint ? ' [progetto: ' + d.project_hint + ']' : '');
    }).join('\n'));
  }
  if (evidence.sessions && evidence.sessions.length) {
    var sess = require('./activitySessions');
    var off = Number(String(romeDayBounds(evidence.date).offset).slice(0, 3)) * 60;
    parts.push('SESSIONI DI LAVORO RICOSTRUITE DAI TIMESTAMP (totale ' + sess.fmtMinutes(sess.totalMinutes(evidence.sessions)) + '):\n' + sess.formatSessions(evidence.sessions, off));
  }
  if (evidence.calibration && evidence.calibration.hint) {
    parts.push('STORICO DELLE STIME PER QUESTA PERSONA: ' + evidence.calibration.hint);
  }
  if (evidence.slack.length) {
    parts.push('MESSAGGI SLACK SCRITTI OGGI (' + evidence.slack.length + '):\n' + evidence.slack.map(function(m) {
      return '- [#' + m.channel + '] ' + m.text;
    }).join('\n'));
  }
  if (evidence.channels && evidence.channels.length) {
    parts.push('MESSAGGI E ALLEGATI DI OGGI NEI CANALI (' + evidence.channels.length + '):\n' + evidence.channels.map(function(m) {
      return '- [#' + m.channel + (m.project ? ' → progetto: ' + m.project : '') + '] ' + (m.text || '') + (m.files && m.files.length ? ' [allegati: ' + m.files.join(', ') + ']' : '');
    }).join('\n'));
  }
  if (evidence.sent && evidence.sent.length) {
    parts.push('EMAIL INVIATE OGGI (oggetti):\n' + evidence.sent.map(function(e) {
      return '- ' + e.subject + (e.to ? ' (a ' + e.to + ')' : '');
    }).join('\n'));
  }
  if (evidence.emails.length) {
    parts.push('EMAIL DI OGGI (oggetti):\n' + evidence.emails.map(function(e) {
      return '- ' + e.subject + (e.from ? ' (da ' + e.from + ')' : '');
    }).join('\n'));
  }
  return parts.join('\n\n');
}

async function estimateDaily(userId, dateStr, deps) {
  deps = deps || {};
  var evidence = await collectEvidence(userId, dateStr, deps);
  if (!hasUsableEvidence(evidence)) {
    logger.info('[DAILY-ESTIMATE] nessuna traccia per', userId, dateStr);
    return null;
  }
  var client = deps.client || new (require('@anthropic-ai/sdk'))();
  var res = await withTimeout(function() {
    return client.messages.create({
      model: MODELS.UTILITY, max_tokens: 900, system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildPrompt(evidence) }],
    });
  }, MODEL_TIMEOUT_MS, 'estimate.model');
  var text = (res.content || []).filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('');
  var m = text.match(/\{[\s\S]*\}/);
  var parsed = m ? safeParse('DAILY-ESTIMATE', m[0], null) : null;
  if (!parsed) return null;

  var { normalizeParsed } = require('../services/dailyParser');
  var structured = normalizeParsed(parsed);
  if (!structured) return null;
  // Nessun task del fatto resta a 0: un'attività con una traccia vale almeno
  // 30 minuti (stima), altrimenti il consuntivo la perde.
  var floored = 0;
  (structured.oggi || []).forEach(function(t) {
    if (!(Number(t.hours) > 0) && !(Number(t.minutes) > 0)) { t.hours = 0; t.minutes = 30; floored++; }
  });
  if (floored) structured.totalOggi = Math.round(structured.oggi.reduce(function(s, t) { return s + (Number(t.hours) || 0) * 60 + (Number(t.minutes) || 0); }, 0) / 60 * 100) / 100;
  // Tetto 8h sul fatto: la stima non deve mai gonfiare il carico.
  if (structured.totalOggi > 8) {
    var scale = 8 / structured.totalOggi;
    structured.oggi.forEach(function(t) {
      var mins = Math.round((t.hours * 60 + t.minutes) * scale / 15) * 15;
      t.hours = Math.floor(mins / 60); t.minutes = mins % 60;
    });
    structured.totalOggi = Math.round(structured.oggi.reduce(function(s, t) { return s + t.hours * 60 + t.minutes; }, 0) / 60 * 100) / 100;
  }
  // Progetto indicato dal modello (da [progetto: X]) → agganciato al catalogo per nome esatto
  try {
    var hints = {};
    (parsed.oggi || []).concat(parsed.domani || []).forEach(function(t) { if (t && t.task && typeof t.project === 'string' && t.project.trim()) hints[String(t.task).trim().substring(0, 300)] = t.project.trim(); });
    if (Object.keys(hints).length) {
      var locSvc = require('../services/projectLocations');
      var locRows = deps.locationRows || evidence.locationRows || [];
      var catalog = await require('../services/projectMatcher').getCatalog();
      (structured.oggi || []).concat(structured.domani || []).forEach(function(t) {
        var h = hints[t.task];
        if (!h || t.project_id) return;
        // Prima il registro (stesso nome che abbiamo scritto nel prompt), poi il catalogo, con la stessa normalizzazione
        var p = locSvc.projectIdForName(locRows, h) || (function() { var k = locSvc.norm(h); var c = catalog.find(function(x) { return locSvc.norm(x.name) === k; }); return c ? { id: c.id, name: c.name } : null; })();
        if (p) { t.project_id = p.id; t.project_name = p.name; }
      });
    }
  } catch(e) { logger.debug('[DAILY-ESTIMATE] project hints:', e.message); }
  try { await require('../services/projectMatcher').enrichStructured(structured, { date: dateStr, userId: userId }); } catch(e) { logger.debug('[DAILY-ESTIMATE] project match:', e.message); }

  structured.estimate = {
    sessions_minutes: require('./activitySessions').totalMinutes(evidence.sessions),
    calibration: evidence.calibration ? { n: evidence.calibration.n, ratio: evidence.calibration.ratio } : null,
    confidence: /^(alta|media|bassa)$/.test(String(parsed.confidence || '')) ? parsed.confidence : 'bassa',
    note: typeof parsed.note === 'string' ? parsed.note.substring(0, 200) : '',
    sources: evidence.sources.slice(),
    generated_at: new Date().toISOString(),
  };
  logger.info('[DAILY-ESTIMATE]', userId, dateStr, '→', structured.oggi.length, 'task oggi,', structured.domani.length, 'domani | fonti:', evidence.sources.join(', '), '| confidence:', structured.estimate.confidence);
  return structured;
}

// ─── Testo ───────────────────────────────────────────────────────────────────

function fmtDur(t) {
  if (!t.hours && !t.minutes) return '';
  return ' ' + (t.hours ? t.hours + 'h' : '') + (t.minutes ? t.minutes + 'min' : '');
}

// Corpo del daily come lo scriverebbe la persona (usato come raw_text della
// entry e come testo del DM/post).
function formatEstimateBody(structured) {
  var lines = [];
  if (structured.oggi && structured.oggi.length) {
    lines.push('*Oggi:*');
    structured.oggi.forEach(function(t) { lines.push('• ' + t.task + fmtDur(t) + (t.activity_name ? ' _(' + t.activity_name + ')_' : '')); });
  }
  if (structured.domani && structured.domani.length) {
    lines.push('*Domani:*');
    structured.domani.forEach(function(t) { lines.push('• ' + t.task + fmtDur(t)); });
  }
  if (structured.blocchi) lines.push('*Blocchi:* ' + structured.blocchi);
  return lines.join('\n');
}

function formatSourcesLine(structured) {
  var e = (structured && structured.estimate) || {};
  var src = (e.sources || []).join(', ') || 'nessuna fonte';
  return 'Ricostruito da: ' + src + ' · affidabilità ' + (e.confidence || 'bassa') + (e.note ? ' · ' + e.note : '');
}

module.exports = {
  romeDayBounds: romeDayBounds,
  dayContext: dayContext,
  collectSlackChannelActivity: collectSlackChannelActivity,
  collectDriveActivity: collectDriveActivity,
  collectAdminCalendar: collectAdminCalendar,
  collectFigmaActivity: collectFigmaActivity,
  collectEvidence: collectEvidence,
  hasUsableEvidence: hasUsableEvidence,
  buildPrompt: buildPrompt,
  estimateDaily: estimateDaily,
  formatEstimateBody: formatEstimateBody,
  formatSourcesLine: formatSourcesLine,
  previousWorkingDay: previousWorkingDay,
  SYSTEM_PROMPT: SYSTEM_PROMPT,
};
