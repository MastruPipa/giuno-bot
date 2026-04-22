// ─── DB index ────────────────────────────────────────────────────────────────
// Single re-export point for all domain modules.
// supabase.js (root) delegates here — all existing require('../../supabase') paths work unchanged.

'use strict';

var clientMod    = require('./client');
var tokens       = require('./tokens');
var prefs        = require('./prefs');
var conversations = require('./conversations');
var memories     = require('./memories');
var profiles     = require('./profiles');
var kb           = require('./kb');
var standup      = require('./standup');
var drive        = require('./drive');
var channels     = require('./channels');
var glossary     = require('./glossary');
var quotes       = require('./quotes');
var leads        = require('./leads');
var cron         = require('./cron');
var feedback     = require('./feedback');
var entities     = require('./entities');
var unifiedSearch = require('./unifiedSearch');
var projects     = require('./projects');
var userFacts    = require('./userFacts');

async function initAll() {
  var results = await Promise.all([
    tokens.loadTokens(),
    prefs.loadPrefs(),
    conversations.loadConversations(),
    memories.loadMemories(),
    profiles.loadProfiles(),
    kb.loadKB(),
    standup.loadStandup(),
    drive.loadDriveIndex(),
    channels.loadChannelMap(),
    channels.loadChannelDigests(),
    glossary.loadGlossary(),
  ]);
  return {
    tokens:        results[0],
    prefs:         results[1],
    conversations: results[2],
    memories:      results[3],
    profiles:      results[4],
    kb:            results[5],
    standup:       results[6],
    driveIndex:    results[7],
  };
}

module.exports = {
  // Client
  isSupabase:  function() { return clientMod.useSupabase; },
  getClient:   clientMod.getClient,

  // Init
  initAll: initAll,

  // Tokens
  saveToken:      tokens.saveToken,
  removeToken:    tokens.removeToken,
  getTokenCache:  tokens.getTokenCache,

  // Prefs
  savePrefs:     prefs.savePrefs,
  getPrefsCache: prefs.getPrefsCache,

  // Conversations
  saveConversation:        conversations.saveConversation,
  getConvCache:            conversations.getConvCache,
  saveConversationSummary: conversations.saveConversationSummary,
  getConversationSummary:  conversations.getConversationSummary,

  // Memories
  addMemory:      memories.addMemory,
  deleteMemory:   memories.deleteMemory,
  searchMemories: memories.searchMemories,
  getMemCache:    memories.getMemCache,
  memoryContentHash: memories.contentHash,

  // Profiles
  saveProfile:     profiles.saveProfile,
  getProfileCache: profiles.getProfileCache,

  // Knowledge Base
  addKBEntry:      kb.addKBEntry,
  deleteKBEntry:   kb.deleteKBEntry,
  searchKB:        kb.searchKB,
  getKBCache:      kb.getKBCache,
  cleanupExpiredKB: kb.cleanupExpiredKB,
  reviewPendingKB:  kb.reviewPendingKB,

  // Standup
  saveStandup:     standup.saveStandup,
  getStandupCache: standup.getStandupCache,

  // Drive
  saveDriveFiles: drive.saveDriveFiles,
  getDriveCache:  drive.getDriveCache,

  // Feedback
  saveFeedback: feedback.saveFeedback,

  // Channel Map
  saveChannelMapping:  channels.saveChannelMapping,
  getChannelMapCache:  channels.getChannelMapCache,

  // Channel Digests
  saveChannelDigest:    channels.saveChannelDigest,
  getChannelDigestCache: channels.getChannelDigestCache,

  // Glossary
  addGlossaryTerm: glossary.addGlossaryTerm,
  searchGlossary:  glossary.searchGlossary,
  getGlossaryCache: glossary.getGlossaryCache,

  // Quotes
  searchQuotes:       quotes.searchQuotes,
  saveQuote:          quotes.saveQuote,
  quoteExistsByDocId: quotes.quoteExistsByDocId,

  // Rate Card
  getRateCard:   quotes.getRateCard,
  listRateCards: quotes.listRateCards,
  saveRateCard:  quotes.saveRateCard,

  // Leads
  leadExists:      leads.leadExists,
  insertLead:      leads.insertLead,
  updateLead:      leads.updateLead,
  searchLeads:     leads.searchLeads,
  getLeadsPipeline: leads.getLeadsPipeline,
  queryLeadsDB:    leads.queryLeadsDB,
  deleteLead:      leads.deleteLead,

  // Cron locks
  acquireCronLock: cron.acquireCronLock,
  releaseCronLock: cron.releaseCronLock,

  // Entities
  resolveEntity: entities.resolveEntity,

  // Unified Search
  unifiedSearch:        unifiedSearch.unifiedSearch,
  getChannelContext:    unifiedSearch.getChannelContext,
  getEntityContext:     unifiedSearch.getEntityContext,
  upsertChannelProfile: unifiedSearch.upsertChannelProfile,
  saveDriveContent:     unifiedSearch.saveDriveContent,
  searchDriveContent:   unifiedSearch.searchDriveContent,
  upsertEntity:         unifiedSearch.upsertEntity,
  addGraphEdge:         unifiedSearch.addGraphEdge,

  // User facts (sticky per-person memory)
  upsertUserFact: userFacts.upsertUserFact,
  getUserFacts:   userFacts.getUserFacts,
  touchUserFact:  userFacts.touchUserFact,

  // Projects
  createProject:        projects.createProject,
  updateProject:        projects.updateProject,
  searchProjects:       projects.searchProjects,
  getProject:           projects.getProject,
  deleteProject:        projects.deleteProject,
  allocateResource:     projects.allocateResource,
  updateAllocation:     projects.updateAllocation,
  getProjectAllocations: projects.getProjectAllocations,
  getUserAllocations:   projects.getUserAllocations,
  getTeamWorkload:      projects.getTeamWorkload,
};
