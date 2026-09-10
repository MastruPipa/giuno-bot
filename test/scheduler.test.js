'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');

// Stub di node-cron: cattura la funzione schedulata per lanciarla a mano.
var Module = require('module');
var cronPath = require.resolve('node-cron');
var stub = new Module(cronPath);
stub.filename = cronPath; stub.loaded = true;
var scheduled = [];
stub.exports = { schedule: function(expr, fn, opts) { var t = { expr: expr, fn: fn, opts: opts }; scheduled.push(t); return t; } };
require.cache[cronPath] = stub;

var lockCalls = [];
var lockPath = require.resolve('../src/services/db/cron');
var lockStub = new Module(lockPath);
lockStub.filename = lockPath; lockStub.loaded = true;
lockStub.exports = {
  acquireCronLock: async function(name, ttl) { lockCalls.push(['acquire', name, ttl]); return name !== 'occupato'; },
  releaseCronLock: async function(name) { lockCalls.push(['release', name]); },
};
require.cache[lockPath] = lockStub;

var scheduler = require('../src/jobs/scheduler');

test('schedule: registra il job con nome, lock e timezone', function() {
  scheduler._resetForTests(); scheduled = [];
  function inviaRoutine() {}
  inviaRoutine._lockName = 'routine';
  scheduler.schedule('30 8 * * 1-5', inviaRoutine, { timezone: 'Europe/Rome' });
  scheduler.schedule('0 * * * *', function() {}, { name: 'orario' });
  var jobs = scheduler.listJobs();
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].name, 'inviaRoutine');
  assert.equal(jobs[0].lock, 'routine');
  assert.equal(jobs[0].timezone, 'Europe/Rome');
  assert.equal(jobs[1].name, 'orario');
  assert.equal(scheduled[0].opts.timezone, 'Europe/Rome');
});

test('run: registra esito, durata, errori e salta le sovrapposizioni', async function() {
  scheduler._resetForTests(); scheduled = [];
  var release;
  var gate = new Promise(function(r) { release = r; });
  scheduler.schedule('* * * * *', async function() { await gate; }, { name: 'lento' });
  scheduler.schedule('* * * * *', async function() { throw new Error('boom'); }, { name: 'rotto' });

  var p1 = scheduled[0].fn();
  var p2 = scheduled[0].fn(); // sovrapposta
  await p2;
  var slow = scheduler.listJobs()[0];
  assert.equal(slow.running, true);
  assert.equal(slow.skippedOverlap, 1);
  release(); await p1;
  slow = scheduler.listJobs()[0];
  assert.equal(slow.running, false);
  assert.equal(slow.runs, 1);
  assert.equal(slow.lastError, null);
  assert.ok(slow.lastDurationMs >= 0);

  await scheduled[1].fn();
  var broken = scheduler.listJobs()[1];
  assert.equal(broken.failures, 1);
  assert.equal(broken.lastError, 'boom');

  var report = scheduler.formatReport();
  assert.match(report, /Cron registrati: 2/);
  assert.match(report, /Con errori all'ultima corsa \(1\)/);
  assert.match(report, /❌ `\* \* \* \* \*` rotto/);
});

test('lockTtl: lo scheduler acquisisce e rilascia il lock col nome del job', async function() {
  scheduler._resetForTests(); scheduled = []; lockCalls = [];
  var ran = 0;
  scheduler.schedule('0 9 * * *', async function() { ran++; }, { name: 'invio', lockTtl: 30 });
  scheduler.schedule('0 9 * * *', async function() { ran++; }, { name: 'occupato', lockTtl: 30 });
  await scheduled[0].fn();
  await scheduled[1].fn();
  assert.equal(ran, 1, 'il job con lock già preso non parte');
  assert.deepEqual(lockCalls, [['acquire', 'invio', 30], ['release', 'invio'], ['acquire', 'occupato', 30]]);
  var jobs = scheduler.listJobs();
  assert.equal(jobs[0].lock, 'invio');
  assert.equal(jobs[1].skippedLock, 1);
});
