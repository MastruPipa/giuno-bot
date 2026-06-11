// ─── Workload Dashboard ──────────────────────────────────────────────────────
// Pagina direzionale /dashboard/workload + export /export/timelogs.csv.
// HTML zero-dipendenze (CSS inline) in coerenza con la /dashboard esistente.
// Grafici della spec: capacità per risorsa (soglie 40h rossa / 33h gialla),
// distribuzione ore per progetto, pianificato vs effettivo.
'use strict';

var db = require('../../supabase');
var dates = require('../utils/trackingDates');

var CAPACITY_RED = 40;
var CAPACITY_YELLOW = 33;

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

// ─── Pagina HTML ─────────────────────────────────────────────────────────────

async function renderWorkloadPage(query) {
  var weekParam = query && /^\d{4}-\d{2}-\d{2}$/.test(String(query.week || '')) ? query.week : null;
  var weekStart = weekParam ? dates.weekStartOf(weekParam) : dates.weekStartOf(dates.oggiRome());
  var weekEnd = dates.addDays(weekStart, 6);
  var prevWeek = dates.addDays(weekStart, -7);
  var nextWeek = dates.addDays(weekStart, 7);

  var data = await db.getPlannedVsActual(weekStart);
  var byUser = data.byUser || {};
  var byProject = data.byProject || {};
  var tokenParam = query && query.token ? '&token=' + encodeURIComponent(query.token) : '';

  function weekLink(w) { return '/dashboard/workload?week=' + w + tokenParam; }

  // ── 1. Capacità per risorsa (istogramma orizzontale CSS) ───────────────────
  var users = Object.keys(byUser).sort(function(a, b) { return byUser[b].actual - byUser[a].actual; });
  var maxH = Math.max(CAPACITY_RED, users.reduce(function(m, uid) { return Math.max(m, byUser[uid].actual); }, 0));
  var capacityRows = users.map(function(uid) {
    var actual = byUser[uid].actual;
    var pct = Math.round((actual / maxH) * 100);
    var color = actual > CAPACITY_RED ? '#c0392b' : (actual > CAPACITY_YELLOW ? '#e67e22' : '#27ae60');
    return '<div class="cap-row"><div class="cap-name">' + esc(userLabel(uid)) + '</div>' +
      '<div class="cap-track">' +
      '<div class="cap-bar" style="width:' + pct + '%;background:' + color + '">' + round1(actual) + 'h</div>' +
      '<div class="cap-line" style="left:' + Math.round((CAPACITY_YELLOW / maxH) * 100) + '%" title="33h"></div>' +
      '<div class="cap-line red" style="left:' + Math.round((CAPACITY_RED / maxH) * 100) + '%" title="40h"></div>' +
      '</div></div>';
  }).join('');

  // ── 2. Distribuzione ore per progetto ──────────────────────────────────────
  var projIds = Object.keys(byProject).filter(function(pid) { return byProject[pid].actual > 0; })
    .sort(function(a, b) { return byProject[b].actual - byProject[a].actual; });
  var totalActual = projIds.reduce(function(s, pid) { return s + byProject[pid].actual; }, 0);
  var distRows = projIds.map(function(pid) {
    var p = byProject[pid];
    var pct = totalActual > 0 ? Math.round((p.actual / totalActual) * 100) : 0;
    return '<tr><td>' + esc(p.name) + '</td><td>' + round1(p.actual) + 'h</td>' +
      '<td><div class="dist-track"><div class="dist-bar" style="width:' + pct + '%"></div></div></td>' +
      '<td>' + pct + '%</td></tr>';
  }).join('');

  // ── 3. Pianificato vs effettivo per utente/progetto ───────────────────────
  var pvaRows = users.map(function(uid) {
    var u = byUser[uid];
    var projRows = Object.keys(u.projects).map(function(pid) {
      var p = u.projects[pid];
      var delta = round1(p.actual - p.planned);
      var icon = p.planned > 0 && p.actual >= p.planned * 2 && delta >= 4 ? '🔴'
        : (p.planned === 0 && p.actual >= 4 ? '🟡' : '');
      return '<tr><td></td><td>' + esc(p.name) + '</td><td>' + round1(p.planned) + 'h</td>' +
        '<td>' + round1(p.actual) + 'h</td><td>' + (delta > 0 ? '+' : '') + delta + 'h ' + icon + '</td></tr>';
    }).join('');
    var uDelta = round1(u.actual - u.planned);
    return '<tr class="user-row"><td><b>' + esc(userLabel(uid)) + '</b></td><td></td>' +
      '<td><b>' + round1(u.planned) + 'h</b></td><td><b>' + round1(u.actual) + 'h</b></td>' +
      '<td><b>' + (uDelta > 0 ? '+' : '') + uDelta + 'h</b></td></tr>' + projRows;
  }).join('');

  var empty = users.length === 0
    ? '<p><i>Nessun time log per questa settimana.</i></p>' : '';

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Giuno — Workload</title>' +
    '<style>body{font-family:sans-serif;padding:32px;background:#f5f5f5;max-width:900px}' +
    'h1,h2{margin-top:28px}a{color:#2c6}' +
    'table{border-collapse:collapse;width:100%;margin-top:8px}' +
    'th,td{border:1px solid #ccc;padding:6px 12px;text-align:left;font-size:14px}' +
    'th{background:#333;color:#fff}tr.user-row{background:#e8e8e8}' +
    '.cap-row{display:flex;align-items:center;margin:6px 0}' +
    '.cap-name{width:160px;font-size:14px}' +
    '.cap-track{flex:1;position:relative;background:#ddd;height:26px;border-radius:4px}' +
    '.cap-bar{height:26px;border-radius:4px;color:#fff;font-size:12px;line-height:26px;padding-left:8px;min-width:36px}' +
    '.cap-line{position:absolute;top:-3px;bottom:-3px;width:2px;background:#e67e22}' +
    '.cap-line.red{background:#c0392b}' +
    '.dist-track{background:#ddd;height:14px;border-radius:3px;min-width:120px}' +
    '.dist-bar{background:#2980b9;height:14px;border-radius:3px}' +
    '</style></head><body>' +
    '<h1>Workload — settimana ' + weekStart + ' → ' + weekEnd + '</h1>' +
    '<p><a href="' + weekLink(prevWeek) + '">← settimana prec.</a> | ' +
    '<a href="' + weekLink(nextWeek) + '">settimana succ. →</a> | ' +
    '<a href="/export/timelogs.csv?from=' + weekStart + '&to=' + weekEnd + tokenParam + '">Export CSV</a> | ' +
    '<a href="/dashboard' + (tokenParam ? '?' + tokenParam.slice(1) : '') + '">Dashboard</a></p>' +
    empty +
    '<h2>Capacità per risorsa (ore consuntivate)</h2>' +
    '<p style="font-size:13px;color:#666">Soglie: <span style="color:#e67e22">33h</span> / <span style="color:#c0392b">40h</span></p>' +
    capacityRows +
    '<h2>Distribuzione ore per progetto</h2>' +
    '<table><thead><tr><th>Progetto</th><th>Ore</th><th></th><th>%</th></tr></thead><tbody>' + distRows + '</tbody></table>' +
    '<h2>Pianificato vs effettivo</h2>' +
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
  var from = query && /^\d{4}-\d{2}-\d{2}$/.test(String(query.from || '')) ? query.from : dates.addDays(today, -30);
  var to = query && /^\d{4}-\d{2}-\d{2}$/.test(String(query.to || '')) ? query.to : today;
  var rows = await db.getLogsInRange(from, to);
  var header = 'log_date,log_type,utente,slack_user_id,progetto,ore,note';
  var lines = rows.map(function(r) {
    return [
      r.log_date, r.log_type, userLabel(r.slack_user_id), r.slack_user_id,
      (r.projects && r.projects.name) || r.project_id, r.hours, r.notes || '',
    ].map(csvField).join(',');
  });
  return {
    filename: 'timelogs_' + from + '_' + to + '.csv',
    content: header + '\n' + lines.join('\n') + '\n',
  };
}

module.exports = {
  renderWorkloadPage: renderWorkloadPage,
  renderCsv: renderCsv,
};
