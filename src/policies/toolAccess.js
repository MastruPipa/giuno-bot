// ─── Tool Access Policy ────────────────────────────────────────────────────────
// RBAC checks extracted from eseguiTool. Used by tool modules and the registry.

'use strict';

var rbac = require('../../rbac');

var checkPermission = rbac.checkPermission;
var getAccessDeniedMessage = rbac.getAccessDeniedMessage;

// Tools allowed for restricted users
var RESTRICTED_ALLOWED = [
  'list_events', 'find_event', 'recall_memory', 'save_memory', 'list_memories',
  'search_slack_messages', 'summarize_channel', 'summarize_thread', 'get_slack_users',
  'set_user_prefs', 'confirm_action', 'search_kb', 'ask_gemini',
  'get_pinned_messages', 'search_files', 'get_user_profile', 'list_usergroups',
  'get_reactions', 'list_emoji', 'set_reminder',
];

/**
 * checkToolAccess — returns null if access is granted, or an error object if denied.
 * @param {string} toolName
 * @param {object} input
 * @param {string} userRole
 * @returns {object|null} error object or null
 */
function checkToolAccess(toolName, input, userRole) {
  userRole = userRole || 'member';

  // Drive finance/contract RBAC
  if (toolName === 'search_drive' || toolName === 'read_doc') {
    var queryLow = ((input.query || '') + ' ' + (input.folder || '')).toLowerCase();
    if ((queryLow.includes('finance') || queryLow.includes('finanz') ||
         queryLow.includes('cassa') || queryLow.includes('fattur')) &&
        !checkPermission(userRole, 'view_drive_finance')) {
      return { error: getAccessDeniedMessage(userRole) };
    }
    if ((queryLow.includes('contratt') || queryLow.includes('contract')) &&
        !checkPermission(userRole, 'view_drive_contracts')) {
      return { error: getAccessDeniedMessage(userRole) };
    }
  }

  // Restricted role: only allowed tools
  if (userRole === 'restricted' && !RESTRICTED_ALLOWED.includes(toolName)) {
    return { error: getAccessDeniedMessage('restricted') };
  }

  return null; // access granted
}

module.exports = {
  checkToolAccess: checkToolAccess,
  RESTRICTED_ALLOWED: RESTRICTED_ALLOWED,
};
