// ─── Budget ore per progetto → giunos_budgets ────────────────────────────────
// La dashboard giun.os confronta le ore registrate con un budget in ore per
// progetto (tabella giunos_budgets, righe "verificate"). Nessuno la
// alimentava. Qui Giuno PROPONE il budget da tre fonti, in ordine: preventivo
// nel DB (giornate × 8), documento di kick-off (ore o € nel testo), deal
// Attio (valore) convertito con la tariffa oraria media della rate card.
// Le proposte entrano con verified=false; un admin le conferma da Slack.

'use strict';

var logger = require('../utils/logger');

function _c() { return require('../services/db/client'); }
function _quotes() { return require('../services/db/quotes'); }
function _db() { return require('../../supabase'); }
function _dossiers() { return require('../services/db/dossiers'); }

var RATE_KEY_RE = /ora|hour|rate|tariffa|costo/i;
var DAY_KEY_RE = /giorn|day|daily/i;

// Tariffa oraria media dalla rate card (resources è JSON libero: si cercano
// numeri plausibili in campi che parlano di tariffa/ora o giornata).
function hourlyRateFromCard(card) {
  var vals = [];
  function walk(x, key) {
    if (x == null) return;
    if (typeof x === 'number' || (typeof x === 'string' && /^\s*€?\s*\d+([.,]\d+)?\s*€?\s*$/.test(x))) {
      var n = Number(String(x).replace(/[€\s]/g, '').replace(',', '.'));
      if (!isFinite(n)) return;
      if (DAY_KEY_RE.test(key || '') && n >= 80 && n <= 4000) vals.push(n / 8);
      else if (RATE_KEY_RE.test(key || '') && n >= 10 && n <= 500) vals.push(n);
      return;
    }
    if (Array.isArray(x)) { x.forEach(function(y) { walk(y, key); }); return; }
    if (typeof x === 'object') Object.keys(x).forEach(function(k) { walk(x[k], k); });
  }
  walk(card && card.resources, '');
  if (!vals.length) return null;
  return Math.round(vals.reduce(function(a, b) { return a + b; }, 0) / vals.length);
}

function euroFromText(text) {
  var t = String(text || '');
  var m = /(?:€\s*|eur[o]?\s*)?(\d{1,3}(?:[.\s]\d{3})+|\d{3,6})(?:[,.](\d{1,2}))?\s*(?:€|eur|euro)?/i.exec(t.replace(/ /g, ' '));
  if (!m || !/€|eur/i.test(t)) return null;
  var n = Number(m[1].replace(/[.\s]/g, ''));
  return isFinite(n) && n >= 100 ? n : null;
}

function hoursFromText(text) {
  var t = String(text || '').toLowerCase();
  var best = null;
  var re = /(\d{1,4})\s*(ore|h\b|giornat[ae]|giorni(?:\/uomo)?|gg\b)/g;
  var m;
  while ((m = re.exec(t)) !== null) {
    var n = Number(m[1]);
    var h = /giorn|gg/.test(m[2]) ? n * 8 : n;
    if (h >= 4 && h <= 5000 && (best == null || h > best)) best = h;
  }
  return best;
}

function periodFor(project) {
  var start = project.start_date || (project.created_at ? String(project.created_at).slice(0, 10) : new Date().toISOString().slice(0, 10));
  var end = project.end_date;
  if (!end) { var d = new Date(start + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 90); end = d.toISOString().slice(0, 10); }
  if (end < start) end = start;
  return { start: start, end: end };
}

// Ritorna la proposta o null. sources: { quotes:[], dossier, rate }.
function proposeBudget(project, sources) {
  sources = sources || {};
  var rate = sources.rate || null;
  var period = periodFor(project);
  var base = { project_id: project.id, scope: 'project', period_start: period.start, period_end: period.end, slack_user_id: null, verified: false };
  var quote = (sources.quotes || []).find(function(q) { return q && (Number(q.total_days) > 0 || Number(q.price_quoted) > 0); });
  if (quote && Number(quote.total_days) > 0) {
    return Object.assign(base, { hours: Math.round(Number(quote.total_days) * 8), euro: Number(quote.price_quoted) || null, basis: 'preventivo', confidence: 'alta',
      source_url: quote.source_doc_id ? 'https://docs.google.com/document/d/' + quote.source_doc_id : 'quotes:' + quote.id, source_revision: 'quote ' + (quote.date || '') + ' ' + (quote.status || '') });
  }
  var kickText = sources.dossier && sources.dossier.dossier ? [sources.dossier.dossier.budget].concat(sources.dossier.dossier.obiettivi || []).join(' ') : '';
  var kickHours = hoursFromText(kickText);
  var kickEuro = euroFromText(kickText);
  if (kickHours) {
    return Object.assign(base, { hours: kickHours, euro: kickEuro, basis: 'kick-off', confidence: 'media',
      source_url: (sources.dossier.sources && sources.dossier.sources.kickoff && sources.dossier.sources.kickoff.link) || 'dossier:' + project.id, source_revision: 'dossier v' + (sources.dossier.version || 1) });
  }
  var euro = kickEuro || (quote && Number(quote.price_quoted) > 0 ? Number(quote.price_quoted) : null) || (Number(project.budget_quoted) > 0 ? Number(project.budget_quoted) : null);
  if (euro && rate) {
    var basis = kickEuro ? 'kick-off (€ ÷ tariffa)' : (quote ? 'preventivo (€ ÷ tariffa)' : 'deal Attio (€ ÷ tariffa)');
    return Object.assign(base, { hours: Math.round(euro / rate), euro: euro, basis: basis, confidence: 'bassa',
      source_url: kickEuro ? ('dossier:' + project.id) : (quote ? 'quotes:' + quote.id : 'attio:' + project.id.replace(/^attio_/, '')), source_revision: 'tariffa media ' + rate + ' €/h' });
  }
  if (euro) return Object.assign(base, { hours: null, euro: euro, basis: 'solo €: manca la rate card per convertire in ore', confidence: 'bassa', source_url: 'attio:' + project.id, source_revision: 'n/d' });
  return null;
}

async function loadExisting(supabase) {
  var res = await supabase.from('giunos_budgets').select('id, project_id, scope, slack_user_id, hours, verified, source_revision, period_start, period_end').eq('scope', 'project').is('slack_user_id', null).limit(1000);
  if (res.error) throw res.error;
  var by = {};
  (res.data || []).forEach(function(r) { by[r.project_id] = r; });
  return by;
}

async function importBudgets(opts) {
  opts = opts || {};
  var deps = opts.deps || {};
  var db = deps.db || _db();
  var supabase = deps.supabase !== undefined ? deps.supabase : _c().getClient();
  var report = { considered: 0, proposed: 0, updated: 0, skipped_verified: 0, none: [], items: [], error: null };
  if (!supabase) { report.error = 'Supabase non configurato'; return report; }
  var existing;
  try { existing = await loadExisting(supabase); }
  catch(e) { report.error = 'tabella giunos_budgets assente o non leggibile (' + e.message + '): applica docs/giunos-budgets.sql'; return report; }
  var projects = (opts.projects || await db.searchProjects({ status: 'active', limit: 300 })).filter(function(p) { return p && p.id && !/^cat_/.test(p.id) && p.status !== 'merged'; });
  var card = deps.rateCard !== undefined ? deps.rateCard : await _quotes().getRateCard();
  var rate = hourlyRateFromCard(card) || (Number(process.env.GIUNO_DEFAULT_HOURLY_RATE) || null);
  var quotesDb = deps.quotes || _quotes();
  var dossiers = deps.dossiers || _dossiers();
  for (var i = 0; i < projects.length; i++) {
    var p = projects[i];
    report.considered++;
    var ex = existing[p.id];
    if (ex && ex.verified) { report.skipped_verified++; continue; }
    var quotes = [];
    try {
      var names = [p.name, p.client_name].filter(Boolean);
      for (var n = 0; n < names.length && !quotes.length; n++) {
        quotes = (await quotesDb.searchQuotes({ client_name: names[n], limit: 5 })).concat(await quotesDb.searchQuotes({ project_name: names[n], limit: 5 }));
      }
    } catch(_) {}
    var dossier = null;
    try { dossier = await dossiers.getDossier(p.id); } catch(_) {}
    var proposal = proposeBudget(p, { quotes: quotes, dossier: dossier, rate: rate });
    if (!proposal || !proposal.hours) { report.none.push({ project: p.name, why: proposal ? proposal.basis : 'nessuna fonte (né preventivo, né kick-off, né valore deal)' }); continue; }
    var row = { project_id: p.id, slack_user_id: null, period_start: proposal.period_start, period_end: proposal.period_end, scope: 'project', hours: proposal.hours, source_url: proposal.source_url, source_revision: proposal.source_revision + ' · ' + proposal.basis + (proposal.euro ? ' · €' + proposal.euro : ''), verified: false, updated_at: new Date().toISOString() };
    report.items.push({ project: p.name, hours: proposal.hours, euro: proposal.euro, basis: proposal.basis, confidence: proposal.confidence, existing: ex ? ex.hours : null });
    if (!opts.apply) continue;
    try {
      if (ex) { var up = await supabase.from('giunos_budgets').update(row).eq('id', ex.id); if (up.error) throw up.error; report.updated++; }
      else { var ins = await supabase.from('giunos_budgets').insert(row); if (ins.error) throw ins.error; report.proposed++; }
    } catch(e) { logger.warn('[BUDGET] scrittura ' + p.name + ' fallita:', e.message); }
  }
  logger.info('[BUDGET] ' + report.considered + ' progetti, ' + report.items.length + ' proposte' + (opts.apply ? ' (' + report.proposed + ' nuove, ' + report.updated + ' aggiornate)' : ' (anteprima)') + ', ' + report.skipped_verified + ' già verificati');
  return report;
}

async function confirmBudget(projectName, opts) {
  opts = opts || {};
  var deps = opts.deps || {};
  var supabase = deps.supabase !== undefined ? deps.supabase : _c().getClient();
  var dossierAgent = deps.dossierAgent || require('./projectDossier');
  var project = await dossierAgent.findProject(projectName);
  if (!project) return { error: 'Progetto "' + projectName + '" non trovato.' };
  var existing = await loadExisting(supabase);
  var row = existing[project.id];
  var fields = { verified: true, updated_at: new Date().toISOString(), source_revision: ((row && row.source_revision) || '') + ' · confermato da ' + (opts.by || 'admin') + ' il ' + new Date().toISOString().slice(0, 10) };
  if (opts.hours) fields.hours = Number(opts.hours);
  if (!row) {
    if (!opts.hours) return { error: 'Per ' + project.name + ' non c\'è una proposta: indica le ore (`budget conferma ' + project.name + ' 120`).' };
    var period = periodFor(project);
    var ins = await supabase.from('giunos_budgets').insert(Object.assign({ project_id: project.id, slack_user_id: null, scope: 'project', period_start: period.start, period_end: period.end, source_url: 'slack:admin', hours: Number(opts.hours) }, fields));
    if (ins.error) return { error: ins.error.message };
    return { success: true, project: project.name, hours: Number(opts.hours), message: 'Budget di ' + project.name + ' impostato a ' + opts.hours + ' ore (verificato).' };
  }
  var up = await supabase.from('giunos_budgets').update(fields).eq('id', row.id);
  if (up.error) return { error: up.error.message };
  return { success: true, project: project.name, hours: fields.hours || row.hours, message: 'Budget di ' + project.name + ' confermato: ' + (fields.hours || row.hours) + ' ore.' };
}

async function budgetStatus(projectId, deps) {
  deps = deps || {};
  var supabase = deps.supabase !== undefined ? deps.supabase : _c().getClient();
  if (!supabase) return null;
  try {
    var res = await supabase.from('giunos_budgets').select('hours, verified, source_revision, period_start, period_end').eq('project_id', projectId).eq('scope', 'project').is('slack_user_id', null).limit(1);
    return (res.data && res.data[0]) || null;
  } catch(_) { return null; }
}

function fmtEuro(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }

function formatReport(r, applied) {
  if (r.error) return '⚠️ ' + r.error;
  var lines = ['*Budget ore per progetto* — ' + r.items.length + ' proposte su ' + r.considered + ' progetti' + (r.skipped_verified ? ', ' + r.skipped_verified + ' già verificati' : '') + (applied ? ' → ' + r.proposed + ' nuove, ' + r.updated + ' aggiornate (non verificate)' : ' (anteprima)')];
  r.items.slice(0, 25).forEach(function(it) {
    lines.push('• *' + it.project + '*: ' + it.hours + 'h' + (it.euro ? ' (€' + fmtEuro(it.euro) + ')' : '') + ' — ' + it.basis + ', affidabilità ' + it.confidence + (it.existing != null && it.existing !== it.hours ? ' (prima: ' + it.existing + 'h)' : ''));
  });
  if (r.none.length) lines.push('_Senza proposta: ' + r.none.slice(0, 12).map(function(n) { return n.project; }).join(', ') + (r.none.length > 12 ? ' e altri ' + (r.none.length - 12) : '') + '_');
  lines.push('`/giuno admin budget conferma <progetto> [ore]` rende verificato un budget; `/giuno admin budget applica` scrive le proposte.');
  return lines.join('\n');
}

// Cron settimanale: scrive le proposte nuove e avvisa gli admin solo se
// c'è qualcosa di nuovo da confermare (gate proattivo: 7 giorni per lo stesso set).
async function proposeAndNotify(deps) {
  deps = deps || {};
  var report = await importBudgets({ apply: true, deps: deps });
  if (report.error) { logger.warn('[BUDGET] cron: ' + report.error); return 0; }
  var pending = report.items.filter(function(it) { return it.existing == null || it.existing !== it.hours; });
  if (!pending.length) return 0;
  var gate = deps.gate || require('../utils/proactiveGate');
  var supabase = deps.supabase !== undefined ? deps.supabase : _c().getClient();
  var app = deps.app || require('../services/slackService').app;
  var roles = deps.roles || await require('../../rbac').getAllRoles();
  var admins = roles.filter(function(r) { return r.role === 'admin'; });
  var key = pending.map(function(it) { return it.project + ':' + it.hours; }).sort().join('|');
  var sent = 0;
  for (var i = 0; i < admins.length; i++) {
    var uid = admins[i].slack_user_id;
    var hash = gate.itemHash('budget:' + key);
    var allowed = supabase ? await gate.followupAllowed(supabase, uid, hash, { cooldownDays: 7, maxAttempts: 1 }) : { allowed: true, attempts: 0 };
    if (!allowed.allowed) continue;
    try {
      await app.client.chat.postMessage({ channel: uid, text: '💰 ' + formatReport(report, true) });
      sent++;
      if (supabase) await gate.recordFollowup(supabase, uid, hash, 'budget ore progetti', allowed.attempts);
    } catch(e) { logger.warn('[BUDGET] avviso admin fallito:', e.message); }
  }
  return sent;
}

module.exports = { proposeAndNotify: proposeAndNotify, hourlyRateFromCard: hourlyRateFromCard, euroFromText: euroFromText, hoursFromText: hoursFromText, periodFor: periodFor, proposeBudget: proposeBudget, importBudgets: importBudgets, confirmBudget: confirmBudget, budgetStatus: budgetStatus, formatReport: formatReport };
