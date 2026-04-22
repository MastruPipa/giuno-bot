// ─── Anthropic Service ─────────────────────────────────────────────────────────
// Anthropic client init and the core LLM agentic loop (askGiuno).

'use strict';

require('dotenv').config();

var Anthropic = require('@anthropic-ai/sdk');
var db = require('../../supabase');
var logger = require('../utils/logger');
var { formatPerSlack, SLACK_FORMAT_RULES } = require('../utils/slackFormat');
var { getUserRole, getRoleSystemPrompt } = require('../../rbac');
var { resolveSlackMentions } = require('./slackService');
var { generaLinkOAuth } = require('./googleAuthService');
var registry = require('../tools/registry');
var { safeParse } = require('../utils/safeCall');

var client = new Anthropic();

// ─── Rate limiting ─────────────────────────────────────────────────────────────

var rateLimits = new Map();
var RATE_LIMIT  = 20;
var RATE_WINDOW = 60 * 1000;

// ─── Response fingerprints ──────────────────────────────────────────────────
// Keep the last 3 replies per user (truncated + TTL 10min) so we can inject a
// "do not repeat" hint into the system prompt and catch obvious parroting.
var _responseFingerprints = new Map(); // userId -> [{ ts, preview }]
var FINGERPRINT_TTL_MS = 10 * 60 * 1000;
var FINGERPRINT_MAX = 3;

function pruneFingerprints(arr) {
  var cutoff = Date.now() - FINGERPRINT_TTL_MS;
  return (arr || []).filter(function(f) { return f.ts > cutoff; });
}

function getRecentReplies(userId) {
  var arr = pruneFingerprints(_responseFingerprints.get(userId));
  _responseFingerprints.set(userId, arr);
  return arr;
}

function recordReply(userId, reply) {
  var preview = String(reply || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  if (!preview) return;
  var arr = getRecentReplies(userId);
  arr.push({ ts: Date.now(), preview: preview });
  while (arr.length > FINGERPRINT_MAX) arr.shift();
  _responseFingerprints.set(userId, arr);
}

function checkRateLimit(userId) {
  var now   = Date.now();
  var entry = rateLimits.get(userId);
  if (!entry || now > entry.resetAt) {
    rateLimits.set(userId, { count: 1, resetAt: now + RATE_WINDOW });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

// ─── System prompt ─────────────────────────────────────────────────────────────

var SYSTEM_PROMPT =
  // ─── CHI SEI ──────────────────────────────────────────────────────────────
  'Ti chiami Giuno. Collega di Katania Studio, agenzia marketing, Catania, 9 persone.\n' +
  'Parli come in ufficio — naturale, diretto, italiano, dai del TU.\n' +
  'Team: Antonio (CEO), Corrado (GM), Gianna (COO/PM), Alessandra (CCO), ' +
  'Nicolò (Dir. Creativo), Giusy (Social), Paolo (Designer), Claudia (Designer), Gloria (Marketing).\n\n' +

  // ─── COME PARLI ───────────────────────────────────────────────────────────
  'COME PARLI:\n' +
  'Rispondi alla domanda e basta. Non aggiungere altro.\n' +
  'Domanda sì/no → rispondi sì o no prima.\n' +
  'Se non sai → "non ho questa info". Non inventare, non compensare con info random.\n' +
  'Se ti correggono → "hai ragione". Non giustificare.\n' +
  'Messaggi corti ("nelle mail", "quello", "sì") → il soggetto è quello del messaggio precedente.\n' +
  'Formato: frasi normali. *grassetto* solo per nomi. No CAPS, no titoloni, no report se non richiesti.\n' +
  'Conferme: "fatto", "ok", "salvato".\n\n' +

  // ─── COSA NON FARE ────────────────────────────────────────────────────────
  'NON FARE MAI:\n' +
  '• Inventare dati, cifre, nomi, date.\n' +
  '• Aggiungere azioni, reminder, follow-up non richiesti.\n' +
  '• Mostrare info sconnesse per riempire il vuoto.\n' +
  '• Mostrare nomi di tool o dire "problemi tecnici".\n' +
  '• Contraddire quello che hai detto prima.\n' +
  '• Rispondere se il messaggio è chiaramente rivolto a un\'altra persona, non a te.\n' +
  '  Se qualcuno scrive "@Antonio ti ricordi di X?" in un thread dove sei presente, NON rispondere — stanno parlando tra loro.\n' +
  '• Dire "ho fatto X" senza aver chiamato il tool.\n' +
  '• In canale pubblico: mostrare cifre deal, tariffe, giudizi su persone → manda in DM.\n' +
  '• Se sei in CC (taggato alla fine, messaggio per altri) → non rispondere.\n\n' +

  // ─── TOOL ─────────────────────────────────────────────────────────────────
  'TOOL:\n' +
  'Prima di rispondere su clienti/progetti: recall_memory + search_kb.\n' +
  'CRM: search_leads (is_active:true). "Prospect" = new/contacted. "Clienti" = won. Non mischiare.\n' +
  'Se utente DÀ numeri → update_lead. Se CHIEDE stima → quotazione.\n' +
  'Tool fallisce → prova altra via: Slack→email→KB→Drive. Non fermarti.\n' +
  'Trascrizioni meeting/recap Gemini: cerca prima nella KB, poi nelle TUE email, poi nelle email dei PARTECIPANTI del meeting.\n' +
  'Se non trovi il recap nelle tue email, prova find_emails sugli altri colleghi che erano alla call.\n' +
  'Gli appunti di Gemini arrivano via email a tutti i partecipanti — cerca con subject del meeting o "meeting notes".\n' +
  'Memorie: frase completa con chi/cosa/quando. "Ricordati che..." → remember_this.\n' +
  '"Tutto su X" → entity_card. "Feedback" → get_feedback_results. "Quanto costi?" → get_api_costs.\n' +
  'Dati recenti prioritari. Info 2024 non è attuale.\n' +
  '#daily (C05846AEV6D): messaggi bot → read_channel con include_bots=true.\n' +
  'Conferma obbligatoria: send_email, create_event, delete_event, share_file, edit_doc.\n\n' +

  // ─── CONTESTO ─────────────────────────────────────────────────────────────
  'CONTESTO:\n' +
  'Tagga persone solo in canale quando devono agire. Mai in DM. Mai se parli DI qualcuno.\n' +
  'Formato Slack: *grassetto* singolo. Mai **. Mai #.\n' +
  'Se vedi LINK_OAUTH → manda il testo formattato. Errore auth → "collega il tuo Google".';

// Old reference - keeping COME COMUNICARE as a dead variable name to avoid breaking anything
// that might reference it
var _PROMPT_VERSION = 'v2_compact_2026_04_05';

// ─── NOTE: The following sections were consolidated into the compact prompt above:
// COME COMUNICARE, FILO CONVERSAZIONE, TOOL FALLISCE, FORMATO RISPOSTE,
// VALUTAZIONE E MISURAZIONE, OBIETTIVITÀ, RIFERIMENTI CONTESTO, REGOLA ZERO,
// ANTI-DUMP, ANTI-INIZIATIVA, ANTI-CONTRADDIZIONE, SLACK FORMATTING,
// CONFERMA OBBLIGATORIA, ANTI-ALLUCINAZIONE, CANALI PUBBLICI, RIFERIMENTI IMPLICITI,
// RBAC, ANTI-TRIGGER, COMPRENSIONE RICHIESTE, MODIFICA vs CREAZIONE,
// CONTESTO CONVERSAZIONE, TOOL USAGE, STRATEGIA SLACK, FILTRO EMAIL,
// INVALIDAZIONE MEMORIES, DATE MEMORIES, QUOTAZIONI, CRM, ENTITÀ, TASSONOMIA,
// FORNITORI, FILTRO TEMPORALE, MEMORIA, USO MEMORIA, CONTATTI, SCHEDA ENTITÀ,
// PRIORITÀ, COSTI API, GESTIONE AGENZIA, TAGGING, CC/PRESA VISIONE,
// SENSIBILITÀ CONTESTO, DATI SENSIBILI, AUTH
// All consolidated into 5 sections: CHI SEI, COME PARLI, NON FARE, TOOL, CONTESTO

// The following line is needed to avoid a syntax error - the old prompt ended here
// and the next function starts. We use a dummy comment to bridge.
// --- END OF SYSTEM_PROMPT ---

function buildSystemPrompt(userRolePrompt, isDM) {
  var now = new Date();
  var dateStr = now.toLocaleDateString('it-IT', {
    weekday: 'long', year: 'numeric',
    month: 'long', day: 'numeric',
    timeZone: 'Europe/Rome',
  });
  var timeStr = now.toLocaleTimeString('it-IT', {
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/Rome',
  });

  // Timestamp helpers for read_channel filtering
  var dayOfWeek = now.getDay();
  var diffToMonday = (dayOfWeek === 0) ? -6 : 1 - dayOfWeek;
  var monday = new Date(now);
  monday.setDate(now.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);
  var mondayTs = Math.floor(monday.getTime() / 1000);
  var yesterdayTs = Math.floor((now.getTime() - 86400000) / 1000);
  var todayTs = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);

  var dmMode = isDM
    ? 'MODALITÀ DM:\n' +
      'Rispondi come persona, NON come sistema. Prosa naturale.\n' +
      'Domanda semplice → max 3 frasi. Domanda media → max 8 frasi.\n' +
      'Niente titoli bold, niente sezioni, niente bullet inutili.\n' +
      'MAI "Serve altro?", MAI recap non richiesti.\n\n'
    : 'MODALITÀ CANALE:\n' +
      'Strutturato se complesso. Conciso se semplice.\n\n';

  var lengthRule = 'LUNGHEZZA E COMUNICAZIONE:\n' +
    'Domanda semplice → 1-3 frasi. Punto. Non aggiungere altro.\n' +
    'Domanda media → 3-8 frasi. Vai dritto al punto.\n' +
    'Domanda complessa → strutturata ma senza ripetizioni.\n' +
    'REGOLE FERRO:\n' +
    '• MAI ripetere lo stesso concetto con parole diverse.\n' +
    '• MAI aggiungere info non richieste.\n' +
    '• MAI dire "SKIP", "knowledge base", "tool", "RPC", "query" — sono termini interni.\n' +
    '• MAI mostrare ragionamento tecnico all\'utente. Se non hai info, dì semplicemente "non lo so".\n' +
    '• MAI chiedere "Serve altro?" o "Posso aiutarti con altro?" — se servono ti scrivono.\n' +
    '• Parla come un collega, non come un sistema. Niente linguaggio da chatbot.\n\n';

  return 'DATA E ORA: ' + dateStr + ' ore ' + timeStr + '\n' +
    'ORARI KATANIA STUDIO: lun-ven 9:00-18:00 (Rome)\n' +
    'Anno corrente: ' + now.getFullYear() + '. Quest\'anno=' + now.getFullYear() +
    ', l\'anno scorso=' + (now.getFullYear() - 1) + '.\n' +
    'Priorità info: ' + now.getFullYear() + ' > ' + (now.getFullYear() - 1) +
    ' > ' + (now.getFullYear() - 2) + ' > storico.\n' +
    'TIMESTAMP UTILI (per oldest in read_channel):\n' +
    '• Lunedì questa settimana: ' + mondayTs + '\n' +
    '• Ieri: ' + yesterdayTs + '\n' +
    '• Oggi mezzanotte: ' + todayTs + '\n\n' +
    dmMode + lengthRule +
    SYSTEM_PROMPT + '\n\nRUOLO UTENTE:\n' + userRolePrompt;
}

// ─── Conversation helpers ──────────────────────────────────────────────────────

function conversationKey(userId, threadTs) {
  return threadTs ? userId + ':' + threadTs : userId;
}

function getConversations() { return db.getConvCache(); }

// Compresses older messages, keeping the last 12 exchanges fresh
async function compressConversation(messages, convKey) {
  var KEEP_RECENT = 12;
  if (messages.length <= KEEP_RECENT) return messages;

  var toCompress = messages.slice(0, messages.length - KEEP_RECENT);
  var recent = messages.slice(messages.length - KEEP_RECENT);

  var existingSummary = '';
  var startIdx = 0;
  if (toCompress.length > 0 && toCompress[0].role === 'user' &&
      typeof toCompress[0].content === 'string' &&
      toCompress[0].content.startsWith('[RIASSUNTO CONVERSAZIONE PRECEDENTE:')) {
    existingSummary = toCompress[0].content;
    startIdx = 1;
  }

  var toSummarize = toCompress.slice(startIdx);
  if (toSummarize.length === 0) return [toCompress[0]].concat(recent);

  var transcript = toSummarize.map(function(m) {
    var role = m.role === 'user' ? 'Utente' : 'Giuno';
    var content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return role + ': ' + content.substring(0, 500);
  }).join('\n');

  var summaryPrompt = existingSummary
    ? 'Hai già questo riassunto della conversazione:\n' + existingSummary + '\n\nEstendi il riassunto includendo questi nuovi scambi:\n' + transcript
    : 'Riassumi questa conversazione in modo conciso, mantenendo: decisioni prese, info importanti su clienti/progetti, task assegnati, preferenze utente emerse, aggiornamenti CRM menzionati.\n\n' + transcript;

  try {
    var res = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: 'Riassumi questa conversazione di un\'agenzia di marketing. Il riassunto deve essere UTILE per riprendere il discorso domani.\n' +
        'Mantieni: nomi clienti/persone, cifre esatte, decisioni prese, azioni da fare, scadenze, problemi aperti.\n' +
        'Formato: frasi complete, non bullet point. Come se raccontassi a un collega "ieri abbiamo parlato di...".\n' +
        'NON includere: saluti, conferme banali, dettagli tecnici sul bot. Max 150 parole.',
      messages: [{ role: 'user', content: summaryPrompt }],
    });
    var summaryText = res.content[0].text.trim();
    var summary = '[RIASSUNTO CONVERSAZIONE PRECEDENTE: ' + summaryText + ']';
    logger.info('[COMPRESS] Conversazione compressa:', toSummarize.length, 'messaggi → riassunto');

    // Save to conversation_summaries (fire-and-forget)
    if (convKey) {
      var proposedActions = [];
      for (var pa = messages.length - 1; pa >= 0; pa--) {
        if (messages[pa].role === 'assistant') {
          var botText = typeof messages[pa].content === 'string' ? messages[pa].content : '';
          var AP = [
            { pattern: /mand[oa] (un messaggio|un dm|il messaggio) a (\w+)/i, type: 'send_dm' },
            { pattern: /aggiorn[oa] (il crm|il lead)/i, type: 'crm_update' },
            { pattern: /cre[oa] (un evento|una call)/i, type: 'create_event' },
          ];
          AP.forEach(function(ap) {
            var m = botText.match(ap.pattern);
            if (m) proposedActions.push({ type: ap.type, description: m[0], proposed_at: new Date().toISOString() });
          });
          break;
        }
      }
      var topics = (summaryText || '').toLowerCase().split(/\W+/).filter(function(w) { return w.length > 4; }).slice(0, 10);
      db.saveConversationSummary(convKey, summaryText, messages.length, topics, proposedActions)
        .catch(function(e) { logger.warn('[COMPRESS] Summary save failed:', e.message); });
    }

    return [
      { role: 'user', content: summary },
      { role: 'assistant', content: 'Ok, ho il contesto della nostra conversazione precedente.' },
    ].concat(recent);
  } catch(e) {
    logger.error('[COMPRESS] Errore compressione:', e.message);
    return messages.slice(-12);
  }
}

// ─── DM rolling summary ──────────────────────────────────────────────────────
// The compressConversation path only fires above 20 messages, which is way too
// late for a 1:1 DM where Giuno should already remember the last few turns the
// next morning. Keep a lightweight, debounced Haiku summary per user.

var _dmSummaryState = new Map(); // userId -> { lastUpdateAt, lastMsgCount }
var DM_SUMMARY_MIN_MESSAGES = 4;
var DM_SUMMARY_MIN_GROWTH = 4;
var DM_SUMMARY_COOLDOWN_MS = 3 * 60 * 1000;

async function maybeUpdateDmSummary(userId, messages) {
  if (!userId || !Array.isArray(messages) || messages.length < DM_SUMMARY_MIN_MESSAGES) return;
  var state = _dmSummaryState.get(userId) || { lastUpdateAt: 0, lastMsgCount: 0 };
  var now = Date.now();
  var growth = messages.length - (state.lastMsgCount || 0);
  var cooledDown = (now - state.lastUpdateAt) > DM_SUMMARY_COOLDOWN_MS;
  if (!cooledDown && growth < DM_SUMMARY_MIN_GROWTH) return;

  // Keep the last ~16 turns so Haiku has enough context without blowing tokens.
  var slice = messages.slice(-16);
  var transcript = slice.map(function(m) {
    var role = m.role === 'user' ? 'Utente' : 'Giuno';
    var text = typeof m.content === 'string' ? m.content : '';
    return role + ': ' + text.replace(/\s+/g, ' ').substring(0, 400);
  }).join('\n');

  try {
    var res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: 'Stai aggiornando la memoria di chat 1:1 tra Giuno (assistente) e un membro del team. ' +
        'Produci DUE blocchi in italiano, in questo formato ESATTO:\n\n' +
        'SUMMARY:\n<4-6 frasi su cosa sta cercando di fare, topic/clienti/progetti ricorrenti, preferenze, cosa resta in sospeso. Se domani l\'utente scrive "riprendiamo", deve bastare per ripartire.>\n\n' +
        'OPEN_ITEMS:\n<0-5 bullet di action item aperti, uno per riga, prefisso "- ". Vuoto se nessuno.>\n\n' +
        'FACTS:\n<0-8 fatti stabili, uno per riga, formato "category: fact". ' +
        'category ammesse: role, style, current_client, current_project, preference, schedule, tool. ' +
        'Fact breve (max ~100 char), asserivo, senza speculation. Esempio "style: conciso, diretto". ' +
        'Vuoto se nulla di chiaro.>\n\n' +
        'Niente saluti, niente meta-commenti. NON citare testualmente frasi di altre persone del team.',
      messages: [{ role: 'user', content: transcript }],
    });
    var raw = (res.content[0] && res.content[0].text || '').trim();
    if (!raw) return;

    var summary = '';
    var openItems = [];
    var facts = [];

    var summaryMatch = raw.match(/SUMMARY:\s*([\s\S]*?)(?=\n\s*OPEN_ITEMS:|\n\s*FACTS:|$)/i);
    if (summaryMatch) summary = summaryMatch[1].trim();

    var openMatch = raw.match(/OPEN_ITEMS:\s*([\s\S]*?)(?=\n\s*FACTS:|$)/i);
    if (openMatch) {
      openItems = openMatch[1].split(/\n/).map(function(l) {
        return l.replace(/^\s*[-•*]\s*/, '').trim();
      }).filter(function(l) { return l.length > 2; });
    }

    var factsMatch = raw.match(/FACTS:\s*([\s\S]*)$/i);
    if (factsMatch) {
      factsMatch[1].split(/\n/).forEach(function(line) {
        var clean = line.replace(/^\s*[-•*]\s*/, '').trim();
        if (!clean) return;
        var colonIdx = clean.indexOf(':');
        if (colonIdx <= 0) return;
        var category = clean.slice(0, colonIdx).trim().toLowerCase();
        var fact = clean.slice(colonIdx + 1).trim();
        if (category && fact && /^(role|style|current_client|current_project|preference|schedule|tool)$/.test(category)) {
          facts.push({ category: category, fact: fact });
        }
      });
    }

    if (!summary) summary = raw; // fallback: raw text is the summary

    var topicTokens = summary.toLowerCase().split(/\W+/).filter(function(w) { return w.length > 4; });
    var seenTopics = {};
    var topics = [];
    for (var ti = 0; ti < topicTokens.length && topics.length < 10; ti++) {
      if (!seenTopics[topicTokens[ti]]) { seenTopics[topicTokens[ti]] = true; topics.push(topicTokens[ti]); }
    }

    var proposedActions = openItems.map(function(item) {
      return { type: 'open_item', description: item, proposed_at: new Date().toISOString() };
    });

    await db.saveConversationSummary(userId, summary, messages.length, topics, proposedActions);

    // Fire-and-forget: upsert extracted facts so they survive summary rewrites.
    for (var fi = 0; fi < facts.length; fi++) {
      db.upsertUserFact(userId, facts[fi].category, facts[fi].fact, 0.7).catch(function() {});
    }

    _dmSummaryState.set(userId, { lastUpdateAt: now, lastMsgCount: messages.length });
    logger.info('[DM-SUMMARY] aggiornata per', userId, '— messaggi:', messages.length, '| open:', openItems.length, '| facts:', facts.length);
  } catch(e) {
    logger.debug('[DM-SUMMARY] update skipped:', e.message);
  }
}

// ─── Auto-learn ────────────────────────────────────────────────────────────────

var { askGemini } = require('./geminiService');

var _autoLearnBlacklist = /slack_user_token|search:read|limitazioni tecniche|problema tecnico.*slack|token non ha|permessi.*slack|non riesco.*accedere.*canali|configurare.*permessi|sistema briefing|sistema feedback|sistema di reporting|sistema promemoria|tracking costi api|architettura tecnica|setup operativo|pricing consulenza.*LOW.*MID|backfill|embedding.*processate|cron.*schedulat|deploy.*completat/i;
var _rolesKeywords = /\bceo\b|\bcoo\b|\bgm\b|\bcco\b|organigramma|rate card|€\/h/i;
// Block auto-learn of financial/contract data — CRM Sheet is source of truth
var _financialKeywords = /€\s*\d|contratt[oi]|fattur|pipeline|subtotale|totale.*confermati|deal|revenue|ricavi|incasso|pagament|scadenza.*contratt|attivo fino|confermato|archiviato/i;

async function autoLearn(userId, userMessage, botReply, context) {
  context = context || {};
  if (!userMessage || userMessage.length < 10) return;
  var msgLower = userMessage.toLowerCase();
  if (msgLower.startsWith('collega') || msgLower.startsWith('/')) return;
  // Skip trivial confirmations
  if (/^(ok|sì|si|no|grazie|perfetto|capito|certo|esatto|giusto|bene|fatto|ricevuto|👍|👀)$/i.test(userMessage.trim())) return;

  // Correction handler — detect user corrections (fix #4)
  try {
    var correctionHandler = require('./correctionHandler');
    if (correctionHandler.isCorrection(userMessage)) {
      await correctionHandler.handleCorrection(userId, userMessage, botReply);
      logger.info('[AUTO-LEARN] Correzione rilevata e gestita per', userId);
    }
  } catch(e) {
    // correctionHandler may not exist yet, ignore
    if (e.code !== 'MODULE_NOT_FOUND') logger.warn('[AUTO-LEARN] Correction handler error:', e.message);
  }

  try {
    // Single LLM call for all auto-learn tasks
    var analysisRes = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: 'Sei il modulo di apprendimento di un assistente aziendale per un\'agenzia di marketing (Katania Studio, 9 persone).\n' +
        'Analizza questa conversazione ed estrai TUTTO ciò che è utile. Preferisci salvare troppo piuttosto che perdere info.\n' +
        'Rispondi SOLO in JSON valido. Se il messaggio è davvero inutile (saluto generico, "ok", "grazie"): {"skip": true}\n' +
        '{\n' +
        '  "memories": [{"content": "FRASE COMPLETA con contesto: chi ha detto cosa, a chi, quando, perché", "tags": ["tipo:valore"]}],\n' +
        '  "profile": {"ruolo": null, "progetto": null, "cliente": null, "competenza": null, "nota": null},\n' +
        '  "kb": [{"content": "info aziendale condivisa", "tags": ["tipo:valore"]}],\n' +
        '  "glossary": [{"term": "termine", "definition": "def", "synonyms": [], "category": "gergo_interno"}],\n' +
        '  "crm_updates": [{"name": "nome azienda/lead", "action": "update|create", "fields": {"status": null, "value": null, "service": null, "last_contact": null, "notes": null}}],\n' +
        '  "project_updates": [{"project_name": "nome progetto", "update": "cosa è cambiato", "client": null}],\n' +
        '  "contacts": [{"name": "nome persona esterna", "role": null, "company": "azienda", "email": null, "phone": null}]\n' +
        '}\n' +
        'COME SALVARE LE MEMORIE — REGOLA FONDAMENTALE:\n' +
        'Ogni memoria DEVE essere una frase completa e comprensibile da sola, come se la leggessi tra 3 mesi.\n' +
        'SBAGLIATO: "Budget 15k" → tra 3 mesi non sai di chi, di cosa, detto da chi.\n' +
        'GIUSTO: "Antonio ha detto (02/04/2026, DM) che il budget del progetto Aitho branding è 15k€"\n' +
        'SBAGLIATO: "Call domani" → inutile senza contesto.\n' +
        'GIUSTO: "Corrado ha organizzato una call con il cliente 869 per il 03/04/2026 alle 15:30 per presentazione branding"\n\n' +
        'COSA SALVARE:\n' +
        '- memories: preferenze, abitudini, opinioni, decisioni, task, deadline, feedback, problemi, relazioni tra persone. Sempre con CHI+COSA+QUANDO+DOVE.\n' +
        '- kb: procedure, decisioni aziendali condivise, info clienti/fornitori, nuove regole\n' +
        '- profile: ruolo, progetti, clienti seguiti, competenze, stile di lavoro\n' +
        '- contacts: persone ESTERNE (es. "Marco di Aitho", "Chiara della 869"). Solo fuori dal team KS.\n' +
        '- crm_updates: aggiornamenti lead/clienti (stato, valore, servizi)\n' +
        '- project_updates: aggiornamenti progetti (stato, blocchi, progressi)\n' +
        '- glossary: soprannomi, abbreviazioni, gergo interno\n' +
        'TAG: tipo:valore (cliente:elfo, progetto:videoclip, persona:paolo, area:sviluppo)\n' +
        'NON SALVARE MAI:\n' +
        '- Conferme banali ("ok fatto", "grazie", "capito")\n' +
        '- Info sulla propria architettura tecnica (Claude, Anthropic, API, tool, sistema)\n' +
        '- Configurazioni, deploy, briefing automatici, cron, report tecnici\n' +
        '- Pricing generati dal tool di quotazione (LOW/MID/HIGH) — quelli sono stime, non dati reali\n' +
        '- Info già presenti nelle memorie precedenti (se l\'utente ripete "Aitho è un cliente" e lo sai già, NON salvare)\n' +
        '- Log di errori, problemi tecnici, permessi, token',
      messages: [{ role: 'user', content:
        (context.conversationSummary ? 'CONVERSAZIONE RECENTE:\n' + context.conversationSummary.substring(0, 1200) + '\n\n---\n' : '') +
        'ULTIMO SCAMBIO:\nUTENTE: ' + userMessage.substring(0, 800) + '\n\nBOT: ' + botReply.substring(0, 600) }],
    });

    var analysisText = analysisRes.content[0].text.trim();
    var jsonMatch = analysisText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    var analysis = safeParse('AUTO-LEARN', jsonMatch[0], null);
    if (!analysis || analysis.skip) return;

    // Memories
    if (analysis.memories && analysis.memories.length > 0) {
      var dateTag = new Date().toISOString().slice(0, 10);
      var sourceTag = context.isDM ? 'DM' : (context.channelId ? '#canale' : 'conversazione');
      for (var mi = 0; mi < analysis.memories.length; mi++) {
        var m = analysis.memories[mi];
        if (m.content && m.content.length > 20 && !_autoLearnBlacklist.test(m.content) && !_financialKeywords.test(m.content)) {
          // Skip if too generic (just a name or single word)
          if (m.content.split(/\s+/).length < 3) continue;
          // Quality gate: check if we already know this (dedup before saving)
          var memCache = db.getMemCache();
          var userMems = (memCache[userId] || []);
          var contentLower = m.content.toLowerCase();
          var contentWords = contentLower.split(/\s+/).filter(function(w) { return w.length > 3; });
          var isDuplicate = userMems.some(function(existing) {
            var existWords = (existing.content || '').toLowerCase().split(/\s+/).filter(function(w) { return w.length > 3; });
            if (existWords.length === 0 || contentWords.length === 0) return false;
            var overlap = contentWords.filter(function(w) { return existWords.indexOf(w) !== -1; });
            return overlap.length / contentWords.length > 0.7; // >70% overlap = duplicate
          });
          if (isDuplicate) continue;

          // Append date/source if not already in content
          var enrichedContent = m.content;
          if (!m.content.includes('202') && !m.content.includes(dateTag)) {
            enrichedContent += ' (' + dateTag + ', ' + sourceTag + ')';
          }
          var tags = (m.tags || []).concat(['data:' + dateTag]);
          var memOpts = {};
          if (context && context.threadTs) memOpts.threadTs = context.threadTs;
          if (context && context.channelId) memOpts.channelId = context.channelId;
          if (context && context.channelType) memOpts.channelType = context.channelType;
          db.addMemory(userId, enrichedContent, tags, memOpts);
          logger.info('[AUTO-LEARN] Memoria:', enrichedContent.substring(0, 60));
        }
      }
    }

    // Profile
    if (analysis.profile) {
      var p = analysis.profile;
      if (p.ruolo || p.progetto || p.cliente || p.competenza || p.nota) {
        var profileTool = require('../tools/profileTools');
        profileTool.updateProfileDirect(userId, p);
        logger.info('[AUTO-LEARN] Profilo aggiornato per', userId);
      }
    }

    // KB entries — admin/finance DMs go to KB as official, other DMs as auto_learn
    if (analysis.kb && analysis.kb.length > 0) {
      var userRole = await getUserRole(userId);
      var isPrivileged = userRole === 'admin' || userRole === 'finance';
      var kbTier = isPrivileged ? 'official' : (context.channelType === 'public' ? 'slack_public' : (context.channelType === 'private' ? 'slack_private' : 'auto_learn'));
      var kbOptions = {
        confidenceTier: kbTier,
        sourceType: isPrivileged ? 'admin' : 'auto_learn',
        sourceChannelId: context.channelId || null,
        sourceChannelType: isPrivileged ? 'admin' : (context.channelType || 'conversation'),
      };
      for (var ki = 0; ki < analysis.kb.length; ki++) {
        var entry = analysis.kb[ki];
        if (!entry.content || entry.content.length <= 5) continue;
        if (_autoLearnBlacklist.test(entry.content)) continue;
        if (_rolesKeywords.test(entry.content) && !isPrivileged) continue;
        if (_financialKeywords.test(entry.content)) continue;
        db.addKBEntry(entry.content, entry.tags || [], userId, kbOptions);
        logger.info('[AUTO-LEARN] KB (' + kbTier + '):', entry.content.substring(0, 60));
      }
    }

    // CRM auto-updates (fix #5 — proactive CRM update)
    if (analysis.crm_updates && analysis.crm_updates.length > 0) {
      try {
        var leadsTools = require('../tools/leadsTools');
        for (var ci = 0; ci < analysis.crm_updates.length; ci++) {
          var crmUpdate = analysis.crm_updates[ci];
          if (!crmUpdate.name || crmUpdate.name.length < 2) continue;
          // Try to find existing lead
          var existingLeads = await leadsTools.searchLeads({ query: crmUpdate.name, limit: 1 });
          if (existingLeads && existingLeads.length > 0 && crmUpdate.action !== 'create') {
            var updateFields = {};
            if (crmUpdate.fields) {
              if (crmUpdate.fields.status) updateFields.status = crmUpdate.fields.status;
              if (crmUpdate.fields.value) updateFields.value = crmUpdate.fields.value;
              if (crmUpdate.fields.last_contact) updateFields.last_contact = crmUpdate.fields.last_contact;
              if (crmUpdate.fields.notes) updateFields.notes = crmUpdate.fields.notes;
            }
            if (Object.keys(updateFields).length > 0) {
              await leadsTools.updateLead(existingLeads[0].id, updateFields);
              logger.info('[AUTO-LEARN] CRM aggiornato:', crmUpdate.name, JSON.stringify(updateFields).substring(0, 80));
            }
          } else if (crmUpdate.action === 'create') {
            await leadsTools.createLead({ name: crmUpdate.name, ...(crmUpdate.fields || {}) });
            logger.info('[AUTO-LEARN] CRM lead creato:', crmUpdate.name);
          }
        }
      } catch(e) {
        logger.warn('[AUTO-LEARN] CRM update error:', e.message);
      }
    }

    // Project updates — link to projects table
    if (analysis.project_updates && analysis.project_updates.length > 0) {
      try {
        for (var pi = 0; pi < analysis.project_updates.length; pi++) {
          var pu = analysis.project_updates[pi];
          if (!pu.project_name || !pu.update) continue;
          // Search for existing project
          var projects = await db.searchProjects({ name: pu.project_name, limit: 1 });
          if (!projects || projects.length === 0) {
            projects = await db.searchProjects({ client_name: pu.project_name, limit: 1 });
          }
          if (projects && projects.length > 0) {
            // Save update as memory linked to project
            var projMemContent = '[Progetto: ' + projects[0].name + '] ' + pu.update;
            db.addMemory(userId, projMemContent, ['progetto:' + projects[0].name.toLowerCase(), 'tipo:update']);
            logger.info('[AUTO-LEARN] Project update:', projMemContent.substring(0, 60));
          } else {
            // No project found — save as generic memory
            db.addMemory(userId, 'Progetto ' + pu.project_name + ': ' + pu.update, ['progetto:' + pu.project_name.toLowerCase(), 'tipo:update']);
          }
        }
      } catch(e) { logger.warn('[AUTO-LEARN] Project update error:', e.message); }
    }

    // External contacts — auto-save people mentioned
    if (analysis.contacts && analysis.contacts.length > 0) {
      try {
        var supabaseContacts = require('./db/client').getClient();
        if (supabaseContacts) {
          for (var cti = 0; cti < analysis.contacts.length; cti++) {
            var ct = analysis.contacts[cti];
            if (!ct.name || ct.name.length < 2) continue;
            // Check if contact already exists
            var existing = await supabaseContacts.from('contacts')
              .select('id').ilike('name', '%' + ct.name + '%').limit(1);
            if (existing.data && existing.data.length > 0) continue; // Already exists
            // Find linked lead
            var ctLeadId = null;
            if (ct.company) {
              var ctLeads = await db.searchLeads({ company_name: ct.company, limit: 1 });
              if (ctLeads && ctLeads.length > 0) ctLeadId = ctLeads[0].id;
            }
            await supabaseContacts.from('contacts').insert({
              name: ct.name, role: ct.role || null, company: ct.company || null,
              email: ct.email || null, phone: ct.phone || null, lead_id: ctLeadId, created_by: userId,
            });
            logger.info('[AUTO-LEARN] Contatto salvato:', ct.name, ct.company || '');
          }
        }
      } catch(e) { logger.warn('[AUTO-LEARN] Contact save error:', e.message); }
    }

    // Glossary terms
    if (analysis.glossary && analysis.glossary.length > 0) {
      for (var gi = 0; gi < analysis.glossary.length; gi++) {
        var gt = analysis.glossary[gi];
        if (gt.term && gt.definition) {
          var existing = db.searchGlossary(gt.term);
          if (existing.length === 0) {
            db.addGlossaryTerm(gt.term, gt.definition, gt.synonyms || [], gt.category || 'gergo_interno', userId);
            logger.info('[AUTO-LEARN] Glossario:', gt.term);
          }
        }
      }
    }
  } catch(e) {
    if (e.name !== 'SyntaxError') logger.error('[AUTO-LEARN] Errore:', e.message);
  }
}

// ─── Retry wrapper for API calls ──────────────────────────────────────────────

var RETRY_DELAYS = [2000, 5000, 10000];

async function callAnthropicWithRetry(params) {
  var lastError = null;
  for (var attempt = 0; attempt <= 3; attempt++) {
    try {
      var result = await client.messages.create(params);
      // Track API cost
      try {
        var costTracker = require('./costTracker');
        var usage = result.usage || {};
        costTracker.trackCall('anthropic', params.model || 'unknown', usage.input_tokens || 0, usage.output_tokens || 0);
      } catch(e) { /* ignore */ }
      return result;
    } catch(err) {
      lastError = err;
      var isOverloaded = (err.status === 529) || (err.message && err.message.includes('overloaded'));
      var isRateLimit = (err.status === 429);
      if ((!isOverloaded && !isRateLimit) || attempt === 3) break;
      var delay = RETRY_DELAYS[attempt] || 10000;
      logger.warn('[API] ' + (isOverloaded ? '529 overloaded' : '429 rate limit') +
        ' — retry ' + (attempt + 1) + '/3 tra ' + (delay / 1000) + 's');
      await new Promise(function(r) { setTimeout(r, delay); });
    }
  }
  if (lastError && (lastError.status === 529 || lastError.status === 429)) {
    throw new Error('API_UNAVAILABLE');
  }
  throw lastError;
}

// ─── askGiuno — main LLM agentic loop ─────────────────────────────────────────

async function askGiuno(userId, userMessage, options) {
  options = options || {};

  if (!checkRateLimit(userId)) {
    return 'Piano piano, mbare. Troppe richieste. Aspetta un minuto.';
  }

  var userRole = await getUserRole(userId);

  var convKey = conversationKey(userId, options.threadTs);
  var convCache = getConversations();
  if (!convCache[convKey]) convCache[convKey] = [];

  var resolvedMessage = await resolveSlackMentions(userMessage);

  var contextData = '';

  // OAuth link injection
  var msgLow = (resolvedMessage || '').toLowerCase();
  if ((/colleg[a-z]|connett[a-z]|autorizz[a-z]/i.test(msgLow)) &&
      (/google|calendar|gmail|account|email|mail/i.test(msgLow))) {
    var oauthUrl = generaLinkOAuth(userId);
    contextData += '\nLINK_OAUTH "<' + oauthUrl + '|Collega il tuo Google>"\n';
  }

  if (options.mentionedBy) {
    contextData += '\n[Sei stato menzionato da <@' + options.mentionedBy + '>. Taggalo nella risposta.]\n';
  }

  if (options.channelContext) {
    contextData += '\n' + options.channelContext + '\n';
    if (options.channelId) {
      var chMap = db.getChannelMapCache()[options.channelId];
      if (chMap) {
        if (chMap.cliente)  contextData += 'CLIENTE CANALE: ' + chMap.cliente + '\n';
        if (chMap.progetto) contextData += 'PROGETTO CANALE: ' + chMap.progetto + '\n';
        if (chMap.tags && chMap.tags.length > 0) contextData += 'TAG CANALE: ' + chMap.tags.join(', ') + '\n';
      }
    }
  }

  // Entity injection — only entities relevant to the message (not ALL entities)
  try {
    var supabaseForEntities = require('./db/client').getClient();
    if (supabaseForEntities && resolvedMessage.length > 5) {
      // Extract potential entity names from the message (words > 3 chars, capitalized or known)
      var entSearchRes = await supabaseForEntities.from('kb_entities')
        .select('canonical_name, entity_category, aliases')
        .limit(500);
      if (entSearchRes.data && entSearchRes.data.length > 0) {
        var msgLower = resolvedMessage.toLowerCase();
        var matchedEntities = entSearchRes.data.filter(function(ent) {
          if (ent.canonical_name.length > 3 && msgLower.includes(ent.canonical_name.toLowerCase())) return true;
          if (ent.aliases && Array.isArray(ent.aliases)) {
            return ent.aliases.some(function(a) { return a.length > 3 && msgLower.includes(a.toLowerCase()); });
          }
          return false;
        });
        if (matchedEntities.length > 0) {
          contextData += '\nENTITÀ MENZIONATE:\n';
          matchedEntities.slice(0, 10).forEach(function(ent) {
            contextData += '• ' + ent.canonical_name + ' [' + (ent.entity_category || 'unknown') + ']\n';
          });
        }
      }
    }
  } catch(e) {
    logger.debug('[CONTEXT] Entity matching non disponibile:', e.message);
  }

  // DM summary in thread context (fix #11, #19)
  if (options.threadTs && options.isDM) {
    try {
      var convSummaries = db.getConversationSummary
        ? await db.getConversationSummary(conversationKey(userId, options.threadTs))
        : null;
      if (convSummaries && convSummaries.summary) {
        contextData += '\nCONTESTO THREAD PRECEDENTE:\n' + convSummaries.summary + '\n';
      }
    } catch(e) {
      logger.debug('[CONTEXT] DM summary non disponibile:', e.message);
    }
  }

  // Reverse context: if we're in a DM, always pull the rolling 1:1 summary
  // (conv_key = userId, no thread suffix) plus the most recent thread summary
  // for this user, so a new turn after hours/days lands on real continuity.
  if (!options.threadTs && (!options.channelId || options.isDM)) {
    try {
      var supabaseForThreadCtx = require('./db/client').getClient();
      if (supabaseForThreadCtx) {
        // 0) Sticky facts per-user — durable truths that survive summary rewrites.
        try {
          var facts = await db.getUserFacts(userId, 12);
          if (facts && facts.length > 0) {
            var factsByCat = {};
            facts.forEach(function(f) {
              if (!factsByCat[f.category]) factsByCat[f.category] = [];
              factsByCat[f.category].push(f.fact);
            });
            var factsLines = Object.keys(factsByCat).map(function(cat) {
              return '- ' + cat + ': ' + factsByCat[cat].join('; ');
            }).join('\n');
            contextData += '\nFATTI STABILI SU QUESTO UTENTE:\n' + factsLines + '\n';
          }
        } catch(factsErr) { /* user_facts may not exist yet */ }

        // 1) Main DM rolling summary — this is the bot's persistent memory of
        // this team member. Injected verbatim with a clear header.
        var dmMainRes = await supabaseForThreadCtx.from('conversation_summaries')
          .select('summary, updated_at, messages_count, proposed_actions')
          .eq('conv_key', userId)
          .limit(1);
        if (dmMainRes.data && dmMainRes.data.length > 0 && dmMainRes.data[0].summary) {
          var dmAgeH = (Date.now() - new Date(dmMainRes.data[0].updated_at).getTime()) / 3600000;
          contextData += '\nMEMORIA CHAT 1:1 CON QUESTO UTENTE (aggiornata ' + Math.round(dmAgeH) + 'h fa, ' +
            (dmMainRes.data[0].messages_count || 0) + ' messaggi totali):\n' +
            dmMainRes.data[0].summary + '\n';
          var openActions = (dmMainRes.data[0].proposed_actions || [])
            .filter(function(a) { return a && a.type === 'open_item' && a.description; });
          if (openActions.length > 0) {
            contextData += 'ACTION ITEMS APERTI CON QUESTO UTENTE:\n' +
              openActions.slice(0, 5).map(function(a) { return '- ' + a.description; }).join('\n') + '\n';
          }
        }

        // 2) Most recent thread summary for this user (if any) — useful if the
        // user had a side-thread recently.
        var recentThreadRes = await supabaseForThreadCtx.from('conversation_summaries')
          .select('conv_key, summary, updated_at')
          .like('conv_key', userId + ':%')
          .order('updated_at', { ascending: false })
          .limit(1);
        if (recentThreadRes.data && recentThreadRes.data.length > 0) {
          var threadSummary = recentThreadRes.data[0];
          if (threadSummary.summary) {
            contextData += '\n[CONTESTO DA ULTIMO THREAD]\n' +
              threadSummary.summary.substring(0, 400) + '\n';
          }
        }
      }
    } catch(threadCtxErr) {
      // Non-blocking — table may not exist
    }
  }

  // User profile context
  var profiles = db.getProfileCache();
  var profile = profiles[userId] || {};
  if (profile.ruolo || (profile.progetti && profile.progetti.length > 0) || (profile.clienti && profile.clienti.length > 0)) {
    contextData += '\nPROFILO UTENTE:\n';
    if (profile.ruolo) contextData += 'Ruolo: ' + profile.ruolo + '\n';
    if (profile.progetti && profile.progetti.length > 0) contextData += 'Progetti: ' + profile.progetti.join(', ') + '\n';
    if (profile.clienti && profile.clienti.length > 0) contextData += 'Clienti: ' + profile.clienti.join(', ') + '\n';
    if (profile.competenze && profile.competenze.length > 0) contextData += 'Competenze: ' + profile.competenze.join(', ') + '\n';
    if (profile.stile_comunicativo) contextData += 'Stile: ' + profile.stile_comunicativo + '\n';
  }

  // Cross-session context: inject latest conversation summary from this user (any thread)
  try {
    var supabaseSess = require('./db/client').getClient();
    if (supabaseSess) {
      var { data: lastSession } = await supabaseSess.from('conversation_summaries')
        .select('summary, updated_at')
        .like('conv_key', userId + '%')
        .order('updated_at', { ascending: false })
        .limit(1);
      if (lastSession && lastSession.length > 0 && lastSession[0].summary) {
        var sessionAge = (Date.now() - new Date(lastSession[0].updated_at).getTime()) / 3600000;
        if (sessionAge < 48) { // Only inject if <48h old
          contextData += '\nCONTESTO PRECEDENTE (ultima conversazione, ' + Math.round(sessionAge) + 'h fa):\n' +
            lastSession[0].summary.substring(0, 300) + '\n';
        }
      }
    }
  } catch(e) { /* non-blocking */ }

  // Behavioral profile injection — user patterns
  try {
    var behaviorTracker = require('./behaviorTracker');
    var behavior = await behaviorTracker.getBehaviorContext(userId);
    if (behavior) {
      contextData += '\nCOME RISPONDERE A QUESTO UTENTE:\n';
      if (behavior.communication_style === 'conciso') {
        contextData += 'Questa persona scrive corto. Rispondi in 1-3 frasi max. Niente elenchi, niente dettagli non richiesti.\n';
      } else if (behavior.communication_style === 'diretto') {
        contextData += 'Questa persona è diretta. Rispondi in modo chiaro e operativo, 3-6 frasi.\n';
      } else if (behavior.communication_style === 'dettagliato') {
        contextData += 'Questa persona apprezza i dettagli. Puoi dare risposte più strutturate con contesto.\n';
      } else if (behavior.communication_style === 'elaborato') {
        contextData += 'Questa persona scrive in modo elaborato. Rispondi con livello di dettaglio simile.\n';
      }
      if (behavior.topics_of_interest && behavior.topics_of_interest.length > 0) {
        contextData += 'Si occupa di: ' + behavior.topics_of_interest.join(', ') + '\n';
      }
    }
  } catch(e) {
    // behaviorTracker may not be ready
  }

  // Sentiment/urgency injection (from handler)
  if (options.sentiment) {
    var s = options.sentiment;
    if (s.urgency !== 'normal' || s.sentiment !== 'neutral') {
      contextData += '\n[TONO MESSAGGIO: urgenza=' + s.urgency + ', sentiment=' + s.sentiment + '. ' + s.responseStyle + ']\n';
    }
  }

  // Glossary injection
  var glossaryMatches = db.searchGlossary(resolvedMessage);
  if (glossaryMatches.length > 0) {
    contextData += '\nGLOSSARIO AZIENDALE:\n';
    glossaryMatches.slice(0, 5).forEach(function(g) {
      contextData += '• ' + g.term + ': ' + g.definition;
      if (g.synonyms && g.synonyms.length > 0) {
        contextData += ' (sinonimi: ' + g.synonyms.join(', ') + ')';
      }
      contextData += '\n';
    });
  }

  // Preflight instruction injection
  if (options.preflightInstruction) {
    contextData += '\n' + options.preflightInstruction + '\n';
  }

  // Cross-user redaction rule — always on. Each team member's DMs are private:
  // never quote verbatim what user A said in DM when answering user B, and
  // never attribute sensitive info to a specific colleague by name unless the
  // current user was part of that conversation.
  contextData += '\n[PRIVACY] Le chat 1:1 tra Giuno e ogni membro del team sono private. ' +
    'Se riferisci info emerse in DM con un\'altra persona, NON citare virgolettato, ' +
    'NON attribuire per nome ("Antonio mi ha detto..."), e NON ripetere dettagli personali. ' +
    'Rielabora a livello di fatto utile, senza fonte, oppure di\' "non posso dirtelo" se è manifestamente privato.\n';

  // Error pattern warnings — if this topic has known mistakes, warn the LLM
  try {
    var errorTracker = require('./errorTracker');
    var errorWarnings = errorTracker.getErrorWarnings(resolvedMessage);
    if (errorWarnings.length > 0) {
      contextData += '\n⚠️ ATTENZIONE — ERRORI PASSATI SU QUESTO ARGOMENTO:\n';
      errorWarnings.forEach(function(w) {
        contextData += '• Errore ripetuto ' + w.count + 'x: ' + (w.lastError || '').substring(0, 150) + '\n';
      });
      contextData += 'PRIMA di rispondere, verifica i dati con un tool. Se non sei sicuro, chiedi conferma.\n';
    }
  } catch(e) { /* errorTracker not available */ }

  // Anti-repetition: inject the last 3 replies we sent to this user so the
  // model knows what NOT to parrot (fixes "tende ad essere ripetitivo").
  var recentReplies = getRecentReplies(userId);
  if (recentReplies.length > 0) {
    contextData += '\n[ULTIME RISPOSTE CHE HAI GIÀ DATO A QUESTO UTENTE (non ripeterle parola per parola, e se la domanda è la stessa di una di queste fai una variazione utile o chiedi precisazione):\n';
    recentReplies.forEach(function(r, idx) {
      contextData += (idx + 1) + '. "' + r.preview + '"\n';
    });
    contextData += ']\n';
  }

  // Weekly priorities injection
  try {
    var supabaseForPrio = require('./db/client').getClient();
    if (supabaseForPrio) {
      var prioRes = await supabaseForPrio.from('weekly_priorities')
        .select('priorities')
        .order('week_start', { ascending: false })
        .limit(1);
      if (prioRes.data && prioRes.data.length > 0 && prioRes.data[0].priorities) {
        var prios = prioRes.data[0].priorities;
        if (Array.isArray(prios) && prios.length > 0) {
          contextData += '\n🎯 PRIORITÀ SETTIMANA:\n';
          prios.forEach(function(p) {
            contextData += '• ' + (p.rank || '') + '. ' + (p.text || p) + '\n';
          });
          contextData += 'Queste sono le priorità correnti. Se la richiesta riguarda una di queste, trattala come urgente.\n';
        }
      }
    }
  } catch(e) { /* ignore */ }

  var messageWithContext = contextData
    ? resolvedMessage + '\n\n[DATI RECUPERATI:\n' + contextData + ']'
    : resolvedMessage;

  var messages = convCache[convKey].concat([{ role: 'user', content: messageWithContext }]);

  var allTools = registry.getAllTools();
  var finalReply = '';
  var retryCount = 0;
  var toolsCalled = [];

  while (true) {
    var response;
    try {
      response = await callAnthropicWithRetry({
        model: 'claude-sonnet-4-20250514',
        max_tokens: options.isDM ? 500 : 900,
        system: buildSystemPrompt(getRoleSystemPrompt(userRole), options.isDM),
        messages: messages,
        tools: allTools,
      });
    } catch(apiErr) {
      if (apiErr.message === 'API_UNAVAILABLE') {
        return 'Claude è momentaneamente sovraccarico. Riprova tra qualche minuto.';
      }
      throw apiErr;
    }

    if (response.stop_reason !== 'tool_use') {
      finalReply = response.content
        .filter(function(b) { return b.type === 'text'; })
        .map(function(b) { return b.text; })
        .join('\n');
      break;
    }

    messages.push({ role: 'assistant', content: response.content });

    var toolResults = await Promise.all(
      response.content
        .filter(function(b) { return b.type === 'tool_use'; })
        .map(async function(tu) {
          toolsCalled.push(tu.name);
          var result = await registry.executeToolCall(tu.name, tu.input, userId, userRole);
          var resultStr = JSON.stringify(result);
          logger.info('Tool:', tu.name, '| User:', userId, '| Result:', resultStr.substring(0, 80));

          return { type: 'tool_result', tool_use_id: tu.id, content: resultStr };
        })
    );

    messages.push({ role: 'user', content: toolResults });
  }

  // Output validation — detect hallucinated actions
  var validator = require('../orchestrator/validator');
  var validation = validator.validate(finalReply, toolsCalled);
  if (!validation.valid) {
    finalReply = validator.fallbackResponse(finalReply, validation.issue);
  }

  // Soft signal: capitalized names that don't appear in user message or
  // contextData are candidates for hallucination. Log only — too many false
  // positives (e.g. fresh entity names) to block on this alone.
  try {
    var ungrounded = validator.findUngroundedEntities(finalReply, [resolvedMessage, contextData]);
    if (ungrounded.length > 0) {
      logger.warn('[VALIDATOR] Entità non ancorate nel contesto:', ungrounded.join(', '),
        '| user:', userId, '| reply:', finalReply.substring(0, 120));
      try {
        require('./errorTracker').recordError('ungrounded_entities:' + ungrounded.slice(0, 3).join(','), 'ungrounded_entity', userId);
      } catch(_) {}
    }
  } catch(_) {}

  // Response cleanup — strip tool names and technical jargon from output
  finalReply = finalReply
    .replace(/\bread_channel\b|\bsearch_kb\b|\brecall_memory\b|\bsearch_leads\b|\bfind_emails\b|\bsearch_drive\b|\bsummarize_channel\b|\bget_channel_digest\b|\bentity_card\b|\bsearch_everywhere\b|\bupdate_lead\b|\bcreate_lead\b|\bask_gemini\b/gi, '')
    .replace(/knowledge base aziendale/gi, '')
    .replace(/\bknowledge base\b/gi, '')
    .replace(/problemi tecnici/gi, 'un problema')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  convCache[convKey].push({ role: 'user', content: messageWithContext });
  convCache[convKey].push({ role: 'assistant', content: finalReply });
  if (convCache[convKey].length > 20) {
    convCache[convKey] = await compressConversation(convCache[convKey], convKey);
  }
  db.saveConversation(convKey, convCache[convKey]);
  recordReply(userId, finalReply);

  // Keep the 1:1 DM memory fresh (debounced, Haiku — see maybeUpdateDmSummary).
  var isDmPrincipal = !options.threadTs && (options.isDM || !options.channelId || (options.channelId && options.channelId.startsWith('D')));
  if (isDmPrincipal) {
    maybeUpdateDmSummary(userId, convCache[convKey]).catch(function(e) {
      logger.debug('[DM-SUMMARY] background error:', e.message);
    });
  }

  var learnContext = {
    channelId: options.channelId || null,
    channelType: options.channelType || 'dm',
    isDM: !options.channelId || (options.channelId && options.channelId.startsWith('D')),
    threadTs: options.threadTs || null,
  };
  if (options.channelType) learnContext.channelType = options.channelType;
  if (options.isDM != null) learnContext.isDM = options.isDM;
  // Pass recent conversation history so autoLearn has full context
  var recentConv = convCache[convKey] || [];
  if (recentConv.length > 2) {
    var convSummary = recentConv.slice(-8).map(function(m) {
      var role = m.role === 'user' ? 'Utente' : 'Giuno';
      var text = typeof m.content === 'string' ? m.content : '';
      return role + ': ' + text.substring(0, 200);
    }).join('\n');
    learnContext.conversationSummary = convSummary;
  }
  // Detect implicit negative feedback: if user rephrases their question right after
  var prevMessages = convCache[convKey] || [];
  if (prevMessages.length >= 4) {
    var lastUserMsg = null;
    var secondLastUserMsg = null;
    for (var pi = prevMessages.length - 1; pi >= 0; pi--) {
      if (prevMessages[pi].role === 'user' && typeof prevMessages[pi].content === 'string') {
        if (!lastUserMsg) lastUserMsg = prevMessages[pi].content;
        else if (!secondLastUserMsg) { secondLastUserMsg = prevMessages[pi].content; break; }
      }
    }
    if (lastUserMsg && secondLastUserMsg) {
      // If user's last two messages share >40% words, they're rephrasing = bad answer
      var words1 = lastUserMsg.toLowerCase().split(/\s+/).filter(function(w) { return w.length > 3; });
      var words2 = secondLastUserMsg.toLowerCase().split(/\s+/).filter(function(w) { return w.length > 3; });
      if (words1.length > 2 && words2.length > 2) {
        var overlap = words1.filter(function(w) { return words2.indexOf(w) !== -1; });
        if (overlap.length / Math.max(words1.length, words2.length) > 0.4) {
          try {
            var errorTracker = require('./errorTracker');
            errorTracker.recordError(secondLastUserMsg, 'rephrase_detected', userId);
            logger.info('[FEEDBACK] Rephrase detected — implicit negative feedback');
          } catch(e) { /* ignore */ }
        }
      }
    }
  }

  autoLearn(userId, resolvedMessage, finalReply, learnContext).catch(function(e) {
    logger.error('Auto-learn error:', e.message);
  });

  return finalReply;
}

module.exports = {
  client: client,
  askGiuno: askGiuno,
  autoLearn: autoLearn,
  SYSTEM_PROMPT: SYSTEM_PROMPT,
  buildSystemPrompt: buildSystemPrompt,
  conversationKey: conversationKey,
};
