// ─── User prefs ──────────────────────────────────────────────────────────────
'use strict';

var c = require('./client');

var _prefsCache = null;

async function loadPrefs() {
  if (!c.useSupabase) {
    _prefsCache = c.readJSON('user_prefs.json', {});
    return _prefsCache;
  }
  try {
    var res = await c.getClient().from('user_prefs').select('*');
    var prefs = {};
    if (res.data) res.data.forEach(function(r) {
      prefs[r.slack_user_id] = {
        routine_enabled: r.routine_enabled,
        notifiche_enabled: r.notifiche_enabled,
        standup_enabled: r.standup_enabled,
      };
    });
    _prefsCache = prefs;
    return prefs;
  } catch(e) { c.logErr('loadPrefs', e); _prefsCache = {}; return {}; }
}

async function savePrefs(userId, prefs) {
  if (!_prefsCache) _prefsCache = {};
  _prefsCache[userId] = prefs;
  if (!c.useSupabase) {
    c.writeJSON('user_prefs.json', _prefsCache);
    return;
  }
  try {
    await c.getClient().from('user_prefs').upsert({
      slack_user_id: userId,
      routine_enabled: prefs.routine_enabled,
      notifiche_enabled: prefs.notifiche_enabled,
      standup_enabled: prefs.standup_enabled,
      updated_at: new Date().toISOString(),
    });
  } catch(e) { c.logErr('savePrefs', e); }
}

function getPrefsCache() { return _prefsCache || {}; }

module.exports = { loadPrefs: loadPrefs, savePrefs: savePrefs, getPrefsCache: getPrefsCache };
