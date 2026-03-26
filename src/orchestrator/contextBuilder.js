// ─── Context Builder ───────────────────────────────────────────────────────────
// Assembles the context object for a request:
// userId, role, profile, channelContext, mentionedBy, channelId, threadTs,
// oauthLink if needed, plus enriched context (memories, KB, temporal awareness).

'use strict';

var db = require('../../supabase');
var rbac = require('../../rbac');
var { generaLinkOAuth } = require('../services/googleAuthService');

var getUserRole = rbac.getUserRole;

/**
 * buildContext — assembles a rich context object from raw request parameters.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.message
 * @param {object} [params.options]   — threadTs, channelId, mentionedBy, channelContext
 * @returns {object}  context
 */
async function buildContext(params) {
  var userId  = params.userId;
  var message = params.message;
  var options = params.options || {};

  var userRole = await getUserRole(userId);

  // User profile
  var profiles = db.getProfileCache();
  var profile  = profiles[userId] || {};

  // Channel map
  var channelMapEntry = null;
  if (options.channelId) {
    channelMapEntry = db.getChannelMapCache()[options.channelId] || null;
  }

  // OAuth link if message is about connecting Google
  var oauthLink = null;
  var msgLow = (message || '').toLowerCase();
  if ((/colleg[a-z]|connett[a-z]|autorizz[a-z]/i.test(msgLow)) &&
      (/google|calendar|gmail|account|email|mail/i.test(msgLow))) {
    var oauthUrl = generaLinkOAuth(userId);
    oauthLink = '<' + oauthUrl + '|Collega il tuo Google>';
  }

  // Enriched context: relevant memories
  var relevantMemories = [];
  try { relevantMemories = db.searchMemories(userId, message) || []; } catch(e) {}

  // Enriched context: KB results
  var kbResults = [];
  try { kbResults = db.searchKB(message) || []; } catch(e) {}

  // Temporal awareness
  var now = new Date();
  var currentYear = now.getFullYear();
  var currentQuarter = 'Q' + Math.ceil((now.getMonth() + 1) / 3);

  // Channel context
  var channelContext = options.channelContext || null;

  // Glossary matches
  var glossaryMatches = [];
  try { glossaryMatches = db.searchGlossary(message) || []; } catch(e) {}

  return {
    userId:           userId,
    userRole:         userRole,
    profile:          profile,
    threadTs:         options.threadTs   || null,
    channelId:        options.channelId  || null,
    channelContext:   channelContext,
    mentionedBy:      options.mentionedBy || null,
    channelMapEntry:  channelMapEntry,
    oauthLink:        oauthLink,

    // Enriched context
    relevantMemories: relevantMemories.slice(0, 8),
    kbResults:        kbResults.slice(0, 5),
    currentDate:      now.toISOString().slice(0, 10),
    currentYear:      currentYear,
    currentQuarter:   currentQuarter,
    temporalNote:     'Siamo nel ' + currentYear + ' ' + currentQuarter +
                      '. Informazioni più recenti hanno priorità su quelle vecchie.',
    glossaryContext:  glossaryMatches.length > 0
      ? glossaryMatches.slice(0, 5).map(function(g) {
          return g.term + ': ' + g.definition +
            (g.synonyms && g.synonyms.length > 0 ? ' (sinonimi: ' + g.synonyms.join(', ') + ')' : '');
        }).join('\n')
      : null,
  };
}

module.exports = { buildContext: buildContext };
