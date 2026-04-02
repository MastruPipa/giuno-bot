// ─── Agency Tools ────────────────────────────────────────────────────────────
// Client accounts, brand assets, content calendar, invoices,
// supplier rates, competitors, time tracking.
'use strict';

var logger = require('../utils/logger');
var db = require('../../supabase');

var definitions = [
  // ─── Client Accounts ────────────────────────────────────────────────────
  {
    name: 'manage_account',
    description: 'Crea o aggiorna un account cliente (relazione post-vendita). Traccia: valore lifetime, servizi attivi, stato rapporto, contratto. Solo admin/finance/manager.',
    input_schema: {
      type: 'object',
      properties: {
        action:           { type: 'string', description: '"create", "update", "get"' },
        company_name:     { type: 'string', description: 'Nome azienda cliente' },
        account_id:       { type: 'string', description: 'ID account (per update)' },
        status:           { type: 'string', description: 'active, paused, churned, prospect' },
        start_date:       { type: 'string', description: 'Data inizio rapporto YYYY-MM-DD' },
        contract_end_date:{ type: 'string', description: 'Scadenza contratto YYYY-MM-DD' },
        monthly_value:    { type: 'number', description: 'Valore mensile €' },
        services_active:  { type: 'array', items: { type: 'string' }, description: 'Servizi attivi (branding, social, web...)' },
        health_score:     { type: 'number', description: 'Soddisfazione 1-10' },
        main_contact:     { type: 'string', description: 'Contatto principale' },
        notes:            { type: 'string' },
      },
      required: ['action', 'company_name'],
    },
  },
  {
    name: 'list_accounts',
    description: 'Lista tutti gli account clienti attivi con valore, servizi, health score. Utile per "come stanno i nostri clienti?"',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filtra per stato (default: active)' },
      },
    },
  },
  // ─── Brand Assets ──────────────────────────────────────────────────────
  {
    name: 'manage_brand',
    description: 'Gestisci gli asset del brand di un cliente: colori, font, tone of voice, guidelines. "Quali sono i colori di Aitho?" → cerca qui.',
    input_schema: {
      type: 'object',
      properties: {
        action:          { type: 'string', description: '"create", "update", "get"' },
        client_name:     { type: 'string', description: 'Nome cliente' },
        primary_colors:  { type: 'array', items: { type: 'string' }, description: 'Colori primari (es. "#FF5733", "rosso KS")' },
        secondary_colors:{ type: 'array', items: { type: 'string' }, description: 'Colori secondari' },
        fonts:           { type: 'array', items: { type: 'string' }, description: 'Font (es. "Montserrat Bold", "Inter Regular")' },
        tone_of_voice:   { type: 'string', description: 'Tono di voce del brand' },
        do_rules:        { type: 'array', items: { type: 'string' }, description: 'Cose da fare (do)' },
        dont_rules:      { type: 'array', items: { type: 'string' }, description: 'Cose da non fare (don\'t)' },
        logo_drive_link: { type: 'string' },
        brand_guide_link:{ type: 'string' },
      },
      required: ['action', 'client_name'],
    },
  },
  // ─── Content Calendar ──────────────────────────────────────────────────
  {
    name: 'manage_content',
    description: 'Gestisci il piano editoriale: crea/aggiorna/cerca contenuti da pubblicare. "Cosa dobbiamo pubblicare questa settimana?" → cerca qui.',
    input_schema: {
      type: 'object',
      properties: {
        action:       { type: 'string', description: '"create", "update", "list", "upcoming"' },
        content_id:   { type: 'string', description: 'ID contenuto (per update)' },
        client_name:  { type: 'string', description: 'Cliente' },
        platform:     { type: 'string', description: 'instagram, facebook, linkedin, tiktok, blog, newsletter' },
        content_type: { type: 'string', description: 'post, story, reel, carousel, article, newsletter' },
        title:        { type: 'string' },
        description:  { type: 'string' },
        status:       { type: 'string', description: 'idea, planned, in_production, review, approved, published, cancelled' },
        publish_date: { type: 'string', description: 'YYYY-MM-DD' },
        assignee:     { type: 'string', description: 'Slack ID di chi produce' },
        copy_text:    { type: 'string', description: 'Copy del post' },
        hashtags:     { type: 'array', items: { type: 'string' } },
        days_ahead:   { type: 'number', description: 'Per "upcoming": quanti giorni avanti guardare (default 7)' },
      },
      required: ['action'],
    },
  },
  // ─── Invoices ──────────────────────────────────────────────────────────
  {
    name: 'manage_invoice',
    description: 'Gestisci fatture: crea, aggiorna stato, cerca. Solo admin/finance. "Fatture in attesa?" → cerca qui.',
    input_schema: {
      type: 'object',
      properties: {
        action:         { type: 'string', description: '"create", "update", "list", "overdue"' },
        invoice_id:     { type: 'string', description: 'ID fattura (per update)' },
        client_name:    { type: 'string' },
        project_id:     { type: 'string' },
        amount:         { type: 'number', description: 'Importo netto €' },
        invoice_number: { type: 'string' },
        status:         { type: 'string', description: 'draft, sent, paid, overdue, cancelled' },
        issued_date:    { type: 'string', description: 'YYYY-MM-DD' },
        due_date:       { type: 'string', description: 'YYYY-MM-DD' },
        paid_date:      { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['action'],
    },
  },
  // ─── Supplier Rates ────────────────────────────────────────────────────
  {
    name: 'manage_supplier_rate',
    description: 'Gestisci tariffe fornitori: crea/aggiorna tariffe, qualità, affidabilità. "Quanto costa Andrea per un video?" → cerca qui.',
    input_schema: {
      type: 'object',
      properties: {
        action:           { type: 'string', description: '"create", "update", "get", "compare"' },
        supplier_name:    { type: 'string' },
        service_type:     { type: 'string', description: 'video, foto, grafica, sviluppo, copy...' },
        rate_type:        { type: 'string', description: 'hourly, daily, project, monthly' },
        rate_amount:      { type: 'number', description: 'Tariffa in €' },
        quality_score:    { type: 'number', description: '1-10' },
        reliability_score:{ type: 'number', description: '1-10' },
        past_projects:    { type: 'array', items: { type: 'string' } },
      },
      required: ['action', 'supplier_name'],
    },
  },
  // ─── Competitors ───────────────────────────────────────────────────────
  {
    name: 'manage_competitor',
    description: 'Traccia i competitor dei clienti. "Chi sono i competitor di Aitho?" → cerca qui.',
    input_schema: {
      type: 'object',
      properties: {
        action:          { type: 'string', description: '"add", "list", "update"' },
        client_name:     { type: 'string' },
        competitor_name: { type: 'string' },
        website:         { type: 'string' },
        social_links:    { type: 'object', description: '{"instagram": "url", "linkedin": "url"}' },
        notes:           { type: 'string' },
      },
      required: ['action'],
    },
  },
  // ─── Time Tracking ─────────────────────────────────────────────────────
  {
    name: 'log_time',
    description: 'Registra ore lavorate nel dettaglio giornaliero. "Ho lavorato 3h sul logo Aitho" → salva qui. Diverso da log_hours (che è a livello progetto).',
    input_schema: {
      type: 'object',
      properties: {
        project_id:       { type: 'string', description: 'ID progetto' },
        project_name:     { type: 'string', description: 'Nome progetto (alternativa a ID)' },
        hours:            { type: 'number', description: 'Ore lavorate' },
        task_description: { type: 'string', description: 'Cosa hai fatto' },
        date:             { type: 'string', description: 'Data YYYY-MM-DD (default: oggi)' },
        billable:         { type: 'boolean', description: 'Ore fatturabili? (default: true)' },
      },
      required: ['hours'],
    },
  },
  {
    name: 'get_time_report',
    description: 'Report ore lavorate: per persona, per progetto, per periodo. "Quante ore ha lavorato Paolo questa settimana?" → usa questo.',
    input_schema: {
      type: 'object',
      properties: {
        user_id:    { type: 'string', description: 'Slack ID (opzionale)' },
        project_id: { type: 'string', description: 'ID progetto (opzionale)' },
        from_date:  { type: 'string', description: 'Da YYYY-MM-DD (default: inizio settimana)' },
        to_date:    { type: 'string', description: 'A YYYY-MM-DD (default: oggi)' },
      },
    },
  },
];

// ─── Execution ──────────────────────────────────────────────────────────────

async function execute(toolName, input, userId, userRole) {
  input = input || {};
  var supabase = db.getClient ? db.getClient() : null;
  if (!supabase) return { error: 'DB non disponibile.' };

  // ─── Client Accounts ──────────────────────────────────────────────────
  if (toolName === 'manage_account') {
    if (userRole !== 'admin' && userRole !== 'finance' && userRole !== 'manager') return { error: 'Solo admin/finance/manager.' };
    if (input.action === 'create') {
      var { data, error } = await supabase.from('client_accounts').insert({
        company_name: input.company_name, status: input.status || 'active',
        start_date: input.start_date || null, contract_end_date: input.contract_end_date || null,
        monthly_value: input.monthly_value || null, services_active: input.services_active || [],
        health_score: input.health_score || null, main_contact: input.main_contact || null, notes: input.notes || null,
      }).select().single();
      return error ? { error: error.message } : { success: true, account: data };
    }
    if (input.action === 'update' && input.account_id) {
      var updates = {}; ['status','contract_end_date','monthly_value','services_active','health_score','main_contact','notes'].forEach(function(k) { if (input[k] !== undefined) updates[k] = input[k]; });
      updates.updated_at = new Date().toISOString();
      if (input.monthly_value) updates.lifetime_value = supabase.rpc ? undefined : null; // Can't do SQL in upsert
      var { data } = await supabase.from('client_accounts').update(updates).eq('id', input.account_id).select().single();
      return { success: true, account: data };
    }
    if (input.action === 'get') {
      var { data } = await supabase.from('client_accounts').select('*').ilike('company_name', '%' + input.company_name + '%').limit(3);
      return { accounts: data || [] };
    }
    return { error: 'Azione non valida. Usa: create, update, get.' };
  }

  if (toolName === 'list_accounts') {
    var q = supabase.from('client_accounts').select('*');
    if (input.status) q = q.eq('status', input.status); else q = q.eq('status', 'active');
    var { data } = await q.order('lifetime_value', { ascending: false }).limit(30);
    return { accounts: data || [], count: (data || []).length };
  }

  // ─── Brand Assets ─────────────────────────────────────────────────────
  if (toolName === 'manage_brand') {
    if (input.action === 'get') {
      var { data } = await supabase.from('client_brand_assets').select('*').ilike('client_name', '%' + input.client_name + '%').limit(1);
      return (data && data.length > 0) ? data[0] : { message: 'Nessun brand asset per "' + input.client_name + '". Crealo con action: "create".' };
    }
    if (input.action === 'create' || input.action === 'update') {
      var row = {};
      ['client_name','primary_colors','secondary_colors','fonts','tone_of_voice','do_rules','dont_rules','logo_drive_link','brand_guide_link'].forEach(function(k) { if (input[k] !== undefined) row[k] = input[k]; });
      row.updated_at = new Date().toISOString();
      if (input.action === 'create') {
        var { data } = await supabase.from('client_brand_assets').insert(row).select().single();
        return { success: true, brand: data };
      } else {
        var { data: existing } = await supabase.from('client_brand_assets').select('id').ilike('client_name', '%' + input.client_name + '%').limit(1);
        if (!existing || existing.length === 0) return { error: 'Brand non trovato. Usa "create".' };
        var { data } = await supabase.from('client_brand_assets').update(row).eq('id', existing[0].id).select().single();
        return { success: true, brand: data };
      }
    }
    return { error: 'Azione: create, update, get.' };
  }

  // ─── Content Calendar ─────────────────────────────────────────────────
  if (toolName === 'manage_content') {
    if (input.action === 'create') {
      var { data } = await supabase.from('content_calendar').insert({
        client_name: input.client_name || '', platform: input.platform || '',
        content_type: input.content_type || null, title: input.title || null,
        description: input.description || null, status: input.status || 'planned',
        publish_date: input.publish_date || null, assignee_slack_id: input.assignee || null,
        copy_text: input.copy_text || null, hashtags: input.hashtags || [],
      }).select().single();
      return { success: true, content: data };
    }
    if (input.action === 'list') {
      var q = supabase.from('content_calendar').select('*');
      if (input.client_name) q = q.ilike('client_name', '%' + input.client_name + '%');
      if (input.status) q = q.eq('status', input.status);
      if (input.platform) q = q.eq('platform', input.platform);
      var { data } = await q.order('publish_date', { ascending: true }).limit(20);
      return { content: data || [], count: (data || []).length };
    }
    if (input.action === 'upcoming') {
      var days = input.days_ahead || 7;
      var from = new Date().toISOString().slice(0, 10);
      var to = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
      var { data } = await supabase.from('content_calendar').select('*')
        .gte('publish_date', from).lte('publish_date', to)
        .not('status', 'in', '("published","cancelled")')
        .order('publish_date');
      return { content: data || [], period: from + ' → ' + to };
    }
    if (input.action === 'update' && input.content_id) {
      var updates = {};
      ['status','title','copy_text','publish_date','assignee','hashtags','performance_notes'].forEach(function(k) { if (input[k] !== undefined) updates[k] = input[k]; });
      updates.updated_at = new Date().toISOString();
      var { data } = await supabase.from('content_calendar').update(updates).eq('id', input.content_id).select().single();
      return { success: true, content: data };
    }
    return { error: 'Azione: create, list, upcoming, update.' };
  }

  // ─── Invoices ─────────────────────────────────────────────────────────
  if (toolName === 'manage_invoice') {
    if (userRole !== 'admin' && userRole !== 'finance') return { error: 'Solo admin/finance.' };
    if (input.action === 'create') {
      var vatRate = 0.22;
      var amount = input.amount || 0;
      var { data } = await supabase.from('invoices').insert({
        client_name: input.client_name || '', project_id: input.project_id || null,
        invoice_number: input.invoice_number || null, amount: amount,
        vat_amount: Math.round(amount * vatRate * 100) / 100,
        total_amount: Math.round(amount * (1 + vatRate) * 100) / 100,
        status: input.status || 'draft', issued_date: input.issued_date || null, due_date: input.due_date || null,
      }).select().single();
      return { success: true, invoice: data };
    }
    if (input.action === 'list') {
      var q = supabase.from('invoices').select('*');
      if (input.client_name) q = q.ilike('client_name', '%' + input.client_name + '%');
      if (input.status) q = q.eq('status', input.status);
      var { data } = await q.order('issued_date', { ascending: false }).limit(20);
      return { invoices: data || [] };
    }
    if (input.action === 'overdue') {
      var today = new Date().toISOString().slice(0, 10);
      var { data } = await supabase.from('invoices').select('*').eq('status', 'sent').lt('due_date', today).order('due_date');
      return { overdue: data || [], count: (data || []).length };
    }
    if (input.action === 'update' && input.invoice_id) {
      var updates = {};
      ['status','paid_date','due_date','notes'].forEach(function(k) { if (input[k] !== undefined) updates[k] = input[k]; });
      updates.updated_at = new Date().toISOString();
      var { data } = await supabase.from('invoices').update(updates).eq('id', input.invoice_id).select().single();
      return { success: true, invoice: data };
    }
    return { error: 'Azione: create, list, overdue, update.' };
  }

  // ─── Supplier Rates ───────────────────────────────────────────────────
  if (toolName === 'manage_supplier_rate') {
    if (input.action === 'get' || input.action === 'compare') {
      var q = supabase.from('supplier_rates').select('*');
      if (input.supplier_name) q = q.ilike('supplier_name', '%' + input.supplier_name + '%');
      if (input.service_type) q = q.ilike('service_type', '%' + input.service_type + '%');
      var { data } = await q.order('rate_amount').limit(10);
      return { rates: data || [] };
    }
    if (input.action === 'create' || input.action === 'update') {
      var row = {};
      ['supplier_name','service_type','rate_type','rate_amount','quality_score','reliability_score','availability','past_projects','notes'].forEach(function(k) { if (input[k] !== undefined) row[k] = input[k]; });
      row.updated_at = new Date().toISOString();
      var { data } = await supabase.from('supplier_rates').upsert(row, { onConflict: 'id' }).select().single();
      return { success: true, rate: data };
    }
    return { error: 'Azione: create, update, get, compare.' };
  }

  // ─── Competitors ──────────────────────────────────────────────────────
  if (toolName === 'manage_competitor') {
    if (input.action === 'add') {
      var { data } = await supabase.from('competitors').insert({
        client_name: input.client_name || '', competitor_name: input.competitor_name || '',
        website: input.website || null, social_links: input.social_links || {},
        notes: input.notes || null, last_checked: new Date().toISOString().slice(0, 10),
      }).select().single();
      return { success: true, competitor: data };
    }
    if (input.action === 'list') {
      var q = supabase.from('competitors').select('*');
      if (input.client_name) q = q.ilike('client_name', '%' + input.client_name + '%');
      var { data } = await q.order('client_name').limit(20);
      return { competitors: data || [] };
    }
    return { error: 'Azione: add, list, update.' };
  }

  // ─── Time Tracking ────────────────────────────────────────────────────
  if (toolName === 'log_time') {
    var projectId = input.project_id;
    if (!projectId && input.project_name) {
      var projects = await db.searchProjects({ name: input.project_name, limit: 1 });
      if (projects && projects.length > 0) projectId = projects[0].id;
    }
    var { data } = await supabase.from('time_entries').insert({
      slack_user_id: userId, project_id: projectId || null,
      date: input.date || new Date().toISOString().slice(0, 10),
      hours: input.hours, task_description: input.task_description || null,
      billable: input.billable !== false,
    }).select().single();
    return { success: true, entry: data };
  }

  if (toolName === 'get_time_report') {
    var now = new Date();
    var dayOfWeek = now.getDay();
    var mondayOffset = (dayOfWeek + 6) % 7;
    var monday = new Date(now); monday.setDate(now.getDate() - mondayOffset);
    var fromDate = input.from_date || monday.toISOString().slice(0, 10);
    var toDate = input.to_date || now.toISOString().slice(0, 10);

    var q = supabase.from('time_entries').select('*, projects(name, client_name)')
      .gte('date', fromDate).lte('date', toDate);
    if (input.user_id) q = q.eq('slack_user_id', input.user_id);
    if (input.project_id) q = q.eq('project_id', input.project_id);
    var { data } = await q.order('date', { ascending: false }).limit(100);

    if (!data || data.length === 0) return { entries: [], total_hours: 0, period: fromDate + ' → ' + toDate };

    var totalHours = 0; var billableHours = 0;
    var byProject = {}; var byUser = {};
    data.forEach(function(e) {
      totalHours += parseFloat(e.hours) || 0;
      if (e.billable) billableHours += parseFloat(e.hours) || 0;
      var projName = e.projects ? e.projects.name : 'non assegnato';
      if (!byProject[projName]) byProject[projName] = 0;
      byProject[projName] += parseFloat(e.hours) || 0;
      if (!byUser[e.slack_user_id]) byUser[e.slack_user_id] = 0;
      byUser[e.slack_user_id] += parseFloat(e.hours) || 0;
    });

    return {
      period: fromDate + ' → ' + toDate, total_hours: totalHours, billable_hours: billableHours,
      by_project: byProject, by_user: byUser, entries: data.slice(0, 20),
    };
  }

  return { error: 'Tool sconosciuto: ' + toolName };
}

module.exports = { definitions: definitions, execute: execute };
