// ─── Cron locks — distributed mutex for Railway multi-instance ───────────────
'use strict';

var c = require('./client');

var INSTANCE_ID = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);

async function acquireCronLock(jobName, ttlMinutes) {
  if (!c.useSupabase) return true;
  ttlMinutes = ttlMinutes || 10;
  try {
    var expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
    await c.getClient().from('cron_locks').delete().eq('job_name', jobName).lt('expires_at', new Date().toISOString());
    var res = await c.getClient().from('cron_locks').insert({ job_name: jobName, locked_at: new Date().toISOString(), locked_by: INSTANCE_ID, expires_at: expiresAt });
    if (res.error) {
      process.stdout.write('[CRON-LOCK] ' + jobName + ' già in esecuzione, skip.\n');
      return false;
    }
    process.stdout.write('[CRON-LOCK] Lock acquisito: ' + jobName + '\n');
    return true;
  } catch(e) {
    process.stdout.write('[CRON-LOCK] Errore (procedo): ' + e.message + '\n');
    return true;
  }
}

async function releaseCronLock(jobName) {
  if (!c.useSupabase) return;
  try { await c.getClient().from('cron_locks').delete().eq('job_name', jobName).eq('locked_by', INSTANCE_ID); } catch(e) {}
}

module.exports = { acquireCronLock: acquireCronLock, releaseCronLock: releaseCronLock };
