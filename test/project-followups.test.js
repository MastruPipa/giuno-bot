'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');

var dbClient = require('../src/services/db/client');
dbClient.useSupabase = false;
dbClient.writeJSON = function() {};
dbClient.readJSON = function(_, def) { return def; };

var fu = require('../src/agents/projectFollowups');

test('parseDateLoose: ISO, gg/mm/aaaa, gg/mm con anno corrente', function() {
  assert.equal(fu.parseDateLoose('2026-09-19', '2026-09-10'), '2026-09-19');
  assert.equal(fu.parseDateLoose('entro il 19/09/2026', '2026-09-10'), '2026-09-19');
  assert.equal(fu.parseDateLoose('3/10', '2026-09-10'), '2026-10-03');
  assert.equal(fu.parseDateLoose('prima possibile', '2026-09-10'), null);
});

function makeDeps(actions, dossierRows, projects) {
  var posted = [];
  var updates = [];
  var gateCalls = {};
  return {
    posted: posted, updates: updates,
    deps: {
      db: {
        getProject: async function(id) { return (projects || []).find(function(p) { return p.id === id; }) || null; },
        searchProjects: async function() { return projects || []; },
        getUserAllocations: async function() { return []; },
      },
      dossiers: {
        listProjectActions: async function(f) {
          return actions.filter(function(a) {
            if (f.status && a.status !== f.status) return false;
            if (f.assignee && a.assignee_slack_id !== f.assignee) return false;
            if (f.notNotified && a.notified_at) return false;
            if (f.createdAfter && !(a.created_at >= f.createdAfter)) return false;
            if (f.dueBefore && !(a.due_date && a.due_date <= f.dueBefore)) return false;
            return true;
          });
        },
        updateProjectAction: async function(id, fields) { updates.push({ id: id, fields: fields }); },
        listDossiers: async function() { return dossierRows || []; },
      },
      gate: {
        notificheEnabled: function(u) { return u !== 'U_OFF'; },
        itemHash: function(t) { return t; },
        followupAllowed: async function(_, uid, hash) { gateCalls[hash] = (gateCalls[hash] || 0) + 1; return { allowed: gateCalls[hash] === 1, attempts: 0 }; },
        recordFollowup: async function() {},
      },
      app: { client: { chat: { postMessage: async function(a) { posted.push(a); return { ts: '1' }; } } } },
      supabase: {},
      roles: [{ slack_user_id: 'U_ADMIN', role: 'admin' }],
      today: '2026-09-10',
    },
  };
}

test('sendMeetingActionFollowups: un DM per persona e call, con bottoni, poi marcate notificate', async function() {
  var now = new Date().toISOString();
  var t = makeDeps([
    { id: 'a1', status: 'open', assignee_slack_id: 'U1', description: 'inviare documenti Caritas', due_date: '2026-09-10', source_title: 'Weekly Mandorle', meeting_date: '2026-09-08', created_at: now, project_id: 'p1' },
    { id: 'a2', status: 'open', assignee_slack_id: 'U1', description: 'contattare Francesco', source_title: 'Weekly Mandorle', created_at: now, project_id: 'p1' },
    { id: 'a3', status: 'open', assignee_slack_id: null, description: 'sviluppare packaging', source_title: 'Weekly Mandorle', created_at: now },
    { id: 'a4', status: 'open', assignee_slack_id: 'U1', description: 'vecchia', created_at: now, notified_at: now },
  ], [], [{ id: 'p1', name: 'Mandorle' }]);
  var n = await fu.sendMeetingActionFollowups(t.deps);
  assert.equal(n, 1);
  assert.equal(t.posted[0].channel, 'U1');
  assert.match(t.posted[0].text, /call \*Weekly Mandorle\* del 2026-09-08[\s\S]*inviare documenti Caritas — entro 2026-09-10 _\(Mandorle\)_[\s\S]*contattare Francesco/);
  assert.equal(t.posted[0].blocks[1].elements[0].value, 'a1,a2');
  assert.deepEqual(t.updates.map(function(u) { return u.id; }), ['a1', 'a2']);
});

test('sendDueReminders: azioni in scadenza all\'assegnatario (con throttle) e scadenze dossier al responsabile/admin', async function() {
  var t = makeDeps([
    { id: 'a1', status: 'open', assignee_slack_id: 'U1', description: 'inviare documenti', due_date: '2026-09-11', created_at: '2026-09-01', project_id: 'p1' },
    { id: 'a2', status: 'open', assignee_slack_id: 'U1', description: 'troppo lontana', due_date: '2026-09-30', created_at: '2026-09-01' },
    { id: 'a3', status: 'open', assignee_slack_id: 'U_OFF', description: 'notifiche spente', due_date: '2026-09-10', created_at: '2026-09-01' },
  ], [
    { project_id: 'p1', dossier: { scadenze: [{ cosa: 'Evento Lucerna', quando: '2026-09-12', chi: 'Peppe', stato: 'aperta' }, { cosa: 'Fine stagione', quando: '2026-11-30' }, { cosa: 'fatta', quando: '2026-09-11', stato: 'fatta' }] } },
    { project_id: 'p2', dossier: { scadenze: [{ cosa: 'Bando', quando: '11/09/2026' }] } },
  ], [{ id: 'p1', name: 'Vinokilo', owner_slack_id: 'U_OWNER' }, { id: 'p2', name: 'Mandorle', owner_slack_id: null }]);
  var n = await fu.sendDueReminders(t.deps);
  assert.equal(n, 3);
  var byChannel = {};
  t.posted.forEach(function(p) { byChannel[p.channel] = p; });
  assert.match(byChannel.U1.text, /In scadenza[\s\S]*inviare documenti — entro 2026-09-11 _\(Vinokilo\)_/);
  assert.doesNotMatch(byChannel.U1.text, /troppo lontana/);
  assert.match(byChannel.U_OWNER.text, /\*Vinokilo\*: Evento Lucerna — 2026-09-12 \(Peppe\)/);
  assert.doesNotMatch(byChannel.U_OWNER.text, /Fine stagione|fatta/);
  assert.match(byChannel.U_ADMIN.text, /\*Mandorle\*: Bando — 2026-09-11/);
  assert.equal(byChannel.U_OFF, undefined);
  // seconda corsa: tutto già mandato → niente
  t.posted.length = 0;
  assert.equal(await fu.sendDueReminders(t.deps), 0);
});

test('morningDeadlinesSection: admin vede tutto, member solo i suoi', async function() {
  var t = makeDeps([
    { id: 'a1', status: 'open', assignee_slack_id: 'U1', description: 'mandare il report', due_date: '2026-09-15', created_at: '2026-09-01', project_id: 'p1' },
  ], [{ project_id: 'p1', dossier: { scadenze: [{ cosa: 'Evento Lucerna', quando: '2026-09-12' }] } }], [{ id: 'p1', name: 'Vinokilo', owner_slack_id: 'U_OWNER' }]);
  var admin = await fu.morningDeadlinesSection('U_ADMIN', Object.assign({ role: 'admin' }, t.deps));
  assert.match(admin, /2026-09-12 — \*Vinokilo\*: Evento Lucerna/);
  var member = await fu.morningDeadlinesSection('U1', Object.assign({ role: 'member' }, t.deps));
  assert.doesNotMatch(member, /Evento Lucerna/);
  assert.match(member, /2026-09-15 — tuo: mandare il report _\(Vinokilo\)_/);
  assert.equal(await fu.morningDeadlinesSection('U9', Object.assign({ role: 'member' }, t.deps)), null);
});

test('handleActionButton: done / ack / dismiss aggiornano lo stato', async function() {
  var t = makeDeps([], [], []);
  var msg = await fu.handleActionButton('project_actions_done', 'a1,a2', 'U1', t.deps);
  assert.match(msg, /fatto/);
  assert.equal(t.updates.length, 2);
  assert.equal(t.updates[0].fields.status, 'done');
  await fu.handleActionButton('project_actions_dismiss', 'a3', 'U1', t.deps);
  assert.equal(t.updates[2].fields.status, 'dismissed');
});
