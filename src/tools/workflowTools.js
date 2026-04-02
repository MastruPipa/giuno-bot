// ─── Workflow Tools ──────────────────────────────────────────────────────────
// Project templates, phases, daily priorities, monthly feedback.
'use strict';

var db = require('../../supabase');
var logger = require('../utils/logger');

var definitions = [
  {
    name: 'list_templates',
    description: 'Elenca i template di progetto disponibili (Branding, Social, Video, Web, Campagna, Evento). Ogni template ha fasi e step predefiniti.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'create_project_from_template',
    description: 'Crea un progetto con fasi pre-caricate da un template. Es. "crea progetto branding per Aitho" → carica 5 fasi con step. Solo admin/manager.',
    input_schema: {
      type: 'object',
      properties: {
        template_name:    { type: 'string', description: 'Nome template: Branding, Social Media, Video Production, Web/App, Campagna ADV, Evento' },
        project_name:     { type: 'string', description: 'Nome del progetto' },
        client_name:      { type: 'string', description: 'Nome cliente' },
        budget_quoted:    { type: 'number', description: 'Budget in € (opzionale)' },
        start_date:       { type: 'string', description: 'Data inizio YYYY-MM-DD (default: oggi)' },
        owner_slack_id:   { type: 'string', description: 'Responsabile (Slack ID)' },
      },
      required: ['template_name', 'project_name'],
    },
  },
  {
    name: 'update_phase',
    description: 'Aggiorna lo stato di una fase del progetto. Usa get_project_details per vedere le fasi e i loro ID.',
    input_schema: {
      type: 'object',
      properties: {
        phase_id:        { type: 'string', description: 'ID della fase' },
        status:          { type: 'string', description: 'Nuovo stato: pending, in_progress, completed, blocked, skipped' },
        assignee:        { type: 'string', description: 'Slack ID assegnatario (opzionale)' },
        actual_end_date: { type: 'string', description: 'Data fine effettiva YYYY-MM-DD (opzionale)' },
        notes:           { type: 'string', description: 'Note (opzionale)' },
      },
      required: ['phase_id', 'status'],
    },
  },
  {
    name: 'get_project_timeline',
    description: 'Mostra la timeline completa di un progetto con tutte le fasi, step, stati e tempi. Vista Gantt testuale.',
    input_schema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'ID del progetto' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'get_my_day',
    description: 'Piano della giornata personalizzato per l\'utente: priorità, deadline, call, ore da allocare, suggerimenti. Usalo quando qualcuno chiede "cosa devo fare oggi?", "le mie priorità", "pianifica la mia giornata".',
    input_schema: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'Slack ID (opzionale, default: utente corrente)' },
      },
    },
  },
  {
    name: 'start_feedback',
    description: 'Avvia il questionario mensile di feedback per tutto il team o per un utente specifico. Solo admin.',
    input_schema: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'Slack ID specifico (opzionale, default: tutto il team)' },
      },
    },
  },
  {
    name: 'get_feedback_results',
    description: 'Mostra i risultati del questionario mensile: risposte di tutti, sintesi, NPS. Solo admin.',
    input_schema: {
      type: 'object',
      properties: {
        month: { type: 'string', description: 'Mese YYYY-MM (opzionale, default: mese corrente)' },
      },
    },
  },
  {
    name: 'set_feedback_questions',
    description: 'Cambia le domande del questionario mensile. Solo admin.',
    input_schema: {
      type: 'object',
      properties: {
        questions: { type: 'array', items: { type: 'string' }, description: 'Lista delle domande (5-8 max)' },
      },
      required: ['questions'],
    },
  },
];

// ─── Execution ──────────────────────────────────────────────────────────────

async function execute(toolName, input, userId, userRole) {
  input = input || {};
  var supabase = db.getClient ? db.getClient() : null;
  if (!supabase) return { error: 'DB non disponibile.' };

  // ─── Templates ──────────────────────────────────────────────────────────
  if (toolName === 'list_templates') {
    try {
      var { data } = await supabase.from('project_templates').select('name, service_category, estimated_days, phases').order('name');
      return { templates: (data || []).map(function(t) {
        var phases = typeof t.phases === 'string' ? JSON.parse(t.phases) : (t.phases || []);
        return { name: t.name, category: t.service_category, days: t.estimated_days, phases_count: phases.length,
          phases: phases.map(function(p) { return p.name + ' (' + p.days + 'gg, ' + (p.steps || []).length + ' step)'; }) };
      }) };
    } catch(e) { return { error: e.message }; }
  }

  // ─── Create from template ─────────────────────────────────────────────
  if (toolName === 'create_project_from_template') {
    if (userRole !== 'admin' && userRole !== 'manager' && userRole !== 'finance') {
      return { error: 'Solo admin/manager/finance possono creare progetti.' };
    }
    try {
      // Find template
      var { data: tpl } = await supabase.from('project_templates').select('*').ilike('name', '%' + input.template_name + '%').limit(1);
      if (!tpl || tpl.length === 0) return { error: 'Template "' + input.template_name + '" non trovato. Usa list_templates per vedere i disponibili.' };
      var template = tpl[0];
      var phases = typeof template.phases === 'string' ? JSON.parse(template.phases) : (template.phases || []);

      // Calculate dates
      var startDate = input.start_date || new Date().toISOString().slice(0, 10);
      var currentDate = new Date(startDate);
      var endDate = new Date(currentDate);
      endDate.setDate(endDate.getDate() + (template.estimated_days || 30));

      // Create project
      var project = await db.createProject({
        name: input.project_name,
        client_name: input.client_name || null,
        status: 'active',
        start_date: startDate,
        end_date: endDate.toISOString().slice(0, 10),
        budget_quoted: input.budget_quoted || null,
        service_category: template.service_category,
        owner_slack_id: input.owner_slack_id || userId,
        tags: ['template:' + template.name.toLowerCase()],
      });
      if (!project) return { error: 'Errore creazione progetto.' };

      // Create phases
      var createdPhases = [];
      for (var pi = 0; pi < phases.length; pi++) {
        var phase = phases[pi];
        var phaseStart = new Date(currentDate);
        var phaseEnd = new Date(currentDate);
        phaseEnd.setDate(phaseEnd.getDate() + (phase.days || 5));

        var { data: phaseData } = await supabase.from('project_phases').insert({
          project_id: project.id,
          phase_number: phase.phase || (pi + 1),
          name: phase.name,
          status: pi === 0 ? 'in_progress' : 'pending',
          steps: (phase.steps || []).map(function(s) { return { name: s, done: false }; }),
          estimated_days: phase.days,
          start_date: phaseStart.toISOString().slice(0, 10),
          end_date: phaseEnd.toISOString().slice(0, 10),
        }).select().single();

        if (phaseData) createdPhases.push(phaseData);
        currentDate = phaseEnd;
      }

      return { success: true, project: project, phases: createdPhases.length, template: template.name, timeline: startDate + ' → ' + endDate.toISOString().slice(0, 10) };
    } catch(e) { return { error: e.message }; }
  }

  // ─── Update phase ─────────────────────────────────────────────────────
  if (toolName === 'update_phase') {
    try {
      var updates = { status: input.status, updated_at: new Date().toISOString() };
      if (input.assignee) updates.assignee_slack_id = input.assignee;
      if (input.actual_end_date) updates.actual_end_date = input.actual_end_date;
      if (input.notes) updates.notes = input.notes;
      if (input.status === 'completed') updates.actual_end_date = updates.actual_end_date || new Date().toISOString().slice(0, 10);

      var { data, error } = await supabase.from('project_phases').update(updates).eq('id', input.phase_id).select().single();
      if (error) return { error: error.message };

      // Auto-advance: if phase completed, start next phase
      if (input.status === 'completed' && data.project_id) {
        var { data: nextPhase } = await supabase.from('project_phases')
          .select('id').eq('project_id', data.project_id).eq('status', 'pending')
          .order('phase_number').limit(1);
        if (nextPhase && nextPhase.length > 0) {
          await supabase.from('project_phases').update({ status: 'in_progress', updated_at: new Date().toISOString() }).eq('id', nextPhase[0].id);
        }
      }

      return { success: true, phase: data };
    } catch(e) { return { error: e.message }; }
  }

  // ─── Project timeline ─────────────────────────────────────────────────
  if (toolName === 'get_project_timeline') {
    try {
      var project = await db.getProject(input.project_id);
      if (!project) return { error: 'Progetto non trovato.' };
      var { data: phases } = await supabase.from('project_phases')
        .select('*').eq('project_id', input.project_id).order('phase_number');

      var statusIcons = { pending: '⬜', in_progress: '🔵', completed: '✅', blocked: '🔴', skipped: '⏭' };
      var timeline = (phases || []).map(function(p) {
        var icon = statusIcons[p.status] || '⬜';
        var steps = typeof p.steps === 'string' ? JSON.parse(p.steps) : (p.steps || []);
        var doneSteps = steps.filter(function(s) { return s.done; }).length;
        var line = icon + ' *Fase ' + p.phase_number + ': ' + p.name + '* [' + p.status + ']';
        if (p.start_date) line += '\n   ' + p.start_date + ' → ' + (p.actual_end_date || p.end_date || '?');
        if (p.assignee_slack_id) line += ' | <@' + p.assignee_slack_id + '>';
        line += '\n   Step: ' + doneSteps + '/' + steps.length;
        if (steps.length > 0) {
          line += ' — ' + steps.map(function(s) { return (s.done ? '✓' : '○') + ' ' + s.name; }).join(', ');
        }
        return line;
      });

      return { project: project.name, client: project.client_name, phases: timeline, total_phases: (phases || []).length };
    } catch(e) { return { error: e.message }; }
  }

  // ─── Get my day ───────────────────────────────────────────────────────
  if (toolName === 'get_my_day') {
    var targetUserId = input.user_id || userId;
    var plan = [];
    var now = new Date();
    var today = now.toISOString().slice(0, 10);

    // 1. Active phases assigned to user
    try {
      var { data: myPhases } = await supabase.from('project_phases')
        .select('*, projects!inner(name, client_name, end_date)')
        .eq('assignee_slack_id', targetUserId)
        .in('status', ['in_progress', 'blocked'])
        .order('end_date', { ascending: true });
      if (myPhases && myPhases.length > 0) {
        myPhases.forEach(function(p) {
          var daysLeft = p.end_date ? Math.ceil((new Date(p.end_date) - now) / 86400000) : null;
          var urgency = daysLeft !== null && daysLeft <= 1 ? '🔴' : (daysLeft !== null && daysLeft <= 3 ? '🟡' : '🟢');
          var projName = p.projects ? p.projects.name : '';
          plan.push({ urgency: urgency, task: projName + ' — ' + p.name, daysLeft: daysLeft, status: p.status, phase_id: p.id });
        });
      }
    } catch(e) { /* ignore */ }

    // 2. Resource allocations
    try {
      var allocs = await db.getUserAllocations(targetUserId);
      var weekHours = 0;
      (allocs || []).forEach(function(a) { weekHours += parseFloat(a.hours_allocated) || 0; });
      if (weekHours > 0) plan.push({ type: 'info', text: 'Ore allocate questa settimana: ' + Math.round(weekHours) + 'h' });
    } catch(e) { /* ignore */ }

    // 3. Upcoming deadlines from memories
    try {
      var deadlineMems = await db.searchMemories(targetUserId, 'scadenza deadline entro consegna oggi ' + today);
      if (deadlineMems && deadlineMems.length > 0) {
        deadlineMems.slice(0, 3).forEach(function(m) {
          if (m.content && !m.content.includes('TOOL:')) plan.push({ type: 'deadline', text: m.content.substring(0, 120) });
        });
      }
    } catch(e) { /* ignore */ }

    // 4. Weekly priorities
    try {
      var { data: prio } = await supabase.from('weekly_priorities').select('priorities').order('week_start', { ascending: false }).limit(1);
      if (prio && prio.length > 0 && prio[0].priorities) {
        var priorities = prio[0].priorities;
        plan.push({ type: 'priorities', items: Array.isArray(priorities) ? priorities.map(function(p) { return p.text || p; }) : [] });
      }
    } catch(e) { /* ignore */ }

    // Sort by urgency
    plan.sort(function(a, b) {
      var order = { '🔴': 0, '🟡': 1, '🟢': 2 };
      return (order[a.urgency] || 3) - (order[b.urgency] || 3);
    });

    return { user: targetUserId, date: today, plan: plan };
  }

  // ─── Start feedback ───────────────────────────────────────────────────
  if (toolName === 'start_feedback') {
    if (userRole !== 'admin') return { error: 'Solo admin può avviare il feedback.' };
    try {
      var month = now ? new Date().toISOString().slice(0, 7) : new Date().toISOString().slice(0, 7);
      // Get questions
      var { data: qData } = await supabase.from('feedback_questions').select('questions').eq('active', true).limit(1);
      var questions = (qData && qData.length > 0) ? qData[0].questions : [
        'Cosa ti ha aiutato di più questo mese?',
        'Cosa ti ha fatto perdere più tempo?',
        'C\'è qualcosa che vorresti che Giuno facesse e non fa?',
        'Utilità di Giuno da 1 a 10?',
        'Un suggerimento per il team?',
      ];
      if (typeof questions === 'string') questions = JSON.parse(questions);

      // Get team
      var { getUtenti } = require('../services/slackService');
      var { app } = require('../services/slackService');
      var utenti = await getUtenti();
      var targets = input.user_id ? utenti.filter(function(u) { return u.id === input.user_id; }) : utenti;
      var sent = 0;

      for (var ui = 0; ui < targets.length; ui++) {
        var u = targets[ui];
        // Check if already started this month
        var { data: existing } = await supabase.from('team_feedback')
          .select('id').eq('slack_user_id', u.id).eq('month', month).limit(1);
        if (existing && existing.length > 0) continue;

        // Create feedback entries
        for (var qi = 0; qi < questions.length; qi++) {
          await supabase.from('team_feedback').insert({
            slack_user_id: u.id, month: month, question_index: qi, question: questions[qi],
          });
        }

        // Send first question via DM
        var nome = u.name.split(' ')[0];
        await app.client.chat.postMessage({
          channel: u.id,
          text: 'Ciao ' + nome + '! Momento feedback mensile. ' + questions.length + ' domande veloci, rispondi quando vuoi.\n\n*1/' + questions.length + ':* ' + questions[0],
        });
        sent++;
      }

      return { success: true, sent: sent, month: month, questions: questions.length };
    } catch(e) { return { error: e.message }; }
  }

  // ─── Get feedback results ─────────────────────────────────────────────
  if (toolName === 'get_feedback_results') {
    if (userRole !== 'admin') return { error: 'Solo admin può vedere i risultati.' };
    try {
      var month = input.month || new Date().toISOString().slice(0, 7);
      var { data } = await supabase.from('team_feedback')
        .select('*').eq('month', month).order('slack_user_id').order('question_index');

      if (!data || data.length === 0) return { message: 'Nessun feedback per ' + month + '.' };

      // Group by user
      var byUser = {};
      data.forEach(function(f) {
        if (!byUser[f.slack_user_id]) byUser[f.slack_user_id] = [];
        byUser[f.slack_user_id].push({ question: f.question, answer: f.answer || '(non risposto)', index: f.question_index });
      });

      var answered = data.filter(function(f) { return f.answer; }).length;
      var total = data.length;

      return { month: month, response_rate: Math.round((answered / total) * 100) + '%', users: byUser, answered: answered, total: total };
    } catch(e) { return { error: e.message }; }
  }

  // ─── Set feedback questions ───────────────────────────────────────────
  if (toolName === 'set_feedback_questions') {
    if (userRole !== 'admin') return { error: 'Solo admin.' };
    try {
      await supabase.from('feedback_questions').update({ active: false }).eq('active', true);
      var { data } = await supabase.from('feedback_questions').insert({
        questions: input.questions, set_by: userId, active: true,
      }).select().single();
      return { success: true, questions: input.questions };
    } catch(e) { return { error: e.message }; }
  }

  return { error: 'Tool sconosciuto: ' + toolName };
}

module.exports = { definitions: definitions, execute: execute };
