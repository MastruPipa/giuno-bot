// ─── Report di copertura dei dati ────────────────────────────────────────────
// Prima di leggere i numeri (dashboard, consuntivi, workload) bisogna sapere
// da dove vengono: chi ha Google collegato, chi compila il daily, quante ore
// sono vere e quante stimate, quali integrazioni sono configurate, quanti
// progetti/dossier/budget esistono. Una pagina sola, per gli admin.

'use strict';

function _c() { return require('../services/db/client'); }

async function buildCoverage(opts) {
  opts = opts || {};
  var deps = opts.deps || {};
  var days = opts.days || 7;
  var supabase = deps.supabase !== undefined ? deps.supabase : _c().getClient();
  var db = deps.db || require('../../supabase');
  var env = deps.env || process.env;
  var since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  var roster = (db.getTeamRoster ? db.getTeamRoster() : []).filter(function(m) { return m.active !== false; });
  var tokens = deps.tokens || ((db.getTokenCache && db.getTokenCache()) || {});
  var prefs = deps.prefs || ((db.getPrefsCache && db.getPrefsCache()) || {});
  var out = { days: days, since: since, people: [], env: {}, data: {} };
  var entries = [], logs = [];
  if (supabase) {
    try { entries = (await supabase.from('standup_entries').select('slack_user_id, date, source, total_hours_oggi').gte('date', since).limit(1000)).data || []; } catch(_) {}
    try { logs = (await supabase.from('time_logs').select('slack_user_id, project_id, hours, log_type, validation').gte('log_date', since).eq('log_type', 'daily').limit(5000)).data || []; } catch(_) {}
  }
  roster.forEach(function(m) {
    var id = m.slack_user_id;
    var mine = entries.filter(function(e) { return e.slack_user_id === id; });
    var myLogs = logs.filter(function(l) { return l.slack_user_id === id; });
    var est = myLogs.filter(function(l) { return l.validation && l.validation.status === 'estimate'; });
    var p = prefs[id] || {};
    out.people.push({
      user_id: id, name: m.canonical_name, google: !!tokens[id],
      daily_real: mine.filter(function(e) { return e.source !== 'estimate'; }).length,
      daily_estimate: mine.filter(function(e) { return e.source === 'estimate'; }).length,
      hours_real: Math.round(myLogs.filter(function(l) { return !(l.validation && l.validation.status === 'estimate'); }).reduce(function(s, l) { return s + Number(l.hours || 0); }, 0) * 10) / 10,
      hours_estimate: Math.round(est.reduce(function(s, l) { return s + Number(l.hours || 0); }, 0) * 10) / 10,
      standup_enabled: p.standup_enabled !== false, tracking_enabled: p.tracking_enabled !== false, notifiche: p.notifiche_enabled !== false,
    });
  });
  out.env = {
    slack_user_token: !!env.SLACK_USER_TOKEN, oauth_admin_token: !!env.OAUTH_ADMIN_TOKEN, attio: !!env.ATTIO_API_KEY, gemini: !!env.GEMINI_API_KEY,
    higgsfield: (function() { try { return require('../services/mcpConnections').getStatus('higgsfield').connected; } catch(_) { return false; } })(),
  };
  if (supabase) {
    async function count(table, filter) {
      try { var q = supabase.from(table).select('*', { count: 'exact', head: true }); if (filter) q = filter(q); var r = await q; return r.error ? null : (r.count || 0); } catch(_) { return null; }
    }
    out.data = {
      projects_active: await count('projects', function(q) { return q.eq('status', 'active'); }),
      dossiers: await count('project_dossiers'),
      documents: await count('project_documents'),
      actions: await count('project_actions'),
      budgets: await count('giunos_budgets'),
      budgets_verified: await count('giunos_budgets', function(q) { return q.eq('verified', true); }),
      recaps_30d: await count('knowledge_base', function(q) { return q.contains('tags', ['tipo:meeting_recap']).gte('created_at', new Date(Date.now() - 30 * 86400000).toISOString()); }),
    };
    try { var dedup = require('../jobs/projectDedupJob'); var dr = await dedup.runDedup({ apply: false }); out.data.dedup_groups = dr.proposals.length; out.data.noise = dr.noise.length; } catch(_) {}
  }
  return out;
}

function yn(b) { return b ? '✅' : '❌'; }

function formatCoverage(c) {
  var lines = ['*Copertura dati — ultimi ' + c.days + ' giorni (dal ' + c.since + ')*'];
  lines.push('*Persone* (Google · daily veri/stimati · ore vere/stimate):');
  c.people.forEach(function(p) {
    var flags = [];
    if (!p.standup_enabled) flags.push('daily disattivato');
    if (!p.tracking_enabled) flags.push('tracking off');
    if (!p.notifiche) flags.push('notifiche off');
    lines.push('• ' + yn(p.google) + ' *' + p.name + '* — daily ' + p.daily_real + '/' + p.daily_estimate + ' · ore ' + p.hours_real + 'h/' + p.hours_estimate + 'h' + (flags.length ? ' _(' + flags.join(', ') + ')_' : ''));
  });
  var noGoogle = c.people.filter(function(p) { return !p.google; }).map(function(p) { return p.name.split(' ')[0]; });
  var noDaily = c.people.filter(function(p) { return p.daily_real === 0; }).map(function(p) { return p.name.split(' ')[0]; });
  lines.push('*Integrazioni:* Slack search ' + yn(c.env.slack_user_token) + ' · token admin/dashboard ' + yn(c.env.oauth_admin_token) + ' · Attio ' + yn(c.env.attio) + ' · Gemini ' + yn(c.env.gemini) + ' · Higgsfield ' + yn(c.env.higgsfield));
  var d = c.data || {};
  lines.push('*Dati:* progetti attivi ' + (d.projects_active != null ? d.projects_active : '?') + (d.dedup_groups ? ' (' + d.dedup_groups + ' gruppi di duplicati, ' + d.noise + ' rumore)' : '') + ' · dossier ' + (d.dossiers != null ? d.dossiers : '?') + ' · documenti ' + (d.documents != null ? d.documents : '?') + ' · azioni dalle call ' + (d.actions != null ? d.actions : '?') + ' · recap 30gg ' + (d.recaps_30d != null ? d.recaps_30d : '?') + ' · budget ' + (d.budgets == null ? 'tabella assente' : d.budgets + ' (' + (d.budgets_verified || 0) + ' verificati)'));
  var todo = [];
  if (noGoogle.length) todo.push('collegare Google: ' + noGoogle.join(', '));
  if (noDaily.length) todo.push('nessun daily vero: ' + noDaily.join(', '));
  if (!c.env.slack_user_token) todo.push('SLACK_USER_TOKEN su Railway (stime senza Slack)');
  if (!c.env.oauth_admin_token) todo.push('OAUTH_ADMIN_TOKEN su Railway (dashboard chiusa)');
  if (d.dedup_groups) todo.push('`/giuno admin progetti dedup apply`');
  if (d.budgets == null) todo.push('applicare docs/giunos-budgets.sql');
  else if (!d.budgets_verified) todo.push('`/giuno admin budget` e confermare i budget');
  if (d.dossiers === 0) todo.push('`/giuno admin gemini-scan 60` poi `dossier refresh all`');
  if (todo.length) lines.push('*Da sbloccare:*\n' + todo.map(function(t) { return '• ' + t; }).join('\n'));
  return lines.join('\n');
}

module.exports = { buildCoverage: buildCoverage, formatCoverage: formatCoverage };
