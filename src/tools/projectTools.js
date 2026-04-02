// ─── Project Tools ──────────────────────────────────────────────────────────
// create_project, update_project, list_projects, get_project_details,
// allocate_resource, log_hours, get_team_workload
'use strict';

var db = require('../../supabase');
var logger = require('../utils/logger');

var definitions = [
  {
    name: 'create_project',
    description: 'Crea un nuovo progetto. Collegalo a un cliente/lead se disponibile. Solo admin e manager.',
    input_schema: {
      type: 'object',
      properties: {
        name:             { type: 'string', description: 'Nome del progetto' },
        client_name:      { type: 'string', description: 'Nome del cliente (opzionale)' },
        status:           { type: 'string', description: 'Stato: planning, active, on_hold, completed, cancelled (default: active)' },
        start_date:       { type: 'string', description: 'Data inizio YYYY-MM-DD (opzionale)' },
        end_date:         { type: 'string', description: 'Data fine YYYY-MM-DD (opzionale)' },
        budget_quoted:    { type: 'number', description: 'Budget preventivato in € (opzionale)' },
        service_category: { type: 'string', description: 'Categoria: branding, video, social, web, foto, design, campagna, evento, copy, content' },
        description:      { type: 'string', description: 'Descrizione breve del progetto' },
        owner_slack_id:   { type: 'string', description: 'Slack ID del responsabile (opzionale)' },
        deliverables:     { type: 'array', items: { type: 'string' }, description: 'Lista deliverable (opzionale)' },
        tags:             { type: 'array', items: { type: 'string' }, description: 'Tag progetto (opzionale)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_project',
    description: 'Aggiorna un progetto esistente. Cerca prima con list_projects per trovare l\'ID.',
    input_schema: {
      type: 'object',
      properties: {
        project_id:       { type: 'string', description: 'ID del progetto da aggiornare' },
        name:             { type: 'string', description: 'Nuovo nome (opzionale)' },
        status:           { type: 'string', description: 'Nuovo stato: planning, active, on_hold, completed, cancelled' },
        end_date:         { type: 'string', description: 'Nuova data fine YYYY-MM-DD' },
        budget_actual:    { type: 'number', description: 'Costo effettivo aggiornato in €' },
        description:      { type: 'string', description: 'Nuova descrizione' },
        deliverables:     { type: 'array', items: { type: 'string' }, description: 'Deliverable aggiornati' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'list_projects',
    description: 'Cerca e lista i progetti. Filtra per stato, cliente, responsabile, categoria. Senza filtri mostra tutti i progetti attivi.',
    input_schema: {
      type: 'object',
      properties: {
        status:           { type: 'string', description: 'Filtra per stato: planning, active, on_hold, completed, cancelled' },
        client_name:      { type: 'string', description: 'Filtra per nome cliente (ricerca parziale)' },
        owner_slack_id:   { type: 'string', description: 'Filtra per responsabile (Slack ID)' },
        service_category: { type: 'string', description: 'Filtra per categoria servizio' },
        name:             { type: 'string', description: 'Cerca per nome progetto (ricerca parziale)' },
        limit:            { type: 'number', description: 'Max risultati (default 20)' },
      },
    },
  },
  {
    name: 'get_project_details',
    description: 'Ottieni tutti i dettagli di un progetto specifico: info, budget, deliverable, team assegnato, ore allocate/lavorate.',
    input_schema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'ID del progetto' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'allocate_resource',
    description: 'Assegna una persona a un progetto con un ruolo e ore stimate. Solo admin e manager.',
    input_schema: {
      type: 'object',
      properties: {
        project_id:      { type: 'string', description: 'ID del progetto' },
        slack_user_id:   { type: 'string', description: 'Slack ID della persona da assegnare' },
        role:            { type: 'string', description: 'Ruolo nel progetto (es. designer, developer, PM, copy, social)' },
        hours_allocated: { type: 'number', description: 'Ore previste' },
        period_start:    { type: 'string', description: 'Inizio periodo YYYY-MM-DD (opzionale)' },
        period_end:      { type: 'string', description: 'Fine periodo YYYY-MM-DD (opzionale)' },
        notes:           { type: 'string', description: 'Note (opzionale)' },
      },
      required: ['project_id', 'slack_user_id'],
    },
  },
  {
    name: 'log_hours',
    description: 'Registra ore lavorate su un progetto. Aggiorna sia l\'allocazione che il budget actual del progetto.',
    input_schema: {
      type: 'object',
      properties: {
        project_id:    { type: 'string', description: 'ID del progetto' },
        slack_user_id: { type: 'string', description: 'Slack ID di chi ha lavorato (default: utente corrente)' },
        hours:         { type: 'number', description: 'Ore da registrare' },
        notes:         { type: 'string', description: 'Cosa è stato fatto (opzionale)' },
      },
      required: ['project_id', 'hours'],
    },
  },
  {
    name: 'get_team_workload',
    description: 'Mostra il carico di lavoro del team: chi sta lavorando su cosa, ore allocate vs lavorate per ogni persona. Utile per capacity planning.',
    input_schema: {
      type: 'object',
      properties: {
        slack_user_id: { type: 'string', description: 'Filtra per una persona specifica (opzionale, default: tutto il team)' },
      },
    },
  },
];

// ─── Tool execution ──────────────────────────────────────────────────────────

async function execute(toolName, input, userId, userRole) {
  input = input || {};

  if (toolName === 'create_project') {
    if (userRole !== 'admin' && userRole !== 'manager' && userRole !== 'finance') {
      return { error: 'Solo admin, manager e finance possono creare progetti.' };
    }
    var project = await db.createProject(input);
    if (!project) return { error: 'Errore nella creazione del progetto.' };
    return { success: true, project: project };
  }

  if (toolName === 'update_project') {
    if (!input.project_id) return { error: 'ID progetto mancante.' };
    var updates = {};
    if (input.name) updates.name = input.name;
    if (input.status) updates.status = input.status;
    if (input.end_date) updates.end_date = input.end_date;
    if (input.budget_actual !== undefined) updates.budget_actual = input.budget_actual;
    if (input.description) updates.description = input.description;
    if (input.deliverables) updates.deliverables = input.deliverables;
    var updated = await db.updateProject(input.project_id, updates);
    if (!updated) return { error: 'Progetto non trovato o errore aggiornamento.' };
    return { success: true, project: updated };
  }

  if (toolName === 'list_projects') {
    var filters = {};
    if (input.status) filters.status = input.status;
    else filters.status = 'active'; // default: solo attivi
    if (input.client_name) filters.client_name = input.client_name;
    if (input.owner_slack_id) filters.owner_slack_id = input.owner_slack_id;
    if (input.service_category) filters.service_category = input.service_category;
    if (input.name) filters.name = input.name;
    if (input.limit) filters.limit = input.limit;
    // If user explicitly asks for all statuses
    if (input.status === 'all' || input.status === 'tutti') delete filters.status;
    var projects = await db.searchProjects(filters);
    return { projects: projects, count: projects.length };
  }

  if (toolName === 'get_project_details') {
    if (!input.project_id) return { error: 'ID progetto mancante.' };
    var project = await db.getProject(input.project_id);
    if (!project) return { error: 'Progetto non trovato.' };
    var allocations = await db.getProjectAllocations(input.project_id);
    var totalAllocated = 0, totalLogged = 0;
    allocations.forEach(function(a) {
      totalAllocated += parseFloat(a.hours_allocated) || 0;
      totalLogged += parseFloat(a.hours_logged) || 0;
    });
    return {
      project: project,
      team: allocations,
      summary: {
        total_hours_allocated: totalAllocated,
        total_hours_logged: totalLogged,
        budget_remaining: project.budget_quoted ? (parseFloat(project.budget_quoted) - parseFloat(project.budget_actual || 0)) : null,
        completion_pct: totalAllocated > 0 ? Math.round((totalLogged / totalAllocated) * 100) : null,
      },
    };
  }

  if (toolName === 'allocate_resource') {
    if (userRole !== 'admin' && userRole !== 'manager' && userRole !== 'finance') {
      return { error: 'Solo admin, manager e finance possono assegnare risorse.' };
    }
    if (!input.project_id || !input.slack_user_id) return { error: 'project_id e slack_user_id sono obbligatori.' };
    var alloc = await db.allocateResource(input);
    if (!alloc) return { error: 'Errore nell\'assegnazione.' };
    return { success: true, allocation: alloc };
  }

  if (toolName === 'log_hours') {
    if (!input.project_id || !input.hours) return { error: 'project_id e hours sono obbligatori.' };
    var logUserId = input.slack_user_id || userId;
    // Find existing allocation for this user on this project
    var allocs = await db.getProjectAllocations(input.project_id);
    var userAlloc = allocs.find(function(a) { return a.slack_user_id === logUserId; });
    if (userAlloc) {
      var newLogged = (parseFloat(userAlloc.hours_logged) || 0) + input.hours;
      await db.updateAllocation(userAlloc.id, { hours_logged: newLogged, notes: input.notes || userAlloc.notes });
    } else {
      // Create allocation on the fly
      await db.allocateResource({
        project_id: input.project_id,
        slack_user_id: logUserId,
        role: 'contributor',
        hours_allocated: input.hours,
        hours_logged: input.hours,
        notes: input.notes || null,
      });
    }
    // Update project budget_actual (approximate: hours * avg rate)
    var proj = await db.getProject(input.project_id);
    if (proj) {
      var newActual = (parseFloat(proj.budget_actual) || 0) + (input.hours * 45); // €45/h default rate
      await db.updateProject(input.project_id, { budget_actual: newActual });
    }
    return { success: true, hours_logged: input.hours, user: logUserId, project: input.project_id };
  }

  if (toolName === 'get_team_workload') {
    if (input.slack_user_id) {
      var userAllocs = await db.getUserAllocations(input.slack_user_id);
      return { user: input.slack_user_id, allocations: userAllocs, count: userAllocs.length };
    }
    var workload = await db.getTeamWorkload();
    return { team: workload, count: workload.length };
  }

  return { error: 'Tool sconosciuto nel modulo projectTools: ' + toolName };
}

module.exports = { definitions: definitions, execute: execute };
