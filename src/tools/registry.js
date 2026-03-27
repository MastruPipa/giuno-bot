// ─── Tool Registry ─────────────────────────────────────────────────────────────
// Imports all tool modules and provides:
//   getAllTools()        — flat array of all tool definitions
//   getToolsForAgent()  — subset of tools for a named agent
//   executeToolCall()   — dispatch + RBAC + critical action confirmation

'use strict';

var logger = require('../utils/logger');
var { checkToolAccess } = require('../policies/toolAccess');
var { askGemini } = require('../services/geminiService');

// ─── Import all tool modules ───────────────────────────────────────────────────

var slackTools    = require('./slackTools');
var gmailTools    = require('./gmailTools');
var calendarTools = require('./calendarTools');
var driveTools    = require('./driveTools');
var memoryTools   = require('./memoryTools');
var profileTools  = require('./profileTools');
var kbTools       = require('./kbTools');
var sheetsTools   = require('./sheetsTools');
var leadsTools    = require('./leadsTools');
var quotesTools   = require('./quotesTools');
var webTools      = require('./webTools');
var suppliersTools = require('./suppliersTools');

var ALL_MODULES = [
  slackTools,
  gmailTools,
  calendarTools,
  driveTools,
  memoryTools,
  profileTools,
  kbTools,
  sheetsTools,
  quotesTools,
  leadsTools,
  webTools,
  suppliersTools,
];

// ─── Critical action confirmation ─────────────────────────────────────────────

var AZIONI_CRITICHE = ['send_email', 'reply_email', 'forward_email', 'create_event', 'delete_event', 'share_file', 'write_sheet'];
var confermeInAttesa = new Map(); // actionId -> { toolName, input, userId, created }
var catalogaConfirm  = new Map(); // cataloga_confirm_userId -> { files, userId, channelId, rateCard }

// ─── getAllTools ───────────────────────────────────────────────────────────────

function getAllTools() {
  var all = [];
  ALL_MODULES.forEach(function(mod) {
    if (mod.definitions) {
      all = all.concat(mod.definitions);
    }
  });
  return all;
}

// ─── getToolsForAgent ─────────────────────────────────────────────────────────

var AGENT_TOOL_SETS = {
  threadSummary: ['summarize_thread', 'summarize_channel', 'read_channel', 'search_slack_messages', 'recall_memory', 'get_channel_map'],
  dailyDigest:   ['list_events', 'find_emails', 'recall_memory', 'search_kb', 'search_slack_messages', 'summarize_channel', 'list_channels'],
  clientRetrieval: ['recall_memory', 'search_kb', 'search_leads', 'query_leads_db', 'search_suppliers', 'get_supplier', 'search_drive', 'browse_folder', 'search_in_shared_drive', 'list_shared_drives', 'read_channel', 'search_slack_messages', 'search_everywhere', 'ask_gemini', 'list_channels', 'summarize_channel', 'get_pinned_messages'],
  crmUpdate: ['search_leads', 'update_lead', 'create_lead', 'recall_memory'],
  general: null, // null means all tools
};

function getToolsForAgent(agentName) {
  var toolNames = AGENT_TOOL_SETS[agentName];
  if (!toolNames) return getAllTools();
  var all = getAllTools();
  return all.filter(function(t) { return toolNames.includes(t.name); });
}

// ─── Build module dispatch map ─────────────────────────────────────────────────

var _moduleByTool = {};
ALL_MODULES.forEach(function(mod) {
  if (mod.definitions) {
    mod.definitions.forEach(function(def) {
      _moduleByTool[def.name] = mod;
    });
  }
});

// ─── executeToolCall ──────────────────────────────────────────────────────────

async function executeToolCall(toolName, input, userId, userRole) {
  userRole = userRole || 'member';

  // ── RBAC access check ────────────────────────────────────────────────────────
  var accessError = checkToolAccess(toolName, input, userRole);
  if (accessError) return accessError;

  // ── confirm_action: execute pending critical action ──────────────────────────
  if (toolName === 'confirm_action') {
    var actionId = input.action_id;
    var pending = confermeInAttesa.get(actionId);
    if (!pending) return { error: 'Nessuna azione in attesa con questo ID. L\'azione potrebbe essere scaduta.' };
    confermeInAttesa.delete(actionId);
    logger.info('[CONFIRM]', pending.toolName, 'confermato da', userId);
    return await executeToolCall(pending.toolName, pending.input, userId, userRole);
  }

  // ── Intercept critical actions → require confirmation ────────────────────────
  if (AZIONI_CRITICHE.includes(toolName)) {
    var actionId = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    confermeInAttesa.set(actionId, { toolName: toolName, input: input, userId: userId, created: Date.now() });
    // Purge stale confirmations
    var now = Date.now();
    confermeInAttesa.forEach(function(v, k) { if (now - v.created > 600000) confermeInAttesa.delete(k); });

    var preview = { requires_confirmation: true, action_id: actionId, action: toolName };

    if (toolName === 'send_email') {
      preview.preview = 'INVIO EMAIL:\nA: ' + input.to + (input.cc ? '\nCc: ' + input.cc : '') + '\nOggetto: ' + input.subject + '\n\n' + (input.body || '').substring(0, 500);
    } else if (toolName === 'reply_email') {
      preview.preview = 'RISPOSTA EMAIL:\nID messaggio: ' + input.message_id + '\n\n' + (input.body || '').substring(0, 500);
    } else if (toolName === 'forward_email') {
      preview.preview = 'INOLTRO EMAIL:\nA: ' + input.to + '\nNota: ' + (input.note || 'nessuna');
    } else if (toolName === 'create_event') {
      preview.preview = 'CREAZIONE EVENTO:\nTitolo: ' + input.title + '\nInizio: ' + input.start + '\nFine: ' + input.end + (input.attendees ? '\nPartecipanti: ' + input.attendees : '');
    } else if (toolName === 'delete_event') {
      preview.preview = 'ELIMINAZIONE EVENTO:\nID: ' + input.event_id;
    } else if (toolName === 'share_file') {
      preview.preview = 'CONDIVISIONE FILE:\nFile: ' + input.file_id + '\nCon: ' + input.email + '\nRuolo: ' + (input.role || 'reader');
    } else if (toolName === 'write_sheet') {
      var rowCount = (input.values || []).length;
      var previewRows = (input.values || []).slice(0, 3).map(function(r) { return (r || []).join(' | '); }).join('\n');
      preview.preview = 'SCRITTURA GOOGLE SHEET:\nSheet: ' + input.sheet_id + '\nRange: ' + input.range + '\nRighe: ' + rowCount + '\n\nAnteprima:\n' + previewRows;
      // Gemini review on data to be written
      var geminiNote = await sheetsTools.reviewWriteSheet(input);
      if (geminiNote) preview.gemini_note = geminiNote;
    }
    return preview;
  }

  // ── Dispatch to module ───────────────────────────────────────────────────────
  var mod = _moduleByTool[toolName];
  if (!mod) return { error: 'Tool sconosciuto: ' + toolName };

  return await mod.execute(toolName, input, userId, userRole);
}

module.exports = {
  getAllTools: getAllTools,
  getToolsForAgent: getToolsForAgent,
  executeToolCall: executeToolCall,
  confermeInAttesa: confermeInAttesa,
  catalogaConfirm: catalogaConfirm,
  AZIONI_CRITICHE: AZIONI_CRITICHE,
};
