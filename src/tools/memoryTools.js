// ─── Memory Tools ──────────────────────────────────────────────────────────────
// save_memory, recall_memory, list_memories, delete_memory

'use strict';

var db = require('../../supabase');
var rbac = require('../../rbac');

var checkPermission = rbac.checkPermission;

// ─── Tool definitions ──────────────────────────────────────────────────────────

var definitions = [
  {
    name: 'save_memory',
    description: 'Salva un\'informazione importante nella memoria permanente dell\'utente. Usalo PROATTIVAMENTE quando l\'utente dice qualcosa che vale la pena ricordare: preferenze clienti, decisioni prese, info di progetto, contatti, procedure.',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Informazione da ricordare' },
        tags:    { type: 'array', items: { type: 'string' }, description: 'Tag per categorizzare (es. "cliente", "progetto-x", "procedura", "contatto")' },
      },
      required: ['content'],
    },
  },
  {
    name: 'recall_memory',
    description: 'Cerca nella memoria permanente dell\'utente. Usalo SEMPRE prima di rispondere a domande su clienti, progetti, procedure, decisioni passate.',
    input_schema: {
      type: 'object',
      properties: {
        query:   { type: 'string', description: 'Testo o tag da cercare nella memoria' },
        user_id: { type: 'string', description: 'ID utente di cui cercare le memorie (solo admin/finance)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_memories',
    description: 'Elenca tutte le memorie dell\'utente, opzionalmente filtrate per tag.',
    input_schema: {
      type: 'object',
      properties: {
        tag:     { type: 'string', description: 'Filtra per tag specifico (opzionale)' },
        user_id: { type: 'string', description: 'ID utente (solo admin/finance)' },
      },
    },
  },
  {
    name: 'delete_memory',
    description: 'Cancella una memoria specifica per ID.',
    input_schema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: 'ID della memoria da cancellare' },
      },
      required: ['memory_id'],
    },
  },
];

// ─── Tool execution ────────────────────────────────────────────────────────────

async function execute(toolName, input, userId, userRole) {
  userRole = userRole || 'member';

  if (toolName === 'save_memory') {
    db.addMemory(userId, input.content, input.tags || []);
    return { success: true, message: 'Memorizzato.' };
  }

  if (toolName === 'recall_memory') {
    if (checkPermission(userRole, 'view_all_memories') && input.user_id) {
      var results = db.searchMemories(input.user_id, input.query);
      return { memories: results, count: results.length };
    }
    var results = db.searchMemories(userId, input.query);
    if (userRole === 'restricted') {
      results = results.filter(function(m) {
        return m.tags.some(function(t) { return (t || '').toLowerCase().includes('offkatania'); });
      });
    }
    return { memories: results, count: results.length };
  }

  if (toolName === 'list_memories') {
    var targetId = userId;
    if (checkPermission(userRole, 'view_all_memories') && input.user_id) {
      targetId = input.user_id;
    }
    var userMems = db.getMemCache()[targetId] || [];
    var filtered = input.tag
      ? userMems.filter(function(m) { return m.tags.some(function(t) { return t.toLowerCase().includes(input.tag.toLowerCase()); }); })
      : userMems;
    if (userRole === 'restricted') {
      filtered = filtered.filter(function(m) {
        return m.tags.some(function(t) { return (t || '').toLowerCase().includes('offkatania'); });
      });
    }
    return { memories: filtered, count: filtered.length };
  }

  if (toolName === 'delete_memory') {
    var deleted = await db.deleteMemory(userId, input.memory_id);
    return deleted ? { success: true } : { error: 'Memoria non trovata.' };
  }

  return { error: 'Tool sconosciuto nel modulo memoryTools: ' + toolName };
}

module.exports = { definitions: definitions, execute: execute };
