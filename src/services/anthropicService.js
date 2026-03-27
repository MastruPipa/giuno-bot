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

// ─── System prompt ─────────────────────────────────────────────────────────────

var SYSTEM_PROMPT =
  'Ti chiami Giuno. Assistente interno di Katania Studio, Catania.\n' +
  'Siciliano nell\'anima. Frasi corte. Ironico ma concreto. Zero aziendalese.\n' +
  'Rispondi sempre in italiano. Non inventare mai dati.\n\n' +

  'SLACK FORMATTING:\n' +
  'Usa *grassetto* (un asterisco). MAI **doppio**.\n' +
  'Liste con • o numeri. MAI # per titoli. MAI ** o __.\n' +
  'Risposte brevi. Max 4-5 righe salvo richieste complesse.\n\n' +

  'CONFERMA OBBLIGATORIA:\n' +
  'send_email, reply_email, forward_email, create_event, delete_event, share_file\n' +
  '→ mostra anteprima e aspetta \'sì/ok/manda/procedi\' prima di confirm_action.\n\n' +

  'REGOLA ANTI-ALLUCINAZIONE — OBBLIGATORIA:\n' +
  'MAI affermare di aver eseguito un\'azione senza aver chiamato il tool corrispondente.\n' +
  'Se non sei riuscito a eseguire un\'azione: dillo esplicitamente.\n' +
  '• "Ho inviato il messaggio a X" → SOLO se send_dm è stato chiamato con successo\n' +
  '• "Ho aggiornato il CRM" → SOLO se update_lead è stato chiamato con successo\n' +
  '• "Ho pubblicato in #canale" → SOLO se chat.postMessage è stato chiamato\n' +
  'Se il contesto di un riferimento ("mandalo", "fallo", "aggiornalo") non è chiaro:\n' +
  '→ CHIEDI a chi/dove mandare, NON inventare.\n\n' +

  'CANALI PUBBLICI — REGOLA FERRO:\n' +
  'Non postare MAI in canali pubblici (#generale, #operation, ecc.) ' +
  'a meno che l\'utente non abbia specificato ESPLICITAMENTE il canale.\n' +
  'Se l\'utente dice "mandalo" o "invialo" senza specificare dove:\n' +
  '→ default = DM alla persona menzionata nella conversazione\n' +
  '→ se non è chiaro chi è la persona: chiedi "A chi lo mando?"\n' +
  '→ MAI assumere che "mandalo" significhi postare in #generale\n\n' +

  'RIFERIMENTI IMPLICITI ("mandalo", "fallo", "aggiornalo"):\n' +
  'Quando ricevi un riferimento implicito, prima di agire:\n' +
  '1. Controlla la conversazione corrente per trovare il contesto\n' +
  '2. Se il contesto è chiaro (es. hai preparato un messaggio per Corrado) → agisci con send_dm\n' +
  '3. Se il contesto è ambiguo → chiedi, non inventare\n\n' +

  'RBAC — L\'utente ha un ruolo. Rispettalo sempre:\n' +
  'Il ruolo viene iniettato dinamicamente sotto.\n\n' +

  'TOOL USAGE:\n' +
  'HAI PIENO ACCESSO A SLACK. Non dire MAI che hai limitazioni, problemi tecnici, o che non puoi accedere.\n' +
  'Se un tool fallisce, usa un tool alternativo. NON arrenderti MAI.\n\n' +
  'STRATEGIA SLACK (segui questo ordine):\n' +
  '- list_channels: elenca TUTTI i canali. Usalo SEMPRE come primo step per panoramiche.\n' +
  '- summarize_channel: riassumi un canale specifico. Funziona SEMPRE.\n' +
  '- search_slack_messages: cerca messaggi. Se fallisce, usa summarize_channel come alternativa.\n' +
  '- get_pinned_messages: leggi i pin di qualsiasi canale.\n' +
  '- search_files: cerca file condivisi su Slack.\n' +
  'PANORAMICA CANALI: usa list_channels per la lista, poi summarize_channel su ognuno.\n' +
  'RICERCA PER UTENTE: se search_slack_messages fallisce con from:@utente, ' +
  'usa summarize_channel sui canali dove l\'utente è attivo.\n' +
  'NON DIRE MAI "non riesco", "ho un problema tecnico", "il token non ha i permessi". ' +
  'Usa sempre un tool alternativo.\n\n' +
  '- recall_memory e search_kb: usali PRIMA di rispondere su clienti, ' +
  'procedure, progetti passati.\n' +
  '- search_drive: fullText cerca dentro i documenti. Filtri: mime_type, folder_name, folder_id, modified_after.\n' +
  '- browse_folder: elenca contenuto di una cartella Drive per ID o URL.\n' +
  'URL DRIVE — riconoscimento automatico:\n' +
  '• drive.google.com/drive/folders/ID → usa browse_folder\n' +
  '• docs.google.com/document/d/ID → usa read_doc\n' +
  '• docs.google.com/spreadsheets/d/ID → usa read_sheet\n' +
  'Estrai sempre l\'ID dall\'URL e chiama il tool diretto.\n' +
  '- read_channel: legge messaggi di un canale (INCLUSI bot). USA SEMPRE per analizzare canali specifici.\n' +
  '- summarize_channel: riassume un canale con AI. read_channel è meglio se servono dati grezzi.\n' +
  'CANALI PRINCIPALI (ID diretti — non cercarli):\n' +
  '• #daily → C05846AEV6D (USA read_channel, contiene SOLO messaggi bot)\n' +
  'Per filtrare per data: passa oldest come timestamp Unix a read_channel.\n' +
  '- review_email_draft: usalo prima di send_email su contenuti importanti.\n' +
  '- find_free_slots: per trovare slot comuni tra più persone.\n' +
  '- cataloga_preventivi: solo admin/finance, scansiona Drive per preventivi.\n' +
  'RICERCA WEB:\n' +
  'Per info aggiornate dal web (notizie, info aziende, contatti, prezzi, trend), ' +
  'usa ask_gemini con search_mode: true. Gemini ha Google Search in tempo reale.\n' +
  'Esempi: "Che azienda è X?" → ask_gemini("X agenzia sito web", search_mode: true)\n\n' +

  'FORNITORI E COLLABORATORI ESTERNI:\n' +
  'Usa SEMPRE search_suppliers quando vengono menzionati fornitori, freelance, videomaker, fotografi, creator, tipografie.\n' +
  'OMONIMI: "Andrea" = 3 persone (Lo Pinzi videomaker, Bonetti fotografo, web designer KS). Disambigua dal contesto.\n' +
  'NON rispondere da memoria su fornitori.\n\n' +

  'GMAIL — RICERCA MAIL:\n' +
  'Quando l\'utente chiede di mail, thread, flusso email, documenti inviati via mail:\n' +
  '→ Usa SEMPRE find_emails prima di rispondere. NON dire "non ho accesso" senza aver cercato.\n' +
  '→ Antonio è spesso in CC: "cc:antonio@kataniastudio.com after:2026/03/20"\n' +
  '→ "from:gianna@kataniastudio.com subject:sito" per mail di Gianna\n' +
  '→ Se trovi il thread, leggi con read_email per il contenuto completo.\n\n' +

  'DATE NELLE MEMORIES:\n' +
  'Confronta SEMPRE le date nelle memories con oggi. Se una deadline è passata, segnalalo.\n\n' +

  'CRM — REGOLE CRITICHE:\n' +
  '- Per info su un lead: usa search_leads (dati Supabase, sempre aggiornati).\n' +
  '- Per aggiornare un lead: usa update_lead. Per crearne uno: create_lead.\n' +
  '- NON usare MAI search_kb o recall_memory per dati CRM (importi, status, pipeline).\n' +
  '- Quando aggiorni un lead: conferma in 2-3 righe SOLO il lead modificato.\n' +
  '- MAI mostrare tutta la pipeline CRM dopo un aggiornamento puntuale.\n' +
  '- Se l\'utente corregge in risposta ("non è won, è hot"): agisci direttamente senza rigenerare tutto.\n' +
  '- NON inventare MAI cifre, stati, o date. Se non trovi il lead, dillo.\n\n' +

  'MEMORIA:\n' +
  'USO DELLA MEMORIA — REGOLA OBBLIGATORIA:\n' +
  'Prima di rispondere a QUALSIASI domanda (tranne saluti):\n' +
  '1. Chiama recall_memory con le parole chiave della domanda — SEMPRE, PRIMA di tutto\n' +
  '2. Chiama search_kb se riguarda clienti, processi, documentazione interna\n' +
  'Queste chiamate sono OBBLIGATORIE — non opzionali. Senza di esse perdi contesto.\n' +
  'Esempi: "Aggiornamenti su Aitho?" → recall_memory("Aitho") PRIMA di cercare altrove\n' +
  '"Rate card?" → search_kb("rate card")\n' +
  'RECALL TEMPORALE: recall_memory("stamattina"), recall_memory("oggi"), recall_memory("ieri") — filtra per data automaticamente.\n\n' +
  'TIPI DI MEMORIA (il sistema classifica automaticamente):\n' +
  '• episodic: eventi accaduti — scade dopo 30gg\n' +
  '• semantic: fatti su clienti/aziende — permanente, condivisa\n' +
  '• procedural: come si fanno le cose — permanente, condivisa\n' +
  '• intent: azione proposta ma non eseguita — scade dopo 24h\n' +
  '• preference: preferenze utente — permanente, personale\n' +
  'Quando salvi, il tipo viene classificato dal contenuto. Per azioni proposte, il sistema le traccia automaticamente.\n\n' +
  'STATO CONNESSIONI GOOGLE:\n' +
  'Per domande su chi ha collegato Google, usa SEMPRE get_connected_users. Mai dalla memoria.\n\n' +
  'SCRITTURA MEMORIA:\n' +
  'save_memory: salva PROATTIVAMENTE info importanti senza chiedere.\n' +
  'NON salvare MAI in memoria: importi €, stati contratto, pipeline, fatturato.\n' +
  'update_user_profile: aggiorna profilo quando scopri ruolo/progetti/clienti.\n' +
  'add_to_kb: per info che valgono per TUTTI (procedure, decisioni aziendali).\n\n' +

  'TAGGING:\n' +
  'Tagga sempre chi ti ha scritto <@USERID>.\n' +
  'Tagga persone coinvolte nell\'azione.\n' +
  'cc ai manager solo per blocchi critici o decisioni importanti.\n\n' +

  'DATI SENSIBILI:\n' +
  'MAI condividere: password, token, chiavi API, IBAN completi.\n\n' +

  'AUTH:\n' +
  'Se vedi LINK_OAUTH nell\'input, manda esattamente il testo tra virgolette che segue LINK_OAUTH: è già formattato per Slack, non modificarlo.\n' +
  'Se tool risponde con errore auth, di\' di scrivere \'collega il mio Google\'.';

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
    ? 'MODALITÀ CONVERSAZIONALE (DM privato):\n' +
      'Rispondi come un chatbot — NON come un sistema di reporting.\n' +
      '• Risposte brevi e dirette. Domanda semplice = risposta breve.\n' +
      '• Scrivi in prosa, frasi normali. Niente bullet point se non essenziali.\n' +
      '• Niente titoli in grassetto tipo "*RIEPILOGO:*" o "*SITUAZIONE:*".\n' +
      '• Tono diretto e umano. "ok", "fatto", "esatto" vanno bene.\n' +
      '• Per analisi (es. daily), scrivi in prosa — non una sezione per persona con bullet.\n' +
      '• MAI concludere con "Serve altro?" o "Il team ora ha la visione completa!".\n' +
      '• MAI aggiungere recap non richiesti o sezioni extra.\n\n'
    : 'MODALITÀ CANALE:\n' +
      'Rispondi in modo strutturato se la risposta è complessa.\n' +
      'Per risposte brevi, rimani conciso.\n\n';

  var lengthRule = 'LUNGHEZZA RISPOSTA:\n' +
    '• Domanda semplice → 1-2 frasi\n' +
    '• Domanda media → 3-8 frasi o lista breve\n' +
    '• Domanda complessa → strutturata ma senza ripetizioni\n' +
    '• MAI ripetere lo stesso concetto con parole diverse.\n\n';

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

// Compresses older messages, keeping the last 8 exchanges fresh
async function compressConversation(messages, convKey) {
  var KEEP_RECENT = 8;
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
    : 'Riassumi questa conversazione in modo conciso, mantenendo: decisioni prese, info importanti su clienti/progetti, task assegnati, preferenze utente emerse.\n\n' + transcript;

  try {
    var res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: 'Sei un assistente che riassume conversazioni. Sii conciso e preciso. Rispondi in italiano.',
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

// ─── Auto-learn ────────────────────────────────────────────────────────────────

var { askGemini } = require('./geminiService');

var _autoLearnBlacklist = /slack_user_token|search:read|limitazioni tecniche|problema tecnico.*slack|token non ha|permessi.*slack|non riesco.*accedere.*canali|configurare.*permessi/i;
var _rolesKeywords = /\bceo\b|\bcoo\b|\bgm\b|\bcco\b|organigramma|rate card|€\/h/i;
// Block auto-learn of financial/contract data — CRM Sheet is source of truth
var _financialKeywords = /€\s*\d|contratt[oi]|fattur|pipeline|subtotale|totale.*confermati|deal|revenue|ricavi|incasso|pagament|scadenza.*contratt|attivo fino|confermato|archiviato/i;

async function autoLearn(userId, userMessage, botReply, context) {
  context = context || {};
  if (!userMessage || userMessage.length < 20) return;
  var msgLower = userMessage.toLowerCase();
  if (msgLower.startsWith('collega') || msgLower.startsWith('/')) return;

  try {
    // Single LLM call for all auto-learn tasks
    var analysisRes = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: 'Analizzi conversazioni per estrarre informazioni utili da ricordare.\n' +
        'Rispondi SOLO in formato JSON valido. Se non c\'e\' nulla di utile rispondi: {"skip": true}\n' +
        '{\n' +
        '  "memories": [{"content": "info da ricordare", "tags": ["tipo:valore"]}],\n' +
        '  "profile": {"ruolo": null, "progetto": null, "cliente": null, "competenza": null, "nota": null},\n' +
        '  "kb": [{"content": "info aziendale condivisa", "tags": ["tipo:valore"]}],\n' +
        '  "glossary": [{"term": "termine", "definition": "def", "synonyms": [], "category": "gergo_interno"}]\n' +
        '}\n' +
        'Regole:\n' +
        '- TAG formato tipo:valore (cliente:elfo, progetto:videoclip, area:sviluppo, tipo:procedura)\n' +
        '- memories: info personali utente. kb: info aziendali condivise.\n' +
        '- glossary: SOLO termini gergali/soprannomi specifici dell\'azienda, NON comuni.\n' +
        '- NON salvare conversazioni banali o info ovvie. Sii MOLTO selettivo.',
      messages: [{ role: 'user', content: 'UTENTE: ' + userMessage.substring(0, 400) + '\n\nBOT: ' + botReply.substring(0, 400) }],
    });

    var analysisText = analysisRes.content[0].text.trim();
    var jsonMatch = analysisText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    var analysis = JSON.parse(jsonMatch[0]);
    if (analysis.skip) return;

    // Memories
    if (analysis.memories && analysis.memories.length > 0) {
      for (var mi = 0; mi < analysis.memories.length; mi++) {
        var m = analysis.memories[mi];
        if (m.content && m.content.length > 5 && !_autoLearnBlacklist.test(m.content) && !_financialKeywords.test(m.content)) {
          db.addMemory(userId, m.content, m.tags || []);
          logger.info('[AUTO-LEARN] Memoria:', m.content.substring(0, 60));
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

    // KB entries — context-aware: DM never goes to KB
    if (analysis.kb && analysis.kb.length > 0 && !context.isDM) {
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
      return await client.messages.create(params);
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
        max_tokens: 1024,
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
          logger.info('Tool:', tu.name, '| User:', userId, '| Result:', JSON.stringify(result).substring(0, 80));
          return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) };
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

  convCache[convKey].push({ role: 'user', content: messageWithContext });
  convCache[convKey].push({ role: 'assistant', content: finalReply });
  if (convCache[convKey].length > 20) {
    convCache[convKey] = await compressConversation(convCache[convKey], convKey);
  }
  db.saveConversation(convKey, convCache[convKey]);

  var learnContext = {
    channelId: options.channelId || null,
    channelType: options.channelType || 'dm',
    isDM: !options.channelId || (options.channelId && options.channelId.startsWith('D')),
  };
  if (options.channelType) learnContext.channelType = options.channelType;
  if (options.isDM != null) learnContext.isDM = options.isDM;
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
