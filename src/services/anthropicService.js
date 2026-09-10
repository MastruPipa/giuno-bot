// ─── Anthropic Service ─────────────────────────────────────────────────────────
// Anthropic client init and the core LLM agentic loop (askGiuno).
//
// Ricalibrazione 2026-09 — cosa cambia rispetto al passato:
//   • La storia della conversazione è il thread/DM Slack (vedi slackTranscript),
//     condiviso tra tutti i partecipanti. La copia in DB è solo un fallback.
//   • Il contesto recuperato (memorie, KB, CRM, profilo…) va in un blocco di
//     sistema dinamico, NON dentro il messaggio dell'utente: la storia resta
//     pulita e il modello distingue "cosa ha detto la persona" da "cosa so io".
//   • Il prompt di sistema statico + i tool sono cacheati (prompt caching):
//     ~100 tool più il prompt costano una volta, non ad ogni turno.
//   • Modello primario da config (Opus 5), thinking adattivo, effort da env.
//   • Il modello può NON rispondere ([NO_REPLY]) quando il messaggio in un
//     thread non è rivolto a lui — decide lui leggendo il thread, non una regex.

'use strict';

require('dotenv').config();

var Anthropic = require('@anthropic-ai/sdk');
var db = require('../../supabase');
var logger = require('../utils/logger');
var datesUtil = require('../utils/dates');
var { getUserRole, getRoleSystemPrompt } = require('../../rbac');
var { resolveSlackMentions } = require('./slackService');
var { generaLinkOAuth } = require('./googleAuthService');
var registry = require('../tools/registry');
var { safeParse } = require('../utils/safeCall');
var { withTimeout } = require('../utils/retryPolicy');
var modelsConfig = require('../config/models');
var slackTranscript = require('./slackTranscript');

var MODELS = modelsConfig.MODELS;

var client = new Anthropic();

// ─── Rate limiting ─────────────────────────────────────────────────────────────

var rateLimits = new Map();
var RATE_LIMIT  = 20;
var RATE_WINDOW = 60 * 1000;

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

// ─── Sentinel "non rispondere" ────────────────────────────────────────────────

var { NO_REPLY, isNoReply } = require('../utils/noReply');

// ─── System prompt (parte statica, cacheata) ──────────────────────────────────
// Scritto per un modello che ragiona: principi e vincoli reali, non una lista di
// divieti. Tutto ciò che cambia per turno (data, utente, canale, contesto
// recuperato) vive nel blocco dinamico costruito da buildDynamicSystem.

var SYSTEM_PROMPT =
  'Sei Giuno, collega digitale di Katania Studio — agenzia di marketing di Catania, 9 persone. ' +
  'Lavori dentro Slack: rispondi in DM, nei thread e quando ti taggano nei canali. ' +
  'Parli italiano, dai del tu, tono da ufficio: diretto, concreto, senza formule da chatbot.\n' +
  'Team: Antonio (CEO), Corrado (GM), Gianna (COO/PM), Alessandra (CCO), Nicolò (Dir. Creativo), ' +
  'Giusy (Social), Paolo (Designer), Claudia (Designer), Gloria (Marketing).\n\n' +

  'COME LEGGERE LA CONVERSAZIONE\n' +
  'La storia che vedi è il thread o il DM Slack reale, nell\'ordine in cui è avvenuto. ' +
  'Nei thread di canale ogni messaggio umano è preceduto dall\'autore (<@U…> (Nome): …); i turni "assistant" sono tuoi. ' +
  'Le menzioni Slack hanno la forma <@Uxxxx>. Un messaggio breve ("sì", "quello", "e per l\'altro?") si riferisce a quanto detto subito prima: ' +
  'risolvi il riferimento dal thread, non chiedere di ripetere. ' +
  'Se nel thread le persone parlano tra loro e nessuno si rivolge a te, e ti è stato detto che puoi restare in silenzio, rispondi esattamente ' + NO_REPLY + '.\n\n' +

  'COME RISPONDI\n' +
  'Rispondi alla domanda posta, con la lunghezza che serve e non di più: una riga se basta una riga, una struttura se la richiesta è complessa. ' +
  'Domanda sì/no → prima la risposta, poi (se utile) il perché. ' +
  'Non aggiungere azioni, promemoria, riepiloghi o offerte di aiuto non richieste. ' +
  'Se ti correggono: prendi atto, correggi, non giustificarti. ' +
  'Se non hai l\'informazione dopo aver cercato, dillo chiaramente invece di riempire il vuoto con dati generici. ' +
  'Non contraddire quanto hai detto prima nello stesso thread senza spiegare cosa è cambiato.\n' +
  'Formato Slack: *grassetto* con un solo asterisco (per nomi e punti chiave), _corsivo_, elenchi con •. Mai **, mai # per i titoli, niente intestazioni in maiuscolo. ' +
  'Conferme brevi ("fatto", "salvato"). Mai mostrare ID Slack grezzi o nomi di tool; un utente disattivato si chiama "utente disattivato".\n\n' +

  'VERITÀ E FONTI\n' +
  'Non inventare dati, cifre, nomi, date. ' +
  'Le ore di lavoro vengono SOLO dai daily (query_standup) e dal consuntivo per progetto (query_time_logs): mai stimarle a occhio. ' +
  'Non classificare le persone in fasce o giudizi quantitativi non misurati. ' +
  'Il contesto recuperato (memorie, KB) ha una data: un fatto vecchio può essere superato, dallo con la sua età quando conta. ' +
  'Il CRM reale è Attio (attio_search / attio_get_record per aziende, persone, deal: valore, stage Won/Lost, servizio; scrivi con attio_create_record / attio_update_record / attio_add_note). ' +
  'search_leads è il CRM interno secondario: "prospect" = new/contacted, "clienti" = won; non mischiare le due fonti. ' +
  'Se rispondi sullo stato di un cliente senza dati CRM live, dichiaralo.\n\n' +

  'TOOL\n' +
  'Prima di rispondere su clienti, progetti o persone, se il contesto fornito non basta, usa recall_memory e search_kb. ' +
  'Se un tool fallisce, prova un\'altra via (Slack → email → KB → Drive) prima di arrenderti. ' +
  'Trascrizioni/recap meeting (Gemini notes): prima KB, poi le TUE email, poi find_emails sui colleghi che erano alla call; cerca per subject del meeting o "meeting notes". ' +
  '#daily (C05846AEV6D): contiene messaggi bot → read_channel con include_bots=true. ' +
  '"Ricordati che…" → remember_this con una frase completa (chi, cosa, quando). "Tutto su X" → entity_card. "Feedback" → get_feedback_results. "Quanto costi?" → get_api_costs. ' +
  'Se l\'utente DÀ numeri (importi, stati) è un aggiornamento CRM; se CHIEDE una stima è una quotazione. ' +
  'Non dire "ho fatto X" se non hai chiamato il tool. ' +
  'Azioni che richiedono conferma esplicita prima di eseguire: send_email, create_event, delete_event, share_file, edit_doc.\n\n' +

  'PRIVACY E CANALI\n' +
  'Le chat 1:1 tra te e ogni membro del team sono private: quando riporti a una persona qualcosa emerso in DM con un\'altra, non citare testualmente, ' +
  'non attribuire per nome ("Antonio mi ha detto…"), non ripetere dettagli personali; rielabora il fatto utile o di\' che non puoi condividerlo. ' +
  'In un canale pubblico non esporre cifre di deal, tariffe o giudizi su persone: proponi di continuare in DM. ' +
  'Tagga (<@U…>) qualcuno solo in canale e solo se deve agire; mai in DM, mai quando parli DI qualcuno. ' +
  'Quando citi un membro del team usa il suo tag preso dal roster; se un nome è ambiguo tra collega e cliente, in DM o canale interno è il collega; se non sei sicuro, chiedi.\n\n' +

  'AUTH\n' +
  'Se vedi LINK_OAUTH nel contesto, riportalo come testo formattato. Se un tool Google fallisce per autorizzazione: "collega il tuo Google".';

var _PROMPT_VERSION = 'v3_slack_native_2026_09';

// Roster + regola team: cambia raramente, quindi sta nel blocco statico
// (viene invalidata la cache solo quando il roster cambia davvero).
function buildStaticSystem() {
  var roster = '';
  try { roster = (db.formatTeamRosterForPrompt && db.formatTeamRosterForPrompt()) || ''; } catch(_) {}
  return SYSTEM_PROMPT + (roster ? '\n\n' + roster : '');
}

// Mantiene la firma storica: usata dai test e da chi vuole il prompt intero.
function buildSystemPrompt(userRolePrompt, isDM) {
  return buildStaticSystem() + '\n\n' + buildDynamicSystem({ userRolePrompt: userRolePrompt, isDM: isDM, sections: [] });
}

function buildDynamicSystem(params) {
  params = params || {};
  var now = new Date();
  var dateStr = now.toLocaleDateString('it-IT', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Europe/Rome',
  });
  var timeStr = now.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });

  var dayOfWeek = now.getDay();
  var diffToMonday = (dayOfWeek === 0) ? -6 : 1 - dayOfWeek;
  var monday = new Date(now);
  monday.setDate(now.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);
  var mondayTs = Math.floor(monday.getTime() / 1000);
  var yesterdayTs = Math.floor((now.getTime() - 86400000) / 1000);
  var todayTs = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);

  var parts = [];
  parts.push('DATA E ORA: ' + dateStr + ' ore ' + timeStr + ' (Europe/Rome). Orari studio: lun-ven 9:00-18:00.\n' +
    'Anno corrente ' + now.getFullYear() + ': le info di quest\'anno hanno priorità su quelle degli anni precedenti.\n' +
    'Timestamp utili per read_channel (oldest): lunedì di questa settimana ' + mondayTs + ' · ieri ' + yesterdayTs + ' · oggi mezzanotte ' + todayTs + '.');

  if (params.isDM) {
    parts.push('MODALITÀ DM: stai parlando in privato con una persona del team. Prosa naturale, come un collega in chat. ' +
      'Niente titoli, niente sezioni se non servono. Rispondi sempre: in DM ' + NO_REPLY + ' non è ammesso.');
  } else {
    parts.push('MODALITÀ CANALE/THREAD: altre persone leggono. Strutturato se complesso, una riga se semplice. ' +
      (params.allowSilence
        ? 'Sei nel thread ma NON sei stato taggato in questo messaggio: se non è rivolto a te (stanno parlando tra loro, o parlano di te ma non a te) rispondi esattamente ' + NO_REPLY + '.'
        : 'Sei stato taggato: rispondi.') +
      (params.isCC ? ' ATTENZIONE: sembri in copia (tag in coda a un messaggio per altri). Rispondi solo se c\'è una domanda diretta per te o un errore grave da segnalare; altrimenti ' + NO_REPLY + '.' : ''));
  }

  if (params.userRolePrompt) parts.push('RUOLO UTENTE:\n' + params.userRolePrompt);
  if (params.speakerLine) parts.push(params.speakerLine);

  (params.sections || []).forEach(function(s) { if (s) parts.push(s); });

  return parts.join('\n\n');
}

// ─── Conversation helpers ──────────────────────────────────────────────────────

function conversationKey(userId, threadTs, channelId, isDM) {
  return slackTranscript.conversationKey({ userId: userId, threadTs: threadTs, channelId: channelId, isDM: isDM });
}

function getConversations() { return db.getConvCache(); }

// Le conversazioni salvate prima della ricalibrazione contengono il blob
// "[DATI RECUPERATI: …]" appeso al messaggio utente: lo togliamo in lettura.
function sanitizeStoredTurns(turns) {
  return (turns || []).map(function(m) {
    if (!m || typeof m.content !== 'string') return m;
    var idx = m.content.indexOf('\n\n[DATI RECUPERATI:');
    if (m.role === 'user' && idx > 0) return { role: 'user', content: m.content.substring(0, idx) };
    return m;
  }).filter(function(m) { return m && typeof m.content === 'string' && m.content.trim(); });
}

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
      model: MODELS.UTILITY,
      max_tokens: 600,
      system: 'Riassumi questa conversazione di un\'agenzia di marketing. Il riassunto deve essere UTILE per riprendere il discorso domani.\n' +
        'Mantieni: nomi clienti/persone, cifre esatte, decisioni prese, azioni da fare, scadenze, problemi aperti.\n' +
        'Formato: frasi complete, non bullet point. Come se raccontassi a un collega "ieri abbiamo parlato di...".\n' +
        'NON includere: saluti, conferme banali, dettagli tecnici sul bot. Max 150 parole.',
      messages: [{ role: 'user', content: summaryPrompt }],
    });
    var summaryText = extractText(res).trim();
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
            if (!m) return;
            var before = botText.substring(Math.max(0, m.index - 20), m.index);
            if (/\b(non|niente|senza|mai)\b[^.!?\n]*$/i.test(before)) return;
            proposedActions.push({ type: ap.type, description: m[0], proposed_at: new Date().toISOString() });
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
// Memoria 1:1 persistente per utente: riassunto + action item aperti + fatti
// stabili (user_facts). Aggiornata in background, debounced.

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

  var slice = messages.slice(-16);
  var transcript = slice.map(function(m) {
    var role = m.role === 'user' ? 'Utente' : 'Giuno';
    var text = typeof m.content === 'string' ? m.content : '';
    return role + ': ' + text.replace(/\s+/g, ' ').substring(0, 400);
  }).join('\n');

  try {
    var res = await client.messages.create({
      model: MODELS.UTILITY,
      max_tokens: 600,
      system: 'Stai aggiornando la memoria di chat 1:1 tra Giuno (assistente) e un membro del team. ' +
        'Produci TRE blocchi in italiano, in questo formato ESATTO:\n\n' +
        'SUMMARY:\n<4-6 frasi su cosa sta cercando di fare, topic/clienti/progetti ricorrenti, preferenze, cosa resta in sospeso. Se domani l\'utente scrive "riprendiamo", deve bastare per ripartire.>\n\n' +
        'OPEN_ITEMS:\n<0-5 bullet di action item aperti, uno per riga, prefisso "- ". Vuoto se nessuno.>\n\n' +
        'FACTS:\n<0-8 fatti stabili, uno per riga, formato "category: fact". ' +
        'category ammesse: role, style, current_client, current_project, preference, schedule, tool. ' +
        'Fact breve (max ~100 char), assertivo, senza speculazioni. Esempio "style: conciso, diretto". ' +
        'Vuoto se nulla di chiaro.>\n\n' +
        'Niente saluti, niente meta-commenti. NON citare testualmente frasi di altre persone del team. ' +
        'Quando citi altri membri del team usa il tag <@U...> preso dal ROSTER. Non confondere i nomi (Peppe ≠ Giusy, Claudia ≠ Clà di un cliente).',
      messages: [{ role: 'user', content: (db.formatTeamRosterForPrompt ? db.formatTeamRosterForPrompt() + '\n\n' : '') + transcript }],
    });
    var raw = extractText(res).trim();
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

    if (!summary) summary = raw;

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

var _autoLearnBlacklist = /slack_user_token|search:read|limitazioni tecniche|problema tecnico.*slack|token non ha|permessi.*slack|non riesco.*accedere.*canali|configurare.*permessi|sistema briefing|sistema feedback|sistema di reporting|sistema promemoria|tracking costi api|architettura tecnica|setup operativo|pricing consulenza.*LOW.*MID|backfill|embedding.*processate|cron.*schedulat|deploy.*completat/i;

var _recentRephrases = {};
function _markRephrase(userId) { _recentRephrases[userId] = Date.now(); }
function _hasRecentRephrase(userId) {
  var t = _recentRephrases[userId];
  if (!t) return false;
  if (Date.now() - t > 10 * 60 * 1000) { delete _recentRephrases[userId]; return false; }
  return true;
}
function _clearRephrase(userId) { delete _recentRephrases[userId]; }
var _rolesKeywords = /\bceo\b|\bcoo\b|\bgm\b|\bcco\b|organigramma|rate card|€\/h/i;
var _financialKeywords = /€\s*\d|contratt[oi]|fattur|pipeline|subtotale|totale.*confermati|deal|revenue|ricavi|incasso|pagament|scadenza.*contratt|attivo fino|confermato|archiviato/i;

var AUTO_LEARN_SYSTEM =
  'Sei il modulo di apprendimento di Giuno, assistente interno di Katania Studio (agenzia marketing, 9 persone).\n' +
  'Leggi l\'ultimo scambio (con la conversazione recente come contesto) e decidi cosa vale la pena ricordare in modo DURATURO.\n' +
  'Criterio: salveresti questa cosa negli appunti se fossi un collega attento? Se tra un mese non servirà a nessuno, non salvarla.\n' +
  'Preferisci POCHE memorie precise a molte generiche. Non risalvare ciò che è già in "GIÀ NOTO".\n' +
  'Rispondi SOLO con JSON valido. Se non c\'è nulla di durevole: {"skip": true}\n' +
  '{\n' +
  '  "memories": [{"content": "frase completa e autonoma: chi, cosa, quando, perché", "tags": ["tipo:valore"]}],\n' +
  '  "profile": {"ruolo": null, "progetto": null, "cliente": null, "competenza": null, "nota": null},\n' +
  '  "kb": [{"content": "regola/procedura/decisione aziendale condivisa", "tags": ["tipo:valore"]}],\n' +
  '  "glossary": [{"term": "termine", "definition": "def", "synonyms": [], "category": "gergo_interno"}],\n' +
  '  "crm_updates": [{"name": "azienda/lead", "action": "update|create", "fields": {"status": null, "value": null, "service": null, "last_contact": null, "notes": null}}],\n' +
  '  "project_updates": [{"project_name": "nome progetto", "update": "cosa è cambiato", "client": null}],\n' +
  '  "contacts": [{"name": "persona esterna", "role": null, "company": "azienda", "email": null, "phone": null}]\n' +
  '}\n' +
  'MEMORIE: ogni memoria deve essere comprensibile da sola tra 3 mesi. ' +
  'SBAGLIATO: "Budget 15k". GIUSTO: "Antonio ha detto (02/04/2026, DM) che il budget del progetto Aitho branding è 15k€".\n' +
  'Cosa entra in memories: decisioni, preferenze e abitudini esplicite, deadline concrete, feedback, problemi aperti, relazioni tra persone/aziende.\n' +
  'Cosa entra in kb: procedure, regole e decisioni aziendali che valgono per tutto il team.\n' +
  'crm_updates SOLO se l\'utente dichiara esplicitamente un cambio di stato/valore/servizio di un lead (non da ipotesi o domande).\n' +
  'contacts: solo persone ESTERNE al team, con almeno azienda o ruolo.\n' +
  'TAG: tipo:valore (cliente:elfo, progetto:videoclip, persona:paolo, area:sviluppo).\n' +
  'NON salvare: conferme banali; domande senza risposta; ipotesi; contenuto sull\'architettura tecnica del bot (modelli, API, tool, cron, deploy); ' +
  'pricing generati dal tool di quotazione (LOW/MID/HIGH); errori tecnici, permessi, token; cose già in GIÀ NOTO.';

async function autoLearn(userId, userMessage, botReply, context) {
  context = context || {};
  if (!userMessage || userMessage.length < 10) return;
  if (isNoReply(botReply)) return;
  var msgLower = userMessage.toLowerCase();
  if (msgLower.startsWith('collega') || msgLower.startsWith('/')) return;
  if (/^(ok|sì|si|no|grazie|perfetto|capito|certo|esatto|giusto|bene|fatto|ricevuto|👍|👀)$/i.test(userMessage.trim())) return;

  if (_hasRecentRephrase(userId)) {
    logger.info('[AUTO-LEARN] Skip (recent rephrase) for', userId);
    return;
  }
  try {
    var ch = require('./correctionHandler');
    if (ch.isCorrection(userMessage)) {
      await ch.handleCorrection(userId, userMessage, botReply);
      _markRephrase(userId);
      logger.info('[AUTO-LEARN] Skip (explicit correction) for', userId);
      return;
    }
  } catch(_) {}
  _clearRephrase(userId);

  try {
    var known = '';
    if (Array.isArray(context.knownMemories) && context.knownMemories.length > 0) {
      known = 'GIÀ NOTO (non risalvare):\n' + context.knownMemories.slice(0, 12).map(function(m) {
        return '- ' + String(m).substring(0, 220);
      }).join('\n') + '\n\n---\n';
    }
    var analysisRes = await client.messages.create({
      model: MODELS.UTILITY,
      max_tokens: 900,
      system: AUTO_LEARN_SYSTEM,
      messages: [{ role: 'user', content:
        known +
        (context.conversationSummary ? 'CONVERSAZIONE RECENTE:\n' + context.conversationSummary.substring(0, 1600) + '\n\n---\n' : '') +
        'ULTIMO SCAMBIO:\nUTENTE: ' + userMessage.substring(0, 1000) + '\n\nGIUNO: ' + (botReply || '').substring(0, 800) }],
    });

    var analysisText = extractText(analysisRes).trim();
    var jsonMatch = analysisText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    var analysis = safeParse('AUTO-LEARN', jsonMatch[0], null);
    if (!analysis || analysis.skip) return;

    // Memories
    if (analysis.memories && analysis.memories.length > 0) {
      var dateTag = datesUtil.todayISO();
      var sourceTag = context.isDM ? 'DM' : (context.channelId ? '#canale' : 'conversazione');
      for (var mi = 0; mi < analysis.memories.length; mi++) {
        var m = analysis.memories[mi];
        if (m.content && m.content.length > 20 && !_autoLearnBlacklist.test(m.content) && !_financialKeywords.test(m.content)) {
          if (m.content.split(/\s+/).length < 3) continue;
          var memCache = db.getMemCache();
          var userMems = (memCache[userId] || []);
          var contentLower = m.content.toLowerCase();
          var contentWords = contentLower.split(/\s+/).filter(function(w) { return w.length > 3; });
          var isDuplicate = userMems.some(function(existing) {
            var existWords = (existing.content || '').toLowerCase().split(/\s+/).filter(function(w) { return w.length > 3; });
            if (existWords.length === 0 || contentWords.length === 0) return false;
            var overlap = contentWords.filter(function(w) { return existWords.indexOf(w) !== -1; });
            return overlap.length / contentWords.length > 0.7;
          });
          if (isDuplicate) continue;

          var enrichedContent = m.content;
          if (!/\b\d{4}-\d{2}-\d{2}\b/.test(m.content)) {
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

    // CRM auto-updates — scritture automatiche disattivabili con
    // GIUNO_AUTOLEARN_CRM_WRITES=0 (le memorie/KB continuano a essere salvate).
    var crmWritesEnabled = process.env.GIUNO_AUTOLEARN_CRM_WRITES !== '0';
    if (!crmWritesEnabled && ((analysis.crm_updates && analysis.crm_updates.length) || (analysis.contacts && analysis.contacts.length))) {
      logger.info('[AUTO-LEARN] scritture CRM/contatti saltate (GIUNO_AUTOLEARN_CRM_WRITES=0)');
    }
    if (crmWritesEnabled && analysis.crm_updates && analysis.crm_updates.length > 0) {
      try {
        var leadsTools = require('../tools/leadsTools');
        for (var ci = 0; ci < analysis.crm_updates.length; ci++) {
          var crmUpdate = analysis.crm_updates[ci];
          if (!crmUpdate.name || crmUpdate.name.length < 2) continue;
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
          var projects = await db.searchProjects({ name: pu.project_name, limit: 1 });
          if (!projects || projects.length === 0) {
            projects = await db.searchProjects({ client_name: pu.project_name, limit: 1 });
          }
          if (projects && projects.length > 0) {
            var projMemContent = '[Progetto: ' + projects[0].name + '] ' + pu.update;
            db.addMemory(userId, projMemContent, ['progetto:' + projects[0].name.toLowerCase(), 'tipo:update']);
            logger.info('[AUTO-LEARN] Project update:', projMemContent.substring(0, 60));
          } else {
            db.addMemory(userId, 'Progetto ' + pu.project_name + ': ' + pu.update, ['progetto:' + pu.project_name.toLowerCase(), 'tipo:update']);
          }
        }
      } catch(e) { logger.warn('[AUTO-LEARN] Project update error:', e.message); }
    }

    // External contacts
    if (crmWritesEnabled && analysis.contacts && analysis.contacts.length > 0) {
      try {
        var supabaseContacts = require('./db/client').getClient();
        if (supabaseContacts) {
          for (var cti = 0; cti < analysis.contacts.length; cti++) {
            var ct = analysis.contacts[cti];
            if (!ct.name || ct.name.length < 2) continue;
            var existing = await supabaseContacts.from('contacts')
              .select('id').ilike('name', '%' + ct.name + '%').limit(1);
            if (existing.data && existing.data.length > 0) continue;
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
          var existingG = db.searchGlossary(gt.term);
          if (existingG.length === 0) {
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

// ─── API call helpers ─────────────────────────────────────────────────────────

function extractText(response) {
  if (!response || !Array.isArray(response.content)) return '';
  return response.content
    .filter(function(b) { return b && b.type === 'text' && typeof b.text === 'string'; })
    .map(function(b) { return b.text; })
    .join('\n');
}

var RETRY_DELAYS = [2000, 5000, 10000];
var _refusalFallbackDisabled = false;

function _wantsRefusalFallback(model) {
  return modelsConfig.REFUSAL_FALLBACK_ENABLED && !_refusalFallbackDisabled &&
    /^claude-(opus-5|fable|mythos)/.test(String(model || ''));
}

async function _createMessage(params) {
  if (_wantsRefusalFallback(params.model)) {
    var betaParams = Object.assign({}, params, {
      betas: [modelsConfig.REFUSAL_FALLBACK_BETA],
      fallbacks: 'default',
    });
    try {
      return await client.beta.messages.create(betaParams);
    } catch(err) {
      // Se il beta/fallback non è accettato (400) proseguiamo senza per tutto
      // il processo: meglio un bot vivo senza fallback che un bot muto.
      if (err && err.status === 400 && /fallback|beta/i.test(String(err.message || ''))) {
        _refusalFallbackDisabled = true;
        logger.warn('[API] server-side fallback non accettato, disattivato per questo processo:', err.message);
      } else {
        throw err;
      }
    }
  }
  return client.messages.create(params);
}

async function callAnthropicWithRetry(params) {
  var lastError = null;
  for (var attempt = 0; attempt <= 3; attempt++) {
    try {
      var result = await _createMessage(params);
      try {
        var costTracker = require('./costTracker');
        var usage = result.usage || {};
        var cacheRead = usage.cache_read_input_tokens || 0;
        var cacheWrite = usage.cache_creation_input_tokens || 0;
        costTracker.trackCall('anthropic', params.model || 'unknown',
          (usage.input_tokens || 0) + cacheRead + cacheWrite, usage.output_tokens || 0);
        if (cacheRead || cacheWrite) {
          logger.debug('[API] cache — read:', cacheRead, 'write:', cacheWrite, 'uncached:', usage.input_tokens || 0);
        }
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

// Tool list stabile (stesso ordine ad ogni chiamata → prefisso cacheabile).
var _toolsCache = null;
function getStableTools() {
  if (!_toolsCache) _toolsCache = registry.getAllTools();
  return _toolsCache;
}

function buildPrimaryRequest(systemBlocks, messages, opts) {
  opts = opts || {};
  var model = opts.model || MODELS.PRIMARY;
  var req = {
    model: model,
    max_tokens: opts.maxTokens || 4096,
    system: systemBlocks,
    messages: messages,
    tools: opts.tools || getStableTools(),
  };
  if (modelsConfig.supportsEffort(model)) {
    req.output_config = { effort: opts.effort || modelsConfig.PRIMARY_EFFORT };
  }
  return req;
}

// ─── askGiuno — main LLM agentic loop ─────────────────────────────────────────

var MAX_TOOL_ROUNDS = 12;
var CONTEXT_CHAR_BUDGET = 14000;

function _rosterName(userId) {
  try {
    var roster = db.getTeamRoster ? db.getTeamRoster() : [];
    for (var i = 0; i < (roster || []).length; i++) {
      if (roster[i] && roster[i].slack_user_id === userId) return roster[i].canonical_name;
    }
  } catch(_) {}
  return null;
}

async function askGiuno(userId, userMessage, options) {
  options = options || {};

  if (!checkRateLimit(userId)) {
    return 'Piano piano, mbare. Troppe richieste. Aspetta un minuto.';
  }

  var userRole = await getUserRole(userId);
  var isDM = options.isDM != null ? !!options.isDM
    : (!options.channelId || String(options.channelId).charAt(0) === 'D');
  var convKey = conversationKey(userId, options.threadTs, options.channelId, isDM);
  var convCache = getConversations();

  var resolvedMessage = await resolveSlackMentions(userMessage);

  // ── Storia: transcript Slack (fonte di verità) → DB (fallback) ─────────────
  var history = [];
  var historySource = 'none';
  if (Array.isArray(options.transcript) && options.transcript.length > 0) {
    history = options.transcript.slice();
    historySource = 'slack';
  } else {
    var stored = convCache[convKey];
    if ((!stored || stored.length === 0) && options.threadTs) {
      stored = convCache[slackTranscript.legacyConversationKey({ userId: userId, threadTs: options.threadTs })];
    }
    if (stored && stored.length > 0) {
      history = sanitizeStoredTurns(stored);
      historySource = 'db';
    }
  }

  // ── Blocco dinamico di sistema ────────────────────────────────────────────
  var sections = [];

  var msgLow = (resolvedMessage || '').toLowerCase();
  if ((/colleg[a-z]|connett[a-z]|autorizz[a-z]/i.test(msgLow)) &&
      (/google|calendar|gmail|account|email|mail/i.test(msgLow))) {
    sections.push('LINK_OAUTH "<' + generaLinkOAuth(userId) + '|Collega il tuo Google>"');
  }

  var speakerName = _rosterName(userId);
  var speakerLine = 'Chi ti scrive ora: <@' + userId + '>' + (speakerName ? ' (' + speakerName + ')' : '') +
    (options.mentionedBy && options.mentionedBy !== userId ? ' — menzionato da <@' + options.mentionedBy + '>' : '') + '.';

  // Canale
  if (options.channelContext) {
    var chBlock = options.channelContext;
    if (options.channelId) {
      var chMap = db.getChannelMapCache()[options.channelId];
      if (chMap) {
        if (chMap.cliente)  chBlock += '\nCLIENTE CANALE: ' + chMap.cliente;
        if (chMap.progetto) chBlock += '\nPROGETTO CANALE: ' + chMap.progetto;
        if (chMap.tags && chMap.tags.length > 0) chBlock += '\nTAG CANALE: ' + chMap.tags.join(', ');
      }
    }
    sections.push(chBlock.trim());
  }

  // Memoria 1:1 (solo DM principale): fatti stabili, riassunto, action item.
  var isDmPrincipal = isDM && !options.threadTs;
  if (isDmPrincipal) {
    try {
      var facts = await db.getUserFacts(userId, 12);
      if (facts && facts.length > 0) {
        var factsByCat = {};
        facts.forEach(function(f) {
          if (!factsByCat[f.category]) factsByCat[f.category] = [];
          factsByCat[f.category].push(f.fact);
        });
        sections.push('FATTI STABILI SU QUESTO UTENTE:\n' + Object.keys(factsByCat).map(function(cat) {
          return '- ' + cat + ': ' + factsByCat[cat].join('; ');
        }).join('\n'));
      }
    } catch(_) {}
    try {
      var supabaseDm = require('./db/client').getClient();
      if (supabaseDm) {
        var dmMainRes = await supabaseDm.from('conversation_summaries')
          .select('summary, updated_at, messages_count, proposed_actions')
          .eq('conv_key', userId)
          .limit(1);
        if (dmMainRes.data && dmMainRes.data.length > 0 && dmMainRes.data[0].summary) {
          var dmAge = datesUtil.ageLabelIt(dmMainRes.data[0].updated_at) || 'data sconosciuta';
          var dmBlock = 'MEMORIA CHAT 1:1 CON QUESTO UTENTE (aggiornata ' + dmAge + '):\n' + dmMainRes.data[0].summary;
          var openActions = (dmMainRes.data[0].proposed_actions || [])
            .filter(function(a) { return a && a.type === 'open_item' && a.description; });
          if (openActions.length > 0) {
            dmBlock += '\nACTION ITEMS APERTI:\n' + openActions.slice(0, 5).map(function(a) {
              var actAge = datesUtil.ageLabelIt(a.proposed_at);
              return '- ' + a.description + (actAge ? ' (proposto ' + actAge + ')' : '');
            }).join('\n');
          }
          sections.push(dmBlock);
        }
      }
    } catch(_) {}
  } else if (options.threadTs && isDM) {
    try {
      var thrSummary = db.getConversationSummary ? await db.getConversationSummary(convKey) : null;
      if (thrSummary && thrSummary.summary) sections.push('CONTESTO THREAD PRECEDENTE:\n' + thrSummary.summary);
    } catch(_) {}
  }

  // Profilo utente
  var profile = (db.getProfileCache()[userId]) || {};
  if (profile.ruolo || (profile.progetti && profile.progetti.length > 0) || (profile.clienti && profile.clienti.length > 0)) {
    var prof = 'PROFILO UTENTE:';
    if (profile.ruolo) prof += '\nRuolo: ' + profile.ruolo;
    if (profile.progetti && profile.progetti.length > 0) prof += '\nProgetti: ' + profile.progetti.join(', ');
    if (profile.clienti && profile.clienti.length > 0) prof += '\nClienti: ' + profile.clienti.join(', ');
    if (profile.competenze && profile.competenze.length > 0) prof += '\nCompetenze: ' + profile.competenze.join(', ');
    if (profile.stile_comunicativo) prof += '\nStile: ' + profile.stile_comunicativo;
    sections.push(prof);
  }

  // Stile di risposta (pattern comportamentali) + tono del messaggio
  try {
    var behaviorTracker = require('./behaviorTracker');
    var behavior = await behaviorTracker.getBehaviorContext(userId);
    if (behavior && behavior.communication_style) {
      var styleHints = {
        conciso: 'Questa persona scrive corto: rispondi in poche frasi, niente elenchi se non richiesti.',
        diretto: 'Questa persona è diretta: rispondi in modo chiaro e operativo.',
        dettagliato: 'Questa persona apprezza i dettagli: puoi dare contesto in più quando serve.',
        elaborato: 'Questa persona scrive in modo elaborato: rispondi con un livello di dettaglio simile.',
      };
      var hint = styleHints[behavior.communication_style];
      if (hint) sections.push('COME RISPONDERE A QUESTO UTENTE: ' + hint +
        (behavior.topics_of_interest && behavior.topics_of_interest.length > 0 ? ' Si occupa di: ' + behavior.topics_of_interest.join(', ') + '.' : ''));
    }
  } catch(_) {}
  if (options.sentiment) {
    var s = options.sentiment;
    if (s.urgency !== 'normal' || s.sentiment !== 'neutral') {
      sections.push('TONO DEL MESSAGGIO: urgenza=' + s.urgency + ', sentiment=' + s.sentiment + '. ' + (s.responseStyle || ''));
    }
  }

  // Contesto recuperato: dal contextBuilder (via router) oppure, se assente,
  // recupero minimo locale (glossario + CRM per domande CRM).
  var knownMemories = [];
  if (options.retrievedContext) {
    sections.push(options.retrievedContext.trim());
    if (Array.isArray(options.retrievedMemories)) knownMemories = options.retrievedMemories;
  } else {
    var glossaryMatches = db.searchGlossary(resolvedMessage);
    if (glossaryMatches.length > 0) {
      sections.push('GLOSSARIO AZIENDALE:\n' + glossaryMatches.slice(0, 5).map(function(g) {
        return '• ' + g.term + ': ' + g.definition + (g.synonyms && g.synonyms.length > 0 ? ' (sinonimi: ' + g.synonyms.join(', ') + ')' : '');
      }).join('\n'));
    }
    try {
      var attioCtxMod = require('../orchestrator/attioContext');
      if (attioCtxMod.isCrmIsh(userMessage)) {
        var attioBlock = null;
        try {
          var attioData = await withTimeout(function() { return attioCtxMod.buildAttioContext(userMessage, []); }, 4000, 'askGiuno.attio');
          attioBlock = attioCtxMod.formatAttioForPrompt(attioData);
        } catch(attioErr) {
          logger.warn('[ASK-GIUNO] Attio non disponibile per domanda CRM:', attioErr && attioErr.message);
        }
        sections.push(attioBlock || '[ATTENZIONE CRM] I dati CRM live (Attio) non sono disponibili ora: se rispondi su stato/pipeline di un cliente da memorie o KB, dichiara che il dato potrebbe non essere aggiornato.');
      }
    } catch(e) { logger.debug('[ASK-GIUNO] attio enrich skip:', e && e.message); }
  }

  // Avvisi su errori passati e priorità settimanali
  try {
    var errorTracker = require('./errorTracker');
    var errorWarnings = errorTracker.getErrorWarnings(resolvedMessage);
    if (errorWarnings.length > 0) {
      sections.push('ATTENZIONE — ERRORI PASSATI SU QUESTO ARGOMENTO:\n' + errorWarnings.map(function(w) {
        return '• Errore ripetuto ' + w.count + 'x: ' + (w.lastError || '').substring(0, 150);
      }).join('\n') + '\nPrima di rispondere verifica i dati con un tool; se non sei sicuro, chiedi conferma.');
    }
  } catch(_) {}
  try {
    var supabaseForPrio = require('./db/client').getClient();
    if (supabaseForPrio) {
      var prioRes = await supabaseForPrio.from('weekly_priorities')
        .select('priorities').order('week_start', { ascending: false }).limit(1);
      var prios = prioRes.data && prioRes.data[0] && prioRes.data[0].priorities;
      if (Array.isArray(prios) && prios.length > 0) {
        sections.push('PRIORITÀ DELLA SETTIMANA (se la richiesta le riguarda, trattala come urgente):\n' + prios.map(function(p) {
          return '• ' + (p.rank || '') + '. ' + (p.text || p);
        }).join('\n'));
      }
    }
  } catch(_) {}

  if (options.preflightInstruction) sections.push(String(options.preflightInstruction).trim());

  // Tetto al contesto: oltre il budget il segnale annega nel rumore.
  var dynamicBody = sections.filter(Boolean).join('\n\n');
  if (dynamicBody.length > CONTEXT_CHAR_BUDGET) {
    var cutAt = dynamicBody.lastIndexOf('\n', CONTEXT_CHAR_BUDGET);
    if (cutAt < CONTEXT_CHAR_BUDGET * 0.8) cutAt = CONTEXT_CHAR_BUDGET;
    logger.warn('[ASK-GIUNO] contesto oltre budget (' + dynamicBody.length + ' char), troncato a ' + cutAt);
    dynamicBody = dynamicBody.substring(0, cutAt) +
      '\n[…altro contesto omesso per limiti di spazio — se ti manca un\'informazione usa i tool di ricerca invece di tirare a indovinare]';
  }

  var dynamicSystem = buildDynamicSystem({
    isDM: isDM,
    allowSilence: !!options.allowSilence,
    isCC: !!options.isCC,
    userRolePrompt: getRoleSystemPrompt(userRole),
    speakerLine: speakerLine,
    sections: dynamicBody ? ['═══ CONTESTO PER QUESTO TURNO ═══\n' + dynamicBody] : [],
  });

  var systemBlocks = [
    { type: 'text', text: buildStaticSystem(), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: dynamicSystem },
  ];

  // ── Messaggi ──────────────────────────────────────────────────────────────
  var currentTurnText = (!isDM && !options.skipAuthorLabel)
    ? '<@' + userId + '>' + (speakerName ? ' (' + speakerName + ')' : '') + ': ' + resolvedMessage
    : resolvedMessage;
  var messages = history.concat([{ role: 'user', content: currentTurnText }]);
  if (messages[0].role !== 'user') messages.unshift({ role: 'user', content: '[inizio della conversazione]' });

  logger.info('[ASK-GIUNO] user:', userId, '| key:', convKey, '| storia:', history.length, 'turni (' + historySource + ')',
    '| contesto:', dynamicBody.length, 'char | modello:', MODELS.PRIMARY);

  var finalReply = '';
  var toolsCalled = [];
  var toolEvidence = [];
  var rounds = 0;
  var refused = false;

  while (true) {
    var response;
    try {
      response = await callAnthropicWithRetry(buildPrimaryRequest(systemBlocks, messages, { maxTokens: options.maxTokens }));
    } catch(apiErr) {
      if (apiErr.message === 'API_UNAVAILABLE') {
        return 'Claude è momentaneamente sovraccarico. Riprova tra qualche minuto.';
      }
      throw apiErr;
    }

    if (response.stop_reason === 'refusal') {
      refused = true;
      logger.warn('[ASK-GIUNO] refusal', response.stop_details ? JSON.stringify(response.stop_details).substring(0, 200) : '');
      finalReply = extractText(response).trim() || 'Su questo non posso aiutarti.';
      break;
    }

    if (response.stop_reason !== 'tool_use') {
      finalReply = extractText(response);
      if (response.stop_reason === 'max_tokens') logger.warn('[ASK-GIUNO] risposta troncata (max_tokens)');
      break;
    }

    rounds++;
    messages.push({ role: 'assistant', content: response.content });

    var toolUses = response.content.filter(function(b) { return b.type === 'tool_use'; });
    var toolResults = await Promise.all(toolUses.map(async function(tu) {
      toolsCalled.push(tu.name);
      var result;
      try {
        result = await registry.executeToolCall(tu.name, tu.input, userId, userRole);
      } catch(toolErr) {
        result = { error: 'Tool ' + tu.name + ' fallito: ' + (toolErr && toolErr.message) };
      }
      var resultStr = JSON.stringify(result);
      logger.info('Tool:', tu.name, '| User:', userId, '| Result:', resultStr.substring(0, 80));
      toolEvidence.push(resultStr);
      var isError = !!(result && typeof result === 'object' && result.error && Object.keys(result).length === 1);
      var block = { type: 'tool_result', tool_use_id: tu.id, content: resultStr };
      if (isError) block.is_error = true;
      return block;
    }));

    if (rounds >= MAX_TOOL_ROUNDS) {
      toolResults.push({ type: 'text', text: '[Limite di chiamate tool raggiunto per questo turno: rispondi ora con quello che hai.]' });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  if (isNoReply(finalReply)) {
    if (options.allowSilence || options.isCC) {
      logger.info('[ASK-GIUNO] il modello ha scelto di non rispondere (key ' + convKey + ')');
      return NO_REPLY;
    }
    // In DM / mention diretta il silenzio non è ammesso: chiedi.
    finalReply = 'Dimmi pure — a cosa ti riferisci?';
  }

  // Output validation — detect hallucinated actions
  var validator = require('../orchestrator/validator');
  if (!refused) {
    var validation = validator.validate(finalReply, toolsCalled);
    if (!validation.valid) finalReply = validator.fallbackResponse(finalReply, validation.issue);

    // Nomi non ancorati: con la storia Slack completa come evidenza i falsi
    // positivi calano; in ogni caso NON si sopprime più la risposta, si
    // aggiunge solo una nota quando i nomi sconosciuti sono ≥3.
    try {
      var historyEvidence = messages.map(function(m) { return typeof m.content === 'string' ? m.content : ''; });
      var ungrounded = validator.findUngroundedEntities(finalReply,
        [resolvedMessage, dynamicBody].concat(historyEvidence, toolEvidence));
      if (ungrounded.length > 0) {
        logger.warn('[VALIDATOR] Entità non ancorate nel contesto:', ungrounded.join(', '), '| user:', userId);
        try { require('./errorTracker').recordError('ungrounded_entities:' + ungrounded.slice(0, 3).join(','), 'ungrounded_entity', userId); } catch(_) {}
        if (ungrounded.length >= 3) {
          finalReply += '\n\n_(Nota: non ho conferma nei dati su ' + ungrounded.slice(0, 3).join(', ') + ' — verifica.)_';
        }
      }
    } catch(_) {}
  }

  // Response cleanup — strip tool names and technical jargon from output
  finalReply = finalReply
    .replace(/\bread_channel\b|\bsearch_kb\b|\brecall_memory\b|\bsearch_leads\b|\bfind_emails\b|\bsearch_drive\b|\bsummarize_channel\b|\bget_channel_digest\b|\bentity_card\b|\bsearch_everywhere\b|\bupdate_lead\b|\bcreate_lead\b|\bask_gemini\b/gi, '')
    .replace(/problemi tecnici/gi, 'un problema')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // ── Persistenza (fallback DB) — turni puliti, senza contesto iniettato ─────
  if (!convCache[convKey]) convCache[convKey] = [];
  convCache[convKey].push({ role: 'user', content: currentTurnText });
  convCache[convKey].push({ role: 'assistant', content: finalReply });
  if (convCache[convKey].length > 30) {
    convCache[convKey] = await compressConversation(convCache[convKey], convKey);
  }
  db.saveConversation(convKey, convCache[convKey]);

  if (refused) return finalReply;

  if (isDmPrincipal) {
    maybeUpdateDmSummary(userId, convCache[convKey]).catch(function(e) {
      logger.debug('[DM-SUMMARY] background error:', e.message);
    });
  }

  var learnContext = {
    channelId: options.channelId || null,
    channelType: options.channelType || (isDM ? 'dm' : 'public'),
    isDM: isDM,
    threadTs: options.threadTs || null,
    knownMemories: knownMemories,
  };
  var recentTurns = messages.filter(function(m) { return typeof m.content === 'string'; }).slice(-8);
  if (recentTurns.length > 1) {
    learnContext.conversationSummary = recentTurns.map(function(m) {
      return (m.role === 'user' ? 'Utente' : 'Giuno') + ': ' + m.content.substring(0, 240);
    }).join('\n');
  }

  // Implicit negative feedback: l'utente riformula la stessa domanda.
  var userTurns = history.filter(function(m) { return m.role === 'user' && typeof m.content === 'string'; });
  var prevUserMsg = userTurns.length > 0 ? userTurns[userTurns.length - 1].content : null;
  if (prevUserMsg) {
    var words1 = resolvedMessage.toLowerCase().split(/\s+/).filter(function(w) { return w.length > 3; });
    var words2 = prevUserMsg.toLowerCase().split(/\s+/).filter(function(w) { return w.length > 3; });
    if (words1.length > 2 && words2.length > 2) {
      var overlap = words1.filter(function(w) { return words2.indexOf(w) !== -1; });
      if (overlap.length / Math.max(words1.length, words2.length) > 0.4) {
        try {
          require('./errorTracker').recordError(prevUserMsg, 'rephrase_detected', userId);
          logger.info('[FEEDBACK] Rephrase detected — implicit negative feedback');
        } catch(_) {}
        _markRephrase(userId);
        try { require('./correctionHandler').handleRephrase(userId, prevUserMsg, '').catch(function() {}); } catch(_) {}
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
  buildDynamicSystem: buildDynamicSystem,
  buildPrimaryRequest: buildPrimaryRequest,
  sanitizeStoredTurns: sanitizeStoredTurns,
  conversationKey: conversationKey,
  extractText: extractText,
  NO_REPLY: NO_REPLY,
  isNoReply: isNoReply,
  PROMPT_VERSION: _PROMPT_VERSION,
};
