// ─── Capire la commessa dal contesto ─────────────────────────────────────────
// "Tutte le pubblicazioni e le caption dei contenuti che ancora non le hanno"
// non nomina nessun cliente, ma chi l'ha scritto lavora da settimane sul PED
// di Gambino Vini, e "caption" è nel vocabolario di quell'attività. Antonio
// (12/9): "non possiamo farlo capire dal contesto?".
//
// Tre passi, dal più sicuro al meno:
//   1. commesse recenti della persona (ore registrate e pianificate negli
//      ultimi 21 giorni) + vocabolario delle loro attività aperte: se le
//      parole del testo stanno nel vocabolario di UNA sola commessa → quella;
//   2. il modello, con la lista delle commesse recenti della persona per
//      prime e poi il resto del catalogo: risponde con un nome esatto o NONE,
//      mai a indovinare;
//   3. niente: chi chiama decide (nel planner: scegli in lista, con le tre
//      commesse più probabili suggerite).

'use strict';

var logger = require('../utils/logger');
var { MODELS } = require('../config/models');
var { withTimeout } = require('../utils/timeout');

var RECENT_DAYS = 21;
var LLM_TIMEOUT_MS = 12000;
var MAX_CATALOG_IN_PROMPT = 60;

function _c() { return require('./db/client'); }
function norm(s) { return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

// Commesse su cui la persona ha registrato o pianificato ore di recente,
// ordinate per ore. [{ id, hours, last_date }]
async function recentProjectsFor(userId, opts) {
  opts = opts || {};
  var deps = opts.deps || {};
  var supabase = deps.supabase !== undefined ? deps.supabase : _c().getClient();
  if (!supabase || !userId) return [];
  var days = opts.days || RECENT_DAYS;
  var since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  try {
    var res = await supabase.from('time_logs').select('project_id, hours, log_date').eq('slack_user_id', userId).gte('log_date', since).limit(500);
    if (res.error) throw res.error;
    var by = {};
    (res.data || []).forEach(function(r) {
      if (!r.project_id || /^cat_/.test(r.project_id)) return;
      var b = by[r.project_id] || (by[r.project_id] = { id: r.project_id, hours: 0, last_date: null });
      b.hours += Number(r.hours) || 0;
      if (!b.last_date || r.log_date > b.last_date) b.last_date = r.log_date;
    });
    return Object.keys(by).map(function(k) { return by[k]; }).sort(function(a, b) { return b.hours - a.hours; });
  } catch(e) { logger.debug('[CONTEXT] commesse recenti non lette:', e.message); return []; }
}

function words(text) {
  var seen = {}, out = [];
  norm(text).split(' ').forEach(function(w) { if (w.length >= 4 && !seen[w]) { seen[w] = true; out.push(w); } });
  return out;
}

// Vocabolario delle attività aperte per commessa: { project_id: Set(parole) }
function activityVocabulary(activities) {
  var acts = require('./projectActivities');
  var out = {};
  (activities || []).forEach(function(a) {
    if (!a || !a.project_id || (a.status || 'open') !== 'open') return;
    var set = out[a.project_id] || (out[a.project_id] = {});
    acts.tokens(a.name).concat(Array.isArray(a.vocabulary) ? a.vocabulary.map(norm) : []).forEach(function(w) { if (w) set[w] = true; });
  });
  return out;
}

// Passo 1: parole del testo nel vocabolario delle attività di UNA sola
// commessa recente della persona.
function matchByVocabulary(text, recentIds, activities) {
  var tw = words(text);
  if (!tw.length) return null;
  var vocab = activityVocabulary(activities);
  var best = null, bestScore = 0, tie = false;
  (recentIds || []).forEach(function(pid) {
    var v = vocab[pid];
    if (!v) return;
    var score = tw.filter(function(w) { return v[w]; }).length;
    if (score > bestScore) { best = pid; bestScore = score; tie = false; }
    else if (score === bestScore && score > 0 && best !== pid) tie = true;
  });
  return best && !tie ? { id: best, score: bestScore } : null;
}

async function askModel(prompt) {
  var Anthropic = require('@anthropic-ai/sdk');
  var client = new Anthropic();
  var res = await withTimeout(function() {
    return client.messages.create({ model: MODELS.UTILITY, max_tokens: 60,
      system: 'Devi dire a quale commessa (cliente/progetto) appartiene un testo scritto da una persona di un\'agenzia creativa. Rispondi SOLO con il nome ESATTO di una commessa della lista, oppure NONE se non è evidente. Mai tirare a indovinare: in dubbio, NONE.',
      messages: [{ role: 'user', content: prompt }] });
  }, LLM_TIMEOUT_MS, 'projectContext.llm');
  return (res.content && res.content[0] && res.content[0].text || '').trim();
}

// Passo 2: il modello, con le commesse recenti della persona per prime.
async function matchByModel(text, catalog, recentIds, deps) {
  deps = deps || {};
  var ask = deps.ask || askModel;
  var external = (catalog || []).filter(function(p) { return !/^cat_/.test(String(p.id)); });
  if (!external.length) return null;
  var recentSet = {};
  (recentIds || []).forEach(function(id) { recentSet[id] = true; });
  var recent = external.filter(function(p) { return recentSet[p.id]; });
  var others = external.filter(function(p) { return !recentSet[p.id]; }).slice(0, MAX_CATALOG_IN_PROMPT);
  var prompt = 'TESTO: ' + String(text).substring(0, 300) + '\n\n' +
    (recent.length ? 'COMMESSE SU CUI LA PERSONA HA LAVORATO DI RECENTE (le più probabili):\n' + recent.map(function(p) { return '- ' + p.name + (p.client ? ' (cliente: ' + p.client + ')' : ''); }).join('\n') + '\n\n' : '') +
    'ALTRE COMMESSE:\n' + others.map(function(p) { return '- ' + p.name + (p.client ? ' (cliente: ' + p.client + ')' : ''); }).join('\n') +
    '\n\nRispondi con il nome esatto o NONE.';
  var answer;
  try { answer = await ask(prompt); } catch(e) { logger.debug('[CONTEXT] modello non disponibile:', e.message); return null; }
  var a = norm(answer.replace(/^["'\s-]+|["'\s.]+$/g, ''));
  if (!a || a === 'none') return null;
  // Confronto con la stessa normalizzazione (senza punteggiatura: "Gambino Vini · Social")
  var hit = external.find(function(p) { return norm(p.name) === a; }) || external.find(function(p) { return (p.norms || []).some(function(n) { return norm(n) === a; }); });
  return hit || null;
}

// text + persona → { id, name, via: 'vocabolario'|'modello' } o null.
// deps: { supabase, activities, catalog, ask, recent }
async function resolveByContext(text, userId, catalog, deps) {
  deps = deps || {};
  var recent = deps.recent || await recentProjectsFor(userId, { deps: deps });
  var recentIds = recent.map(function(r) { return r.id; });
  var byId = {};
  (catalog || []).forEach(function(p) { byId[p.id] = p; });
  var activities = deps.activities || await require('./projectActivities').loadOpen({ deps: deps });
  var v = matchByVocabulary(text, recentIds, activities);
  if (v && byId[v.id]) return { id: v.id, name: byId[v.id].name, via: 'vocabolario' };
  if (deps.model === false) return null;
  var m = await matchByModel(text, catalog, recentIds, deps);
  if (m) return { id: m.id, name: m.name, via: 'modello' };
  return null;
}

// Le commesse più probabili per la persona, per il messaggio d'errore.
function suggestions(recent, catalog, n) {
  var byId = {};
  (catalog || []).forEach(function(p) { byId[p.id] = p; });
  return (recent || []).map(function(r) { return byId[r.id]; }).filter(Boolean).slice(0, n || 3).map(function(p) { return p.name; });
}

module.exports = { RECENT_DAYS: RECENT_DAYS, recentProjectsFor: recentProjectsFor, activityVocabulary: activityVocabulary, matchByVocabulary: matchByVocabulary, matchByModel: matchByModel, resolveByContext: resolveByContext, suggestions: suggestions, words: words };
