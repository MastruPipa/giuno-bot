// ─── Project Tools ──────────────────────────────────────────────────────────
// create_project, update_project, list_projects, get_project_details,
// allocate_resource, log_hours, get_team_workload
'use strict';

var db = require('../../supabase');
var logger = require('../utils/logger');

var definitions = [
  {
    name: 'get_project_dossier',
    description: 'Scheda (dossier) aggiornata di un progetto: stato, scadenze, rischi, prossimi passi, decisioni, team, referenti. ' +
      'Usa per "a che punto è X", "scheda/dossier di X", "cosa sappiamo del progetto X", "scadenze di X". Se non esiste, proponi refresh_project_dossier.',
    input_schema: { type: 'object', properties: { project_name: { type: 'string', description: 'Nome del progetto o del cliente' } }, required: ['project_name'] },
  },
  {
    name: 'refresh_project_dossier',
    description: 'Ricostruisce ORA la scheda di un progetto da kick-off, recap delle call, canale Slack, ore e allocazioni. Richiede qualche secondo. Solo admin, manager, finance.',
    input_schema: { type: 'object', properties: { project_name: { type: 'string', description: 'Nome del progetto' } }, required: ['project_name'] },
  },
  {
    name: 'list_project_dossiers',
    description: 'Elenco dei progetti con scheda (dossier) disponibile, con fase e data di aggiornamento.',
    input_schema: { type: 'object', properties: {} },
  },
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
    description: 'Imposta il TOTALE giornaliero svolto dalla persona sul progetto, nello stesso registro di log_time e dashboard. Sostituisce il totale precedente; NON somma. Per ore aggiuntive leggi prima get_time_report e riconcilia. Non modificare i costi.',
    input_schema: {
      type: 'object',
      properties: {
        project_id:    { type: 'string', description: 'ID del progetto' },
        slack_user_id: { type: 'string', description: 'Slack ID di chi ha lavorato (default: utente corrente)' },
        hours:         { type: 'number', description: 'Totale giornaliero sul progetto, non incremento' },
        date:          { type: 'string', description: 'Data del lavoro YYYY-MM-DD (default oggi)' },
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

  if (toolName === 'get_project_dossier' || toolName === 'refresh_project_dossier') {
    var dossierAgent = require('../agents/projectDossier');
    var dossiersDb = require('../services/db/dossiers');
    var prj = await dossierAgent.findProject(input.project_name || '');
    if (!prj) return { error: 'Nessun progetto attivo che corrisponda a "' + input.project_name + '". Usa list_projects per i nomi esatti.' };
    if (toolName === 'refresh_project_dossier') {
      if (['admin', 'manager', 'finance'].indexOf(userRole) === -1) return { error: 'Solo admin, manager e finance possono ricostruire un dossier.' };
      try {
        var built = await dossierAgent.buildDossier(prj);
        if (!built) return { project: prj.name, error: 'Nessuna fonte disponibile per ' + prj.name + ' (né kick-off, né recap, né canale attivo, né ore): la scheda non si può costruire.' };
        return { project: prj.name, version: built.row.version, changes: built.changes, text: dossierAgent.formatDossier(prj, built.row) };
      } catch(e) { return { error: 'Costruzione dossier fallita: ' + e.message }; }
    }
    var row = await dossiersDb.getDossier(prj.id);
    if (!row || !row.dossier || !Object.keys(row.dossier).length) {
      return { project: prj.name, no_dossier: true, message: 'Per ' + prj.name + ' non c\'è ancora una scheda. Posso costruirla adesso con refresh_project_dossier (serve un admin/manager).' };
    }
    var budgetInfo = null;
    try {
      var bRow = await require('../agents/budgetImporter').budgetStatus(prj.id);
      if (bRow && bRow.hours != null) {
        var logsAll = await dossiersDb.getProjectTimeLogs(prj.id, bRow.period_start || '2000-01-01');
        var registered = Math.round(logsAll.reduce(function(sum, l) { return sum + (Number(l.hours) || 0); }, 0) * 10) / 10;
        budgetInfo = { hours: Number(bRow.hours), registered_hours: registered, remaining_hours: Math.round((Number(bRow.hours) - registered) * 10) / 10, verified: !!bRow.verified, period: (bRow.period_start || '') + ' → ' + (bRow.period_end || '') };
      }
    } catch(_) {}
    var dossierText = dossierAgent.formatDossier(prj, row);
    if (budgetInfo) dossierText += '\n*Budget ore:* ' + budgetInfo.hours + 'h' + (budgetInfo.verified ? '' : ' (proposta, non verificata)') + ' · registrate ' + budgetInfo.registered_hours + 'h · restano ' + budgetInfo.remaining_hours + 'h';
    return { project: prj.name, version: row.version, built_at: row.built_at, needs_refresh: !!row.needs_refresh, dossier: row.dossier, budget: budgetInfo, text: dossierText };
  }

  if (toolName === 'list_project_dossiers') {
    var dossiersDb2 = require('../services/db/dossiers');
    var rows = await dossiersDb2.listDossiers();
    var active = await db.searchProjects({ statuses: ['active', 'planning', 'on_hold'], limit: 300 });
    var names = {};
    (active || []).forEach(function(p) { names[p.id] = p.name; });
    var list = rows.filter(function(r) { return names[r.project_id] && r.dossier && Object.keys(r.dossier).length; })
      .map(function(r) { return { project: names[r.project_id], fase: r.dossier.fase || null, built_at: r.built_at, version: r.version, needs_refresh: !!r.needs_refresh }; });
    return { count: list.length, dossiers: list };
  }

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

    // Trigger post-mortem when project is completed
    if (input.status === 'completed') {
      try {
        var { generatePostMortem } = require('../agents/projectPostMortem');
        generatePostMortem(input.project_id).catch(function(e) {
          logger.warn('[PROJECT] Post-mortem error:', e.message);
        });
      } catch(e) { /* ignore */ }
    }

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
    var targetUser = input.slack_user_id || userId;
    if (targetUser !== userId && !['admin', 'manager', 'finance'].includes(userRole)) {
      return { error: 'Puoi registrare soltanto le tue ore.' };
    }
    return require('../services/timeRecording').recordDailyTotal({
      userId: targetUser, actorId: userId, projectId: input.project_id,
      date: input.date, hours: input.hours, notes: input.notes,
    });
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
