'use strict';

process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || 'x';
process.env.SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || 'x';
process.env.SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN || 'x';

var test = require('node:test');
var assert = require('node:assert/strict');
var Module = require('module');
var boltPath = require.resolve('@slack/bolt');
if (!require.cache[boltPath]) {
  var stub = new Module(boltPath); stub.filename = boltPath; stub.loaded = true;
  stub.exports = { App: function StubApp() { this.client = {}; this.error = function() {}; } };
  require.cache[boltPath] = stub;
}
var dsv2 = require('../src/handlers/dailyStandupV2');
var est = require('../src/agents/dailyEstimator');
var tracking = require('../src/config/tracking');

// Antonio (17/9): la stima arriva a tutti alle 17:30, anche a lui; poi si
// approva, si modifica (modulo o a parole) o si compila da zero.

test('orari: stima 17:30, promemoria 18:00, recap 18:30, lun-ven', function() {
  assert.deepEqual(dsv2.DAILY_TIMES, { send: '17:30', push: '18:00', recap: '18:30' });
  var jobs = [];
  dsv2.scheduleDailyJobs({ schedule: function(expr, fn, opts) { jobs.push([expr, opts.name]); } });
  assert.deepEqual(jobs, [['30 17 * * 1-5', 'daily_send'], ['0 18 * * 1-5', 'daily_push'], ['30 18 * * 1-5', 'daily_recap']]);
  assert.equal(dsv2.cronExprFor('9:05'), '5 9 * * 1-5');
});

test('Antonio è dentro al daily; le altre esclusioni restano', function() {
  assert.equal(tracking.isExcludedName('Antonio Katania'), false);
  assert.equal(tracking.isExcludedName('Gloria Rossi'), true);
  assert.equal(tracking.isExcludedName('Cellulare studio'), true);
});

test('classifyEstimateReply: approvazione a parole, modifica a parole, il resto no', function() {
  ['approvo', 'confermo', 'Approvo così'].forEach(function(t) { assert.equal(dsv2.classifyEstimateReply(t), 'approve', t); });
  // "ok" nudo: approvazione solo se l'ultimo messaggio di Giuno era la proposta (lo decide il handler).
  ['ok', 'Ok!', 'va bene così', 'sì', 'perfetto 👍'].forEach(function(t) { assert.equal(dsv2.classifyEstimateReply(t), 'approve_bare', t); });
  ['aggiungi 1h di call con Elios', 'la grafica erano 3h', 'togli la revisione', 'leva il meeting di fondazione per il sud che è saltato', 'non ho fatto la call', 'in più ho fatto 1h di preventivo Acme',
    'manca la call con Gambino 1h', 'puoi aggiungere 30 min di mail?', 'Giuno, togli la revisione'].forEach(function(t) { assert.equal(dsv2.classifyEstimateReply(t), 'amend', t); });
  // Daily intero, domande, richieste esplicite di posting: non sono risposte alla proposta.
  ['Oggi: grafiche 3h\nDomani: PED', 'quando esce il recap?', 'ciao giuno, cosa mi consigli?', 'posta il daily: oggi grafiche 3h e call 1h', ''].forEach(function(t) { assert.equal(dsv2.classifyEstimateReply(t), null, JSON.stringify(t)); });
});

test('amendEstimate: il modello applica la modifica, la stima tiene fonti e storico delle modifiche', async function() {
  var seen;
  var fakeClient = { messages: { create: async function(req) { seen = req; return { content: [{ type: 'text', text: JSON.stringify({
    oggi: [{ task: 'Grafiche Elfo', hours: 3, minutes: 0, project: 'Elfo' }, { task: 'Call con Elios', hours: 1, minutes: 0, project: 'Elios' }], domani: [{ task: 'PED', hours: 0, minutes: 0 }], blocchi: null,
  }) }] }; } } };
  var current = { oggi: [{ task: 'Grafiche Elfo', hours: 2, minutes: 0 }], domani: [{ task: 'PED', hours: 0, minutes: 0 }], blocchi: null, estimate: { sources: ['documenti Drive'], confidence: 'media', generated_at: 'g' } };
  var out = await est.amendEstimate(current, 'la grafica erano 3h e aggiungi 1h di call con Elios', { client: fakeClient, userId: 'U1', date: '2026-09-17' });
  assert.match(seen.system, /SOLO quella modifica/);
  assert.match(seen.messages[0].content, /DAILY ATTUALE:[\s\S]*Grafiche Elfo[\s\S]*MODIFICA CHIESTA DALLA PERSONA:\nla grafica erano 3h/);
  assert.equal(out.oggi.length, 2); assert.equal(out.oggi[0].hours, 3); assert.equal(out.totalOggi, 4);
  assert.deepEqual(out.estimate.sources, ['documenti Drive']); assert.equal(out.estimate.generated_at, 'g');
  assert.deepEqual(out.estimate.amendments, ['la grafica erano 3h e aggiungi 1h di call con Elios']);
  assert.equal(await est.amendEstimate(current, '', { client: fakeClient }), null);
  var broken = { messages: { create: async function() { return { content: [{ type: 'text', text: 'non so' }] }; } } };
  assert.equal(await est.amendEstimate(current, 'togli tutto', { client: broken }), null);
});

test('proposta in DM: tre bottoni (approvo, modifico nel modulo, da zero), istruzioni per scrivere, orario del recap', function() {
  var structured = { oggi: [{ task: 'Grafiche Elfo', hours: 2, minutes: 0 }], domani: [], blocchi: null, estimate: { sources: ['documenti Drive'], confidence: 'media', generated_at: 'g' } };
  var msg = dsv2.estimateProposalMessage({ id: 'U1', name: 'Paolo Spartano' }, structured, { mode: 'daily' });
  assert.equal(msg.channel, 'U1');
  assert.match(msg.blocks[0].text.text, /Ciao \*Paolo\*, è il momento del daily/);
  assert.match(msg.blocks[2].text.text, /\*Approva\* con il bottone, \*modifica\* nel modulo già compilato, oppure \*scrivimi qui\* cosa aggiungere o cambiare/);
  assert.match(msg.blocks[3].elements[0].text, /Se alle 18:30 non ho tue notizie/);
  var buttons = msg.blocks[4].elements.map(function(b) { return b.action_id + ':' + b.text.text; });
  assert.deepEqual(buttons, ['daily_estimate_confirm:✅ Approvo', 'open_daily_modal:✏️ Modifico nel modulo', 'open_daily_modal_blank:📝 Compilo da zero']);
  assert.match(dsv2.estimateProposalMessage({ id: 'U1', name: 'Paolo' }, structured, { mode: 'amended' }).blocks[0].text.text, /Ok \*Paolo\*, aggiornato così/);
});

test('amendPendingEstimate: aggiorna la stima in sospeso e rimanda la proposta; senza proposta non fa nulla', async function() {
  var today = dsv2.oggi();
  var sent = [];
  var fakeApp = { client: { chat: { postMessage: async function(m) { sent.push(m); } } } };
  var fakeEstimator = {
    amendEstimate: async function(current, instruction) { return Object.assign({}, current, { oggi: current.oggi.concat([{ task: 'Call Elios', hours: 1, minutes: 0 }]), estimate: Object.assign({}, current.estimate, { amendments: [instruction] }) }); },
    formatEstimateBody: est.formatEstimateBody, formatSourcesLine: est.formatSourcesLine,
  };
  var fakeDb = { getStandupCache: function() { return { oggi: today, stime: {} }; }, saveStandup: async function() {} };
  assert.equal(await dsv2.amendPendingEstimate('U_NOBODY', 'aggiungi 1h', { estimator: fakeEstimator, app: fakeApp, db: fakeDb, utenti: [] }), null);
  dsv2.rememberPendingEstimate('U_PAOLO', today, { oggi: [{ task: 'Grafiche', hours: 2, minutes: 0 }], domani: [], blocchi: null, estimate: { sources: ['canali'], confidence: 'media', generated_at: 'g' } });
  try {
    var out = await dsv2.amendPendingEstimate('U_PAOLO', 'aggiungi 1h di call con Elios', { estimator: fakeEstimator, app: fakeApp, db: fakeDb, utenti: [{ id: 'U_PAOLO', name: 'Paolo Spartano' }] });
    assert.equal(out.oggi.length, 2);
    assert.equal(dsv2.getPendingEstimate('U_PAOLO', today).oggi.length, 2, 'la proposta in sospeso è quella aggiornata');
    assert.equal(sent.length, 1);
    assert.match(sent[0].blocks[0].text.text, /aggiornato così/);
    assert.match(sent[0].text, /Call Elios 1h/);
  } finally { dsv2.clearPendingEstimate('U_PAOLO'); }
});

test('sendDailyRequestWithEstimate: con tracce manda la stima e mette la persona in attesa; senza tracce il modulo', async function() {
  var sent = [];
  var fakeApp = { client: { chat: { postMessage: async function(m) { sent.push(m); } } } };
  var saved = [];
  var fakeDb = { getStandupCache: function() { return { oggi: dsv2.oggi(), risposte: {}, stime: {} }; }, saveStandup: async function(sd) { saved.push(sd); }, getProject: async function() { return null; } };
  var inattesa = new Set();
  var structured = { oggi: [{ task: 'Grafiche Elfo', hours: 2, minutes: 0 }], domani: [], blocchi: null, estimate: { sources: ['canali'], confidence: 'media', generated_at: 'g' } };
  var r = await dsv2.sendDailyRequestWithEstimate({ id: 'U_ANT', name: 'Antonio Katania' }, { app: fakeApp, db: fakeDb, inattesa: inattesa, buildEstimateFor: async function() { return structured; } });
  assert.deepEqual(r, { estimate: true });
  assert.ok(inattesa.has('U_ANT')); assert.deepEqual(saved[0].inattesa, ['U_ANT']);
  assert.match(sent[0].blocks[0].text.text, /Ciao \*Antonio\*, è il momento del daily/);
  assert.equal(sent[0].blocks[4].elements[0].text.text, '✅ Approvo');

  sent.length = 0;
  var r2 = await dsv2.sendDailyRequestWithEstimate({ id: 'U_ANT', name: 'Antonio Katania' }, { app: fakeApp, db: fakeDb, inattesa: inattesa, buildEstimateFor: async function() { return null; }, quickDeps: { context: { recentProjectsFor: async function() { return []; } } } });
  assert.deepEqual(r2, { estimate: false });
  assert.match(sent[0].text, /è il momento del daily!/);
});

test('trigger_daily_request: risponde subito e manda il DM in background (la stima può superare il turno)', async function() {
  var workflowTools = require('../src/tools/workflowTools');
  var slackService = require('../src/services/slackService');
  var origSend = dsv2.sendDailyRequestWithEstimate;
  var origGet = slackService.getUtenti;
  var started = [];
  var release;
  dsv2.sendDailyRequestWithEstimate = function(target) { started.push(target.id); return new Promise(function(res) { release = function() { res({ estimate: true }); }; }); };
  slackService.getUtenti = async function() { return [{ id: 'U_ANT', name: 'Antonio' }]; };
  try {
    var t0 = Date.now();
    var res = await workflowTools.execute('trigger_daily_request', {}, 'U_ANT', 'admin');
    assert.ok(Date.now() - t0 < 500, 'non aspetta la stima');
    assert.equal(res.success, true); assert.equal(res.in_background, true); assert.equal(res.sent_to, 'U_ANT');
    assert.match(res.nota, /arriva da solo/);
    assert.deepEqual(started, ['U_ANT']);
    release();
  } finally { dsv2.sendDailyRequestWithEstimate = origSend; slackService.getUtenti = origGet; }
});

test('users.list: cache di 5 minuti, lista vecchia se Slack non risponde, roster in DB senza cache', async function() {
  var svc = require('../src/services/slackService');
  var calls = 0;
  var okApp = { client: { users: { list: async function() { calls++; return { members: [{ id: 'U1', real_name: 'Paolo', profile: { email: 'p@k.it' } }] }; } } } };
  var koApp = { client: { users: { list: async function() { calls++; throw new Error('socket hang up'); } } } };
  svc.invalidateUsersCache();
  var t = 1000;
  var now = function() { return t; };
  assert.equal((await svc.listMembers({ app: okApp, now: now })).length, 1); assert.equal(calls, 1);
  assert.equal((await svc.listMembers({ app: okApp, now: now })).length, 1); assert.equal(calls, 1, 'seconda lettura dalla cache');
  t += 6 * 60000;
  var stale = await svc.listMembers({ app: koApp, now: now });
  assert.equal(stale[0].id, 'U1', 'Slack giù: vale la lista vecchia');
  assert.ok(calls >= 2);
  svc.invalidateUsersCache();
  var fromRoster = await svc.listMembers({ app: koApp, now: now, teamDb: { getTeamRoster: function() { return [{ slack_user_id: 'U_ANT', canonical_name: 'Antonio Katania' }]; } } });
  assert.deepEqual(fromRoster.map(function(u) { return u.id + ':' + u.real_name; }), ['U_ANT:Antonio Katania']);
  svc.invalidateUsersCache();
  await assert.rejects(svc.listMembers({ app: koApp, now: now, teamDb: { getTeamRoster: function() { return []; } } }), /socket hang up/);
  svc.invalidateUsersCache();
});

test('trigger_daily_request: se users.list fallisce si va avanti con users.info o col solo id', async function() {
  var workflowTools = require('../src/tools/workflowTools');
  var svc = require('../src/services/slackService');
  var origSend = dsv2.sendDailyRequestWithEstimate;
  var origGet = svc.getUtenti;
  var targets = [];
  dsv2.sendDailyRequestWithEstimate = async function(target) { targets.push(target); return { estimate: false }; };
  svc.getUtenti = async function() { throw new Error('SLACK.users.list timeout'); };
  svc.app.client.users = { info: async function(a) { return { user: { real_name: 'Antonio Katania', profile: { email: 'a@k.it' } } }; } };
  try {
    var res = await workflowTools.execute('trigger_daily_request', {}, 'U_ANT', 'admin');
    assert.equal(res.success, true);
    assert.deepEqual(targets, [{ id: 'U_ANT', name: 'Antonio Katania', email: 'a@k.it' }]);
    svc.app.client.users = { info: async function() { throw new Error('boom'); } };
    var res2 = await workflowTools.execute('trigger_daily_request', {}, 'U_ANT', 'admin');
    assert.equal(res2.success, true);
    assert.deepEqual(targets[1], { id: 'U_ANT', name: '' });
  } finally { dsv2.sendDailyRequestWithEstimate = origSend; svc.getUtenti = origGet; delete svc.app.client.users; }
});

test('lastBotMessageIsProposal: vero solo se l\'ultimo messaggio di Giuno nel DM ha il bottone Approvo', async function() {
  var proposal = { bot_id: 'B1', blocks: [{ type: 'section' }, { type: 'actions', elements: [{ action_id: 'daily_estimate_confirm' }, { action_id: 'open_daily_modal' }] }] };
  var advice = { bot_id: 'B1', text: 'Il mio consiglio: lascia perdere il DM con la stima.' };
  var mk = function(msgs) { return { client: { conversations: { history: async function(a) { assert.equal(a.latest, '170.5'); return { messages: msgs }; } } } }; };
  assert.equal(await dsv2.lastBotMessageIsProposal('D1', '170.5', { app: mk([proposal]) }), true);
  assert.equal(await dsv2.lastBotMessageIsProposal('D1', '170.5', { app: mk([advice, proposal]) }), false, 'in mezzo c\'è la risposta a una domanda');
  assert.equal(await dsv2.lastBotMessageIsProposal('D1', '170.5', { app: mk([{ user: 'U_ANT', text: 'leva il meeting' }, proposal]) }), true, 'i messaggi dell\'utente non contano');
  assert.equal(await dsv2.lastBotMessageIsProposal('D1', '170.5', { app: { client: { conversations: { history: async function() { throw new Error('boom'); } } } } }), false);
});
