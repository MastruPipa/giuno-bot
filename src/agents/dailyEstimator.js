// ─── Daily Estimator ─────────────────────────────────────────────────────────
// Chi non compila il daily non sparisce dal quadro: Giuno ricostruisce una
// PROPOSTA di daily dalle tracce della giornata e la manda in DM alla persona
// con un bottone "Confermo". Se nemmeno così arriva una risposta, alle 18:00
// la proposta viene salvata come daily STIMATO (source = 'estimate'), ben
// marcato in #daily, e sovrascritta appena la persona compila davvero.
//
// Fonti, in ordine di affidabilità:
//   1. il piano che la persona stessa aveva scritto nel daily precedente
//      ("domani" di ieri) e la pianificazione settimanale (time_logs weekly);
//   2. il calendario Google di oggi (riunioni con durata reale);
//   3. i messaggi Slack scritti oggi (search.messages, serve SLACK_USER_TOKEN);
//   4. oggetti delle email di oggi (se il Google della persona è collegato).
// Le fonti mancanti si saltano in silenzio: la stima dice da cosa deriva.
//
// Regole ferree per il modello: mai inventare task senza una traccia, ore solo
// quando c'è una durata reale (calendario) o un piano scritto, totale ≤ 8h.
// Le ore stimate NON entrano mai nel consuntivo time_logs finché la persona
// non conferma o ricompila.

'use strict';

var logger = require('../utils/logger');
var { MODELS } = require('../config/models');
var { safeParse, safeCall } = require('../utils/safeCall');
var { withTimeout } = require('../utils/retryPolicy');
var trackingDates = require('../utils/trackingDates');

var SOURCE_TIMEOUT_MS = 8000;
var MODEL_TIMEOUT_MS = 25000;

// ─── Raccolta evidenze ───────────────────────────────────────────────────────

function previousWorkingDay(dateStr) {
  var d = new Date(dateStr + 'T12:00:00Z');
  do { d.setUTCDate(d.getUTCDate() - 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().substring(0, 10);
}

async function collectEvidence(userId, dateStr, deps) {
  deps = deps || {};
  var db = deps.db || require('../../supabase');
  var app = deps.app || require('../services/slackService').app;
  var evidence = { date: dateStr, sources: [], plan_yesterday: [], weekly_plan: [], calendar: [], slack: [], emails: [] };

  // 1a. "Domani" scritto nel daily precedente
  await safeCall('ESTIMATE.plan_yesterday', async function() {
    var supabase = require('../services/db/client').getClient();
    if (!supabase) return;
    var prev = previousWorkingDay(dateStr);
    var res = await withTimeout(function() {
      return supabase.from('standup_entries').select('domani_tasks, source')
        .eq('slack_user_id', userId).eq('date', prev).limit(1);
    }, SOURCE_TIMEOUT_MS, 'estimate.plan_yesterday');
    var row = res && res.data && res.data[0];
    if (row && Array.isArray(row.domani_tasks) && row.domani_tasks.length > 0 && row.source !== 'estimate') {
      evidence.plan_yesterday = row.domani_tasks.map(function(t) {
        return { task: t.task, hours: t.hours || 0, minutes: t.minutes || 0, project: t.project_name || null };
      });
      evidence.sources.push('piano di ieri');
    }
  });

  // 1b. Pianificazione settimanale (ore per progetto)
  await safeCall('ESTIMATE.weekly_plan', async function() {
    var weekStart = trackingDates.weekStartOf(dateStr);
    var logs = await withTimeout(function() { return db.getLogsForUserDate(userId, weekStart, 'weekly'); }, SOURCE_TIMEOUT_MS, 'estimate.weekly');
    if (!logs || logs.length === 0) return;
    var rows = [];
    for (var i = 0; i < logs.length && i < 12; i++) {
      var name = logs[i].project_id;
      try { var p = await db.getProject(logs[i].project_id); if (p && p.name) name = p.name; } catch(_) {}
      rows.push({ project: name, hours_week: Number(logs[i].hours) || 0 });
    }
    if (rows.length) { evidence.weekly_plan = rows; evidence.sources.push('pianificazione settimanale'); }
  });

  // 2. Calendario di oggi
  await safeCall('ESTIMATE.calendar', async function() {
    var calendarTools = require('../tools/calendarTools');
    var res = await withTimeout(function() {
      return calendarTools.execute('find_event', { date_from: dateStr + 'T00:00:00', date_to: dateStr + 'T23:59:59' }, userId);
    }, SOURCE_TIMEOUT_MS, 'estimate.calendar');
    if (!res || res.error || !Array.isArray(res.events) || res.events.length === 0) return;
    evidence.calendar = res.events.slice(0, 12).map(function(e) {
      var start = e.start ? new Date(e.start) : null;
      var end = e.end ? new Date(e.end) : null;
      var mins = (start && end && !isNaN(start) && !isNaN(end)) ? Math.round((end - start) / 60000) : null;
      return { title: e.title, start: e.start, minutes: mins, attendees: (e.attendees || []).length };
    });
    evidence.sources.push('calendario');
  });

  // 3. Messaggi Slack scritti oggi dalla persona
  await safeCall('ESTIMATE.slack', async function() {
    var token = process.env.SLACK_USER_TOKEN;
    if (!token || !app || !app.client) return;
    var res = await withTimeout(function() {
      return app.client.search.messages({
        token: token, query: 'from:<@' + userId + '> on:' + dateStr, count: 40, sort: 'timestamp', sort_dir: 'desc',
      });
    }, SOURCE_TIMEOUT_MS, 'estimate.slack');
    var matches = (res && res.messages && res.messages.matches) || [];
    if (matches.length === 0) return;
    evidence.slack = matches.slice(0, 40).map(function(m) {
      return { channel: (m.channel && m.channel.name) || '?', text: String(m.text || '').replace(/\s+/g, ' ').substring(0, 220) };
    });
    evidence.sources.push('messaggi Slack');
  });

  // 4. Email di oggi (solo oggetto/mittente)
  await safeCall('ESTIMATE.emails', async function() {
    var gmailTools = require('../tools/gmailTools');
    var res = await withTimeout(function() {
      return gmailTools.execute('find_emails', { query: 'newer_than:1d -category:promotions', max: 15 }, userId);
    }, SOURCE_TIMEOUT_MS, 'estimate.emails');
    if (!res || res.error || !Array.isArray(res.emails) || res.emails.length === 0) return;
    evidence.emails = res.emails.map(function(e) {
      return { subject: String(e.subject || '').substring(0, 120), from: String(e.from || '').substring(0, 60) };
    });
    evidence.sources.push('email');
  });

  return evidence;
}

function hasUsableEvidence(evidence) {
  return !!(evidence && (evidence.plan_yesterday.length || evidence.calendar.length || evidence.slack.length || evidence.emails.length || evidence.weekly_plan.length));
}

// ─── Stima col modello ───────────────────────────────────────────────────────

var SYSTEM_PROMPT =
  'Ricostruisci il daily di un membro di un\'agenzia creativa italiana che NON lo ha compilato, a partire dalle tracce della sua giornata. ' +
  'Il daily ha tre parti: "oggi" (lavoro FATTO oggi con ore), "domani" (piano), "blocchi".\n' +
  'Rispondi SOLO con JSON valido:\n' +
  '{"oggi":[{"task":"descrizione breve","hours":N,"minutes":N,"basis":"da dove viene"}],"domani":[{"task":"...","hours":0,"minutes":0}],"blocchi":null,"confidence":"alta|media|bassa","note":"una frase su cosa manca"}\n' +
  'Regole:\n' +
  '- Ogni task in "oggi" deve avere una traccia concreta (riunione in calendario, messaggio Slack, email, piano scritto ieri). Niente task inventati.\n' +
  '- Ore: usa la durata reale per le riunioni in calendario; per il resto usa il piano di ieri/settimanale come stima; se non hai nulla, 0 ore.\n' +
  '- Totale "oggi" mai sopra 8 ore. Preferisci poche righe solide a molte righe deboli.\n' +
  '- "domani": solo se emerge da piano settimanale o messaggi; altrimenti lista vuota.\n' +
  '- "blocchi": solo se un messaggio lo dice esplicitamente.\n' +
  '- confidence "bassa" se hai solo piano/settimanale senza tracce del giorno; "alta" solo con calendario o messaggi che confermano.\n' +
  '- Se le tracce non bastano per nessun task: {"oggi":[],"domani":[],"blocchi":null,"confidence":"bassa","note":"..."}.';

function buildPrompt(evidence) {
  var parts = ['DATA: ' + evidence.date];
  if (evidence.plan_yesterday.length) {
    parts.push('PIANO SCRITTO IERI PER OGGI:\n' + evidence.plan_yesterday.map(function(t) {
      return '- ' + t.task + (t.hours || t.minutes ? ' (' + (t.hours ? t.hours + 'h' : '') + (t.minutes ? t.minutes + 'min' : '') + ')' : '') + (t.project ? ' [' + t.project + ']' : '');
    }).join('\n'));
  }
  if (evidence.weekly_plan.length) {
    parts.push('PIANIFICAZIONE DELLA SETTIMANA (ore totali per progetto):\n' + evidence.weekly_plan.map(function(r) {
      return '- ' + r.project + ': ' + r.hours_week + 'h';
    }).join('\n'));
  }
  if (evidence.calendar.length) {
    parts.push('CALENDARIO DI OGGI:\n' + evidence.calendar.map(function(e) {
      return '- ' + (e.title || '(senza titolo)') + (e.minutes ? ' — ' + e.minutes + ' min' : '') + (e.attendees ? ', ' + e.attendees + ' partecipanti' : '');
    }).join('\n'));
  }
  if (evidence.slack.length) {
    parts.push('MESSAGGI SLACK SCRITTI OGGI (' + evidence.slack.length + '):\n' + evidence.slack.map(function(m) {
      return '- [#' + m.channel + '] ' + m.text;
    }).join('\n'));
  }
  if (evidence.emails.length) {
    parts.push('EMAIL DI OGGI (oggetti):\n' + evidence.emails.map(function(e) {
      return '- ' + e.subject + (e.from ? ' (da ' + e.from + ')' : '');
    }).join('\n'));
  }
  return parts.join('\n\n');
}

async function estimateDaily(userId, dateStr, deps) {
  deps = deps || {};
  var evidence = await collectEvidence(userId, dateStr, deps);
  if (!hasUsableEvidence(evidence)) {
    logger.info('[DAILY-ESTIMATE] nessuna traccia per', userId, dateStr);
    return null;
  }
  var client = deps.client || new (require('@anthropic-ai/sdk'))();
  var res = await withTimeout(function() {
    return client.messages.create({
      model: MODELS.UTILITY, max_tokens: 900, system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildPrompt(evidence) }],
    });
  }, MODEL_TIMEOUT_MS, 'estimate.model');
  var text = (res.content || []).filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('');
  var m = text.match(/\{[\s\S]*\}/);
  var parsed = m ? safeParse('DAILY-ESTIMATE', m[0], null) : null;
  if (!parsed) return null;

  var { normalizeParsed } = require('../services/dailyParser');
  var structured = normalizeParsed(parsed);
  if (!structured) return null;
  // Tetto 8h sul fatto: la stima non deve mai gonfiare il carico.
  if (structured.totalOggi > 8) {
    var scale = 8 / structured.totalOggi;
    structured.oggi.forEach(function(t) {
      var mins = Math.round((t.hours * 60 + t.minutes) * scale / 15) * 15;
      t.hours = Math.floor(mins / 60); t.minutes = mins % 60;
    });
    structured.totalOggi = Math.round(structured.oggi.reduce(function(s, t) { return s + t.hours * 60 + t.minutes; }, 0) / 60 * 100) / 100;
  }
  try { await require('../services/projectMatcher').enrichStructured(structured); } catch(e) { logger.debug('[DAILY-ESTIMATE] project match:', e.message); }

  structured.estimate = {
    confidence: /^(alta|media|bassa)$/.test(String(parsed.confidence || '')) ? parsed.confidence : 'bassa',
    note: typeof parsed.note === 'string' ? parsed.note.substring(0, 200) : '',
    sources: evidence.sources.slice(),
    generated_at: new Date().toISOString(),
  };
  logger.info('[DAILY-ESTIMATE]', userId, dateStr, '→', structured.oggi.length, 'task oggi,', structured.domani.length, 'domani | fonti:', evidence.sources.join(', '), '| confidence:', structured.estimate.confidence);
  return structured;
}

// ─── Testo ───────────────────────────────────────────────────────────────────

function fmtDur(t) {
  if (!t.hours && !t.minutes) return '';
  return ' ' + (t.hours ? t.hours + 'h' : '') + (t.minutes ? t.minutes + 'min' : '');
}

// Corpo del daily come lo scriverebbe la persona (usato come raw_text della
// entry e come testo del DM/post).
function formatEstimateBody(structured) {
  var lines = [];
  if (structured.oggi && structured.oggi.length) {
    lines.push('*Oggi:*');
    structured.oggi.forEach(function(t) { lines.push('• ' + t.task + fmtDur(t)); });
  }
  if (structured.domani && structured.domani.length) {
    lines.push('*Domani:*');
    structured.domani.forEach(function(t) { lines.push('• ' + t.task + fmtDur(t)); });
  }
  if (structured.blocchi) lines.push('*Blocchi:* ' + structured.blocchi);
  return lines.join('\n');
}

function formatSourcesLine(structured) {
  var e = (structured && structured.estimate) || {};
  var src = (e.sources || []).join(', ') || 'nessuna fonte';
  return 'Ricostruito da: ' + src + ' · affidabilità ' + (e.confidence || 'bassa') + (e.note ? ' · ' + e.note : '');
}

module.exports = {
  collectEvidence: collectEvidence,
  hasUsableEvidence: hasUsableEvidence,
  buildPrompt: buildPrompt,
  estimateDaily: estimateDaily,
  formatEstimateBody: formatEstimateBody,
  formatSourcesLine: formatSourcesLine,
  previousWorkingDay: previousWorkingDay,
  SYSTEM_PROMPT: SYSTEM_PROMPT,
};
