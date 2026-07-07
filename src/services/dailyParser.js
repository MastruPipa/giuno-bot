// ─── Daily Parser ─────────────────────────────────────────────────────────────
// Estrae task e durate dai daily scritti a mano (DM o canale #daily), che
// prima venivano salvati come solo raw_text: zero ore, zero task — chi non
// usava il modale era invisibile al calcolo del carico. Una chiamata LLM per
// daily testuale (~10/settimana), stesso pattern JSON-extract di
// consolidaMemorie in cronHandlers.
'use strict';

var logger = require('../utils/logger');
var { safeParse } = require('../utils/safeCall');
var { withTimeout } = require('../utils/timeout');

var PARSE_TIMEOUT_MS = 20000;

// Il daily unico arriva alle 16:00: "oggi" = lavoro FATTO (consuntivo),
// "domani" = piano. Chi scrive col vecchio schema ("cosa hai fatto ieri")
// sta comunque descrivendo lavoro fatto → bucket "oggi".
var SYSTEM_PROMPT =
  'Sei un parser di daily standup di un\'agenzia creativa italiana. Il daily viene compilato nel pomeriggio: ' +
  'descrive il lavoro FATTO oggi e il piano per domani. Dal testo estrai i task con le durate.\n' +
  'Rispondi SOLO con JSON valido, nessun testo attorno:\n' +
  '{"oggi":[{"task":"testo del task senza la durata","hours":N,"minutes":N}],"domani":[...],"blocchi":"testo"|null}\n' +
  'Regole:\n' +
  '- Durate: "3h"→3h0m; "1h30"/"1,5h"/"1h 30\'"→1h30m; "45min"/"45\'"→0h45m; "mezz\'ora"→0h30m. Senza durata→0h0m.\n' +
  '- Lavoro FATTO (intestazioni tipo "Oggi", "Cosa hai fatto", anche "Ieri" per abitudine) → "oggi".\n' +
  '- Piano FUTURO (intestazioni tipo "Domani", "Cosa farai") → "domani".\n' +
  '- Se non c\'è alcuna intestazione, metti tutto in "oggi" (fatto).\n' +
  '- "blocchi" solo se esplicitamente indicati (es. "Qualcosa ti blocca?"), altrimenti null.\n' +
  '- Una riga = un task. NON inventare task né durate. Se il testo non è un daily rispondi {"oggi":[],"domani":[],"blocchi":null}.';

// Normalizza e valida l'output del modello in forma { oggi, domani, blocchi,
// totalOggi, totalDomani } compatibile con lo `structured` del modale.
// Pura e testabile. Ritorna null se non c'è nessun task utilizzabile.
// Retrocompatibilità: se il modello (o un vecchio testo) produce "ieri",
// quei task sono comunque lavoro fatto → confluiscono in "oggi".
function normalizeParsed(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;

  function cleanList(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter(function(t) { return t && typeof t.task === 'string' && t.task.trim().length > 0; })
      .slice(0, 15)
      .map(function(t) {
        var h = Math.max(0, Math.min(24, parseInt(t.hours, 10) || 0));
        var m = Math.max(0, Math.min(59, parseInt(t.minutes, 10) || 0));
        return { task: t.task.trim().substring(0, 300), hours: h, minutes: m };
      });
  }

  var oggi = cleanList(parsed.oggi).concat(cleanList(parsed.ieri)).slice(0, 15);
  var domani = cleanList(parsed.domani);
  if (oggi.length === 0 && domani.length === 0) return null;

  function totalHours(list) {
    var mins = list.reduce(function(s, t) { return s + t.hours * 60 + t.minutes; }, 0);
    return Math.round((mins / 60) * 100) / 100;
  }

  var blocchi = (typeof parsed.blocchi === 'string' && parsed.blocchi.trim())
    ? parsed.blocchi.trim().substring(0, 500) : null;

  return {
    oggi: oggi,
    domani: domani,
    blocchi: blocchi,
    totalOggi: totalHours(oggi),
    totalDomani: totalHours(domani),
  };
}

// Testo libero → structured (o null se il parsing fallisce / non è un daily).
// Non lancia mai: il chiamante salva comunque il raw_text come oggi.
async function parseDailyText(rawText) {
  var text = (rawText || '').trim();
  if (text.length < 10) return null;
  try {
    var Anthropic = require('@anthropic-ai/sdk');
    var client = new Anthropic();
    var res = await withTimeout(function() {
      return client.messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: text.substring(0, 4000) }],
      });
    }, PARSE_TIMEOUT_MS, 'dailyParser.parse');

    var out = (res.content && res.content[0] && res.content[0].text || '').trim();
    var jsonMatch = out.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    var parsed = safeParse('DAILY-PARSER', jsonMatch[0], null);
    var normalized = normalizeParsed(parsed);
    if (normalized) {
      logger.info('[DAILY-PARSER] Estratti', normalized.ieri.length, 'task ieri,',
        normalized.oggi.length, 'task oggi (', normalized.totalOggi, 'h oggi)');
    }
    return normalized;
  } catch(e) {
    logger.warn('[DAILY-PARSER] Parsing fallito (salvo solo raw_text):', e.message);
    return null;
  }
}

module.exports = {
  parseDailyText: parseDailyText,
  normalizeParsed: normalizeParsed,
};
