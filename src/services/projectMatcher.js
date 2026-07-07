// ─── Project Matcher ──────────────────────────────────────────────────────────
// Aggancia i task testuali dei daily ai progetti veri (tabella projects):
// prima l'attribuzione era una substring a valle in query_standup ("Bagno
// Maria montaggio" → bucket testuale), qui ogni task riceve project_id e
// project_name all'ingestion. Match deterministico sui nomi dei progetti
// attivi; fallback LLM in un'unica chiamata batch solo per i task rimasti
// senza match.
'use strict';

var logger = require('../utils/logger');
var db = require('../../supabase');
var { safeParse } = require('../utils/safeCall');
var { withTimeout } = require('../utils/timeout');
var norm = require('../jobs/projectFilters').norm;

var LLM_TIMEOUT_MS = 15000;

// ─── Catalogo progetti attivi (cache TTL 5 min) ──────────────────────────────

var _catalog = null;
var _catalogAt = 0;

async function getCatalog() {
  var now = Date.now();
  if (_catalog && (now - _catalogAt) < 300000) return _catalog;
  try {
    var projects = await db.searchProjects({ status: 'active', limit: 100 });
    var list = (projects || [])
      .filter(function(p) { return p && p.id && p.name; })
      .map(function(p) { return { id: String(p.id), name: String(p.name), norm: norm(p.name) }; });
    if (list.length > 0) {
      _catalog = list;
      _catalogAt = now;
    }
    return _catalog || [];
  } catch(e) {
    logger.warn('[PROJECT-MATCH] Catalogo non disponibile:', e.message);
    return _catalog || [];
  }
}

// ─── Match deterministico ─────────────────────────────────────────────────────
// Il nome progetto (normalizzato, ≥4 char per evitare match spuri tipo "KS"
// dentro parole) deve comparire come substring del testo del task. A parità
// vince il nome più lungo ("Bagno Maria Tarocco" batte "Tarocco").
function matchTaskAgainstCatalog(taskText, catalog) {
  var text = norm(taskText);
  if (!text) return null;
  var best = null;
  for (var i = 0; i < catalog.length; i++) {
    var p = catalog[i];
    if (!p.norm || p.norm.length < 4) continue;
    if (text.indexOf(p.norm) === -1) continue;
    if (!best || p.norm.length > best.norm.length) best = p;
  }
  return best;
}

// ─── Fallback LLM (batch, una chiamata per daily) ────────────────────────────

async function llmMatch(unmatchedTexts, catalog) {
  if (unmatchedTexts.length === 0 || catalog.length === 0) return {};
  try {
    var Anthropic = require('@anthropic-ai/sdk');
    var client = new Anthropic();
    var res = await withTimeout(function() {
      return client.messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 800,
        system: 'Associa ogni task al progetto/cliente giusto della lista, se evidente. ' +
          'Rispondi SOLO con JSON: {"matches": {"<indice task>": "<nome progetto ESATTO dalla lista>"}}. ' +
          'Ometti gli indici per cui non sei sicuro: MAI tirare a indovinare.',
        messages: [{
          role: 'user',
          content: 'PROGETTI:\n' + catalog.map(function(p) { return '- ' + p.name; }).join('\n') +
            '\n\nTASK:\n' + unmatchedTexts.map(function(t, i) { return i + '. ' + t; }).join('\n'),
        }],
      });
    }, LLM_TIMEOUT_MS, 'projectMatcher.llm');

    var out = (res.content && res.content[0] && res.content[0].text || '').trim();
    var jsonMatch = out.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};
    var parsed = safeParse('PROJECT-MATCH', jsonMatch[0], null);
    var byNorm = {};
    catalog.forEach(function(p) { byNorm[p.norm] = p; });
    var result = {};
    Object.keys((parsed && parsed.matches) || {}).forEach(function(idx) {
      var p = byNorm[norm(parsed.matches[idx])];
      if (p) result[idx] = p;
    });
    return result;
  } catch(e) {
    logger.warn('[PROJECT-MATCH] Fallback LLM fallito:', e.message);
    return {};
  }
}

// ─── API ──────────────────────────────────────────────────────────────────────

// Arricchisce IN PLACE una lista di task [{task, hours, minutes}] con
// project_id/project_name. options.useLlm=false per il solo deterministico
// (es. backfill massivo). Non lancia mai.
async function enrichTasksWithProjects(tasks, options) {
  options = options || {};
  if (!Array.isArray(tasks) || tasks.length === 0) return tasks;
  try {
    var catalog = await getCatalog();
    if (catalog.length === 0) return tasks;

    var unmatched = [];
    tasks.forEach(function(t, i) {
      if (!t || !t.task || t.project_id) return;
      var hit = matchTaskAgainstCatalog(t.task, catalog);
      if (hit) {
        t.project_id = hit.id;
        t.project_name = hit.name;
      } else {
        unmatched.push({ index: i, text: t.task });
      }
    });

    if (options.useLlm !== false && unmatched.length > 0) {
      var llmHits = await llmMatch(unmatched.map(function(u) { return u.text; }), catalog);
      unmatched.forEach(function(u, pos) {
        var p = llmHits[String(pos)];
        if (p) {
          tasks[u.index].project_id = p.id;
          tasks[u.index].project_name = p.name;
        }
      });
    }
  } catch(e) {
    logger.warn('[PROJECT-MATCH] enrich fallito (task restano senza progetto):', e.message);
  }
  return tasks;
}

// Arricchisce lo structured di un daily ({ieri, oggi, ...}).
async function enrichStructured(structured, options) {
  if (!structured) return structured;
  await enrichTasksWithProjects(structured.ieri || [], options);
  await enrichTasksWithProjects(structured.oggi || [], options);
  return structured;
}

module.exports = {
  enrichTasksWithProjects: enrichTasksWithProjects,
  enrichStructured: enrichStructured,
  matchTaskAgainstCatalog: matchTaskAgainstCatalog,
  getCatalog: getCatalog,
};
