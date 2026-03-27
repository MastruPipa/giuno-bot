// ─── Profile Tools ─────────────────────────────────────────────────────────────
// update_user_profile, get_user_profile

'use strict';

var db = require('../../supabase');

// ─── Profile helpers ───────────────────────────────────────────────────────────

function getProfile(userId) {
  var profiles = db.getProfileCache();
  if (!profiles[userId]) {
    profiles[userId] = {
      ruolo: null,
      progetti: [],
      clienti: [],
      competenze: [],
      stile_comunicativo: null,
      note: [],
      ultimo_aggiornamento: null,
    };
  }
  return profiles[userId];
}

function updateProfileDirect(userId, updates) {
  var profile = getProfile(userId);
  if (updates.ruolo) profile.ruolo = updates.ruolo;
  if (updates.progetto && !profile.progetti.includes(updates.progetto)) profile.progetti.push(updates.progetto);
  if (updates.cliente && !profile.clienti.includes(updates.cliente)) profile.clienti.push(updates.cliente);
  if (updates.competenza && !profile.competenze.includes(updates.competenza)) profile.competenze.push(updates.competenza);
  if (updates.stile_comunicativo) profile.stile_comunicativo = updates.stile_comunicativo;
  if (updates.nota) profile.note.push(updates.nota);
  if (profile.note.length > 20) profile.note = profile.note.slice(-20);
  profile.ultimo_aggiornamento = new Date().toISOString();
  db.saveProfile(userId, profile);
}

// ─── Tool definitions ──────────────────────────────────────────────────────────

var definitions = [
  {
    name: 'update_user_profile',
    description: 'Aggiorna il profilo di un utente. Usalo PROATTIVAMENTE quando scopri info su ruolo, progetti, clienti, competenze di un collega.',
    input_schema: {
      type: 'object',
      properties: {
        ruolo:              { type: 'string', description: 'Ruolo dell\'utente' },
        progetto:           { type: 'string', description: 'Progetto su cui lavora (aggiunge alla lista)' },
        cliente:            { type: 'string', description: 'Cliente che segue (aggiunge alla lista)' },
        competenza:         { type: 'string', description: 'Competenza specifica' },
        stile_comunicativo: { type: 'string', description: 'Descrizione dello stile comunicativo preferito' },
        nota:               { type: 'string', description: 'Nota libera sul profilo' },
      },
    },
  },
  {
    name: 'get_user_profile',
    description: 'Legge il profilo di un utente: ruolo, progetti, clienti, competenze, stile.',
    input_schema: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'ID Slack dell\'utente (opzionale, default utente corrente)' },
      },
    },
  },
  {
    name: 'get_connected_users',
    description: 'Restituisce la lista dei membri del team con il loro stato di connessione Google. ' +
      'Usare SEMPRE quando viene chiesto chi ha collegato Google a Giuno, chi ha accesso, quanti sono connessi. ' +
      'NON rispondere dalla memoria su questo — i dati cambiano.',
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Filtra: all (default), connected, not_connected' },
      },
    },
  },
];

// ─── Tool execution ────────────────────────────────────────────────────────────

async function execute(toolName, input, userId) {
  if (toolName === 'update_user_profile') {
    updateProfileDirect(userId, input);
    return { success: true, profile: getProfile(userId) };
  }

  if (toolName === 'get_connected_users') {
    var filter = input.filter || 'all';
    var { getUserTokens } = require('../services/googleAuthService');
    var { getUtenti } = require('../services/slackService');
    try {
      var utenti = await getUtenti();
      var tokens = getUserTokens();
      var users = utenti.map(function(u) {
        var hasToken = !!tokens[u.id];
        return { display_name: u.name, slack_user_id: u.id, google_connected: hasToken };
      });
      if (filter === 'connected') users = users.filter(function(u) { return u.google_connected; });
      else if (filter === 'not_connected') users = users.filter(function(u) { return !u.google_connected; });
      var connected = users.filter(function(u) { return u.google_connected; });
      var notConnected = users.filter(function(u) { return !u.google_connected; });
      return {
        total: users.length,
        connected: connected.length,
        not_connected: notConnected.length,
        users: users,
        summary: connected.map(function(u) { return u.display_name; }).join(', ') + ' hanno Google collegato. ' +
          (notConnected.length > 0 ? notConnected.map(function(u) { return u.display_name; }).join(', ') + ' non ancora.' : 'Tutti collegati.'),
      };
    } catch(e) { return { error: 'Errore: ' + e.message }; }
  }

  if (toolName === 'get_user_profile') {
    var targetId = input.user_id || userId;
    var profile = getProfile(targetId);
    return { profile: profile };
  }

  return { error: 'Tool sconosciuto nel modulo profileTools: ' + toolName };
}

module.exports = {
  definitions: definitions,
  execute: execute,
  getProfile: getProfile,
  updateProfileDirect: updateProfileDirect,
};
