// ─── User profiles ───────────────────────────────────────────────────────────
'use strict';

var c = require('./client');

var _profileCache = null;

async function loadProfiles() {
  if (!c.useSupabase) {
    _profileCache = c.readJSON('user_profiles.json', {});
    return _profileCache;
  }
  try {
    var res = await c.getClient().from('user_profiles').select('*');
    var profiles = {};
    if (res.data) res.data.forEach(function(r) {
      profiles[r.slack_user_id] = {
        ruolo: r.ruolo,
        progetti: r.progetti || [],
        clienti: r.clienti || [],
        competenze: r.competenze || [],
        stile_comunicativo: r.stile_comunicativo,
        note: r.note || [],
        ultimo_aggiornamento: r.ultimo_aggiornamento,
      };
    });
    _profileCache = profiles;
    return profiles;
  } catch(e) { c.logErr('loadProfiles', e); _profileCache = {}; return {}; }
}

async function saveProfile(userId, profile) {
  if (!_profileCache) _profileCache = {};
  _profileCache[userId] = profile;
  if (!c.useSupabase) {
    c.writeJSON('user_profiles.json', _profileCache);
    return;
  }
  try {
    await c.getClient().from('user_profiles').upsert({
      slack_user_id: userId,
      ruolo: profile.ruolo,
      progetti: profile.progetti || [],
      clienti: profile.clienti || [],
      competenze: profile.competenze || [],
      stile_comunicativo: profile.stile_comunicativo,
      note: profile.note || [],
      ultimo_aggiornamento: profile.ultimo_aggiornamento,
      updated_at: new Date().toISOString(),
    });
  } catch(e) { c.logErr('saveProfile', e); }
}

function getProfileCache() { return _profileCache || {}; }

module.exports = { loadProfiles: loadProfiles, saveProfile: saveProfile, getProfileCache: getProfileCache };
