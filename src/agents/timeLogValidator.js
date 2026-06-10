// ─── Time Log Validator (gate Giuno) ─────────────────────────────────────────
// Gate di validazione nel write path dei time log, in due strati:
//   1. validateDeterministic — regole strict, sincrone, gratuite
//   2. validateWithGiuno     — validazione semantica + anomalie (Haiku)
// Il gate AI è NEL percorso di scrittura (decisione esplicita), ma con budget
// di tempo duro: se l'LLM non risponde entro il timeout i dati vengono salvati
// comunque con validation.status='fallback_deterministic_only' — un input
// dell'utente non si perde mai per un degrado del provider.
//
// Vincolo Bolt: tutto il gate gira PRE-ack (la finestra è ~3s), quindi il
// timeout di default è 2200ms.
'use strict';

var logger = require('../utils/logger');
var { withTimeout } = require('../utils/retryPolicy');

var MODEL = 'claude-haiku-4-5-20251001';
var AI_TIMEOUT_MS = 2200;
var HOURS_MIN = 0.5;
var HOURS_MAX = 24;

// Caller LLM iniettabile per i test (e per eventuali mock in sviluppo)
var _llmCaller = null;
function setLLMCaller(fn) { _llmCaller = fn; }

// ─── Strato 1: regole deterministiche ────────────────────────────────────────
// rows: [{ index, project_id, hours }]
// ctx:  { prefix: 'wp'|'tt', logType: 'weekly'|'daily', projectsById: {id: {name, status}} }
// Ritorna { ok, errors } con errors keyed per block_id (formato ack di Slack).
function validateDeterministic(rows, ctx) {
  var errors = {};
  var prefix = ctx.prefix;
  if (!rows || rows.length === 0) {
    errors[prefix + '_project_1'] = 'Aggiungi almeno un progetto con le ore.';
    return { ok: false, errors: errors };
  }
  var seen = {};
  var total = 0;
  rows.forEach(function(r) {
    var pBlock = prefix + '_project_' + r.index;
    var hBlock = prefix + '_hours_' + r.index;
    if (!r.project_id) {
      errors[pBlock] = 'Progetto non valido. Seleziona una voce presente nel menu a tendina.';
    } else {
      var proj = ctx.projectsById ? ctx.projectsById[r.project_id] : null;
      if (!proj) {
        errors[pBlock] = 'Progetto non valido. Seleziona una voce presente nel menu a tendina.';
      } else if (proj.status && proj.status !== 'active') {
        errors[pBlock] = 'Il progetto "' + proj.name + '" non è più attivo.';
      }
      if (seen[r.project_id]) {
        errors[pBlock] = 'Progetto duplicato: unisci le ore in una sola riga.';
      }
      seen[r.project_id] = true;
    }
    if (r.hours == null || isNaN(r.hours) || r.hours < HOURS_MIN || r.hours > HOURS_MAX) {
      errors[hBlock] = 'Inserisci un numero valido compreso tra 0.5 e 24.';
    } else {
      total += r.hours;
    }
  });
  if (Object.keys(errors).length === 0 && ctx.logType === 'daily' && total > 24) {
    errors[prefix + '_hours_1'] = 'Il totale giornaliero supera le 24 ore (' + total + 'h): controlla le righe.';
  }
  return { ok: Object.keys(errors).length === 0, errors: errors };
}

// ─── Strato 2: gate semantico Giuno ──────────────────────────────────────────

function buildGatePayload(rows, ctx) {
  var byId = ctx.projectsById || {};
  return {
    log_type: ctx.logType,
    log_date: ctx.context && ctx.context.logDate ? ctx.context.logDate : null,
    rows: rows.map(function(r) {
      var p = byId[r.project_id];
      return { row: r.index, project: p ? p.name : r.project_id, hours: r.hours };
    }),
    // Contesto per il riconoscimento anomalie: ore pianificate e consuntivo
    // settimana corrente, per nome progetto.
    planned_week: mapToNames(ctx.context && ctx.context.planned, byId),
    actuals_week: mapToNames(ctx.context && ctx.context.actuals, byId),
  };
}

function mapToNames(byProjectId, projectsById) {
  if (!byProjectId) return {};
  var out = {};
  Object.keys(byProjectId).forEach(function(pid) {
    var p = projectsById[pid];
    out[p ? p.name : pid] = byProjectId[pid];
  });
  return out;
}

async function callGiuno(payload) {
  if (_llmCaller) return _llmCaller(payload);
  var Anthropic = require('@anthropic-ai/sdk');
  var client = new Anthropic();
  var res = await client.messages.create({
    model: MODEL,
    max_tokens: 300,
    system: 'Sei il gate di validazione dei time log di un\'agenzia creativa.\n' +
      'Ricevi le righe inviate (progetto + ore) e il contesto settimanale (ore pianificate e consuntivate).\n' +
      'Rispondi SOLO in JSON, senza testo extra:\n' +
      '{"verdict":"ok"|"reject","reject_reason":"breve motivo o null",' +
      '"anomalies":[{"row":N,"severity":"low"|"medium"|"high","reason":"breve motivo"}]}\n' +
      'Regole: rifiuta SOLO dati palesemente non plausibili (es. stesso giorno dichiarato due volte ' +
      'con totali impossibili). Scostamenti forti dal pianificato NON sono motivo di reject: ' +
      'sono anomalie da segnalare (es. pianificate 4h, consuntivate 16h → severity high).',
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
  });
  var text = res && res.content && res.content[0] ? res.content[0].text : '';
  var match = text.match(/\{[\s\S]*\}/);
  return match ? JSON.parse(match[0]) : { verdict: 'ok', anomalies: [] };
}

// ─── Orchestrazione del gate ─────────────────────────────────────────────────
// Ritorna { ok, errors|null, validation|null }.
// validation è il verdetto da persistere nella colonna time_logs.validation.
async function validateSubmission(rows, ctx) {
  var det = validateDeterministic(rows, ctx);
  if (!det.ok) return { ok: false, errors: det.errors, validation: null };

  var started = Date.now();
  try {
    var verdict = await withTimeout(function() {
      return callGiuno(buildGatePayload(rows, ctx));
    }, ctx.aiTimeoutMs || AI_TIMEOUT_MS, 'giuno time-log gate');

    if (verdict && verdict.verdict === 'reject') {
      var errors = {};
      errors[ctx.prefix + '_hours_1'] = verdict.reject_reason ||
        'I dati inseriti non sembrano plausibili: ricontrolla ore e progetti.';
      return { ok: false, errors: errors, validation: null };
    }
    return {
      ok: true, errors: null,
      validation: {
        status: 'ai_ok',
        anomalies: (verdict && verdict.anomalies) || [],
        model: MODEL,
        ms: Date.now() - started,
      },
    };
  } catch(e) {
    // LLM lento o giù: il deterministico è già passato, non perdiamo i dati.
    logger.warn('[TT-GATE] Giuno gate degradato (' + e.message + '), salvo con sola validazione deterministica');
    return {
      ok: true, errors: null,
      validation: { status: 'fallback_deterministic_only', error: e.message, ms: Date.now() - started },
    };
  }
}

// ─── Anomalie deterministiche ────────────────────────────────────────────────
// Usate in aggiunta (o in sostituzione, in caso di fallback) alle anomalie del
// gate AI. Confronta il consuntivo settimanale con il pianificato.
// args: { rows, planned: {pid: h}, actuals: {pid: h}, projectsById }
function detectAnomalies(args) {
  var anomalies = [];
  var planned = args.planned || {};
  var actuals = args.actuals || {};
  var byId = args.projectsById || {};
  (args.rows || []).forEach(function(r) {
    if (!r.project_id || r.hours == null || isNaN(r.hours)) return;
    var name = byId[r.project_id] ? byId[r.project_id].name : r.project_id;
    var plannedH = planned[r.project_id] || 0;
    var actualH = (actuals[r.project_id] || 0);
    if (plannedH === 0 && r.hours >= 4) {
      anomalies.push({
        row: r.index, project_id: r.project_id, severity: 'medium',
        reason: r.hours + 'h su "' + name + '" che non era pianificato questa settimana',
      });
    } else if (plannedH > 0 && actualH >= plannedH * 2 && (actualH - plannedH) >= 4) {
      anomalies.push({
        row: r.index, project_id: r.project_id, severity: 'high',
        reason: '"' + name + '": consuntivate ' + actualH + 'h contro ' + plannedH + 'h pianificate',
      });
    }
  });
  return anomalies;
}

module.exports = {
  validateDeterministic: validateDeterministic,
  validateSubmission: validateSubmission,
  detectAnomalies: detectAnomalies,
  setLLMCaller: setLLMCaller,
  HOURS_MIN: HOURS_MIN,
  HOURS_MAX: HOURS_MAX,
};
