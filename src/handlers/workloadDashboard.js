// ─── Workload Dashboard ──────────────────────────────────────────────────────
// Pagina direzionale /dashboard/workload + export /export/timelogs.csv.
// HTML zero-dipendenze (CSS inline) in coerenza con la /dashboard esistente.
// Monitoraggio del carico per fascia temporale arbitraria (preset o custom),
// con drill-down su singola risorsa (?user=) e singolo progetto (?project=).
// I dati arrivano da workloadService (daily 16:00 + time_logs), scritti al
// momento del submit: il "tempo reale" è il refresh automatico della pagina.
'use strict';

var db = require('../../supabase');
var dates = require('../utils/trackingDates');
var { isValidISODate } = require('../utils/dates');

// Bande di carico coerenti con standupTools (ok <85%, pieno 85–105%,
// sovraccarico >105%), applicate alla capacità del periodo (8h × workdays).
var BAND_FULL = 0.85;
var BAND_OVER = 1.05;
var REFRESH_SECONDS = 60;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function userLabel(slackUserId) {
  var m = db.findTeamMemberById(slackUserId);
  return m && m.canonical_name ? m.canonical_name : slackUserId;
}

function round1(n) {
  return Math.round((n || 0) * 10) / 10;
}

// ─── Filtri (querystring → range + drill-down) ───────────────────────────────

var PRESETS = ['oggi', 'settimana', 'settimana_scorsa', 'due_settimane', 'mese', 'mese_scorso', 'trimestre'];
var PRESET_LABELS = {
  oggi: 'Oggi', settimana: 'Questa settimana', settimana_scorsa: 'Settimana scorsa',
  due_settimane: 'Ultime 2 settimane', mese: 'Questo mese', mese_scorso: 'Mese scorso',
  trimestre: 'Trimestre',
};

// Pura (testabile senza DB): risolve i parametri della querystring in un
// intervallo [from, to] + filtri sanificati. Precedenza: from/to espliciti
// (→ custom) > ?week= legacy (→ settimana ancorata) > ?range= preset.
// Input invalidi vengono scartati, mai riflessi in output.
function resolveRangeFilters(query, today) {
  query = query || {};
  var user = /^[A-Z0-9]{5,20}$/i.test(String(query.user || '')) ? String(query.user) : null;
  var project = /^[\w-]{1,64}$/.test(String(query.project || '')) ? String(query.project) : null;

  var from = isValidISODate(query.from) ? String(query.from) : null;
  var to = isValidISODate(query.to) ? String(query.to) : null;
  if (from && to) {
    if (from > to) { var tmp = from; from = to; to = tmp; }
    return { from: from, to: to, preset: 'custom', weekAnchor: null, user: user, project: project };
  }

  if (isValidISODate(query.week)) {
    var anchor = dates.weekStartOf(String(query.week));
    return { from: anchor, to: dates.addDays(anchor, 6), preset: 'settimana', weekAnchor: anchor, user: user, project: project };
  }

  var preset = PRESETS.indexOf(String(query.range || '')) >= 0 ? String(query.range) : 'settimana';
  var monday = dates.weekStartOf(today);
  var f = monday, t = dates.addDays(monday, 6);
  if (preset === 'oggi') { f = today; t = today; }
  else if (preset === 'settimana_scorsa') { f = dates.addDays(monday, -7); t = dates.addDays(monday, -1); }
  else if (preset === 'due_settimane') { f = dates.addDays(monday, -7); t = dates.addDays(monday, 6); }
  else if (preset === 'mese') { f = dates.monthStartOf(today); t = dates.monthEndOf(today); }
  else if (preset === 'mese_scorso') { t = dates.addDays(dates.monthStartOf(today), -1); f = dates.monthStartOf(t); }
  else if (preset === 'trimestre') { f = dates.quarterStartOf(today); t = today; } // quarter-to-date
  return {
    from: f, to: t, preset: preset,
    weekAnchor: preset === 'settimana' ? monday : null,
    user: user, project: project,
  };
}

// Querystring da oggetto, saltando i null (i valori sono già sanificati ma
// vengono comunque encodati: finiscono negli href).
function qs(params) {
  var parts = [];
  Object.keys(params).forEach(function(k) {
    if (params[k] == null || params[k] === '') return;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
  });
  return parts.length ? '?' + parts.join('&') : '';
}

// ─── Pagina HTML ─────────────────────────────────────────────────────────────

async function renderWorkloadPage(query) {
  var today = dates.oggiRome();
  var f = resolveRangeFilters(query, today);
  var token = query && query.token ? String(query.token) : null;

  // Catalogo progetti per la select + risoluzione del nome del progetto
  // filtrato (serve al filtro standup, che matcha per nome).
  var projects = await db.searchProjects({ status: 'active', limit: 100 });
  var projectName = null;
  if (f.project) {
    var hit = null;
    for (var i = 0; i < projects.length; i++) { if (projects[i].id === f.project) { hit = projects[i]; break; } }
    if (!hit) { // progetto archiviato o fuori dai primi 100: lookup diretto
      hit = await db.getProject(f.project);
      if (hit) projects.push(hit);
    }
    projectName = hit && hit.name ? hit.name : f.project;
  }

  var workloadService = require('../services/workloadService');
  var overview = await workloadService.getRangeOverview(f.from, f.to, {
    userId: f.user, projectId: f.project, projectName: projectName,
  });
  var byUser = (overview.pva && overview.pva.byUser) || {};
  var byProject = (overview.pva && overview.pva.byProject) || {};

  function pageLink(overrides) {
    var params = { user: f.user, project: f.project, token: token };
    Object.keys(overrides || {}).forEach(function(k) { params[k] = overrides[k]; });
    return '/dashboard/workload' + qs(params);
  }

  // ── Barra filtri: preset + form GET (custom range, risorsa, progetto) ──────
  var presetLinks = PRESETS.map(function(p) {
    var cls = p === f.preset ? ' class="preset active"' : ' class="preset"';
    return '<a' + cls + ' href="' + esc(pageLink({ range: p })) + '">' + esc(PRESET_LABELS[p]) + '</a>';
  }).join(' ');

  var roster = db.getTeamRoster().filter(function(m) { return m && m.active !== false; });
  var rosterHasUser = roster.some(function(m) { return m.slack_user_id === f.user; });
  var userOptions = '<option value="">Tutte le risorse</option>' +
    (f.user && !rosterHasUser ? '<option value="' + esc(f.user) + '" selected>' + esc(userLabel(f.user)) + '</option>' : '') +
    roster.map(function(m) {
      var sel = m.slack_user_id === f.user ? ' selected' : '';
      return '<option value="' + esc(m.slack_user_id) + '"' + sel + '>' + esc(m.canonical_name || m.slack_user_id) + '</option>';
    }).join('');

  var catalogHasProject = projects.some(function(p) { return p.id === f.project; });
  var projectOptions = '<option value="">Tutti i progetti</option>' +
    (f.project && !catalogHasProject ? '<option value="' + esc(f.project) + '" selected>' + esc(projectName || f.project) + '</option>' : '') +
    projects.map(function(p) {
      var sel = p.id === f.project ? ' selected' : '';
      return '<option value="' + esc(p.id) + '"' + sel + '>' + esc(p.name || p.id) + '</option>';
    }).join('');

  var filterForm = '<div class="filters">' +
    '<div class="presets">' + presetLinks + '</div>' +
    '<form method="get" action="/dashboard/workload">' +
    '<label>Dal <input type="date" name="from" value="' + esc(f.from) + '"></label> ' +
    '<label>al <input type="date" name="to" value="' + esc(f.to) + '"></label> ' +
    '<select name="user">' + userOptions + '</select> ' +
    '<select name="project">' + projectOptions + '</select> ' +
    (token ? '<input type="hidden" name="token" value="' + esc(token) + '">' : '') +
    '<button type="submit">Applica</button>' +
    '</form></div>';

  // ── Navigazione settimana (solo in vista settimanale, retrocompatibile) ────
  var weekNav = '';
  if (f.preset === 'settimana') {
    var anchor = f.weekAnchor || f.from;
    weekNav = '<a href="' + esc(pageLink({ week: dates.addDays(anchor, -7) })) + '">← settimana prec.</a> | ' +
      '<a href="' + esc(pageLink({ week: dates.addDays(anchor, 7) })) + '">settimana succ. →</a> | ';
  }

  var csvLink = '/export/timelogs.csv' + qs({ from: f.from, to: f.to, user: f.user, project: f.project, token: token });

  // ── 0. Dichiarato (daily 16:00) vs Consuntivo per risorsa ──────────────────
  // La vista d'insieme che riconcilia i due sistemi: quello che il team
  // dichiara nel daily e quello che finisce nei consuntivi per progetto.
  // Con filtro progetto carico e copertura non sono calcolati/mostrati:
  // le ore sono un sottoinsieme e il giudizio sarebbe fuorviante.
  var CARICO_ICONS = { ok: '🟢', pieno: '🟡', sovraccarico: '🔴' };
  var ovUsers = Object.keys(overview.byUser || {}).sort(function(a, b) {
    return overview.byUser[b].estimated_hours - overview.byUser[a].estimated_hours;
  });
  var showCarico = !f.project;
  var stimeRows = ovUsers.map(function(uid) {
    var u = overview.byUser[uid];
    var row = '<tr><td>' + esc(userLabel(uid)) + '</td>' +
      '<td>' + round1(u.estimated_hours) + 'h' + (showCarico && u.pct_of_tracked_days != null ? ' (' + u.pct_of_tracked_days + '%)' : '') + '</td>' +
      '<td>' + (u.actual_hours > 0 ? round1(u.actual_hours) + 'h' : '—') + '</td>';
    if (showCarico) {
      var icon = u.carico ? (CARICO_ICONS[u.carico] || '') + ' ' + u.carico : '—';
      var copertura = u.days_with_daily + '/' + overview.workdays + ' daily';
      if (u.missing_checkins < overview.workdays) copertura += ' · ' + u.days_with_checkin + '/' + overview.workdays + ' check-in';
      row += '<td>' + icon + '</td><td>' + esc(copertura) + '</td>';
    }
    return row + '</tr>';
  }).join('');
  var stimeTable = ovUsers.length === 0 ? '' :
    '<h2>Ore dichiarate (daily 16:00) per risorsa</h2>' +
    '<p class="note">Dichiarato = tutti i task del daily; consuntivo progetti = la parte agganciata a un progetto (auto-derivata).' +
    (showCarico ? ' Carico sui giorni con daily compilato: 🟢 ok &lt;85% · 🟡 pieno 85–105% · 🔴 sovraccarico &gt;105%' : '') + '</p>' +
    '<table><thead><tr><th>Risorsa</th><th>Dichiarato</th><th>Su progetti</th>' +
    (showCarico ? '<th>Carico</th><th>Copertura</th>' : '') + '</tr></thead>' +
    '<tbody>' + stimeRows + '</tbody></table>';

  // ── 1. Capacità per risorsa: bande scalate al periodo (8h × workdays) ──────
  var capacityH = overview.workdays * 8;
  var users = Object.keys(byUser).sort(function(a, b) { return byUser[b].actual - byUser[a].actual; });
  var maxH = Math.max(capacityH * BAND_OVER || 8, users.reduce(function(m, uid) { return Math.max(m, byUser[uid].actual); }, 0));
  var capacityRows = users.map(function(uid) {
    var actual = byUser[uid].actual;
    var pct = Math.round((actual / maxH) * 100);
    var color = '#7f8c8d';
    if (capacityH > 0) {
      color = actual > capacityH * BAND_OVER ? '#c0392b'
        : (actual >= capacityH * BAND_FULL ? '#e67e22' : '#27ae60');
    }
    var lines = capacityH > 0
      ? '<div class="cap-line" style="left:' + Math.round((capacityH * BAND_FULL / maxH) * 100) + '%" title="' + round1(capacityH * BAND_FULL) + 'h (85%)"></div>' +
        '<div class="cap-line red" style="left:' + Math.round((capacityH * BAND_OVER / maxH) * 100) + '%" title="' + round1(capacityH * BAND_OVER) + 'h (105%)"></div>'
      : '';
    return '<div class="cap-row"><div class="cap-name">' + esc(userLabel(uid)) + '</div>' +
      '<div class="cap-track">' +
      '<div class="cap-bar" style="width:' + pct + '%;background:' + color + '">' + round1(actual) + 'h</div>' +
      lines + '</div></div>';
  }).join('');
  var capacityNote = capacityH > 0
    ? '<p class="note">Capacità del periodo: ' + capacityH + 'h (8h × ' + overview.workdays + ' gg lavorativi). ' +
      'Soglie: <span style="color:#e67e22">' + round1(capacityH * BAND_FULL) + 'h (85%)</span> / ' +
      '<span style="color:#c0392b">' + round1(capacityH * BAND_OVER) + 'h (105%)</span></p>'
    : '<p class="note">Nessun giorno lavorativo nel periodo: soglie di capacità non applicabili.</p>';

  // ── 2. Distribuzione ore per progetto ──────────────────────────────────────
  var projIds = Object.keys(byProject).filter(function(pid) { return byProject[pid].actual > 0; })
    .sort(function(a, b) { return byProject[b].actual - byProject[a].actual; });
  var totalActual = projIds.reduce(function(s, pid) { return s + byProject[pid].actual; }, 0);
  var distRows = projIds.map(function(pid) {
    var p = byProject[pid];
    var pct = totalActual > 0 ? Math.round((p.actual / totalActual) * 100) : 0;
    return '<tr><td><a href="' + esc(pageLink({ from: f.from, to: f.to, project: pid })) + '">' + esc(p.name) + '</a></td>' +
      '<td>' + round1(p.actual) + 'h</td>' +
      '<td><div class="dist-track"><div class="dist-bar" style="width:' + pct + '%"></div></div></td>' +
      '<td>' + pct + '%</td></tr>';
  }).join('');

  // ── 3. Pianificato vs effettivo per utente/progetto ───────────────────────
  // Su range non allineati alla settimana il pianificato (granularità
  // settimanale) include per intero i piani delle settimane che intersecano
  // il periodo: il Δ resta indicativo e le icone di allarme vengono soppresse.
  var weekAligned = overview.week_aligned !== false;
  var pvaRows = users.map(function(uid) {
    var u = byUser[uid];
    var projRows = Object.keys(u.projects).map(function(pid) {
      var p = u.projects[pid];
      var delta = round1(p.actual - p.planned);
      var icon = '';
      if (weekAligned) {
        icon = p.planned > 0 && p.actual >= p.planned * 2 && delta >= 4 ? '🔴'
          : (p.planned === 0 && p.actual >= 4 ? '🟡' : '');
      }
      return '<tr><td></td><td>' + esc(p.name) + '</td><td>' + round1(p.planned) + 'h</td>' +
        '<td>' + round1(p.actual) + 'h</td><td>' + (delta > 0 ? '+' : '') + delta + 'h ' + icon + '</td></tr>';
    }).join('');
    var uDelta = round1(u.actual - u.planned);
    return '<tr class="user-row"><td><b><a href="' + esc(pageLink({ from: f.from, to: f.to, user: uid, project: f.project })) + '">' + esc(userLabel(uid)) + '</a></b></td><td></td>' +
      '<td><b>' + round1(u.planned) + 'h</b></td><td><b>' + round1(u.actual) + 'h</b></td>' +
      '<td><b>' + (uDelta > 0 ? '+' : '') + uDelta + 'h</b></td></tr>' + projRows;
  }).join('');
  var pvaCaveat = weekAligned ? '' :
    '<p class="note">⚠️ Il pianificato è settimanale: include per intero i piani delle settimane che ' +
    'intersecano il periodo — il Δ è indicativo su periodi non allineati alla settimana.</p>';

  // ── Intestazione drill-down (filtri attivi) ────────────────────────────────
  var drilldown = '';
  if (f.project || f.user) {
    var parts = [];
    if (f.user) parts.push('risorsa <b>' + esc(userLabel(f.user)) + '</b>');
    if (f.project) parts.push('progetto <b>' + esc(projectName || f.project) + '</b>');
    var totals = '';
    if (f.project && overview.totals_all && overview.totals_all.actual > 0) {
      var pctTot = Math.round((totalActual / overview.totals_all.actual) * 100);
      totals = ' — ' + round1(totalActual) + 'h effettive nel periodo (' + pctTot + '% del totale team ' +
        round1(overview.totals_all.actual) + 'h)';
    }
    drilldown = '<p class="drill">Filtro attivo: ' + parts.join(' · ') + totals +
      ' — <a href="' + esc(pageLink({ from: f.from, to: f.to, user: null, project: null })) + '">rimuovi filtri</a></p>';
  }

  var empty = users.length === 0 && ovUsers.length === 0
    ? '<p><i>Nessun time log per questo periodo.</i></p>' : '';
  var truncWarning = overview.truncated
    ? '<p class="note">⚠️ Periodo molto ampio: i dati superano il limite di lettura e potrebbero essere incompleti. Restringi il range.</p>' : '';

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Giuno — Workload</title>' +
    '<meta http-equiv="refresh" content="' + REFRESH_SECONDS + '">' +
    '<style>body{font-family:sans-serif;padding:32px;background:#f5f5f5;max-width:900px}' +
    'h1,h2{margin-top:28px}a{color:#2c6}' +
    'table{border-collapse:collapse;width:100%;margin-top:8px}' +
    'th,td{border:1px solid #ccc;padding:6px 12px;text-align:left;font-size:14px}' +
    'th{background:#333;color:#fff}tr.user-row{background:#e8e8e8}' +
    '.note{font-size:13px;color:#666}' +
    '.drill{font-size:14px;background:#fff3cd;padding:8px 12px;border:1px solid #e0d9b0;border-radius:4px}' +
    '.filters{background:#fff;border:1px solid #ddd;border-radius:6px;padding:12px 16px;margin-top:12px}' +
    '.filters form{margin-top:10px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:14px}' +
    '.presets a.preset{display:inline-block;padding:3px 10px;margin:2px;border:1px solid #ccc;border-radius:12px;' +
    'font-size:13px;text-decoration:none;color:#333;background:#eee}' +
    '.presets a.preset.active{background:#2c6;color:#fff;border-color:#2c6}' +
    '.cap-row{display:flex;align-items:center;margin:6px 0}' +
    '.cap-name{width:160px;font-size:14px}' +
    '.cap-track{flex:1;position:relative;background:#ddd;height:26px;border-radius:4px}' +
    '.cap-bar{height:26px;border-radius:4px;color:#fff;font-size:12px;line-height:26px;padding-left:8px;min-width:36px}' +
    '.cap-line{position:absolute;top:-3px;bottom:-3px;width:2px;background:#e67e22}' +
    '.cap-line.red{background:#c0392b}' +
    '.dist-track{background:#ddd;height:14px;border-radius:3px;min-width:120px}' +
    '.dist-bar{background:#2980b9;height:14px;border-radius:3px}' +
    '</style></head><body>' +
    '<h1>Workload — dal ' + esc(f.from) + ' al ' + esc(f.to) + ' (' + overview.workdays + ' gg lavorativi)</h1>' +
    '<p class="note">Ultimo aggiornamento ' + esc(dates.oraRome()) + ' (Europe/Rome) — auto-refresh ogni ' + REFRESH_SECONDS + 's</p>' +
    '<p>' + weekNav +
    '<a href="' + esc(csvLink) + '">Export CSV</a> | ' +
    '<a href="/dashboard' + (token ? qs({ token: token }) : '') + '">Dashboard</a></p>' +
    filterForm +
    drilldown +
    truncWarning +
    empty +
    stimeTable +
    '<h2>Capacità per risorsa (ore consuntivate)</h2>' +
    capacityNote +
    capacityRows +
    '<h2>Distribuzione ore per progetto</h2>' +
    '<table><thead><tr><th>Progetto</th><th>Ore</th><th></th><th>%</th></tr></thead><tbody>' + distRows + '</tbody></table>' +
    '<h2>Pianificato vs effettivo</h2>' +
    pvaCaveat +
    '<table><thead><tr><th>Risorsa</th><th>Progetto</th><th>Pianificato</th><th>Effettivo</th><th>Δ</th></tr></thead><tbody>' + pvaRows + '</tbody></table>' +
    '</body></html>';
}

// ─── Export CSV ──────────────────────────────────────────────────────────────

function csvField(v) {
  var s = String(v == null ? '' : v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

async function renderCsv(query) {
  var today = dates.oggiRome();
  var from = query && isValidISODate(query.from) ? query.from : dates.addDays(today, -30);
  var to = query && isValidISODate(query.to) ? query.to : today;
  // Stessi filtri drill-down della dashboard (sanificati con le stesse whitelist)
  var f = resolveRangeFilters(query, today);
  var rows = await db.getLogsInRange(from, to);
  if (f.user) rows = rows.filter(function(r) { return r.slack_user_id === f.user; });
  if (f.project) rows = rows.filter(function(r) { return r.project_id === f.project; });
  var header = 'log_date,log_type,utente,slack_user_id,progetto,ore,note';
  var lines = rows.map(function(r) {
    return [
      r.log_date, r.log_type, userLabel(r.slack_user_id), r.slack_user_id,
      (r.projects && r.projects.name) || r.project_id, r.hours, r.notes || '',
    ].map(csvField).join(',');
  });
  var suffix = (f.user ? '_' + f.user : '') + (f.project ? '_' + f.project : '');
  return {
    filename: 'timelogs_' + from + '_' + to + suffix + '.csv',
    content: header + '\n' + lines.join('\n') + '\n',
  };
}

module.exports = {
  renderWorkloadPage: renderWorkloadPage,
  renderCsv: renderCsv,
  resolveRangeFilters: resolveRangeFilters,
};
