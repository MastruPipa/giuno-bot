// ─── Team Roster ─────────────────────────────────────────────────────────────
// Single source of truth on WHO is in the team. Used everywhere a Slack name
// needs to be disambiguated (Peppe vs a client called Peppe, Giusy vs
// Giuseppina, Claudia vs a lead Claudia, …).

'use strict';

var c = require('./client');
var logger = require('../../utils/logger');

var _rosterCache = null;

async function loadTeamRoster() {
  if (!c.useSupabase) { _rosterCache = []; return _rosterCache; }
  try {
    var res = await c.getClient().from('team_members')
      .select('slack_user_id, canonical_name, aliases, role, primary_projects, primary_clients, active')
      .eq('active', true);
    _rosterCache = (res && res.data) || [];
    logger.info('[TEAM-ROSTER] caricato:', _rosterCache.length, 'membri');
    return _rosterCache;
  } catch(e) {
    if (!/team_members/i.test(String(e && e.message || ''))) c.logErr('loadTeamRoster', e);
    _rosterCache = [];
    return [];
  }
}

function getTeamRoster() { return _rosterCache || []; }

// Case-insensitive lookup against canonical_name + aliases. Returns the
// matching row or null. Used by entity resolvers / prompt injectors.
function findTeamMemberByName(nameOrAlias) {
  if (!nameOrAlias) return null;
  var needle = String(nameOrAlias).toLowerCase().trim();
  if (!needle || needle.length < 2) return null;
  var roster = _rosterCache || [];
  for (var i = 0; i < roster.length; i++) {
    var m = roster[i];
    if (!m) continue;
    if ((m.canonical_name || '').toLowerCase() === needle) return m;
    if (Array.isArray(m.aliases)) {
      for (var j = 0; j < m.aliases.length; j++) {
        if ((m.aliases[j] || '').toLowerCase() === needle) return m;
      }
    }
  }
  return null;
}

// Return the team-roster entries whose canonical_name or any alias appears
// inside the given text (token-boundary match). Used to auto-tag messages.
function findTeamMembersInText(text) {
  if (!text) return [];
  var roster = _rosterCache || [];
  if (roster.length === 0) return [];
  var hits = [];
  var seen = {};
  for (var i = 0; i < roster.length; i++) {
    var m = roster[i];
    if (!m || seen[m.slack_user_id]) continue;
    var names = [m.canonical_name].concat(Array.isArray(m.aliases) ? m.aliases : []);
    for (var j = 0; j < names.length; j++) {
      var n = (names[j] || '').trim();
      if (n.length < 2) continue;
      var re = new RegExp('(^|[^\\p{L}\\p{N}])' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^\\p{L}\\p{N}]|$)', 'iu');
      if (re.test(text)) { hits.push(m); seen[m.slack_user_id] = true; break; }
    }
  }
  return hits;
}

async function upsertTeamMember(fields) {
  if (!c.useSupabase) return null;
  if (!fields || !fields.slack_user_id || !fields.canonical_name) return null;
  var row = {
    slack_user_id: fields.slack_user_id,
    canonical_name: fields.canonical_name,
    aliases: Array.isArray(fields.aliases) ? fields.aliases : [],
    role: fields.role || null,
    primary_projects: Array.isArray(fields.primary_projects) ? fields.primary_projects : [],
    primary_clients: Array.isArray(fields.primary_clients) ? fields.primary_clients : [],
    active: fields.active !== false,
    updated_at: new Date().toISOString(),
  };
  try {
    await c.getClient().from('team_members').upsert(row, { onConflict: 'slack_user_id' });
    var roster = _rosterCache || [];
    var idx = -1;
    for (var i = 0; i < roster.length; i++) {
      if (roster[i] && roster[i].slack_user_id === row.slack_user_id) { idx = i; break; }
    }
    if (idx >= 0) roster[idx] = row; else roster.push(row);
    _rosterCache = roster;
    return row;
  } catch(e) {
    logger.warn('[TEAM-ROSTER] upsert failed:', e.message);
    return null;
  }
}

async function deactivateTeamMember(slackUserId) {
  if (!c.useSupabase || !slackUserId) return false;
  try {
    await c.getClient().from('team_members')
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq('slack_user_id', slackUserId);
    _rosterCache = (_rosterCache || []).filter(function(m) { return m.slack_user_id !== slackUserId; });
    return true;
  } catch(e) {
    logger.warn('[TEAM-ROSTER] deactivate failed:', e.message);
    return false;
  }
}

// Compact roster block for LLM prompts: one line per person.
function formatRosterForPrompt() {
  var roster = _rosterCache || [];
  if (roster.length === 0) return '';
  var lines = roster.map(function(m) {
    var aliasPart = Array.isArray(m.aliases) && m.aliases.length > 0 ? ' (alias: ' + m.aliases.join(', ') + ')' : '';
    var rolePart = m.role ? ' — ' + m.role : '';
    var projPart = Array.isArray(m.primary_projects) && m.primary_projects.length > 0 ? ' | progetti: ' + m.primary_projects.join(', ') : '';
    return '<@' + m.slack_user_id + '> ' + m.canonical_name + aliasPart + rolePart + projPart;
  });
  return 'ROSTER TEAM KATANIA STUDIO (fonte di verità — usa SEMPRE il tag <@U...> quando citi qualcuno):\n' + lines.join('\n');
}

module.exports = {
  loadTeamRoster: loadTeamRoster,
  getTeamRoster: getTeamRoster,
  findTeamMemberByName: findTeamMemberByName,
  findTeamMembersInText: findTeamMembersInText,
  upsertTeamMember: upsertTeamMember,
  deactivateTeamMember: deactivateTeamMember,
  formatRosterForPrompt: formatRosterForPrompt,
};
