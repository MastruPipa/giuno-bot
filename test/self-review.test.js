'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var sr = require('../src/agents/selfReview');

test('findFallbackReplies: riconosce le risposte in fallback e il messaggio che le ha causate', function() {
  var convs = [{ conv_key: 'U1', messages: [
    { role: 'user', content: '<@U1> (Antonio): manda' }, { role: 'assistant', content: '' },
    { role: 'user', content: 'cosa hai scritto?' }, { role: 'assistant', content: 'Non sono riuscito a completare l\'azione. Riprova o dimmi esattamente cosa devo fare.' },
    { role: 'user', content: 'ok' }, { role: 'assistant', content: 'Perfetto.' },
    { role: 'user', content: 'e quindi?' }, { role: 'assistant', content: 'Dimmi pure — a cosa ti riferisci?' },
  ] }];
  var f = sr.findFallbackReplies(convs);
  assert.deepEqual(f.map(function(x) { return x.kind + ':' + x.user_message; }), ['vuota:manda', 'validator:cosa hai scritto?', 'contesto:e quindi?']);
});

test('buildPrompt/parseReview/formatReview', function() {
  var signals = { date: '2026-09-10', conversations: 12, actions: 5, api: [{ model: 'claude-opus-5', calls: 70, input: 2400000, usd: 16.4 }],
    fallbacks: [{ kind: 'validator', user_message: 'cosa hai scritto?' }], tool_failures: [{ tool: 'send_dm', error: 'Destinatario non trovato', input: '{"target_user_name":"Nicolò"}' }],
    cron_errors: [{ name: 'drive_watcher', error: 'timeout' }], error_patterns: [], feedback_negative: [], eval: { ran_at: '2026-09-10T12:00:00Z', passed: 15, total: 18, avg_judge: 0.81, failed: [{ id: 'dm-check-letto', failures: ['non ha chiamato il tool check_dm_replies'] }] } };
  var p = sr.buildPrompt(signals);
  assert.match(p, /RISPOSTE IN FALLBACK \(1\)[\s\S]*\[validator\] dopo: "cosa hai scritto\?"/);
  assert.match(p, /TOOL FALLITI \(1\)[\s\S]*send_dm: Destinatario non trovato/);
  assert.match(p, /ULTIMA EVAL \(2026-09-10\): 15\/18, giudice 0\.81[\s\S]*dm-check-letto/);
  assert.equal(sr.hasSomethingToSay(signals), true);
  assert.equal(sr.hasSomethingToSay({ fallbacks: [], tool_failures: [], cron_errors: [], error_patterns: [], feedback_negative: [], eval: null }), false);
  var r = sr.parseReview('{"sintesi":"Giornata densa.","cosa_ha_funzionato":["campagne"],"problemi":[{"titolo":"Validator troppo severo","evidenza":"1 risposta soppressa","causa_probabile":"pattern ho scritto","proposta":"contare le azioni registrate","dove":"codice","impatto":"alto","sforzo":"piccolo"}],"non_toccare":["dedup DM"]}');
  var text = sr.formatReview(signals, r);
  assert.match(text, /Retrospettiva di Giuno — 2026-09-10[\s\S]*12 conversazioni · 5 azioni · 1 risposte in fallback · 1 tool falliti · 1 cron con errori · \$16\.40/);
  assert.match(text, /\*1\. Validator troppo severo\* _\(codice, impatto alto, sforzo piccolo\)_[\s\S]*→ contare le azioni registrate/);
  assert.match(text, /\*Non toccare:\* dedup DM/);
});

test('runSelfReview: giornata pulita → nessun DM; con segnali → modello, salvataggio, DM agli admin', async function() {
  var posted = [];
  var saved = [];
  var fakeSupabase = { from: function(table) { return { upsert: async function(row) { saved.push({ table: table, row: row }); return {}; } }; } };
  var deps = {
    supabase: fakeSupabase,
    client: { messages: { create: async function() { return { content: [{ type: 'text', text: JSON.stringify({ sintesi: 'ok', cosa_ha_funzionato: [], problemi: [{ titolo: 'T', proposta: 'P', dove: 'prompt', impatto: 'medio', sforzo: 'piccolo' }], non_toccare: [] }) }] }; } } },
    app: { client: { chat: { postMessage: async function(a) { posted.push(a); return { ts: '1' }; } } } },
    roles: [{ slack_user_id: 'U_ANT', role: 'admin' }],
  };
  var clean = await sr.runSelfReview({ date: '2026-09-10', notify: true, deps: deps, signals: { date: '2026-09-10', conversations: 3, actions: 1, api: [], fallbacks: [], tool_failures: [], cron_errors: [], error_patterns: [], feedback_negative: [], eval: null } });
  assert.equal(clean.review, null);
  assert.equal(posted.length, 0);
  var out = await sr.runSelfReview({ date: '2026-09-10', notify: true, deps: deps, signals: { date: '2026-09-10', conversations: 3, actions: 1, api: [], fallbacks: [{ kind: 'vuota', user_message: 'manda' }], tool_failures: [], cron_errors: [], error_patterns: [], feedback_negative: [], eval: null } });
  assert.equal(out.notified, 1);
  assert.equal(saved[0].table, 'self_reviews');
  assert.match(posted[0].text, /\*1\. T\*/);
});
