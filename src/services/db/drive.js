// ─── Drive index ─────────────────────────────────────────────────────────────
'use strict';

var c = require('./client');

var _driveCache = null;

async function loadDriveIndex() {
  if (!c.useSupabase) { _driveCache = c.readJSON('drive_index.json', {}); return _driveCache; }
  try {
    var res = await c.getClient().from('drive_index').select('*');
    var idx = {};
    if (res.data) res.data.forEach(function(r) {
      if (!idx[r.slack_user_id]) idx[r.slack_user_id] = {};
      idx[r.slack_user_id][r.file_id] = {
        name: r.name, type: r.type, link: r.link, modified: r.modified,
        owner: r.owner, description: r.description, indexed: r.indexed_at,
      };
    });
    _driveCache = idx;
    return idx;
  } catch(e) { c.logErr('loadDriveIndex', e); _driveCache = {}; return {}; }
}

async function saveDriveFiles(slackUserId, files) {
  if (!_driveCache) _driveCache = {};
  if (!_driveCache[slackUserId]) _driveCache[slackUserId] = {};
  var rows = [];
  files.forEach(function(f) {
    var entry = {
      name: f.name, type: f.mimeType, link: f.webViewLink, modified: f.modifiedTime,
      owner: (f.owners && f.owners[0]) ? f.owners[0].emailAddress : null,
      description: f.description || null, indexed: new Date().toISOString(),
    };
    _driveCache[slackUserId][f.id] = entry;
    rows.push({ slack_user_id: slackUserId, file_id: f.id, name: entry.name, type: entry.type, link: entry.link, modified: entry.modified, owner: entry.owner, description: entry.description, indexed_at: entry.indexed });
  });
  if (!c.useSupabase) { c.writeJSON('drive_index.json', _driveCache); return; }
  try { await c.getClient().from('drive_index').upsert(rows); } catch(e) { c.logErr('saveDriveFiles', e); }
}

function getDriveCache() { return _driveCache || {}; }

module.exports = { loadDriveIndex: loadDriveIndex, saveDriveFiles: saveDriveFiles, getDriveCache: getDriveCache };
