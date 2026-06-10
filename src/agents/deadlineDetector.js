// ─── Deadline Detector ─────────────────────────────────────────────────────────
// Detects deadlines in Slack messages and saves them to KB + memory.
// Runs in background — never blocks the main reply.
//
// L'output dell'LLM viene VALIDATO prima di salvare: una data allucinata o
// già passata non deve diventare un reminder (era una delle cause dei
// "reminder sballati").

'use strict';

var logger = require('../utils/logger');
var dates = require('../utils/dates');

var DEADLINE_KEYWORDS = [
  'entro', 'deadline', 'scadenza', 'consegna',
  'entro venerdì', 'entro lunedì', 'entro domani',
  'entro il', 'da consegnare', 'va fatto entro',
  'scade il', 'ultimo giorno', 'entro fine',
  'entro la settimana', 'entro il mese',
];

// Orizzonte massimo: una "scadenza" estratta a più di 13 mesi è quasi
// certamente un errore di anno del modello.
var MAX_HORIZON_DAYS = 400;

// Valida la scadenza estratta dall'LLM. Pura e testabile.
// Ritorna { ok, iso|null, reason|null }:
//  - ok=true,  iso=YYYY-MM-DD  → data concreta valida e futura
//  - ok=true,  iso=null        → descrizione testuale ("fine mese"): salvabile ma senza reminder
//  - ok=false                  → scarta tutto (data malformata, passata o troppo lontana)
function validateDeadline(deadline, todayStr) {
  var s = String(deadline || '').trim();
  if (!s) return { ok: false, iso: null, reason: 'vuota' };
  var looksISO = /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!looksISO) return { ok: true, iso: null, reason: null }; // descrizione testuale
  if (!dates.isValidISODate(s)) return { ok: false, iso: null, reason: 'data non valida: ' + s };
  if (s < todayStr) return { ok: false, iso: null, reason: 'data passata: ' + s };
  var horizon = (new Date(s + 'T12:00:00Z') - new Date(todayStr + 'T12:00:00Z')) / 86400000;
  if (horizon > MAX_HORIZON_DAYS) return { ok: false, iso: null, reason: 'oltre orizzonte: ' + s };
  return { ok: true, iso: s, reason: null };
}

async function detectAndSaveDeadlines(userId, text, channelId) {
  if (!text || text.length < 10) return;

  var textLow = text.toLowerCase();
  var hasDeadline = DEADLINE_KEYWORDS.some(function(kw) {
    return textLow.includes(kw);
  });
  if (!hasDeadline) return;

  var Anthropic = require('@anthropic-ai/sdk');
  var client = new Anthropic();
  var res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    system: 'Estrai scadenze da messaggi Slack aziendali.\n' +
      'Rispondi SOLO in JSON: ' +
      '{"found": true, "task": "cosa va fatto", ' +
      '"deadline": "YYYY-MM-DD o descrizione", ' +
      '"person": "nome persona o null"}\n' +
      'Se non c\'è una scadenza chiara: {"found": false}\n' +
      dates.dateContextIt() + '\n' +
      'Regole sulle date:\n' +
      '- "venerdì", "lunedì" ecc. = il PROSSIMO giorno con quel nome rispetto a oggi.\n' +
      '- Se giorno/mese indicati sono già passati quest\'anno, la scadenza è dell\'anno prossimo.\n' +
      '- Usa il formato YYYY-MM-DD SOLO se la data è determinabile con certezza; altrimenti scrivi la descrizione testuale.',
    messages: [{ role: 'user', content: text.substring(0, 500) }],
  });

  var jsonMatch = res.content[0].text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return;

  var parsed;
  try { parsed = JSON.parse(jsonMatch[0]); } catch(e) { return; }
  if (!parsed.found || !parsed.task) return;

  var todayStr = dates.todayISO();
  var check = validateDeadline(parsed.deadline, todayStr);
  if (!check.ok) {
    logger.warn('[DEADLINE] Estrazione scartata (' + check.reason + '):', String(parsed.task).substring(0, 60));
    return;
  }

  var db = require('../../supabase');

  var content = 'SCADENZA: ' + parsed.task +
    ' — entro ' + parsed.deadline +
    (parsed.person ? ' — responsabile: ' + parsed.person : '') +
    ' (rilevata il ' + todayStr + ')';

  db.addKBEntry(content, [
    'tipo:scadenza',
    'canale:' + channelId,
    'deadline:' + parsed.deadline,
  ], 'deadline-detector');

  db.addMemory(userId, content, ['scadenza', 'task']);

  logger.info('[DEADLINE] Rilevata:', content.substring(0, 80));

  // Schedule reminder if deadline is within 7 days (solo date ISO validate).
  // Il reminder parte il giorno prima alle ~08:30 ora di Roma (07:30 UTC
  // d'estate, 07:30 UTC va bene anche d'inverno: 08:30 locali).
  if (check.iso) {
    var daysUntil = Math.round((new Date(check.iso + 'T12:00:00Z') - new Date(todayStr + 'T12:00:00Z')) / 86400000);

    if (daysUntil > 0 && daysUntil <= 7) {
      var reminderUtc = new Date(check.iso + 'T07:30:00Z');
      reminderUtc.setUTCDate(reminderUtc.getUTCDate() - 1);

      var msUntilReminder = reminderUtc.getTime() - Date.now();
      if (msUntilReminder > 0) {
        setTimeout(async function() {
          try {
            var { app } = require('../services/slackService');
            var msg = '*Reminder scadenza domani:*\n' + parsed.task;
            if (parsed.person) msg += '\nResponsabile: ' + parsed.person;
            await app.client.chat.postMessage({ channel: channelId, text: msg });
          } catch(e) { logger.error('[DEADLINE] Errore reminder:', e.message); }
        }, msUntilReminder);
        logger.info('[DEADLINE] Reminder schedulato tra', daysUntil - 1, 'giorni');
      }
    }
  }
}

module.exports = {
  detectAndSaveDeadlines: detectAndSaveDeadlines,
  validateDeadline: validateDeadline,
};
