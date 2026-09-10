// ─── Sync del roster dal workspace Slack ─────────────────────────────────────
// Il roster (team_members) era fermo a giugno: Samuele non c'era, Nicolò
// risultava attivo, e Giuno "diceva" di aggiornarlo senza avere un tool.
// Qui: ogni mattina users.list → chi manca viene aggiunto (nome, alias,
// mansione dal profilo), chi è stato disattivato su Slack viene disattivato,
// gli admin ricevono il riepilogo delle novità. Ospiti e bot restano fuori.

'use strict';

var logger = require('../utils/logger');

var SKIP_IDS = new Set(['USLACKBOT']);

function firstName(full) { return String(full || '').trim().split(/\s+/)[0] || ''; }

function slackUserToMember(u) {
  var full = (u.real_name || (u.profile && u.profile.real_name) || u.name || '').trim();
  var aliases = [];
  var fn = firstName(full);
  if (fn && fn.toLowerCase() !== full.toLowerCase()) aliases.push(fn);
  if (u.name && u.name.toLowerCase() !== full.toLowerCase() && u.name.toLowerCase() !== fn.toLowerCase()) aliases.push(u.name);
  return {
    slack_user_id: u.id, canonical_name: full || u.id, aliases: aliases,
    role: (u.profile && u.profile.title) || null, email: (u.profile && u.profile.email) || null,
    is_guest: !!(u.is_restricted || u.is_ultra_restricted),
  };
}

// Pura: confronta utenti Slack e roster. Ritorna { toAdd, toDeactivate, guests }.
function diffRoster(slackUsers, roster) {
  var humans = (slackUsers || []).filter(function(u) { return u && u.id && !u.is_bot && !SKIP_IDS.has(u.id) && !u.is_app_user; });
  var byId = {};
  humans.forEach(function(u) { byId[u.id] = u; });
  var rosterById = {};
  (roster || []).forEach(function(m) { if (m && m.slack_user_id) rosterById[m.slack_user_id] = m; });
  var toAdd = [], guests = [], toDeactivate = [];
  humans.forEach(function(u) {
    if (u.deleted) return;
    var m = slackUserToMember(u);
    if (rosterById[u.id] && rosterById[u.id].active !== false) return;
    if (m.is_guest) { guests.push(m); return; }
    toAdd.push(m);
  });
  (roster || []).forEach(function(m) {
    if (!m || m.active === false) return;
    var u = byId[m.slack_user_id];
    if (!u || u.deleted) toDeactivate.push(m);
  });
  return { toAdd: toAdd, toDeactivate: toDeactivate, guests: guests };
}

async function listSlackUsers(app) {
  var out = [];
  var cursor;
  do {
    var res = await app.client.users.list({ limit: 200, cursor: cursor });
    out = out.concat(res.members || []);
    cursor = res.response_metadata && res.response_metadata.next_cursor;
  } while (cursor);
  return out;
}

function formatReport(diff, applied) {
  var lines = ['*Roster team' + (applied ? ' aggiornato' : ' — anteprima') + ':* ' + diff.toAdd.length + ' da aggiungere, ' + diff.toDeactivate.length + ' da disattivare' + (diff.guests.length ? ', ' + diff.guests.length + ' ospiti ignorati' : '')];
  diff.toAdd.forEach(function(m) { lines.push('• ➕ <@' + m.slack_user_id + '> ' + m.canonical_name + (m.role ? ' — ' + m.role : ' — mansione da impostare') + (m.aliases.length ? ' _(alias: ' + m.aliases.join(', ') + ')_' : '')); });
  diff.toDeactivate.forEach(function(m) { lines.push('• ➖ ' + m.canonical_name + ' (account Slack disattivato)'); });
  if (diff.guests.length) lines.push('Ospiti: ' + diff.guests.map(function(g) { return g.canonical_name; }).join(', '));
  if (applied && diff.toAdd.length) lines.push('Ruolo di accesso: `/giuno admin ruolo @utente member|manager|finance|admin` · mansione: `/giuno admin team set @utente role="..."`');
  return lines.join('\n');
}

async function syncRosterFromSlack(opts) {
  opts = opts || {};
  var deps = opts.deps || {};
  var app = deps.app || require('../services/slackService').app;
  var db = deps.db || require('../../supabase');
  var users = deps.users || await listSlackUsers(app);
  var roster = db.getTeamRoster ? db.getTeamRoster() : [];
  var diff = diffRoster(users, roster);
  var apply = opts.apply !== false;
  if (apply) {
    for (var i = 0; i < diff.toAdd.length; i++) {
      var m = diff.toAdd[i];
      await db.upsertTeamMember({ slack_user_id: m.slack_user_id, canonical_name: m.canonical_name, aliases: m.aliases, role: m.role, active: true });
    }
    for (var j = 0; j < diff.toDeactivate.length; j++) await db.deactivateTeamMember(diff.toDeactivate[j].slack_user_id);
    if (diff.toAdd.length || diff.toDeactivate.length) logger.info('[ROSTER-SYNC] +' + diff.toAdd.length + ' / -' + diff.toDeactivate.length);
  }
  if (opts.notify && (diff.toAdd.length || diff.toDeactivate.length)) {
    try {
      var roles = deps.roles || await require('../../rbac').getAllRoles();
      var admins = roles.filter(function(r) { return r.role === 'admin'; });
      for (var k = 0; k < admins.length; k++) await app.client.chat.postMessage({ channel: admins[k].slack_user_id, text: '👥 ' + formatReport(diff, apply) });
    } catch(e) { logger.warn('[ROSTER-SYNC] avviso admin fallito:', e.message); }
  }
  return { diff: diff, applied: apply };
}

module.exports = { diffRoster: diffRoster, slackUserToMember: slackUserToMember, listSlackUsers: listSlackUsers, formatReport: formatReport, syncRosterFromSlack: syncRosterFromSlack };
