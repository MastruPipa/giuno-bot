// ─── Cron locks — distributed mutex for Railway multi-instance ───────────────
'use strict';

var c = require('./client');
var logger = require('../../utils/logger');

var INSTANCE_ID = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);

async function acquireCronLock(jobName, ttlMinutes) {
  if (!c.useSupabase) return true;
  ttlMinutes = ttlMinutes || 10;
  try {
    var expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
    var expired = await c.getClient().from('cron_locks').delete().eq('job_name', jobName).lt('expires_at', new Date().toISOString());
    if (expired.error) throw expired.error;
    var res = await c.getClient().from('cron_locks').insert({ job_name: jobName, locked_at: new Date().toISOString(), locked_by: INSTANCE_ID, expires_at: expiresAt });
    if (res.error) {
      if (res.error.code !== '23505') throw res.error;
      // Chi lo tiene e fino a quando: il 17/9 il promemoria delle 18:00 è
      // stato saltato per un lock di cui non si è saputo l'origine.
      var holder = '';
      try {
        var cur = await c.getClient().from('cron_locks').select('locked_by, locked_at, expires_at').eq('job_name', jobName).limit(1);
        var row = cur && cur.data && cur.data[0];
        if (row) holder = ' (tenuto da ' + row.locked_by + (row.locked_by === INSTANCE_ID ? ' = questa istanza' : '') + ' dalle ' + row.locked_at + ', scade ' + row.expires_at + ')';
      } catch(_) {}
      process.stdout.write('[CRON-LOCK] ' + jobName + ' già in esecuzione, skip.' + holder + '\n');
      return false;
    }
    process.stdout.write('[CRON-LOCK] Lock acquisito: ' + jobName + '\n');
    return true;
  } catch(e) {
    logger.error('[CRON-LOCK] Lock non disponibile:', e.message);
    throw e;
  }
}

async function releaseCronLock(jobName) {
  if (!c.useSupabase) return;
  try {
    await c.getClient().from('cron_locks').delete().eq('job_name', jobName).eq('locked_by', INSTANCE_ID);
  } catch(e) {
    logger.warn('[DB-CRON] release lock fallita:', e.message);
  }
}

module.exports = { acquireCronLock: acquireCronLock, releaseCronLock: releaseCronLock };
