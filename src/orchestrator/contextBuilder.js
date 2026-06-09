// ─── Context Builder V2 ──────────────────────────────────────────────────────
// Builds rich context using unified_search RPC + fallback to cache.
// Backward-compatible: returns all V1 fields + new V2 fields.
'use strict';

var db = require('../../supabase');
var rbac = require('../../rbac');
var logger = require('../utils/logger');
var { generaLinkOAuth } = require('../services/googleAuthService');
var embeddingService = require('../services/embeddingService');
var attio = require('../services/attioService');
var { safeCall } = require('../utils/safeCall');
var { withTimeout, withRetry } = require('../utils/retryPolicy');

var getUserRole = rbac.getUserRole;

// Project statuses we treat as "closed": memories/KB tagged with one of these
// projects are filtered out of proactive context unless the user names them.
var CLOSED_PROJECT_STATUSES = {
  completed: 1, completato: 1, closed: 1, chiuso: 1, archived: 1, archiviato: 1,
  done: 1, cancelled: 1, canceled: 1, annullato: 1, lost: 1, perso: 1,
};

// ─── Context needs per intent ────────────────────────────────────────────────

var CONTEXT_NEEDS = {
  THREAD_SUMMARY:   { memories: true,  kb: false, glossary: false, entities: false, drive: false, crm: false },
  DAILY_DIGEST:     { memories: true,  kb: true,  glossary: false, entities: false, drive: false, crm: false },
  CLIENT_RETRIEVAL: { memories: true,  kb: true,  glossary: true,  entities: true,  drive: true,  crm: true  },
  QUOTE_SUPPORT:    { memories: false, kb: true,  glossary: false, entities: false, drive: false, crm: true  },
  CRM_UPDATE:       { memories: false, kb: false, glossary: false, entities: true,  drive: false, crm: true  },
  HISTORICAL_SCAN:  { memories: false, kb: false, glossary: false, entities: false, drive: false, crm: false },
  GENERAL:          { memories: true,  kb: true,  glossary: true,  entities: true,  drive: true,  crm: false },
};

// CRM-flavoured questions that classify as GENERAL still get Attio enrichment.
var CRM_KEYWORDS = /\b(client[ei]|aziend[ae]|deal|trattativ[ae]|pipeline|offert[ae]|preventiv[oi]|propost[ae]|lead|prospect|fattur|contratt[oi]|won|lost|crm|attio)\b/i;

// ─── Trivial message detection ───────────────────────────────────────────────

var TRIVIAL_PATTERNS = [
  /^(ok|sì|si|no|grazie|perfetto|capito|certo|esatto|giusto|bene|dai|vabbè|oki|yep|yes|nope|np|ok!)$/i,
  /^(ok grazie|grazie mille|perfetto grazie|va bene|va benissimo|ottimo|fatto|ricevuto|confermato)$/i,
];

function isTrivialMessage(message) {
  var m = (message || '').trim();
  return TRIVIAL_PATTERNS.some(function(p) { return p.test(m); });
}

// ─── Main builder ────────────────────────────────────────────────────────────

// Pull candidate CRM search terms out of the message: resolved entity names
// first, then capitalised tokens (likely company/person names). Bounded to 2.
var _TERM_STOP = { Giuno: 1, Antonio: 1, Ciao: 1, Ehi: 1, Hey: 1, Ok: 1, Grazie: 1, Quale: 1, Quali: 1, Come: 1, Cosa: 1, Chi: 1, Quanto: 1, Quando: 1, Dove: 1, Perche: 1, Perché: 1 };
function extractCrmTerms(message, entities) {
  var terms = [];
  var seen = {};
  var push = function(t) {
    if (!t) return;
    t = String(t).trim();
    if (t.length < 3) return;
    var key = t.toLowerCase();
    if (seen[key] || _TERM_STOP[t]) return;
    seen[key] = 1; terms.push(t);
  };
  (entities || []).forEach(function(e) { if (e && e.name) push(e.name); });
  var caps = (message || '').match(/\b[A-ZÀ-Ý][\wÀ-ÿ.&'’-]{2,}\b/g) || [];
  caps.forEach(push);
  return terms.slice(0, 2);
}

// Proactively fetch relevant Attio records so CRM questions are grounded in the
// real CRM without the model having to call a tool first. Best-effort: returns
// null when Attio isn't configured or nothing matches.
async function buildAttioContext(message, entities) {
  if (!attio.isConfigured()) return null;
  var terms = extractCrmTerms(message, entities);
  if (terms.length === 0) return null;

  var companies = [];
  var deals = [];
  var seenCo = {}, seenDeal = {};
  for (var i = 0; i < terms.length; i++) {
    var filter = { name: { '$contains': terms[i] } };
    var cs = await safeCall('CTX.attio.companies', function() { return attio.queryRecords('companies', filter, 3); }, []);
    var ds = await safeCall('CTX.attio.deals', function() { return attio.queryRecords('deals', filter, 3); }, []);
    (cs || []).forEach(function(c) { if (c.record_id && !seenCo[c.record_id]) { seenCo[c.record_id] = 1; companies.push(c); } });
    (ds || []).forEach(function(d) { if (d.record_id && !seenDeal[d.record_id]) { seenDeal[d.record_id] = 1; deals.push(d); } });
  }

  // Resolve a few deals linked to the top company match (answers "che deal con X").
  if (companies[0] && companies[0].values && companies[0].values.associated_deals) {
    var refs = [].concat(companies[0].values.associated_deals);
    for (var j = 0; j < refs.length && j < 3; j++) {
      var rid = refs[j] && refs[j].record_id;
      if (rid && !seenDeal[rid]) {
        var dd = await safeCall('CTX.attio.dealRef', function() { return attio.getRecord('deals', rid); }, null);
        if (dd) { seenDeal[rid] = 1; deals.push(dd); }
      }
    }
  }

  if (companies.length === 0 && deals.length === 0) return null;
  return { companies: companies.slice(0, 4), deals: deals.slice(0, 5) };
}

async function buildContext(params) {
  var userId  = params.userId;
  var message = params.message || '';
  var options = params.options || {};
  var intent  = params.intent || 'GENERAL';
  var needs   = CONTEXT_NEEDS[intent] || CONTEXT_NEEDS.GENERAL;

  var userRole = await getUserRole(userId);
  var profiles = db.getProfileCache();
  var profile = profiles[userId] || {};

  // Channel type detection
  var channelType = options.channelType || 'dm';
  if (!options.channelType && options.channelId) {
    if (options.channelId.startsWith('D')) channelType = 'dm';
    else {
      var chMap = db.getChannelMapCache()[options.channelId];
      channelType = (chMap && chMap.is_private) ? 'private' : 'public';
    }
  }
  var isDM = channelType === 'dm';

  // Channel map entry
  var channelMapEntry = options.channelId ? (db.getChannelMapCache()[options.channelId] || null) : null;

  // OAuth link
  var oauthLink = null;
  var msgLow = (message || '').toLowerCase();
  if ((/colleg[a-z]|connett[a-z]|autorizz[a-z]/i.test(msgLow)) &&
      (/google|calendar|gmail|account|email|mail/i.test(msgLow))) {
    oauthLink = '<' + generaLinkOAuth(userId) + '|Collega il tuo Google>';
  }

  // Temporal
  var now = new Date();
  var currentYear = now.getFullYear();
  var currentQuarter = 'Q' + Math.ceil((now.getMonth() + 1) / 3);

  // ─── V2: Try unified search RPC, fallback to cache ─────────────────────

  var relevantMemories = [];
  var kbResults = [];
  var relevantEntities = [];
  var driveContext = [];
  var channelProfile = null;
  var teamContext = null;

  // Thread-aware preflight: if we're in a known thread, pull memories/KB entries
  // tagged to it so Giuno doesn't keep re-fetching the same Slack context.
  // Runs before unified_search so thread hits always win.
  var supabaseForThread = db.isSupabase && db.isSupabase() ? db.getClient() : null;
  if (options.threadTs && supabaseForThread) {
    try {
      var threadMemRes = await withTimeout(function() {
        return supabaseForThread.from('memories')
          .select('id, content, memory_type, tags, created_at, confidence_score')
          .eq('thread_ts', options.threadTs)
          .is('superseded_by', null)
          .order('created_at', { ascending: false })
          .limit(5);
      }, 2000, 'CTX.threadMemories');
      if (threadMemRes && threadMemRes.data) {
        threadMemRes.data.forEach(function(m) {
          relevantMemories.push({ content: m.content, type: m.memory_type, tags: m.tags, created: m.created_at, _fromThread: true });
        });
      }

      var threadKbRes = await withTimeout(function() {
        return supabaseForThread.from('knowledge_base')
          .select('id, content, tags, confidence_tier, confidence_score')
          .eq('source_thread_ts', options.threadTs)
          .order('created_at', { ascending: false })
          .limit(5);
      }, 2000, 'CTX.threadKB');
      if (threadKbRes && threadKbRes.data) {
        threadKbRes.data.forEach(function(k) {
          kbResults.push({ content: k.content, tags: k.tags, confidence_tier: k.confidence_tier, _fromThread: true });
        });
      }
    } catch(threadErr) {
      // thread_ts / source_thread_ts columns may not exist yet (migration pending) —
      // degrade silently unless it's something else worth investigating.
      if (!/thread_ts|source_thread_ts/i.test(String(threadErr && threadErr.message || ''))) {
        logger.warn('[CTX-V2] Thread preflight failed:', threadErr.message);
      }
    }
  }

  var unifiedWorked = false;
  if (!isTrivialMessage(message) && message.length > 5 && (needs.memories || needs.kb || needs.entities || needs.drive)) {
    try {
      var searchResults = await withRetry(function() {
        return withTimeout(function() {
          return db.unifiedSearch(message, userId, 12,
            [needs.memories ? 'memories' : null, needs.kb ? 'kb' : null,
             needs.entities ? 'entities' : null, needs.drive ? 'drive' : null, 'channels']
            .filter(Boolean));
        }, 4000, 'CTX.unifiedSearch');
      }, { retries: 1, baseDelayMs: 120 });

      if (searchResults && searchResults.length > 0) {
        unifiedWorked = true;
        // Privacy guard: when we're answering in a public channel we must not
        // surface memories/KB entries sourced from a private channel or a DM.
        var isPublicAudience = channelType === 'public';
        for (var i = 0; i < searchResults.length; i++) {
          var r = searchResults[i];
          var meta = r.metadata || {};
          var sourceType = meta.source_channel_type || meta.channel_type;
          if (isPublicAudience && (sourceType === 'private' || sourceType === 'dm')) continue;
          if (r.source === 'memory') {
            relevantMemories.push({ content: r.content, type: meta.type, tags: meta.tags, created: meta.created_at, source_channel_type: sourceType });
          } else if (r.source === 'kb') {
            kbResults.push({ content: r.content, tags: meta.tags, confidence_tier: meta.tier, source_channel_type: sourceType });
          } else if (r.source === 'entity') {
            relevantEntities.push({ name: r.content, type: meta.entity_type, aliases: meta.aliases, context: meta.context });
          } else if (r.source === 'drive') {
            driveContext.push({ summary: r.content, fileName: meta.file_name, link: meta.web_link, category: meta.doc_category, client: meta.related_client });
          } else if (r.source === 'channel' && !channelProfile) {
            channelProfile = { channel_name: meta.channel_name, cliente: meta.cliente, progetto: meta.progetto, key_topics: meta.key_topics, team_members: meta.team_members };
          }
        }
      }
    } catch(e) {
      logger.warn('[CTX-V2] Unified search error, using fallback:', e.message, { threadTs: options.threadTs, channelId: options.channelId });
      try { require('../services/errorTracker').recordError(e.message || String(e), 'unified_search', userId); } catch(_) {}
    }

    // Post-filter: boost recent results, penalize old ones
    if (unifiedWorked) {
      var nowMs = Date.now();
      var boostRecent = function(items) {
        return items.sort(function(a, b) {
          var aDate = a.created || a.created_at || '';
          var bDate = b.created || b.created_at || '';
          var aAge = aDate ? (nowMs - new Date(aDate).getTime()) / 86400000 : 999;
          var bAge = bDate ? (nowMs - new Date(bDate).getTime()) / 86400000 : 999;
          return aAge - bAge; // Recent first
        });
      };
      if (relevantMemories.length > 1) relevantMemories = boostRecent(relevantMemories);
      if (kbResults.length > 1) kbResults = boostRecent(kbResults);
    }
  }

  // Fallback to cache-based search if unified didn't work
  if (!unifiedWorked) {
    if (needs.memories) {
      var rawMem = (await safeCall('CTX.searchMemories', function() { return db.searchMemories(userId, message); }, [])) || [];
      relevantMemories = rawMem.filter(function(m) {
        return (m.confidence_score || m.final_score || 0.5) >= 0.3;
      }).slice(0, 5);
    }
    if (needs.kb) {
      var rawKB = (await safeCall('CTX.searchKB', function() { return db.searchKB(message); }, [])) || [];
      kbResults = rawKB.filter(function(k) {
        return (k.confidence_score || 0.5) >= 0.3;
      }).slice(0, 3);
    }

    // Semantic search layer (if embeddings available)
    if (embeddingService.getProvider() && message.length > 10) {
      var semResults = (await safeCall('CTX.semanticSearch',
        function() {
          return withTimeout(function() {
            return embeddingService.semanticSearch(message, { limit: 3 });
          }, 3500, 'CTX.semanticSearch');
        }, [])) || [];
      if (semResults && semResults.length > 0) {
        semResults.forEach(function(sr) {
          kbResults.push({ content: sr.content, confidence_tier: 'semantic_match', confidence_score: sr.similarity || 0.7 });
        });
      }
    }
  }

  // Always inject latest user corrections for briefing/summary quality
  if (needs.memories) {
    var correctionMemories = (await safeCall(
      'CTX.searchMemories.corrections',
      function() { return db.searchMemories(userId, 'CORREZIONE_BRIEFING feedback correzione briefing'); },
      []
    )) || [];
    if (correctionMemories.length > 0) {
      var normalized = correctionMemories
        .filter(function(m) { return m && m.content && m.content.includes('CORREZIONE_BRIEFING:'); })
        .slice(0, 3);
      if (normalized.length > 0) {
        relevantMemories = normalized.concat(relevantMemories || []).slice(0, 8);
      }
    }
  }

  // Channel context from RPC or options
  var channelContext = options.channelContext || null;
  if (options.channelId && !channelProfile) {
    var rpcCtx = await safeCall('CTX.getChannelContext',
      function() { return db.getChannelContext(options.channelId, 8); }, null);
    if (rpcCtx) channelProfile = rpcCtx;
  }

  // Entity graph context
  if (needs.entities && relevantEntities.length > 0) {
    var entityCtx = await safeCall('CTX.getEntityContext',
      function() { return db.getEntityContext(relevantEntities[0].name, 1); }, null);
    if (entityCtx && entityCtx.found) teamContext = entityCtx;
  }

  // Glossary
  var glossaryContext = null;
  if (needs.glossary) {
    var gm = (await safeCall('CTX.searchGlossary', function() { return db.searchGlossary(message); }, [])) || [];
    if (gm.length > 0) {
      glossaryContext = gm.slice(0, 5).map(function(g) {
        return g.term + ': ' + g.definition + (g.synonyms && g.synonyms.length > 0 ? ' (sinonimi: ' + g.synonyms.join(', ') + ')' : '');
      }).join('\n');
    }
  }

  // Closed-project guard: drop retrieved memories/KB tied to a project that
  // has been closed, UNLESS the user explicitly named that project. This stops
  // the bot from dragging in long-finished projects nobody mentioned.
  if ((relevantMemories && relevantMemories.length) || (kbResults && kbResults.length)) {
    try {
      var statusMap = (await safeCall('CTX.getProjectStatusMap',
        function() { return db.getProjectStatusMap(); }, {})) || {};
      var msgLow = (message || '').toLowerCase();
      var hasClosedUnmentionedTag = function(tags) {
        if (!Array.isArray(tags)) return false;
        for (var ti = 0; ti < tags.length; ti++) {
          var mt = /^progetto:(.+)$/i.exec(String(tags[ti] || ''));
          if (!mt) continue;
          var pname = mt[1].toLowerCase().trim();
          var st = (statusMap[pname] || '').toLowerCase();
          if (CLOSED_PROJECT_STATUSES[st] && msgLow.indexOf(pname) === -1) return true;
        }
        return false;
      };
      relevantMemories = (relevantMemories || []).filter(function(m) { return !hasClosedUnmentionedTag(m.tags); });
      kbResults = (kbResults || []).filter(function(k) { return !hasClosedUnmentionedTag(k.tags); });
    } catch(e) { logger.debug('[CTX-V2] closed-project filter skipped:', e && e.message); }
  }

  // Automatic CRM grounding: for CRM-flavoured questions, enrich with Attio.
  var attioContext = null;
  if ((needs.crm || CRM_KEYWORDS.test(message)) && !isTrivialMessage(message)) {
    attioContext = await safeCall('CTX.buildAttioContext', function() {
      return withTimeout(function() { return buildAttioContext(message, relevantEntities); }, 4000, 'CTX.attio');
    }, null);
  }

  return {
    // V1 backward-compatible fields
    userId:           userId,
    userRole:         userRole,
    profile:          profile,
    threadTs:         options.threadTs   || null,
    channelId:        options.channelId  || null,
    channelContext:   channelContext,
    mentionedBy:      options.mentionedBy || null,
    channelMapEntry:  channelMapEntry,
    oauthLink:        oauthLink,
    channelType:      channelType,
    isDM:             isDM,
    relevantMemories: relevantMemories,
    kbResults:        kbResults,
    currentDate:      now.toISOString().slice(0, 10),
    currentYear:      currentYear,
    currentQuarter:   currentQuarter,
    temporalNote:     'Siamo nel ' + currentYear + ' ' + currentQuarter + '. Info recenti hanno priorità.',
    glossaryContext:  glossaryContext,

    // V2 new fields
    intent:           intent,
    relevantEntities: relevantEntities,
    driveContext:     driveContext,
    channelProfile:   channelProfile,
    teamContext:      teamContext,
    attioContext:     attioContext,
  };
}

// ─── Format context for system prompt injection ──────────────────────────────

function formatContextForPrompt(ctx) {
  var parts = [];

  if (ctx.channelProfile) {
    var cp = ctx.channelProfile;
    var info = 'Canale: #' + (cp.channel_name || 'unknown');
    if (cp.cliente) info += ' | Cliente: ' + cp.cliente;
    if (cp.progetto) info += ' | Progetto: ' + cp.progetto;
    if (cp.key_topics) info += '\nTemi: ' + (Array.isArray(cp.key_topics) ? cp.key_topics.join(', ') : cp.key_topics);
    if (cp.team_members) info += '\nTeam: ' + (Array.isArray(cp.team_members) ? cp.team_members.join(', ') : cp.team_members);
    parts.push('CONTESTO CANALE:\n' + info);
  }

  if (ctx.relevantMemories && ctx.relevantMemories.length > 0) {
    // Filter out system memories and show clean content
    var cleanMems = ctx.relevantMemories.filter(function(m) {
      var c = m.content || '';
      return !(/^precall_|^\[TOOL:|^TOOL:|^FEEDBACK_|^tool_result|briefing inviato/i.test(c)) && c.length > 15;
    });
    if (cleanMems.length > 0) {
      // Memories older than ~60d for episodic/intent types are likely stale: flag
      // them so the model treats them as "was true then" instead of current truth.
      var stalenessMs = 60 * 86400000;
      var nowMs = Date.now();
      parts.push('MEMORIA:\n' + cleanMems.slice(0, 5).map(function(m) {
        var body = (m.content || '');
        var created = m.created || m.created_at;
        var type = m.type || m.memory_type;
        var isPerishable = type === 'episodic' || type === 'intent' || !type;
        if (created && isPerishable) {
          var ageMs = nowMs - new Date(created).getTime();
          if (ageMs > stalenessMs) {
            var months = Math.max(2, Math.round(ageMs / (30 * 86400000)));
            body = '[info di ~' + months + ' mesi fa — verifica prima di usare] ' + body;
          }
        }
        return '- ' + body;
      }).join('\n'));
    }
  }

  if (ctx.attioContext && ((ctx.attioContext.companies || []).length || (ctx.attioContext.deals || []).length)) {
    var ac = ctx.attioContext;
    var acLines = [];
    (ac.companies || []).forEach(function(c) {
      var v = c.values || {};
      var line = (v.name || '(senza nome)');
      if (v.description) line += ' — ' + String(v.description).substring(0, 120);
      acLines.push('• AZIENDA ' + line + ' [id:' + c.record_id + ']');
    });
    (ac.deals || []).forEach(function(d) {
      var v = d.values || {};
      var bits = [];
      if (v.stage) bits.push('stage: ' + (Array.isArray(v.stage) ? v.stage.join('/') : v.stage));
      if (v.value != null) bits.push('valore: ' + v.value);
      if (v.servizio_proposto) bits.push('servizio: ' + [].concat(v.servizio_proposto).join(', '));
      acLines.push('• DEAL ' + (v.name || '(senza nome)') + (bits.length ? ' — ' + bits.join(' | ') : '') + ' [id:' + d.record_id + ']');
    });
    parts.push('ATTIO (CRM — fonte di verità, usa questi dati e i tool attio_* per dettagli/modifiche):\n' + acLines.join('\n'));
  }

  if (ctx.kbResults && ctx.kbResults.length > 0) {
    parts.push('KB:\n' + ctx.kbResults.slice(0, 4).map(function(k) {
      return '- ' + (k.content || '');
    }).join('\n'));
  }

  if (ctx.relevantEntities && ctx.relevantEntities.length > 0) {
    parts.push('ENTITÀ:\n' + ctx.relevantEntities.slice(0, 3).map(function(e) {
      return '- ' + e.name + ' (' + e.type + ')';
    }).join('\n'));
  }

  if (ctx.driveContext && ctx.driveContext.length > 0) {
    parts.push('DRIVE:\n' + ctx.driveContext.slice(0, 3).map(function(d) {
      return '- ' + d.fileName + (d.client ? ' (' + d.client + ')' : '') + (d.summary ? ': ' + d.summary.substring(0, 100) : '');
    }).join('\n'));
  }

  return parts.length > 0 ? '\n═══ CONTESTO ═══\n' + parts.join('\n\n') + '\n════════════════\n' : '';
}

module.exports = { buildContext: buildContext, formatContextForPrompt: formatContextForPrompt };
