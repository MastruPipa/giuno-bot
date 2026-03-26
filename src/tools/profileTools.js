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
];

// ─── Tool execution ────────────────────────────────────────────────────────────

async function execute(toolName, input, userId) {
  if (toolName === 'update_user_profile') {
    updateProfileDirect(userId, input);
    return { success: true, profile: getProfile(userId) };
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
