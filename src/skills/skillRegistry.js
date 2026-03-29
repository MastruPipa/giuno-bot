// ─── Skill Registry ──────────────────────────────────────────────────────────
// Matches user messages to specialized skills. If a skill matches (score >= 10),
// it runs with a focused prompt + targeted data. Otherwise falls through to
// normal intent classification.
'use strict';

var logger = require('../utils/logger');
var { SKILLS } = require('./skillDefinitions');
var { checkPermission } = require('../../rbac');

var MIN_SCORE = 10;

// ─── Match a message against all skills ──────────────────────────────────────

function matchSkill(message, channelId, channelName) {
  if (!message || message.length < 5) return null;
  var msgLow = message.toLowerCase();
  var chName = (channelName || '').toLowerCase();

  var bestSkill = null;
  var bestScore = 0;

  for (var i = 0; i < SKILLS.length; i++) {
    var skill = SKILLS[i];
    var score = 0;

    // Keyword matching (+10 each)
    for (var ki = 0; ki < skill.keywords.length; ki++) {
      if (msgLow.includes(skill.keywords[ki])) score += 10;
    }

    // Regex matching (+15 each)
    if (skill.regex) {
      for (var ri = 0; ri < skill.regex.length; ri++) {
        if (skill.regex[ri].test(msgLow)) score += 15;
      }
    }

    // Channel hint (+5)
    if (skill.channels && skill.channels.length > 0) {
      for (var ci = 0; ci < skill.channels.length; ci++) {
        if (chName.includes(skill.channels[ci])) { score += 5; break; }
      }
    }

    if (score >= MIN_SCORE && score > bestScore) {
      bestScore = score;
      bestSkill = skill;
    }
  }

  if (bestSkill) {
    logger.info('[SKILL] Matched:', bestSkill.id, '| Score:', bestScore);
  }

  return bestSkill ? { skill: bestSkill, score: bestScore } : null;
}

// ─── Execute a matched skill ─────────────────────────────────────────────────

async function executeSkill(skill, message, ctx) {
  // RBAC check
  if (skill.minRole && skill.minRole !== 'member') {
    var roleOrder = { admin: 1, finance: 2, manager: 3, member: 4, restricted: 5 };
    var userLevel = roleOrder[ctx.userRole] || 4;
    var requiredLevel = roleOrder[skill.minRole] || 4;
    if (userLevel > requiredLevel) {
      return 'Non hai i permessi per questa funzione. Serve almeno ruolo ' + skill.minRole + '.';
    }
  }

  // Delegation: some skills just redirect to an existing intent
  if (skill.delegateTo) {
    return null; // Signal to router to use normal intent routing
  }

  var db = require('../../supabase');

  // Load skill-specific context
  var skillContext = {};
  if (skill.loadContext) {
    try {
      skillContext = await skill.loadContext(db, ctx, message) || {};
    } catch(e) {
      logger.warn('[SKILL] Context load error for', skill.id, ':', e.message);
    }
  }

  // Build context string
  var contextStr = '';
  for (var key in skillContext) {
    var val = skillContext[key];
    if (!val) continue;
    if (Array.isArray(val)) {
      if (val.length === 0) continue;
      contextStr += '\n' + key.toUpperCase() + ':\n';
      val.forEach(function(item) {
        if (typeof item === 'string') contextStr += '• ' + item + '\n';
        else contextStr += '• ' + JSON.stringify(item).substring(0, 200) + '\n';
      });
    } else if (typeof val === 'object') {
      contextStr += '\n' + key.toUpperCase() + ': ' + JSON.stringify(val).substring(0, 300) + '\n';
    } else {
      contextStr += '\n' + key.toUpperCase() + ': ' + val + '\n';
    }
  }

  // Call Claude with focused skill prompt
  var Anthropic = require('@anthropic-ai/sdk');
  var client = new Anthropic();

  var systemPrompt = skill.prompt +
    '\n\nCONTESTO:\n' + contextStr +
    '\n\nFORMATTAZIONE: *grassetto* singolo. MAI **. Max 20 righe. Sii operativo.';

  try {
    var registry = require('../tools/registry');
    var tools = registry.getAllTools();
    var messages = [{ role: 'user', content: message }];
    var finalReply = '';

    while (true) {
      var response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: ctx.isDM ? 500 : 800,
        system: systemPrompt,
        messages: messages,
        tools: tools,
      });

      if (response.stop_reason !== 'tool_use') {
        finalReply = response.content
          .filter(function(b) { return b.type === 'text'; })
          .map(function(b) { return b.text; })
          .join('\n');
        break;
      }

      messages.push({ role: 'assistant', content: response.content });
      var toolResults = await Promise.all(
        response.content.filter(function(b) { return b.type === 'tool_use'; }).map(async function(tu) {
          var result = await registry.executeToolCall(tu.name, tu.input, ctx.userId, ctx.userRole);
          return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) };
        })
      );
      messages.push({ role: 'user', content: toolResults });
    }

    return finalReply;
  } catch(e) {
    logger.error('[SKILL] Execute error:', skill.id, e.message);
    return null; // Fall through to normal routing
  }
}

module.exports = { matchSkill: matchSkill, executeSkill: executeSkill, SKILLS: SKILLS };
