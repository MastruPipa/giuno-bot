// ─── "Altro (non in lista)": il testo libero NON crea commesse ──────────────
// Nel planner e nella modale ore chi non trova la voce scrive a mano. Prima
// quel testo diventava un progetto nuovo, e la lista si riempiva di righe
// come "Vini Gambino - riunione con cliente + fix premi + ricerca visiva
// shooting" (Antonio, 12/9: "ancora molti progetti sono spezzettati").
//
// Ora il testo si aggancia a una commessa esistente: stesso nome, oppure il
// cliente/la commessa nominati nel testo (stesse regole del daily:
// projectMatcher.resolveTask), oppure un'attività trasversale (regole
// interne). Se non si aggancia, la riga non passa e la persona sceglie in
// lista: le commesse nuove le creano gli admin (deal Attio, create_project).

'use strict';

function _db() { return require('../../supabase'); }
function _matcher() { return require('./projectMatcher'); }
var norm = require('../jobs/projectFilters').norm;

// name: testo scritto; activeProjects: righe projects in lista.
// Ritorna { project, created:false, via } oppure { error }.
async function resolveOtherProject(name, userId, activeProjects, deps) {
  deps = deps || {};
  var db = deps.db || _db();
  var matcher = deps.matcher || _matcher();
  var clean = String(name || '').replace(/\s+/g, ' ').trim();
  if (clean.length < 2) return { error: 'Scrivi il nome della commessa (almeno 2 caratteri).' };
  var key = norm(clean);
  var existing = (activeProjects || []).find(function(p) { return norm(p.name) === key; }) || null;
  if (!existing) {
    var found = await db.searchProjects({ name: clean, limit: 10 });
    existing = (found || []).find(function(p) { return norm(p.name) === key; }) || null;
    if (existing && existing.status === 'merged' && existing.merged_into) {
      var canonical = await db.getProject(existing.merged_into);
      if (canonical) existing = canonical;
    }
    if (existing && ['completed', 'archived', 'cancelled'].indexOf(existing.status) !== -1) {
      // Scelta apposta per nome: riapriamo.
      try { await db.updateProject(existing.id, { status: 'active' }); existing.status = 'active'; } catch(e) { /* best effort */ }
    }
  }
  if (existing) return { project: existing, created: false, via: 'nome' };
  // Il testo nomina un cliente o una commessa ("Tarocco - shooting e onboarding")
  var catalog = deps.catalog || await matcher.getCatalog();
  var hit = matcher.resolveTask(clean, catalog) || tokenMatch(clean, catalog);
  if (hit) {
    var row = (activeProjects || []).find(function(p) { return String(p.id) === String(hit.id); }) || await db.getProject(hit.id) || { id: hit.id, name: hit.name };
    return { project: row, created: false, via: 'testo', text: clean };
  }
  return { error: 'Non trovo una commessa in "' + clean.substring(0, 60) + '". Scegli una voce in lista o scrivi il nome del cliente: le commesse nuove le creano gli admin.' };
}

// "Vini Gambino - riunione…" nomina "Gambino Vini" con le parole in altro
// ordine: se TUTTE le parole (≥4 lettere) del nome o del cliente di una
// commessa stanno nel testo, è lei. Con più commesse candidate diverse
// (stesso cliente, due deal) non si sceglie.
function words(s) { return norm(s).split(' ').filter(function(w) { return w.length >= 4; }); }
function tokenMatch(text, catalog) {
  var tw = words(text);
  if (!tw.length) return null;
  var best = null, bestLen = 0, tie = false;
  (catalog || []).forEach(function(p) {
    if (/^cat_/.test(String(p.id))) return;
    [p.norm, p.client].concat(p.norms || []).forEach(function(n) {
      var pw = n ? words(n) : [];
      if (!pw.length || !pw.every(function(w) { return tw.indexOf(w) !== -1; })) return;
      if (pw.length > bestLen) { best = p; bestLen = pw.length; tie = false; }
      else if (pw.length === bestLen && best && best.id !== p.id) tie = true;
    });
  });
  return best && !tie ? best : null;
}

module.exports = { resolveOtherProject: resolveOtherProject, tokenMatch: tokenMatch };
