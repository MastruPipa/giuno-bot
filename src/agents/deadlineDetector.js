// ─── Deadline Detector ─────────────────────────────────────────────────────────
// Detects deadlines in Slack messages and saves them to KB + memory.
// Runs in background — never blocks the main reply.

'use strict';

var logger = require('../utils/logger');

var DEADLINE_KEYWORDS = [
  'entro', 'deadline', 'scadenza', 'consegna',
  'entro venerdì', 'entro lunedì', 'entro domani',
  'entro il', 'da consegnare', 'va fatto entro',
  'scade il', 'ultimo giorno', 'entro fine',
  'entro la settimana', 'entro il mese',
];

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
      'Data di oggi: ' + new Date().toISOString().slice(0, 10),
    messages: [{ role: 'user', content: text.substring(0, 500) }],
  });

  var jsonMatch = res.content[0].text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return;

  var parsed;
  try { parsed = JSON.parse(jsonMatch[0]); } catch(e) { return; }
  if (!parsed.found) return;

  var db = require('../../supabase');

  var content = 'SCADENZA: ' + parsed.task +
    ' — entro ' + parsed.deadline +
    (parsed.person ? ' — responsabile: ' + parsed.person : '');

  db.addKBEntry(content, [
    'tipo:scadenza',
    'canale:' + channelId,
    'deadline:' + parsed.deadline,
  ], 'deadline-detector');

  db.addMemory(userId, content, ['scadenza', 'task']);

  logger.info('[DEADLINE] Rilevata:', content.substring(0, 80));

  // Schedule reminder if deadline is within 7 days
  if (parsed.deadline && parsed.deadline.match(/^\d{4}-\d{2}-\d{2}$/)) {
    var deadlineDate = new Date(parsed.deadline);
    var now = new Date();
    var daysUntil = Math.ceil((deadlineDate - now) / (1000 * 60 * 60 * 24));

    if (daysUntil > 0 && daysUntil <= 7) {
      var reminderTime = new Date(deadlineDate);
      reminderTime.setDate(reminderTime.getDate() - 1);
      reminderTime.setHours(9, 0, 0, 0);

      var msUntilReminder = reminderTime.getTime() - now.getTime();
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

module.exports = { detectAndSaveDeadlines: detectAndSaveDeadlines };
