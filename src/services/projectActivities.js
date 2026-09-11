// ─── Attività di progetto (il livello tra commessa e microtask) ─────────────
// Cliente → commessa → ATTIVITÀ → microtask. "Gambino Vini" è il cliente, la
// commessa è "Gambino Vini · Social", l'attività è "PED settembre 2026", la
// microtask è "caption video gambino" scritta da Giusy nel daily. L'attività
// ha un inizio e una fine (o è ricorrente: "PED mensile" apre da sola
// "PED ottobre" il primo del mese e chiude settembre).
//
// Tabella project_activities (migrazione in supabase_migration.sql). La
// microtask porta activity_id/activity_name nel JSON del daily
// (standup_entries.oggi_tasks), accanto a project_id: le ore per attività si
// ricavano da lì e devono sempre tornare con il consuntivo per commessa
// (time_logs), che non cambia.
//
// Aggancio: trovata la commessa, si sceglie tra le attività aperte di quella
// commessa valide nel giorno. Una sola → quella. Più di una → vince il
// vocabolario (parole date dal PM + parole imparate dai daily già agganciati);
// a parità o senza parole in comune la microtask resta sulla commessa senza
// attività, e il PM la vede tra le orfane. Mai un'attribuzione inventata.

'use strict';

var logger = require('../utils/logger');

var CACHE_MS = 5 * 60000;
var MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
var RECURRENCES = { mensile: 'mensile', settimanale: 'settimanale' };
var KINDS = ['consegna', 'ricorrente', 'continuativa'];
var MAX_VOCAB = 80;
// Parole vuote del daily: non dicono a quale attività appartiene la microtask.
var STOP = new Set(('della delle dello degli dell alla alle allo agli sulla sulle sullo sugli nella nelle nello negli con per una uno del dei dal dai che non ore min oggi ieri domani fatto fatta fatti fare fino anche come dopo prima poi tutto tutti tutta alcuni altro altra altri ancora circa quasi sempre mezza mezzo call riunione meeting cliente progetto lavoro lavorato lavorando preparazione preparato continuato continuo revisione revisioni modifiche modifica varie vari gestione').split(' '));

function _c() { return require('./db/client'); }
function _db() { return require('../../supabase'); }
function norm(s) { return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

function tokens(text) {
  var seen = {}, out = [];
  norm(text).split(' ').forEach(function(w) {
    if (w.length < 4 || STOP.has(w) || /^\d+$/.test(w) || seen[w]) return;
    seen[w] = true; out.push(w);
  });
  return out;
}

// ─── Periodi ─────────────────────────────────────────────────────────────────

function pad(n) { return String(n).padStart(2, '0'); }
function monthBounds(dateStr) {
  var y = Number(dateStr.slice(0, 4)), m = Number(dateStr.slice(5, 7));
  var last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: y + '-' + pad(m) + '-01', end: y + '-' + pad(m) + '-' + pad(last), label: MONTHS[m - 1] + ' ' + y };
}
function weekBounds(dateStr) {
  var dates = require('../utils/trackingDates');
  var start = dates.weekStartOf(dateStr);
  return { start: start, end: dates.addDays(start, 6), label: 'settimana del ' + start.slice(8, 10) + '/' + start.slice(5, 7) };
}
function periodFor(recurrence, dateStr) { return recurrence === 'settimanale' ? weekBounds(dateStr) : monthBounds(dateStr); }
function coversDate(a, dateStr) {
  return (!a.period_start || a.period_start <= dateStr) && (!a.period_end || a.period_end >= dateStr);
}
function isTemplate(a) { return !!(a && a.recurrence); }

// ─── Lettura ─────────────────────────────────────────────────────────────────

var _cache = { at: 0, rows: null, missing: false };

async function readRows(supabase, statuses) {
  if (!supabase) return { rows: [], missing: true };
  try {
    var q = supabase.from('project_activities').select('*').limit(2000);
    if (statuses && statuses.length) q = q.in('status', statuses);
    var res = await q;
    if (res.error) throw res.error;
    return { rows: res.data || [], missing: false };
  } catch(e) {
    var missing = /project_activities|relation|does not exist|schema cache/i.test(String(e.message || ''));
    if (!missing) logger.debug('[ACTIVITIES] lettura fallita:', e.message);
    return { rows: [], missing: missing };
  }
}

// Attività aperte (istanze e modelli ricorrenti), con cache di 5 minuti.
async function loadOpen(opts) {
  opts = opts || {};
  var deps = opts.deps || {};
  var injected = deps.supabase !== undefined;
  if (!opts.force && !injected && _cache.rows && (Date.now() - _cache.at) < CACHE_MS) return _cache.rows;
  var supabase = injected ? deps.supabase : _c().getClient();
  var r = await readRows(supabase, ['open']);
  if (!injected) _cache = { at: Date.now(), rows: r.rows, missing: r.missing };
  return r.rows;
}
function invalidate() { _cache = { at: 0, rows: null, missing: false }; }
function tableMissing() { return !!_cache.missing; }

// ─── Aggancio della microtask ────────────────────────────────────────────────

// Un'attività chiusa (done) resta la candidata giusta per le microtask
// datate DENTRO il suo periodo: il PED di agosto, chiuso il 1° settembre,
// prende ancora i daily del 31 agosto riagganciati dopo.
function candidatesFor(activities, projectId, dateStr) {
  return (activities || []).filter(function(a) {
    if (!a || a.project_id !== projectId || isTemplate(a)) return false;
    var st = a.status || 'open';
    if (st === 'open') return coversDate(a, dateStr);
    return st === 'done' && !!a.period_end && coversDate(a, dateStr);
  });
}

function vocabularyOf(a) {
  var seen = {}, out = [];
  tokens(a.name).concat(Array.isArray(a.vocabulary) ? a.vocabulary.map(norm) : []).forEach(function(w) {
    if (!w || seen[w]) return; seen[w] = true; out.push(w);
  });
  return out;
}

function score(a, textTokens) {
  var v = vocabularyOf(a), n = 0;
  textTokens.forEach(function(w) { if (v.indexOf(w) !== -1) n++; });
  return n;
}

// text + commessa + giorno → attività o null. Deterministico.
function resolveActivity(text, projectId, activities, dateStr) {
  if (!projectId) return null;
  var cands = candidatesFor(activities, projectId, dateStr);
  if (!cands.length) return null;
  if (cands.length === 1) return cands[0];
  var tt = tokens(text);
  if (!tt.length) return null;
  var best = null, bestScore = 0, tie = false;
  cands.forEach(function(a) {
    var s = score(a, tt);
    if (s > bestScore) { best = a; bestScore = s; tie = false; }
    else if (s === bestScore && s > 0) tie = true;
  });
  return best && !tie ? best : null;
}

// Arricchisce IN PLACE i task che hanno project_id ma non activity_id. Non lancia mai.
async function enrichTasks(tasks, opts) {
  opts = opts || {};
  if (!Array.isArray(tasks) || !tasks.length) return tasks;
  try {
    var need = tasks.some(function(t) { return t && t.project_id && !t.activity_id; });
    if (!need) return tasks;
    var activities = opts.activities || await loadOpen({ deps: opts.deps });
    if (!activities.length) return tasks;
    var day = opts.date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
    tasks.forEach(function(t) {
      if (!t || !t.project_id || t.activity_id) return;
      var a = resolveActivity(t.task, t.project_id, activities, day);
      if (a) { t.activity_id = a.id; t.activity_name = a.name; }
    });
  } catch(e) { logger.debug('[ACTIVITIES] enrich saltato:', e.message); }
  return tasks;
}

// ─── Scrittura ───────────────────────────────────────────────────────────────

function newId() { return 'act_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

async function findExisting(supabase, projectId, name, periodStart) {
  var res = await supabase.from('project_activities').select('*').eq('project_id', projectId).ilike('name', name).limit(5);
  if (res.error) throw res.error;
  return (res.data || []).find(function(a) { return (a.period_start || null) === (periodStart || null); }) || null;
}

// spec: { project_id, name, kind, period_start, period_end, recurrence, vocabulary, owner_slack_id, source_url, template_id, created_by }
async function createActivity(spec, deps) {
  deps = deps || {};
  var supabase = deps.supabase !== undefined ? deps.supabase : _c().getClient();
  if (!supabase) return { error: 'Database non configurato.' };
  if (!spec || !spec.project_id || !spec.name) return { error: 'Servono commessa e nome.' };
  try {
    var existing = await findExisting(supabase, spec.project_id, spec.name, spec.period_start);
    if (existing) return { activity: existing, existed: true };
    var row = {
      id: newId(), project_id: spec.project_id, name: String(spec.name).trim(),
      kind: KINDS.indexOf(spec.kind) !== -1 ? spec.kind : (spec.recurrence ? 'ricorrente' : 'consegna'),
      period_start: spec.period_start || null, period_end: spec.period_end || null,
      recurrence: spec.recurrence ? RECURRENCES[spec.recurrence] || null : null,
      template_id: spec.template_id || null, status: 'open',
      owner_slack_id: spec.owner_slack_id || null, source_url: spec.source_url || null,
      vocabulary: Array.isArray(spec.vocabulary) ? spec.vocabulary.map(norm).filter(Boolean).slice(0, MAX_VOCAB) : [],
      created_by: spec.created_by || null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    var ins = await supabase.from('project_activities').insert(row).select().single();
    if (ins.error) throw ins.error;
    invalidate();
    return { activity: ins.data || row, existed: false };
  } catch(e) { logger.warn('[ACTIVITIES] creazione fallita:', e.message); return { error: e.message }; }
}

async function setStatus(activityId, status, deps) {
  deps = deps || {};
  var supabase = deps.supabase !== undefined ? deps.supabase : _c().getClient();
  if (!supabase) return false;
  try {
    var upd = { status: status, updated_at: new Date().toISOString() };
    if (status === 'done') {
      upd.closed_at = new Date().toISOString();
      // Senza fine dichiarata, la chiusura fissa la fine a oggi: le microtask
      // fino a oggi restano agganciabili, quelle dopo no.
      var cur = await supabase.from('project_activities').select('period_end').eq('id', activityId).limit(1);
      if (cur.error) throw cur.error;
      if (!(cur.data && cur.data[0] && cur.data[0].period_end)) upd.period_end = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
    }
    var res = await supabase.from('project_activities').update(upd).eq('id', activityId);
    if (res.error) throw res.error;
    invalidate();
    return true;
  } catch(e) { logger.warn('[ACTIVITIES] stato non aggiornato:', e.message); return false; }
}

// ─── Ricorrenze: il PED di ottobre si apre da solo ───────────────────────────
// Per ogni modello ricorrente (recurrence valorizzata) esiste un'istanza per
// il periodo corrente; le istanze con periodo finito si chiudono (done), mai
// cancellate: le ore restano lì.
async function rollRecurring(opts) {
  opts = opts || {};
  var deps = opts.deps || {};
  var supabase = deps.supabase !== undefined ? deps.supabase : _c().getClient();
  var today = opts.today || new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
  var report = { templates: 0, opened: [], closed: [], errors: [] };
  if (!supabase) return report;
  var all = deps.activities || (await readRows(supabase, ['open'])).rows;
  var templates = all.filter(function(a) { return isTemplate(a) && (a.status || 'open') === 'open'; });
  report.templates = templates.length;
  for (var i = 0; i < templates.length; i++) {
    var t = templates[i];
    var p = periodFor(t.recurrence, today);
    var instances = all.filter(function(a) { return a.template_id === t.id; });
    var current = instances.find(function(a) { return a.period_start === p.start; });
    var name = t.name + ' ' + p.label;
    if (!current) {
      if (opts.apply) {
        var r = await createActivity({ project_id: t.project_id, name: name, kind: 'ricorrente', period_start: p.start, period_end: p.end, template_id: t.id, vocabulary: t.vocabulary, owner_slack_id: t.owner_slack_id, created_by: 'ricorrenza' }, { supabase: supabase });
        if (r.error) { report.errors.push(name + ': ' + r.error); continue; }
      }
      report.opened.push({ project_id: t.project_id, name: name, period_start: p.start, period_end: p.end });
    }
    for (var k = 0; k < instances.length; k++) {
      var inst = instances[k];
      if ((inst.status || 'open') !== 'open' || !inst.period_end || inst.period_end >= today) continue;
      if (opts.apply) await setStatus(inst.id, 'done', { supabase: supabase });
      report.closed.push({ project_id: inst.project_id, name: inst.name, period_end: inst.period_end });
    }
  }
  if (opts.apply) invalidate();
  return report;
}

// ─── Riaggancio delle microtask e apprendimento ──────────────────────────────
// Ogni notte (e quando il PM crea un'attività nuova) le microtask con
// commessa ma senza attività vengono riprovate; quelle già agganciate
// insegnano le loro parole all'attività, così la volta dopo "caption" basta.
function taskHours(t) { return (Number(t && t.hours) || 0) + (Number(t && t.minutes) || 0) / 60; }

function learnFrom(tasks, byId) {
  var changed = {};
  (tasks || []).forEach(function(t) {
    var a = t && t.activity_id && byId[t.activity_id];
    if (!a) return;
    var vocab = Array.isArray(a.vocabulary) ? a.vocabulary.slice() : [];
    var nameTokens = tokens(a.name);
    tokens(t.task).forEach(function(w) {
      if (vocab.indexOf(w) !== -1 || nameTokens.indexOf(w) !== -1 || vocab.length >= MAX_VOCAB) return;
      vocab.push(w); changed[a.id] = true;
    });
    a.vocabulary = vocab;
  });
  return Object.keys(changed);
}

async function reattach(opts) {
  opts = opts || {};
  var deps = opts.deps || {};
  var supabase = deps.supabase !== undefined ? deps.supabase : _c().getClient();
  var days = opts.days || 14;
  var report = { entries: 0, tasks: 0, attached: 0, learned: 0, orphans: [], byProject: {} };
  if (!supabase) return report;
  // Aperte E chiuse: una microtask di ieri può appartenere all'istanza chiusa stamattina.
  var activities = deps.activities || (await readRows(supabase, ['open', 'done'])).rows;
  var byId = {};
  activities.forEach(function(a) { byId[a.id] = a; });
  var since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  var entries = opts.entries || (await supabase.from('standup_entries').select('id, slack_user_id, date, source, oggi_tasks').gte('date', since).limit(500)).data || [];
  report.entries = entries.length;
  var toLearn = [];
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var tasks = (e.oggi_tasks || []).filter(function(t) { return t && t.project_id && taskHours(t) > 0; });
    if (!tasks.length) continue;
    // Orfana = microtask di una commessa che HA attività aperte quel giorno e
    // non si è agganciata. Una commessa senza attività non produce orfane.
    var pending = tasks.filter(function(t) { return !t.activity_id && candidatesFor(activities, t.project_id, e.date).length > 0; });
    report.tasks += pending.length;
    await enrichTasks(pending, { activities: activities, date: e.date });
    var now = pending.filter(function(t) { return t.activity_id; }).length;
    if (now && opts.apply) {
      try {
        var up = await supabase.from('standup_entries').update({ oggi_tasks: e.oggi_tasks }).eq('id', e.id);
        if (up.error) throw up.error;
      } catch(err) { logger.warn('[ACTIVITIES] daily ' + e.id + ' non aggiornato:', err.message); now = 0; }
    }
    report.attached += now;
    toLearn = toLearn.concat(tasks.filter(function(t) { return t.activity_id; }));
    pending.filter(function(t) { return !t.activity_id; }).forEach(function(t) {
      var o = { user_id: e.slack_user_id, date: e.date, project_id: t.project_id, project_name: t.project_name || t.project_id, task: t.task, hours: Math.round(taskHours(t) * 100) / 100 };
      report.orphans.push(o);
      var bp = report.byProject[t.project_id] || (report.byProject[t.project_id] = { name: o.project_name, tasks: 0, hours: 0 });
      bp.tasks++; bp.hours = Math.round((bp.hours + o.hours) * 100) / 100;
    });
  }
  var changedIds = learnFrom(toLearn, byId);
  if (opts.apply) {
    for (var c = 0; c < changedIds.length; c++) {
      try {
        var lr = await supabase.from('project_activities').update({ vocabulary: byId[changedIds[c]].vocabulary, updated_at: new Date().toISOString() }).eq('id', changedIds[c]);
        if (lr.error) throw lr.error;
        report.learned++;
      } catch(err) { logger.debug('[ACTIVITIES] vocabolario non salvato:', err.message); }
    }
    invalidate();
  } else report.learned = changedIds.length;
  logger.info('[ACTIVITIES] ' + report.entries + ' daily, ' + report.tasks + ' microtask senza attività, ' + report.attached + ' agganciate, ' + report.orphans.length + ' restano sulla commessa');
  return report;
}

// ─── Comandi admin: parsing e formati ────────────────────────────────────────
// "nuova <commessa> = <nome> [mensile|settimanale] [entro AAAA-MM-GG] [parole: a, b, c]"
function parseSpec(text) {
  var s = String(text || '').trim();
  var eq = s.indexOf('=');
  if (eq === -1) return null;
  var projectName = s.slice(0, eq).trim();
  var rest = s.slice(eq + 1).trim();
  var out = { projectName: projectName, recurrence: null, period_end: null, vocabulary: [] };
  var m = /\bparole\s*:\s*(.+)$/i.exec(rest);
  if (m) { out.vocabulary = m[1].split(/[,;]/).map(function(w) { return w.trim(); }).filter(Boolean); rest = rest.slice(0, m.index).trim(); }
  m = /\bentro\s+(\d{4}-\d{2}-\d{2})\b/i.exec(rest);
  if (m) { out.period_end = m[1]; rest = (rest.slice(0, m.index) + rest.slice(m.index + m[0].length)).trim(); }
  m = /\b(mensile|settimanale)\b/i.exec(rest);
  if (m) { out.recurrence = m[1].toLowerCase(); rest = (rest.slice(0, m.index) + rest.slice(m.index + m[0].length)).trim(); }
  out.name = rest.replace(/\s+/g, ' ').trim();
  if (!out.projectName || !out.name) return null;
  return out;
}

function fmtH(h) { return (Math.round(h * 10) / 10) + 'h'; }

function formatList(activities, projects) {
  var names = {};
  (projects || []).forEach(function(p) { names[p.id] = p.name; });
  var byProject = {};
  (activities || []).forEach(function(a) { (byProject[a.project_id] = byProject[a.project_id] || []).push(a); });
  var ids = Object.keys(byProject).sort(function(x, y) { return String(names[x] || x).localeCompare(String(names[y] || y)); });
  if (!ids.length) return 'Nessuna attività aperta. Creane una: `/giuno admin attivita nuova <commessa> = <nome> [mensile|settimanale] [entro AAAA-MM-GG] [parole: a, b]`';
  var lines = ['*Attività aperte (' + activities.length + '):*'];
  ids.forEach(function(pid) {
    lines.push('*' + (names[pid] || pid) + '*');
    byProject[pid].sort(function(x, y) { return String(x.period_start || '').localeCompare(String(y.period_start || '')) || x.name.localeCompare(y.name); }).forEach(function(a) {
      var tag = isTemplate(a) ? ' _(ricorrenza ' + a.recurrence + ')_' : (a.period_start || a.period_end) ? ' _(' + (a.period_start || '…') + ' → ' + (a.period_end || '…') + ')_' : '';
      var vocab = Array.isArray(a.vocabulary) && a.vocabulary.length ? ' · parole: ' + a.vocabulary.slice(0, 6).join(', ') + (a.vocabulary.length > 6 ? '…' : '') : '';
      lines.push('  • ' + a.name + tag + vocab);
    });
  });
  return lines.join('\n');
}

function formatRollReport(r, applied) {
  var lines = ['*Ricorrenze:* ' + r.templates + ' modelli, ' + r.opened.length + ' istanze ' + (applied ? 'aperte' : 'da aprire') + ', ' + r.closed.length + ' ' + (applied ? 'chiuse' : 'da chiudere')];
  r.opened.forEach(function(o) { lines.push('  • apre "' + o.name + '" (' + o.period_start + ' → ' + o.period_end + ')'); });
  r.closed.forEach(function(o) { lines.push('  • chiude "' + o.name + '" (finita il ' + o.period_end + ')'); });
  r.errors.forEach(function(e) { lines.push('  ⚠️ ' + e); });
  if (!applied && (r.opened.length || r.closed.length)) lines.push('_Anteprima: `/giuno admin attivita ricorrenze apply` per applicare._');
  return lines.join('\n');
}

function formatReattachReport(r, applied) {
  var lines = ['*Microtask e attività:* ' + r.entries + ' daily letti, ' + r.tasks + ' microtask senza attività, ' + r.attached + ' agganciate' + (applied ? '' : ' (anteprima)') + ', ' + r.learned + ' vocabolari ' + (applied ? 'aggiornati' : 'da aggiornare') + ', ' + r.orphans.length + ' restano sulla sola commessa'];
  Object.keys(r.byProject).sort(function(a, b) { return r.byProject[b].hours - r.byProject[a].hours; }).slice(0, 10).forEach(function(pid) {
    var bp = r.byProject[pid];
    var ex = r.orphans.filter(function(o) { return o.project_id === pid; }).slice(0, 3).map(function(o) { return '"' + String(o.task).substring(0, 40) + '"'; }).join(', ');
    lines.push('• *' + bp.name + '*: ' + bp.tasks + ' microtask, ' + fmtH(bp.hours) + ' — ' + ex);
  });
  if (r.orphans.length) lines.push('_Crea l\'attività che manca (`/giuno admin attivita nuova <commessa> = <nome> …`) o aggiungi parole: al giro successivo le microtask si agganciano da sole._');
  return lines.join('\n');
}

module.exports = {
  KINDS: KINDS, RECURRENCES: RECURRENCES, MONTHS: MONTHS,
  norm: norm, tokens: tokens, monthBounds: monthBounds, weekBounds: weekBounds, periodFor: periodFor, coversDate: coversDate, isTemplate: isTemplate,
  loadOpen: loadOpen, invalidate: invalidate, tableMissing: tableMissing,
  candidatesFor: candidatesFor, resolveActivity: resolveActivity, enrichTasks: enrichTasks,
  createActivity: createActivity, setStatus: setStatus, rollRecurring: rollRecurring, reattach: reattach, learnFrom: learnFrom,
  parseSpec: parseSpec, formatList: formatList, formatRollReport: formatRollReport, formatReattachReport: formatReattachReport,
};
