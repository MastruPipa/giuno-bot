// ─── Context Builder V2 ──────────────────────────────────────────────────────
// Builds rich context using unified_search RPC + fallback to cache.
// Backward-compatible: returns all V1 fields + new V2 fields.
'use strict';

var db = require('../../supabase');
var rbac = require('../../rbac');
var logger = require('../utils/logger');
var { generaLinkOAuth } = require('../services/googleAuthService');
var embeddingService = require('../services/embeddingService');

var getUserRole = rbac.getUserRole;

// ─── Context needs per intent ────────────────────────────────────────────────

var CONTEXT_NEEDS = {
  THREAD_SUMMARY:   { memories: true,  kb: false, glossary: false, entities: false, drive: false },
  DAILY_DIGEST:     { memories: true,  kb: true,  glossary: false, entities: false, drive: false },
  CLIENT_RETRIEVAL: { memories: true,  kb: true,  glossary: true,  entities: true,  drive: true  },
  QUOTE_SUPPORT:    { memories: false, kb: true,  glossary: false, entities: false, drive: false },
  CRM_UPDATE:       { memories: false, kb: false, glossary: false, entities: true,  drive: false },
  HISTORICAL_SCAN:  { memories: false, kb: false, glossary: false, entities: false, drive: false },
  GENERAL:          { memories: true,  kb: true,  glossary: true,  entities: true,  drive: true  },
};

// ─── Main builder ────────────────────────────────────────────────────────────

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

  var unifiedWorked = false;
  if (message.length > 5 && (needs.memories || needs.kb || needs.entities || needs.drive)) {
    try {
      var searchResults = await db.unifiedSearch(message, userId, 12,
        [needs.memories ? 'memories' : null, needs.kb ? 'kb' : null,
         needs.entities ? 'entities' : null, needs.drive ? 'drive' : null, 'channels']
        .filter(Boolean));

      if (searchResults && searchResults.length > 0) {
        unifiedWorked = true;
        for (var i = 0; i < searchResults.length; i++) {
          var r = searchResults[i];
          var meta = r.metadata || {};
          if (r.source === 'memory') {
            relevantMemories.push({ content: r.content, type: meta.type, tags: meta.tags, created: meta.created_at });
          } else if (r.source === 'kb') {
            kbResults.push({ content: r.content, tags: meta.tags, confidence_tier: meta.tier });
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
      logger.warn('[CTX-V2] Unified search error, using fallback:', e.message);
    }
  }

  // Fallback to cache-based search if unified didn't work
  if (!unifiedWorked) {
    if (needs.memories) {
      try {
        var rawMem = await db.searchMemories(userId, message) || [];
        // Confidence gate: filter low-quality
        relevantMemories = rawMem.filter(function(m) {
          return (m.confidence_score || m.final_score || 0.5) >= 0.3;
        }).slice(0, 5);
      } catch(e) {}
    }
    if (needs.kb) {
      try {
        var rawKB = db.searchKB(message) || [];
        kbResults = rawKB.filter(function(k) {
          return (k.confidence_score || 0.5) >= 0.3;
        }).slice(0, 3);
      } catch(e) {}
    }

    // Semantic search layer (if embeddings available)
    if (embeddingService.getProvider() && message.length > 10) {
      try {
        var semResults = await embeddingService.semanticSearch(message, { limit: 3 });
        if (semResults && semResults.length > 0) {
          semResults.forEach(function(sr) {
            kbResults.push({ content: sr.content, confidence_tier: 'semantic_match', confidence_score: sr.similarity || 0.7 });
          });
        }
      } catch(e) {}
    }
  }

  // Channel context from RPC or options
  var channelContext = options.channelContext || null;
  if (options.channelId && !channelProfile) {
    try {
      var rpcCtx = await db.getChannelContext(options.channelId, 8);
      if (rpcCtx) channelProfile = rpcCtx;
    } catch(e) {}
  }

  // Entity graph context
  if (needs.entities && relevantEntities.length > 0) {
    try {
      var entityCtx = await db.getEntityContext(relevantEntities[0].name, 1);
      if (entityCtx && entityCtx.found) teamContext = entityCtx;
    } catch(e) {}
  }

  // Glossary
  var glossaryContext = null;
  if (needs.glossary) {
    try {
      var gm = db.searchGlossary(message) || [];
      if (gm.length > 0) {
        glossaryContext = gm.slice(0, 5).map(function(g) {
          return g.term + ': ' + g.definition + (g.synonyms && g.synonyms.length > 0 ? ' (sinonimi: ' + g.synonyms.join(', ') + ')' : '');
        }).join('\n');
      }
    } catch(e) {}
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
    parts.push('MEMORIA:\n' + ctx.relevantMemories.slice(0, 5).map(function(m) {
      return '- [' + (m.type || m.memory_type || '?') + '] ' + (m.content || '');
    }).join('\n'));
  }

  if (ctx.kbResults && ctx.kbResults.length > 0) {
    parts.push('KB:\n' + ctx.kbResults.slice(0, 4).map(function(k) {
      return '- [' + (k.confidence_tier || '?') + '] ' + (k.content || '');
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
