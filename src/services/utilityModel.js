// ─── Chiamate "utility" al modello ───────────────────────────────────────────
// Un solo punto per le chiamate di servizio (stime, parser, riassunti,
// memorie, aggancio commesse): niente tool, una risposta breve, spesso JSON.
//
// Perché esiste (17/9/2026): dal 10/9 il modello utility è claude-sonnet-5,
// che ragiona (thinking) di default. Con budget di 60-1500 token il modello
// consumava tutto il budget ragionando e non scriveva la risposta: contenuto
// senza blocco di testo, JSON non trovato, null silenzioso. Nessuna stima
// del daily per una settimana, parser dei daily a zero task, consolidamento
// memorie con "reading 'trim' of undefined". Qui il thinking è spento dove il
// modello lo consente, la risposta vuota o troncata viene loggata, e ogni
// chiamata finisce nel tracker dei costi con il nome della funzione.
'use strict';

var logger = require('../utils/logger');
var modelsConfig = require('../config/models');

var _client = null;
function defaultClient() {
  if (!_client) { var Anthropic = require('@anthropic-ai/sdk'); _client = new Anthropic(); }
  return _client;
}

// Testo della risposta: solo i blocchi text (un blocco thinking non è testo).
function textOf(res) {
  if (!res || !Array.isArray(res.content)) return '';
  return res.content
    .filter(function(b) { return b && b.type === 'text' && typeof b.text === 'string'; })
    .map(function(b) { return b.text; })
    .join('\n');
}

function track(res, model, feature) {
  try {
    var usage = (res && res.usage) || {};
    require('./costTracker').trackCall('anthropic', model, usage.input_tokens || 0, usage.output_tokens || 0, {
      feature: feature, cacheRead: usage.cache_read_input_tokens || 0, cacheWrite: usage.cache_creation_input_tokens || 0,
    });
  } catch(e) { logger.debug('[UTILITY] tracking saltato:', e.message); }
}

// Parametri come messages.create; model di default MODELS.UTILITY.
// opts.client: un client alternativo (test, o il client condiviso).
async function create(params, feature, opts) {
  opts = opts || {};
  feature = feature || 'utility';
  var req = Object.assign({}, params || {});
  req.model = req.model || modelsConfig.MODELS.UTILITY;
  Object.assign(req, modelsConfig.thinkingOffParams(req.model));
  var client = opts.client || defaultClient();
  var res = await client.messages.create(req);
  track(res, req.model, feature);
  var text = textOf(res);
  if (!text.trim()) {
    logger.warn('[UTILITY:' + feature + '] risposta senza testo (modello ' + req.model + ', stop_reason ' + (res && res.stop_reason) + ', max_tokens ' + req.max_tokens + ')');
  } else if (res && res.stop_reason === 'max_tokens') {
    logger.warn('[UTILITY:' + feature + '] risposta troncata a max_tokens=' + req.max_tokens + ' (modello ' + req.model + ')');
  }
  return res;
}

// Un "client" con la sola messages.create, per i punti che ne avevano uno
// proprio: cambia solo da dove arriva il client, non la chiamata.
function client(feature, opts) {
  return { messages: { create: function(params) { return create(params, feature, opts); } } };
}

module.exports = { create: create, client: client, textOf: textOf };
