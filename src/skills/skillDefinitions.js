// ─── Skill Definitions ───────────────────────────────────────────────────────
// 11 specialized skills for Katania Studio. Each has trigger keywords/regex,
// a focused system prompt, and a data loader that fetches targeted context.
'use strict';

var logger = require('../utils/logger');

var SKILLS = [
  {
    id: 'content_creation',
    name: 'Content Creation',
    keywords: ['post social', 'piano editoriale', 'ped', 'copy per', 'carousel', 'reel idea', 'caption'],
    regex: [/scrivi\s+(un\s+)?post/i, /crea\s+(un\s+)?contenuto/i, /idea\s+(per\s+)?(reel|post|story)/i],
    channels: ['social', 'content', 'ped'],
    minRole: 'member',
    prompt: 'Sei un content strategist di Katania Studio.\n' +
      'Crea contenuti social professionali, on-brand, pronti per la pubblicazione.\n' +
      'REGOLE: includi hook, body, CTA. Adatta tono al brand del cliente.\n' +
      'Se è un carousel: slide per slide. Se è un reel: script con timing.\n' +
      'Proponi sempre 2-3 varianti di copy.\n',
    loadContext: async function(db, ctx) {
      var context = {};
      if (ctx.channelProfile && ctx.channelProfile.cliente) {
        var kbRes = db.searchKB(ctx.channelProfile.cliente + ' brand tone voice');
        if (kbRes && kbRes.length > 0) context.brandKB = kbRes.slice(0, 3);
      }
      return context;
    },
  },
  {
    id: 'campaign_planning',
    name: 'Campaign Planning',
    keywords: ['campagna', 'brief campagna', 'budget adv', 'piano media', 'target audience'],
    regex: [/pianifica\s+(una\s+)?campagna/i, /brief\s+(per\s+)?campagna/i],
    channels: ['adv', 'campagne', 'marketing'],
    minRole: 'member',
    prompt: 'Sei un campaign planner di Katania Studio.\n' +
      'Struttura brief di campagna completi: obiettivo, target, canali, budget, KPI, timeline.\n' +
      'Basa le stime su campagne simili passate se disponibili.\n',
    loadContext: async function(db, ctx) {
      var kbRes = db.searchKB('campagna budget media plan');
      return { pastCampaigns: (kbRes || []).slice(0, 5) };
    },
  },
  {
    id: 'call_prep',
    name: 'Call Prep',
    keywords: ['briefing call', 'call con', 'meeting con', 'prepara la call', 'briefing per'],
    regex: [/prepara.*(call|meeting|riunione)/i, /briefing\s+(per|pre)\s+(call|meeting)/i],
    channels: [],
    minRole: 'member',
    prompt: 'Sei l\'assistente pre-call di Katania Studio.\n' +
      'Prepara un briefing operativo per la call: contesto cliente, storico CRM, ultimi sviluppi, ' +
      'punti da discutere, domande da fare, cose da evitare.\n' +
      'Formato: max 15 righe, diretto, actionable.\n',
    loadContext: async function(db, ctx, message) {
      var context = {};
      // Extract entity name from message
      var match = (message || '').match(/(?:call|meeting|riunione)\s+(?:con|per|di)\s+(.+?)(?:\s*\?|$)/i);
      var entityName = match ? match[1].trim() : null;
      if (entityName) {
        var leads = await db.searchLeads({ company_name: entityName, limit: 1 });
        if (leads && leads.length > 0) context.lead = leads[0];
        try {
          var { data: entity } = await db.getClient().rpc('resolve_entity', { p_name: entityName });
          if (entity && entity.length > 0) context.entity = entity[0];
        } catch(e) {
          logger.warn('[SKILL-DEFS] esecuzione skill fallita:', e.message);
        }
        var memories = await db.searchMemories(ctx.userId, entityName);
        if (memories && memories.length > 0) context.memories = memories.slice(0, 5);
      }
      return context;
    },
  },
  {
    id: 'pipeline_review',
    name: 'Pipeline Review',
    keywords: ['pipeline', 'crm review', 'stato lead', 'follow-up scaduti', 'rivedi crm'],
    regex: [/revis?i?ona?\s+(il\s+)?crm/i, /analizza\s+(la\s+)?pipeline/i],
    channels: ['vendite', 'commerciale'],
    minRole: 'manager',
    prompt: 'Sei l\'analista CRM di Katania Studio.\n' +
      'Analizza la pipeline: lead per fase, follow-up scaduti, azioni urgenti.\n' +
      'Identifica: deal bloccati, follow-up mancati, opportunità da riattivare.\n' +
      'Output: tabella status + 3-5 azioni prioritarie.\n',
    loadContext: async function(db) {
      var pipeline = await db.getLeadsPipeline();
      var leads = await db.searchLeads({ limit: 30 });
      return { pipeline: pipeline, allLeads: leads };
    },
  },
  {
    id: 'draft_outreach',
    name: 'Draft Outreach',
    keywords: ['email commerciale', 'cold email', 'follow-up email', 'scrivi email a'],
    regex: [/scrivi\s+(una?\s+)?email\s+(commerciale|a|per)/i, /bozza\s+email/i],
    channels: [],
    minRole: 'member',
    prompt: 'Sei il copywriter commerciale di Katania Studio.\n' +
      'Scrivi email professionali, calde, personalizzate. Niente template generici.\n' +
      'Includi: subject line, body, CTA. Tono: professionale ma non freddo.\n' +
      'Se hai storico del cliente, personalizza con riferimenti specifici.\n',
    loadContext: async function(db, ctx, message) {
      var match = (message || '').match(/(?:email|mail)\s+(?:a|per)\s+(.+?)(?:\s*\?|$)/i);
      var name = match ? match[1].trim() : null;
      if (name) {
        var leads = await db.searchLeads({ company_name: name, limit: 1 });
        return { lead: leads && leads.length > 0 ? leads[0] : null };
      }
      return {};
    },
  },
  {
    id: 'status_report',
    name: 'Status Report',
    keywords: ['stato progetti', 'report progetti', 'overview progetti', 'come vanno i progetti'],
    regex: [/stat[oi]\s+(dei?\s+)?progett/i, /report\s+(dei?\s+)?progett/i],
    channels: ['operation', 'management'],
    minRole: 'member',
    prompt: 'Sei il PM di Katania Studio.\n' +
      'Genera un report stato progetti BASATO SUI DATI REALI.\n' +
      'Per ogni progetto calcola e mostra:\n' +
      '• Semaforo: 🟢 budget ±10% e on time | 🟡 budget +10-25% o ritardo 1-2 sett | 🔴 budget >+25% o ritardo >2 sett | ⚫ dati mancanti\n' +
      '• Budget: €quotato vs €actual (delta € e %)\n' +
      '• Ore: allocate vs lavorate (% completamento)\n' +
      '• Timeline: start_date → end_date, giorni rimanenti\n' +
      '• Team: chi è assegnato e con che ruolo\n' +
      'Se mancano dati (budget, ore, date), segnala ⚫ e suggerisci cosa inserire.\n' +
      'Max 25 righe. Formato tabellare.\n',
    loadContext: async function(db) {
      var supabase = db.getClient();
      if (!supabase) return {};
      var projects = await db.searchProjects({ status: 'active', limit: 30 });
      // Get allocations for each project
      var projectDetails = [];
      for (var i = 0; i < Math.min(projects.length, 15); i++) {
        var allocs = await db.getProjectAllocations(projects[i].id);
        projectDetails.push({ project: projects[i], allocations: allocs });
      }
      // Also get channel profiles for additional context
      var profiles = [];
      try {
        var { data } = await supabase.from('channel_profiles')
          .select('channel_name, cliente, progetto, project_phase, team_members')
          .not('cliente', 'is', null).not('project_phase', 'eq', 'chiuso').limit(20);
        profiles = data || [];
      } catch(e) { /* ignore */ }
      var signals = [];
      try {
        var { data: sigs } = await supabase.from('pm_signals')
          .select('channel_id, signal_type, message_excerpt, urgency_score')
          .eq('status', 'open').gte('urgency_score', 3).limit(10);
        signals = sigs || [];
      } catch(e) { /* ignore */ }
      return { projectDetails: projectDetails, channelProfiles: profiles, signals: signals };
    },
  },
  {
    id: 'capacity_planning',
    name: 'Capacity Planning',
    keywords: ['carico team', 'chi è libero', 'bottleneck', 'capacità team', 'workload'],
    regex: [/chi\s+(è|ha)\s+(liber|disponibil)/i, /carico\s+(del\s+)?team/i],
    channels: ['operation', 'management'],
    minRole: 'manager',
    prompt: 'Sei il resource planner di Katania Studio (9 persone).\n' +
      'Analizza il carico del team: chi lavora su cosa, chi è sovraccarico, chi è libero.\n' +
      'Usa i dati dalla tabella projects + resource_allocations come fonte primaria.\n' +
      'Confronta ore allocate vs ore lavorate per ogni persona.\n' +
      'SCALA: 🟢 <70% carico, 🟡 70-90% carico, 🔴 >90% carico.\n' +
      'Suggerisci ribilanciamenti se trovi bottleneck.\n',
    loadContext: async function(db) {
      var supabase = db.getClient();
      if (!supabase) return {};
      var projects = await db.searchProjects({ status: 'active', limit: 30 });
      var workload = await db.getTeamWorkload();
      var { data: users } = await supabase.from('user_profiles')
        .select('nome, ruolo, progetti, slack_user_id').limit(15);
      return { activeProjects: projects || [], teamWorkload: workload || [], team: users || [] };
    },
  },
  {
    id: 'finance_overview',
    name: 'Finance Overview',
    keywords: ['fatturato', 'costi', 'overview finanziaria', 'revenue', 'budget', 'margini'],
    regex: [/fatturato\s+(q\d|mensile|annuale)/i, /overview\s+finanz/i, /margini?\s+(progett|client)/i],
    channels: ['amministrazione', 'finance'],
    minRole: 'admin',
    prompt: 'Sei il CFO assistant di Katania Studio.\n' +
      'Analizza con NUMERI PRECISI:\n' +
      '• Revenue: somma valori lead won (dal CRM)\n' +
      '• Pipeline: valore totale lead attivi per stato\n' +
      '• Progetti: budget_quoted vs budget_actual per ogni progetto attivo. Calcola margine.\n' +
      '• Burn rate: quanto stiamo spendendo vs quanto abbiamo preventivato\n' +
      'Mostra SEMPRE: delta €, delta %, trend rispetto al trimestre precedente se disponibile.\n' +
      'Se un progetto sfora il budget >10%: segnala come 🔴.\n' +
      'ATTENZIONE: dati finanziari sono sensibili — verifica il ruolo dell\'utente.\n',
    loadContext: async function(db) {
      var leads = await db.searchLeads({ status: 'won', limit: 50 });
      var pipeline = await db.getLeadsPipeline();
      var projects = await db.searchProjects({ status: 'active', limit: 30 });
      var kbFinance = db.searchKB('fatturato costi budget finanziario');
      return { wonLeads: leads, pipeline: pipeline, activeProjects: projects, financeKB: (kbFinance || []).slice(0, 5) };
    },
  },
  {
    id: 'project_health',
    name: 'Project Health Check',
    keywords: ['salute progetto', 'health check', 'come va il progetto', 'stato progetto'],
    regex: [/com[e']?\s+(va|sta|messo)\s+(il\s+)?progett/i, /health\s+check/i, /progetto\s+.+\s+(stato|come va)/i],
    channels: ['operation', 'management'],
    minRole: 'member',
    prompt: 'Sei l\'analista operativo di Katania Studio.\n' +
      'Fai un HEALTH CHECK del progetto richiesto con dati misurabili.\n' +
      'CALCOLA e mostra:\n' +
      '• BUDGET: €quotato vs €speso. Delta € e %. Burn rate (€speso / giorni trascorsi × giorni totali).\n' +
      '• TEMPO: data inizio → data fine. Giorni trascorsi vs totali. % timeline consumata.\n' +
      '• RISORSE: ore allocate vs lavorate per persona. Chi è on track, chi sfora.\n' +
      '• DELIVERABLE: se presenti, quanti completati vs totali.\n' +
      '• SEMAFORO FINALE: 🟢 🟡 🔴 ⚫ con motivazione basata sui numeri.\n\n' +
      'Se NON ci sono dati sufficienti per una sezione, mostra ⚫ e specifica cosa manca.\n' +
      'NON dire "sembra andare bene" — mostra i numeri e lascia che parlino.\n',
    loadContext: async function(db, ctx, message) {
      var match = (message || '').match(/progett[oi]?\s+(?:di\s+)?(.+?)(?:\s*\?|$)/i);
      var name = match ? match[1].trim() : null;
      if (!name) return {};
      var projects = await db.searchProjects({ name: name, limit: 3 });
      if (!projects || projects.length === 0) {
        projects = await db.searchProjects({ client_name: name, limit: 3 });
      }
      if (!projects || projects.length === 0) return { noProject: true, searchedName: name };
      var project = projects[0];
      var allocations = await db.getProjectAllocations(project.id);
      return { project: project, allocations: allocations };
    },
  },
  {
    id: 'account_research',
    name: 'Account Research',
    keywords: ['cosa sappiamo di', 'tutto su', 'dossier su', 'ricerca su'],
    regex: [/cosa\s+sa(i|ppiamo)\s+(di|su)/i, /dossier\s+(su|per)/i, /tutto\s+(quello\s+che\s+)?(sai|sappiamo)\s+(su|di)/i],
    channels: [],
    minRole: 'member',
    prompt: 'Sei il research analyst di Katania Studio.\n' +
      'Compila un dossier completo sull\'entità richiesta: chi sono, cosa facciamo con loro, ' +
      'storico interazioni, documenti rilevanti, persone coinvolte, stato attuale.\n' +
      'Usa TUTTE le fonti: CRM, memorie, KB, Drive, Slack.\n',
    loadContext: async function(db, ctx, message) {
      var match = (message || '').match(/(?:di|su)\s+(.+?)(?:\s*\?|$)/i);
      var name = match ? match[1].trim() : null;
      var context = {};
      if (name) {
        var leads = await db.searchLeads({ company_name: name, limit: 3 });
        context.leads = leads;
        var memories = await db.searchMemories(ctx.userId, name);
        context.memories = (memories || []).slice(0, 8);
        var kb = db.searchKB(name);
        context.kb = (kb || []).slice(0, 5);
      }
      return context;
    },
  },
  {
    id: 'quote_support_skill',
    name: 'Quote Support',
    keywords: ['quotare', 'quanto costa fare', 'stima costi', 'quanto quotare'],
    regex: [/quanto\s+(cost|quot)/i, /(?:fai|crea|genera|prepara)\s+(?:un\s+)?preventivo/i],
    channels: ['preventivi'],
    minRole: 'manager',
    prompt: null, // Delegates to quoteSupportAgent
    delegateTo: 'QUOTE_SUPPORT',
  },
  {
    id: 'weekly_digest',
    name: 'Weekly Digest',
    keywords: ['recap settimanale', 'recap della settimana', 'settimana in sintesi'],
    regex: [/recap\s+(della\s+)?settimana/i, /com'?è\s+andata\s+(la\s+)?settimana/i],
    channels: [],
    minRole: 'member',
    prompt: null,
    delegateTo: 'DAILY_DIGEST',
  },
];

module.exports = { SKILLS: SKILLS };
