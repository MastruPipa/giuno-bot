// ─── Feedback ────────────────────────────────────────────────────────────────
'use strict';

var c = require('./client');

async function saveFeedback(ts, userId, feedback, text) {
  if (!c.useSupabase) {
    var log = c.readJSON('feedback.json', []);
    log.push({ ts: ts, user: userId, feedback: feedback, text: text, date: new Date().toISOString() });
    c.writeJSON('feedback.json', log);
    return;
  }
  try {
    await c.getClient().from('feedback').insert({ ts: ts, slack_user_id: userId, feedback: feedback, message_text: text });
  } catch(e) { c.logErr('saveFeedback', e); }
}

module.exports = { saveFeedback: saveFeedback };
