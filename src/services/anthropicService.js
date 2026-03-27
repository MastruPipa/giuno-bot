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
  '- search_drive: fullText cerca dentro i documenti. ' +
  'Filtri: mime_type, folder_name, modified_after.\n' +
  '- summarize_channel/thread/doc: usali per recap e riassunti.\n' +
  '- review_email_draft: usalo prima di send_email su contenuti importanti.\n' +
  '- find_free_slots: per trovare slot comuni tra più persone.\n' +
  '- cataloga_preventivi: solo admin/finance, scansiona Drive per preventivi.\n\n' +

  'MEMORIA:\n' +
  'save_memory: salva PROATTIVAMENTE info importanti senza chiedere.\n' +
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

function buildSystemPrompt(userRolePrompt) {
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

  return 'DATA E ORA: ' + dateStr + ' ore ' + timeStr + '\n' +
    'ORARI KATANIA STUDIO: lun-ven 9:00-18:00 (Rome)\n' +
    'Anno corrente: ' + now.getFullYear() + '. Quest\'anno=' + now.getFullYear() +
    ', l\'anno scorso=' + (now.getFullYear() - 1) + '.\n' +
    'Priorità info: ' + now.getFullYear() + ' > ' + (now.getFullYear() - 1) +
    ' > ' + (now.getFullYear() - 2) + ' > storico.\n\n' +
    SYSTEM_PROMPT + '\n\nRUOLO UTENTE:\n' + userRolePrompt;
}

// ─── Conversation helpers ──────────────────────────────────────────────────────

function conversationKey(userId, threadTs) {
  return threadTs ? userId + ':' + threadTs : userId;
}

function getConversations() { return db.getConvCache(); }

// Compresses older messages, keeping the last 8 exchanges fresh
async function compressConversation(messages) {
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
    var summary = '[RIASSUNTO CONVERSAZIONE PRECEDENTE: ' + res.content[0].text.trim() + ']';
    logger.info('[COMPRESS] Conversazione compressa:', toSummarize.length, 'messaggi → riassunto');
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

async function autoLearn(userId, userMessage, botReply) {
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
        if (m.content && m.content.length > 5 && !_autoLearnBlacklist.test(m.content)) {
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

    // KB entries — no separate Gemini review (Haiku already filtered)
    if (analysis.kb && analysis.kb.length > 0) {
      var userRole = await getUserRole(userId);
      var isPrivileged = userRole === 'admin' || userRole === 'finance';
      for (var ki = 0; ki < analysis.kb.length; ki++) {
        var entry = analysis.kb[ki];
        if (!entry.content || entry.content.length <= 5) continue;
        if (_autoLearnBlacklist.test(entry.content)) continue;
        if (_rolesKeywords.test(entry.content) && !isPrivileged) {
          logger.info('[AUTO-LEARN] Skip KB ruoli/rate card protetta:', entry.content.substring(0, 60));
          continue;
        }
        db.addKBEntry(entry.content, entry.tags || [], userId);
        logger.info('[AUTO-LEARN] KB:', entry.content.substring(0, 60));
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

  var messageWithContext = contextData
    ? resolvedMessage + '\n\n[DATI RECUPERATI:\n' + contextData + ']'
    : resolvedMessage;

  var messages = convCache[convKey].concat([{ role: 'user', content: messageWithContext }]);

  var allTools = registry.getAllTools();
  var finalReply = '';
  var retryCount = 0;

  while (true) {
    var response;
    try {
      response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: buildSystemPrompt(getRoleSystemPrompt(userRole)),
        messages: messages,
        tools: allTools,
      });
    } catch(apiErr) {
      if (apiErr.status === 429 && retryCount < 2) {
        retryCount++;
        var waitSec = retryCount * 5;
        logger.warn('[RATE-LIMIT] 429, attendo ' + waitSec + 's (tentativo ' + retryCount + '/2)');
        await new Promise(function(r) { setTimeout(r, waitSec * 1000); });
        continue;
      }
      if (apiErr.status === 429) {
        return 'Sto ricevendo troppe richieste in questo momento, mbare. Riprova tra un minuto.';
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
          var result = await registry.executeToolCall(tu.name, tu.input, userId, userRole);
          logger.info('Tool:', tu.name, '| User:', userId, '| Result:', JSON.stringify(result).substring(0, 80));
          return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) };
        })
    );

    messages.push({ role: 'user', content: toolResults });
  }

  convCache[convKey].push({ role: 'user', content: messageWithContext });
  convCache[convKey].push({ role: 'assistant', content: finalReply });
  if (convCache[convKey].length > 20) {
    convCache[convKey] = await compressConversation(convCache[convKey]);
  }
  db.saveConversation(convKey, convCache[convKey]);

  autoLearn(userId, resolvedMessage, finalReply).catch(function(e) {
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
