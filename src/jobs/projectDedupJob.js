// ─── Deduplica progetti ──────────────────────────────────────────────────────
// La tabella projects nasce da tre sincronizzazioni (deal Attio, canali Slack,
// categorie) più quelli manuali: lo stesso progetto compare due o tre volte
// ("Tarocco" dal canale e "Tarocco- Lieviti e Magia" da Attio) e i canali di
// servizio diventano "progetti". Qui si propongono i gruppi di duplicati e le
// righe rumore; l'admin applica. Il merge sposta ore, allocazioni e documenti
// sul canonico, aggiunge il nome del duplicato agli alias e marca il duplicato
// status='merged' + merged_into, così le sync non lo resuscitano.

'use strict';

var logger = require('../utils/logger');
var filters = require('./projectFilters');

var STOPWORDS = new Set(['di', 'e', 'x', 'per', 'con', 'la', 'il', 'lo', 'le', 'i', 'gli', 'un', 'una', 'the', 'and', 'del', 'della', 'dei', 'da', 'a', 'in', 'su', 'srl', 'sas', 'spa', 'ks', 'katania', 'studio', 'nuovo', 'lead', 'progetto']);

function compact(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
}

function tokens(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').split(' ').filter(function(t) { return t && !STOPWORDS.has(t) && t.length > 1; });
}

function source(p) {
  var id = String(p.id || '');
  if (/^attio_/.test(id)) return 'attio';
  if (/^chan_/.test(id)) return 'chan';
  if (/^cat_/.test(id)) return 'cat';
  return 'manual';
}

// Due righe sono lo stesso progetto se i nomi compattati coincidono, se i
// token di uno sono contenuti nell'altro (con almeno un token "forte" ≥4
// caratteri), o se hanno lo stesso client_name.
function isDuplicatePair(a, b) {
  var ca = compact(a.name), cb = compact(b.name);
  if (ca && ca === cb) return 'stesso nome';
  var cca = compact(a.client_name), ccb = compact(b.client_name);
  // Due deal Attio dello stesso cliente sono due commesse diverse, non doppioni.
  var bothDeals = source(a) === 'attio' && source(b) === 'attio';
  if (cca && cca === ccb && !bothDeals) return 'stesso cliente';
  if (cca && cca === cb) return 'cliente = nome';
  if (ccb && ccb === ca) return 'cliente = nome';
  var ta = tokens(a.name), tb = tokens(b.name);
  if (!ta.length || !tb.length) return null;
  var small = ta.length <= tb.length ? ta : tb;
  var big = small === ta ? tb : ta;
  var strong = small.some(function(t) { return t.length >= 4; });
  if (!strong) return null;
  var bigSet = new Set(big);
  var bigCompact = compact(big.join(''));
  var allIn = small.every(function(t) { return bigSet.has(t) || bigCompact.indexOf(t) !== -1; });
  if (allIn) return 'nome contenuto';
  // "parco-cava-grottadeldrago" vs "Parco Cava Grotta del Drago"
  var sc = compact(small.join('')), bc = compact(big.join(''));
  if (sc.length >= 8 && (bc.indexOf(sc) !== -1 || sc.indexOf(bc) !== -1)) return 'nome contenuto';
  return null;
}

function findDuplicateGroups(projects) {
  var list = (projects || []).filter(function(p) { return p && p.id && source(p) !== 'cat' && p.status !== 'merged'; });
  var parent = list.map(function(_, i) { return i; });
  var reasons = {};
  function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
  // Quante commesse Attio ha ogni cliente: un canale si unisce a un deal per
  // "stesso cliente" solo se il cliente ha UNA commessa; con più commesse il
  // canale resta al livello cliente (lo gestisce il registro posizioni) e
  // l'unione transitiva non può fondere due commesse diverse.
  var dealsByClient = {};
  list.forEach(function(p) { if (source(p) === 'attio' && compact(p.client_name)) dealsByClient[compact(p.client_name)] = (dealsByClient[compact(p.client_name)] || 0) + 1; });
  for (var i = 0; i < list.length; i++) {
    for (var j = i + 1; j < list.length; j++) {
      var why = isDuplicatePair(list[i], list[j]);
      if (!why) continue;
      if (why === 'stesso cliente' && (dealsByClient[compact(list[i].client_name)] || 0) > 1) continue;
      var ri = find(i), rj = find(j);
      if (ri !== rj) parent[rj] = ri;
      reasons[list[i].id + '|' + list[j].id] = why;
    }
  }
  var groups = {};
  list.forEach(function(p, i) { var r = find(i); (groups[r] = groups[r] || []).push(p); });
  return Object.keys(groups).map(function(k) { return groups[k]; }).filter(function(g) { return g.length > 1; })
    .map(function(g) {
      var why = [];
      for (var a = 0; a < g.length; a++) for (var b = a + 1; b < g.length; b++) {
        var r = reasons[g[a].id + '|' + g[b].id] || reasons[g[b].id + '|' + g[a].id];
        if (r && why.indexOf(r) === -1) why.push(r);
      }
      return { projects: g, reasons: why };
    });
}

function weight(p, stats) {
  var s = (stats && stats[p.id]) || {};
  return (s.logs || 0) * 3 + (s.allocs || 0) + (s.docs || 0) * 2;
}

// Canonico: manuale > deal Attio (porta budget e CRM) > canale con più dati.
// Se nel gruppo ci sono più deal Attio con nomi diversi il gruppo è ambiguo
// (un cliente con più commesse): niente merge automatico.
function chooseCanonical(group, stats) {
  var attio = group.filter(function(p) { return source(p) === 'attio'; });
  var distinctAttio = {};
  attio.forEach(function(p) { distinctAttio[compact(p.name)] = true; });
  if (Object.keys(distinctAttio).length > 1) return { ambiguous: true, note: 'più deal Attio diversi nello stesso gruppo' };
  var manual = group.filter(function(p) { return source(p) === 'manual'; });
  var pick = null;
  if (manual.length) pick = manual.sort(function(a, b) { return weight(b, stats) - weight(a, stats); })[0];
  else if (attio.length) pick = attio.sort(function(a, b) { return weight(b, stats) - weight(a, stats); })[0];
  else pick = group.slice().sort(function(a, b) { return weight(b, stats) - weight(a, stats) || String(b.updated_at || '').localeCompare(String(a.updated_at || '')); })[0];
  return { canonical: pick, duplicates: group.filter(function(p) { return p.id !== pick.id; }) };
}

function proposeMerges(projects, stats) {
  return findDuplicateGroups(projects).map(function(g) {
    var choice = chooseCanonical(g.projects, stats);
    return Object.assign({ reasons: g.reasons, projects: g.projects }, choice);
  });
}

// Righe "progetto" nate da canali di servizio o nomi generici.
function findNoiseProjects(projects) {
  return (projects || []).filter(function(p) {
    return p && source(p) === 'chan' && p.status === 'active' && (filters.isGenericChannel(p.name) || filters.isJunkProjectName(p.name));
  });
}

function mergeAliases(canonical, dup) {
  var set = {};
  (canonical.aliases || []).concat([dup.name, dup.client_name]).concat(dup.aliases || []).forEach(function(a) {
    if (a && compact(a) && compact(a) !== compact(canonical.name)) set[compact(a)] = String(a).trim();
  });
  return Object.keys(set).map(function(k) { return set[k]; });
}

function mergedCanonicalFields(canonical, dup) {
  var tags = {};
  (canonical.tags || []).concat(dup.tags || []).forEach(function(t) { if (t && !/^tipo:interno$/.test(t)) tags[t] = true; });
  return {
    aliases: mergeAliases(canonical, dup),
    client_name: canonical.client_name || dup.client_name || null,
    owner_slack_id: canonical.owner_slack_id || dup.owner_slack_id || null,
    description: canonical.description || dup.description || null,
    tags: Object.keys(tags),
    updated_at: new Date().toISOString(),
  };
}

async function applyMerge(dup, canonical, deps) {
  deps = deps || {};
  var c = deps.client || require('../services/db/client');
  if (!c.useSupabase) return { moved: {}, skipped: 'no supabase' };
  var sb = c.getClient();
  var moved = {};
  var tables = ['time_logs', 'resource_allocations', 'project_documents', 'project_actions'];
  for (var i = 0; i < tables.length; i++) {
    try {
      var res = await sb.from(tables[i]).update({ project_id: canonical.id }).eq('project_id', dup.id).select('id');
      moved[tables[i]] = (res.data || []).length;
    } catch(e) { logger.warn('[DEDUP] spostamento ' + tables[i] + ' fallito:', e.message); }
  }
  try { await sb.from('project_dossiers').delete().eq('project_id', dup.id); } catch(e) { /* ok */ }
  try {
    await sb.from('projects').update(mergedCanonicalFields(canonical, dup)).eq('id', canonical.id);
    await sb.from('projects').update({ status: 'merged', merged_into: canonical.id, updated_at: new Date().toISOString() }).eq('id', dup.id);
    var dossiers = deps.dossiers || require('../services/db/dossiers');
    await dossiers.markNeedsRefresh(canonical.id);
  } catch(e) { logger.error('[DEDUP] merge ' + dup.id + ' → ' + canonical.id + ' fallito:', e.message); throw e; }
  try { require('../services/projectMatcher').invalidateCatalog(); } catch(_) {}
  try { require('../handlers/timeTrackingModals').invalidateProjectsCache(); } catch(_) {}
  logger.info('[DEDUP] ' + dup.name + ' (' + dup.id + ') → ' + canonical.name + ' (' + canonical.id + ')', JSON.stringify(moved));
  return { moved: moved };
}

async function archiveNoise(rows, deps) {
  deps = deps || {};
  var c = deps.client || require('../services/db/client');
  if (!c.useSupabase) return 0;
  var n = 0;
  for (var i = 0; i < rows.length; i++) {
    try {
      await c.getClient().from('projects').update({ status: 'archived', tags: (rows[i].tags || []).concat(['rumore']), updated_at: new Date().toISOString() }).eq('id', rows[i].id);
      n++;
    } catch(e) { logger.warn('[DEDUP] archivio ' + rows[i].id + ' fallito:', e.message); }
  }
  return n;
}

async function loadStats(deps) {
  var c = (deps && deps.client) || require('../services/db/client');
  if (!c.useSupabase) return {};
  var stats = {};
  function bump(rows, key) { (rows || []).forEach(function(r) { stats[r.project_id] = stats[r.project_id] || {}; stats[r.project_id][key] = (stats[r.project_id][key] || 0) + 1; }); }
  try {
    var sb = c.getClient();
    bump((await sb.from('time_logs').select('project_id').limit(5000)).data, 'logs');
    bump((await sb.from('resource_allocations').select('project_id').limit(2000)).data, 'allocs');
    bump((await sb.from('project_documents').select('project_id').limit(2000)).data, 'docs');
  } catch(e) { logger.warn('[DEDUP] stats non disponibili:', e.message); }
  return stats;
}

async function runDedup(opts) {
  opts = opts || {};
  var deps = opts.deps || {};
  var db = deps.db || require('../../supabase');
  var projects = opts.projects || await db.searchProjects({ statuses: ['active', 'planning', 'on_hold'], limit: 400 });
  var stats = opts.stats || await loadStats(deps);
  var proposals = proposeMerges(projects, stats);
  var noise = findNoiseProjects(projects);
  var report = { proposals: proposals, noise: noise, applied: 0, archived: 0, ambiguous: proposals.filter(function(p) { return p.ambiguous; }).length };
  if (opts.apply) {
    for (var i = 0; i < proposals.length; i++) {
      var p = proposals[i];
      if (p.ambiguous) continue;
      for (var j = 0; j < p.duplicates.length; j++) {
        try { await applyMerge(p.duplicates[j], p.canonical, deps); report.applied++; } catch(e) { /* già loggato */ }
      }
    }
    report.archived = await archiveNoise(noise, deps);
  }
  return report;
}

function formatReport(r, applied) {
  var lines = [];
  lines.push('*Deduplica progetti* — ' + r.proposals.length + ' gruppi' + (r.ambiguous ? ' (' + r.ambiguous + ' ambigui)' : '') + ', ' + r.noise.length + ' righe rumore' +
    (applied ? ' → ' + r.applied + ' merge applicati, ' + r.archived + ' archiviate' : ' (anteprima)'));
  r.proposals.forEach(function(p) {
    if (p.ambiguous) { lines.push('• ⚠️ ' + p.projects.map(function(x) { return x.name; }).join(' / ') + ' — ' + p.note + ': decidi tu con `merge`'); return; }
    lines.push('• *' + p.canonical.name + '* ← ' + p.duplicates.map(function(d) { return d.name + ' (' + source(d) + ')'; }).join(', ') + ' _[' + p.reasons.join(', ') + ']_');
  });
  if (r.noise.length) lines.push('Rumore da archiviare: ' + r.noise.map(function(n) { return n.name; }).join(', '));
  if (!applied && (r.proposals.length || r.noise.length)) lines.push('`/giuno admin progetti dedup apply` per applicare · `/giuno admin progetti merge <duplicato> -> <canonico>` per un merge manuale');
  return lines.join('\n');
}

// Controllo notturno: se ci sono proposte nuove, un DM agli admin (una volta
// per insieme di proposte).
async function checkAndNotify(deps) {
  deps = deps || {};
  var report = await runDedup({ deps: deps });
  if (!report.proposals.length && !report.noise.length) return 0;
  var key = report.proposals.map(function(p) { return p.projects.map(function(x) { return x.id; }).sort().join('+'); }).concat(report.noise.map(function(n) { return n.id; })).sort().join('|');
  var gate = deps.gate || require('../utils/proactiveGate');
  var supabase = deps.supabase !== undefined ? deps.supabase : require('../services/db/client').getClient();
  var app = deps.app || require('../services/slackService').app;
  var roles = deps.roles || await require('../../rbac').getAllRoles();
  var admins = roles.filter(function(r) { return r.role === 'admin'; });
  var sent = 0;
  for (var i = 0; i < admins.length; i++) {
    var uid = admins[i].slack_user_id;
    var hash = gate.itemHash('dedup:' + key);
    var allowed = supabase ? await gate.followupAllowed(supabase, uid, hash, { cooldownDays: 7, maxAttempts: 1 }) : { allowed: true, attempts: 0 };
    if (!allowed.allowed) continue;
    try {
      await app.client.chat.postMessage({ channel: uid, text: '🧹 ' + formatReport(report, false) });
      sent++;
      if (supabase) await gate.recordFollowup(supabase, uid, hash, 'dedup progetti', allowed.attempts);
    } catch(e) { logger.warn('[DEDUP] avviso admin fallito:', e.message); }
  }
  return sent;
}

module.exports = {
  compact: compact, tokens: tokens, source: source,
  isDuplicatePair: isDuplicatePair, findDuplicateGroups: findDuplicateGroups, chooseCanonical: chooseCanonical,
  proposeMerges: proposeMerges, findNoiseProjects: findNoiseProjects, mergedCanonicalFields: mergedCanonicalFields,
  applyMerge: applyMerge, archiveNoise: archiveNoise, runDedup: runDedup, formatReport: formatReport, checkAndNotify: checkAndNotify,
};
