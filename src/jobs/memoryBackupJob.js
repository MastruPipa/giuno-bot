// ─── Memory Backup to Drive ──────────────────────────────────────────────────
// Weekly snapshot of memories, user_facts, conversation_summaries and KB
// entries written as a single JSON file into the admin's Drive. Keep the
// last 4 weekly backups, older ones are deleted.
//
// Also exposed via exportForUser(userId) for on-demand personal export
// ("mostrami tutto quello che sai di me").

'use strict';

var { Readable } = require('stream');
var logger = require('../utils/logger');
var db = require('../../supabase');
var { acquireCronLock, releaseCronLock } = require('../../supabase');
var { getDrivePerUtente } = require('../services/googleAuthService');

var BACKUP_FOLDER_NAME = 'Giuno Memory Backups';
var BACKUP_ADMIN_USER_ID = process.env.MEMORY_BACKUP_ADMIN_USER_ID || null;
var KEEP_WEEKLY = 4;

async function collectSnapshot(options) {
  options = options || {};
  var supabase = db.getClient && db.getClient();
  if (!supabase) throw new Error('Supabase not configured');

  var userFilter = options.userId ? { slack_user_id: options.userId } : null;

  // memories
  var memQuery = supabase.from('memories')
    .select('id, slack_user_id, content, tags, memory_type, confidence_score, created_at, thread_ts, source_channel_id, source_channel_type')
    .order('created_at', { ascending: false })
    .limit(options.maxRows || 5000);
  if (userFilter) memQuery = memQuery.eq('slack_user_id', userFilter.slack_user_id);
  var memRes = await memQuery;

  // user_facts
  var factsQuery = supabase.from('user_facts')
    .select('slack_user_id, category, fact, confidence, last_confirmed_at, created_at')
    .order('last_confirmed_at', { ascending: false })
    .limit(options.maxRows || 2000);
  if (userFilter) factsQuery = factsQuery.eq('slack_user_id', userFilter.slack_user_id);
  var factsRes = await factsQuery;

  // conversation_summaries
  var sumQuery = supabase.from('conversation_summaries')
    .select('conv_key, summary, messages_count, topics, proposed_actions, updated_at')
    .order('updated_at', { ascending: false })
    .limit(options.maxRows || 2000);
  if (userFilter) sumQuery = sumQuery.like('conv_key', userFilter.slack_user_id + '%');
  var sumRes = await sumQuery;

  var kb = null;
  if (!userFilter) {
    var kbRes = await supabase.from('knowledge_base')
      .select('id, content, tags, confidence_tier, confidence_score, source_type, source_channel_type, created_at')
      .order('created_at', { ascending: false })
      .limit(options.maxRows || 5000);
    kb = kbRes.data || [];
  }

  return {
    generated_at: new Date().toISOString(),
    scope: userFilter ? 'user' : 'global',
    scope_user_id: userFilter ? userFilter.slack_user_id : null,
    memories: memRes.data || [],
    user_facts: factsRes.data || [],
    conversation_summaries: sumRes.data || [],
    knowledge_base: kb,
  };
}

async function findOrCreateFolder(drive) {
  var search = await drive.files.list({
    q: "mimeType='application/vnd.google-apps.folder' and name='" + BACKUP_FOLDER_NAME.replace(/'/g, "\\'") + "' and trashed=false",
    fields: 'files(id, name)',
    spaces: 'drive',
  });
  if (search.data.files && search.data.files.length > 0) return search.data.files[0].id;

  var created = await drive.files.create({
    requestBody: { name: BACKUP_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id',
  });
  return created.data.id;
}

async function pruneOldBackups(drive, folderId) {
  var r = await drive.files.list({
    q: "'" + folderId + "' in parents and trashed=false and name contains 'giuno-memory-'",
    fields: 'files(id, name, createdTime)',
    orderBy: 'createdTime desc',
    pageSize: 50,
  });
  var files = (r.data.files || []).filter(function(f) { return !f.name.includes('-user-'); });
  if (files.length <= KEEP_WEEKLY) return 0;
  var toDelete = files.slice(KEEP_WEEKLY);
  var deleted = 0;
  for (var i = 0; i < toDelete.length; i++) {
    try { await drive.files.delete({ fileId: toDelete[i].id }); deleted++; } catch(e) { /* ignore */ }
  }
  return deleted;
}

async function uploadBackup(drive, folderId, payload, filename) {
  var json = JSON.stringify(payload, null, 2);
  var stream = Readable.from([json]);
  var created = await drive.files.create({
    requestBody: { name: filename, parents: [folderId], mimeType: 'application/json' },
    media: { mimeType: 'application/json', body: stream },
    fields: 'id, webViewLink',
  });
  return created.data;
}

async function runWeeklyBackup() {
  var locked = await acquireCronLock('memory_backup_weekly', 20);
  if (!locked) return;
  try {
    if (!BACKUP_ADMIN_USER_ID) {
      logger.warn('[MEM-BACKUP] MEMORY_BACKUP_ADMIN_USER_ID non configurato, skip.');
      return;
    }
    var drive = getDrivePerUtente(BACKUP_ADMIN_USER_ID);
    if (!drive) {
      logger.warn('[MEM-BACKUP] Drive non disponibile per admin', BACKUP_ADMIN_USER_ID);
      return;
    }
    var folderId = await findOrCreateFolder(drive);
    var snapshot = await collectSnapshot({});
    var stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    var filename = 'giuno-memory-' + stamp + '.json';
    var file = await uploadBackup(drive, folderId, snapshot, filename);
    var pruned = await pruneOldBackups(drive, folderId);
    logger.info('[MEM-BACKUP] Backup caricato:', filename,
      '| rows mem:', snapshot.memories.length,
      '| facts:', snapshot.user_facts.length,
      '| summaries:', snapshot.conversation_summaries.length,
      '| kb:', (snapshot.knowledge_base || []).length,
      '| pruned:', pruned);
    return { fileId: file.id, link: file.webViewLink };
  } catch(e) {
    logger.error('[MEM-BACKUP] Errore:', e.message);
  } finally { await releaseCronLock('memory_backup_weekly'); }
}

// On-demand: export everything we know about a specific user to THAT user's
// Drive (so they own their data). Returns the file link for Slack reply.
async function exportForUser(slackUserId) {
  var drive = getDrivePerUtente(slackUserId);
  if (!drive) throw new Error('Collega il tuo Google per poter fare l\'export.');
  var folderId = await findOrCreateFolder(drive);
  var snapshot = await collectSnapshot({ userId: slackUserId });
  var stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  var filename = 'giuno-memory-user-' + slackUserId + '-' + stamp + '.json';
  var file = await uploadBackup(drive, folderId, snapshot, filename);
  return {
    fileId: file.id,
    link: file.webViewLink,
    rows: {
      memories: snapshot.memories.length,
      facts: snapshot.user_facts.length,
      summaries: snapshot.conversation_summaries.length,
    },
  };
}

module.exports = {
  runWeeklyBackup: runWeeklyBackup,
  exportForUser: exportForUser,
  collectSnapshot: collectSnapshot,
};
