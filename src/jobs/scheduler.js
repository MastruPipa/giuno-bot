// ─── Scheduler — registro dei cron ───────────────────────────────────────────
// Giuno ha ~45 job schedulati sparsi in quattro file, alcuni con lock
// distribuito e altri no, e fino a oggi nessun posto dove vedere "cosa gira,
// quando, com'è andata l'ultima volta". Questo modulo è un proxy di node-cron:
// stessa firma schedule(expr, fn, opts) così i chiamanti non cambiano, ma ogni
// job viene registrato con nome, espressione, lock, ultimo esito, durata ed
// errori, e non parte se la corsa precedente è ancora in esecuzione.
//
// opts.name    → nome leggibile (altrimenti derivato da funzione/espressione)
// opts.lock    → nome del lock distribuito già gestito dal job (informativo:
//                il lock resta responsabilità di lockedJob/acquireCronLock)
// opts.lockTtl → minuti: lo scheduler acquisisce LUI il lock distribuito con
//                il nome del job prima di eseguirlo e lo rilascia dopo. Serve
//                ai job che inviano messaggi ma non avevano un lock: durante un
//                redeploy Railway due istanze convivono e partivano doppi.
// fn._lockName → impostato da lockedJob, letto qui per il registro

'use strict';

var nodeCron = require('node-cron');
var logger = require('../utils/logger');

var _jobs = [];
var _counter = 0;

function _autoName(expr, fn) {
  if (fn && fn.name && fn.name !== 'anonymous') return fn.name;
  return 'job' + (++_counter) + ' (' + expr + ')';
}

function schedule(expr, fn, opts) {
  opts = opts || {};
  var job = {
    name: opts.name || _autoName(expr, fn),
    expr: expr,
    timezone: opts.timezone || null,
    lock: opts.lock || (fn && fn._lockName) || (opts.lockTtl ? (opts.name || null) : null),
    lockTtl: opts.lockTtl || null,
    runs: 0,
    failures: 0,
    skippedOverlap: 0,
    running: false,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastDurationMs: null,
    lastError: null,
  };

  var wrapped = async function() {
    if (job.running) {
      job.skippedOverlap++;
      logger.warn('[CRON:' + job.name + '] corsa precedente ancora in esecuzione, salto');
      return;
    }
    // Reserve locally before waiting for the distributed lock.
    job.running = true;
    var cronLocks = null;
    var t0 = Date.now();
    try {
      if (job.lockTtl) {
        var locks = require('../services/db/cron');
        var got = await locks.acquireCronLock(job.name, job.lockTtl);
        if (!got) { job.skippedLock = (job.skippedLock || 0) + 1; return; }
        cronLocks = locks;
      }
      job.runs++;
      job.lastStartedAt = new Date().toISOString();
      await fn();
      job.lastError = null;
    } catch(e) {
      job.failures++;
      job.lastError = (e && e.message) || String(e);
      logger.error('[CRON:' + job.name + '] Errore:', job.lastError);
    } finally {
      job.running = false;
      job.lastFinishedAt = new Date().toISOString();
      job.lastDurationMs = Date.now() - t0;
      if (cronLocks) { try { await cronLocks.releaseCronLock(job.name); } catch(_) {} }
    }
  };

  var cronOpts = {};
  if (opts.timezone) cronOpts.timezone = opts.timezone;
  job.task = nodeCron.schedule(expr, wrapped, cronOpts);
  _jobs.push(job);
  return job.task;
}

function listJobs() {
  return _jobs.map(function(j) {
    return {
      name: j.name, expr: j.expr, timezone: j.timezone, lock: j.lock,
      runs: j.runs, failures: j.failures, skippedOverlap: j.skippedOverlap, skippedLock: j.skippedLock || 0, running: j.running,
      lastStartedAt: j.lastStartedAt, lastFinishedAt: j.lastFinishedAt,
      lastDurationMs: j.lastDurationMs, lastError: j.lastError,
    };
  });
}

function _ago(iso) {
  if (!iso) return 'mai';
  var m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'adesso';
  if (m < 60) return m + ' min fa';
  var h = Math.round(m / 60);
  if (h < 48) return h + ' h fa';
  return Math.round(h / 24) + ' g fa';
}

// Report leggibile per Slack: una riga per job, errori in evidenza.
function formatReport() {
  var jobs = listJobs();
  if (jobs.length === 0) return 'Nessun cron registrato.';
  var lines = ['*Cron registrati: ' + jobs.length + '*'];
  var withErrors = jobs.filter(function(j) { return j.lastError; });
  if (withErrors.length) {
    lines.push('\n*Con errori all\'ultima corsa (' + withErrors.length + '):*');
    withErrors.forEach(function(j) {
      lines.push('• ' + j.name + ' — ' + _ago(j.lastFinishedAt) + ': ' + String(j.lastError).substring(0, 120));
    });
  }
  lines.push('\n*Tutti:*');
  jobs.forEach(function(j) {
    var status = j.running ? '⏳' : (j.lastError ? '❌' : (j.runs > 0 ? '✅' : '·'));
    var extra = [];
    if (j.lock) extra.push('lock');
    if (j.skippedOverlap) extra.push('sovrapposizioni saltate: ' + j.skippedOverlap);
    lines.push(status + ' `' + j.expr + '` ' + j.name + ' — ultimo: ' + _ago(j.lastFinishedAt) +
      (j.lastDurationMs != null ? ' (' + Math.round(j.lastDurationMs / 1000) + 's)' : '') +
      ' · corse ' + j.runs + (j.failures ? ', errori ' + j.failures : '') +
      (extra.length ? ' · ' + extra.join(', ') : ''));
  });
  return lines.join('\n');
}

function _resetForTests() { _jobs = []; _counter = 0; }

module.exports = { schedule: schedule, listJobs: listJobs, formatReport: formatReport, _resetForTests: _resetForTests };
