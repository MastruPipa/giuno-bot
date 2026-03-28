// ─── Sheet Scanner Job ───────────────────────────────────────────────────────
// Scans registered Google Sheets, detects changes via MD5, generates AI summaries.
'use strict';

var crypto = require('crypto');
var dbClient = require('../services/db/client');
var logger = require('../utils/logger');
var { getSheetPerUtente } = require('../services/googleAuthService');

var CONFIG = {
  MODEL: 'claude-haiku-4-5-20251001',
  MAX_ROWS: 5000,
  DEFAULT_USER_ID: process.env.GIUNO_DEFAULT_USER_ID || process.env.ANTONIO_SLACK_ID || 'U052S2RT7B6',
};

function md5(text) {
  return crypto.createHash('md5').update(text || '').digest('hex');
}

function rowsToCSV(rows) {
  if (!rows || rows.length === 0) return '';
  return rows.map(function(row) {
    return (row || []).map(function(cell) { return String(cell || ''); }).join(',');
  }).join('\n');
}

async function readSheet(sheetsApi, spreadsheetId, sheetName) {
  try {
    var range = sheetName ? "'" + sheetName.replace(/'/g, "''") + "'!A1:Z" + CONFIG.MAX_ROWS : 'A1:Z' + CONFIG.MAX_ROWS;
    var res = await sheetsApi.spreadsheets.values.get({ spreadsheetId: spreadsheetId, range: range });
    return res.data.values || [];
  } catch(e) {
    logger.warn('[SHEET-SCAN] Read error:', e.message);
    return null;
  }
}

async function generateSummary(rows, displayName, category) {
  if (!rows || rows.length < 2) return null;
  var csv = rowsToCSV(rows).substring(0, 6000);
  try {
    var Anthropic = require('@anthropic-ai/sdk');
    var client = new Anthropic();
    var res = await client.messages.create({
      model: CONFIG.MODEL, max_tokens: 512,
      messages: [{ role: 'user', content:
        'Analizza questo Google Sheet di Katania Studio.\n' +
        'Nome: ' + displayName + (category ? ' | Categoria: ' + category : '') + '\n' +
        'Righe: ' + rows.length + '\n\n' +
        'DATI (CSV):\n' + csv + '\n\n' +
        'Rispondi JSON:\n' +
        '{"worth_saving":true,"summary":"2-4 frasi operative","key_facts":["fatto1","fatto2"],"data_type":"crm|finanza|gestionale|hr|altro"}\n' +
        'Se dati irrilevanti: {"worth_saving":false}'
      }],
    });
    var match = res.content[0].text.trim().replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch(e) {
    logger.warn('[SHEET-SCAN] AI summary error:', e.message);
    return null;
  }
}

async function scanSheet(supabase, sheetsApi, registryRow) {
  var rows = await readSheet(sheetsApi, registryRow.spreadsheet_id, registryRow.sheet_name);
  if (rows === null) return { status: 'error', error: 'read_failed' };
  if (rows.length < 2) return { status: 'skipped', reason: 'empty' };

  var csv = rowsToCSV(rows);
  var hash = md5(csv);

  // Change detection
  if (hash === registryRow.last_hash) {
    await supabase.from('sheet_scan_registry').update({ last_scanned_at: new Date().toISOString() }).eq('id', registryRow.id);
    return { status: 'unchanged' };
  }

  // Changed — generate summary
  var summary = await generateSummary(rows, registryRow.display_name, registryRow.category);
  if (!summary || !summary.worth_saving) {
    await supabase.from('sheet_scan_registry').update({ last_hash: hash, last_scanned_at: new Date().toISOString() }).eq('id', registryRow.id);
    return { status: 'scanned', updated: false };
  }

  // Save to KB
  var kbContent = '[SHEET] ' + registryRow.display_name + '\n' + summary.summary;
  if (summary.key_facts && summary.key_facts.length > 0) {
    kbContent += '\n' + summary.key_facts.map(function(f) { return '• ' + f; }).join('\n');
  }

  var kbId = 'kb_sheet_' + registryRow.id;
  try {
    await supabase.from('knowledge_base').upsert({
      id: kbId,
      content: kbContent,
      source_type: 'sheet_scan',
      confidence_score: 0.8,
      confidence_tier: 'drive_indexed',
      validation_status: 'approved',
      added_by: 'sheet_scanner',
      tags: [registryRow.display_name, registryRow.category, summary.data_type].filter(Boolean),
      created_at: new Date().toISOString(),
    }, { onConflict: 'id' });
  } catch(e) {
    logger.warn('[SHEET-SCAN] KB upsert error:', e.message);
  }

  // Update registry
  await supabase.from('sheet_scan_registry').update({
    last_hash: hash,
    last_scanned_at: new Date().toISOString(),
    last_summary: summary.summary,
    row_count: rows.length,
  }).eq('id', registryRow.id);

  return { status: 'updated', kbId: kbId };
}

async function runSheetScanner(options) {
  options = options || {};
  var supabase = dbClient.getClient();
  if (!supabase) { logger.error('[SHEET-SCAN] No Supabase'); return { scanned: 0, updated: 0, errors: 0 }; }

  var userId = options.userId || CONFIG.DEFAULT_USER_ID;
  var sheetsApi = getSheetPerUtente(userId);
  if (!sheetsApi) { logger.error('[SHEET-SCAN] No Sheets API for user:', userId); return { scanned: 0, updated: 0, errors: 0 }; }

  // Get registry
  var query = supabase.from('sheet_scan_registry').select('*').eq('is_active', true);
  if (!options.forceAll) {
    // Filter by frequency
    var now = new Date();
    var day = now.getDay(); // 0=sun
    // daily: always, weekly: only on monday, monthly: only on 1st
    query = query.or('scan_frequency.eq.daily,scan_frequency.eq.on_change');
    if (day === 1) query = query.or('scan_frequency.eq.weekly');
    if (now.getDate() === 1) query = query.or('scan_frequency.eq.monthly');
  }

  var { data: registry } = await query;
  if (!registry || registry.length === 0) { logger.info('[SHEET-SCAN] No sheets to scan'); return { scanned: 0, updated: 0, errors: 0 }; }

  logger.info('[SHEET-SCAN] Scanning', registry.length, 'sheets');
  var scanned = 0, updated = 0, errors = 0;

  for (var i = 0; i < registry.length; i++) {
    var row = registry[i];
    try {
      var result = await scanSheet(supabase, sheetsApi, row);
      scanned++;
      if (result.status === 'updated') updated++;
      if (result.status === 'error') errors++;
      logger.info('[SHEET-SCAN]', row.display_name, '→', result.status);
    } catch(e) {
      errors++;
      logger.error('[SHEET-SCAN] Error on', row.display_name, ':', e.message);
    }
    await new Promise(function(r) { setTimeout(r, 300); });
  }

  logger.info('[SHEET-SCAN] Done. Scanned:', scanned, '| Updated:', updated, '| Errors:', errors);
  return { scanned: scanned, updated: updated, errors: errors };
}

async function listRegistry() {
  var supabase = dbClient.getClient();
  if (!supabase) return [];
  var { data } = await supabase.from('sheet_scan_registry').select('id, display_name, scan_frequency, is_active, last_scanned_at, last_hash').order('display_name');
  return data || [];
}

module.exports = { runSheetScanner: runSheetScanner, listRegistry: listRegistry };
