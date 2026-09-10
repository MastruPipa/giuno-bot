// ─── Registro delle azioni eseguite per conversazione ────────────────────────
// La storia che il modello vede è il transcript Slack: testo, niente tool.
// Così al turno dopo "ho mandato" non ha prove e o rimanda (doppioni) o dice
// "non ho traccia". Qui ogni azione con effetto (DM, email, eventi, CRM…)
// viene registrata e rientra nel contesto come fatto certo.

'use strict';

function _c() { return require('./client'); }
var FILE = 'conversation_actions.json';
var _mem = null;
function _read() { if (!_mem) _mem = _c().readJSON(FILE, []); return _mem; }

async function logAction(convKey, userId, tool, summary) {
  var row = { conv_key: convKey, user_id: userId || null, tool: tool, summary: String(summary || '').substring(0, 400), at: new Date().toISOString() };
  var c = _c();
  if (!c.useSupabase) { var all = _read(); all.push(row); if (all.length > 500) all.splice(0, all.length - 500); c.writeJSON(FILE, all); return row; }
  try {
    var res = await c.getClient().from('conversation_actions').insert(row);
    if (res.error) throw res.error;
  } catch(e) { c.logErr('logAction', e); }
  return row;
}

async function recentActions(convKey, hours, limit) {
  var since = new Date(Date.now() - (hours || 24) * 3600000).toISOString();
  var c = _c();
  if (!c.useSupabase) {
    return _read().filter(function(a) { return a.conv_key === convKey && a.at >= since; }).slice(-(limit || 12));
  }
  try {
    var res = await c.getClient().from('conversation_actions').select('tool, summary, at, user_id')
      .eq('conv_key', convKey).gte('at', since).order('at', { ascending: true }).limit(limit || 12);
    if (res.error) throw res.error;
    return res.data || [];
  } catch(e) { c.logErr('recentActions', e); return []; }
}

function _resetForTests() { _mem = []; }

module.exports = { logAction: logAction, recentActions: recentActions, _resetForTests: _resetForTests };
