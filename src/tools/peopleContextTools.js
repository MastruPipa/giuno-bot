// ─── People & Context Tools ─────────────────────────────────────────────────
// Contacts, entity cards, priorities, explicit memory, error tracking.
'use strict';

var db = require('../../supabase');
var logger = require('../utils/logger');

var definitions = [
  {
    name: 'save_contact',
    description: 'Salva un contatto esterno (persona fuori dal team KS). Es. "Marco di Aitho", "Chiara della 869". Collega al lead se esiste.',
    input_schema: {
      type: 'object',
      properties: {
        name:    { type: 'string', description: 'Nome della persona' },
        email:   { type: 'string', description: 'Email (opzionale)' },
        phone:   { type: 'string', description: 'Telefono (opzionale)' },
        role:    { type: 'string', description: 'Ruolo (es. "Marketing Manager", "CEO", "referente")' },
        company: { type: 'string', description: 'Azienda/cliente di appartenenza' },
        notes:   { type: 'string', description: 'Note sul contatto' },
      },
      required: ['name'],
    },
  },
  {
    name: 'search_contacts',
    description: 'Cerca contatti esterni per nome, azienda o ruolo. Usa questo tool quando qualcuno chiede "chi è Marco di Aitho?" o "contatti del cliente X".',
    input_schema: {
      type: 'object',
      properties: {
        query:   { type: 'string', description: 'Nome, azienda o ruolo da cercare' },
        company: { type: 'string', description: 'Filtra per azienda (opzionale)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'entity_card',
    description: 'Genera una SCHEDA COMPLETA di un\'entità (cliente, progetto, fornitore, persona). Raccoglie dati da TUTTE le fonti: CRM, memorie, KB, progetti, contatti, Drive, canali Slack. Usa questo quando l\'utente chiede "tutto su X", "scheda di X", "dossier su X".',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nome dell\'entità (cliente, progetto, persona, fornitore)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'remember_this',
    description: 'Salva esplicitamente un ricordo con alta confidenza. Usa quando l\'utente dice "ricordati che...", "segna che...", "tieni a mente che...". Conferma il salvataggio.',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Cosa ricordare' },
        tags:    { type: 'array', items: { type: 'string' }, description: 'Tag (opzionale)' },
        shared:  { type: 'boolean', description: 'Se true, visibile a tutti. Default false (personale).' },
      },
      required: ['content'],
    },
  },
  {
    name: 'set_priorities',
    description: 'Imposta le priorità della settimana. Queste influenzano il modo in cui Giuno valuta e risponde — tutto ciò che è in lista priorità viene trattato come urgente.',
    input_schema: {
      type: 'object',
      properties: {
        priorities: { type: 'array', items: { type: 'string' }, description: 'Lista priorità (es. ["Lancio sito Aitho", "Chiusura preventivo 869", "Shooting Club House"])' },
      },
      required: ['priorities'],
    },
  },
  {
    name: 'get_priorities',
    description: 'Mostra le priorità della settimana corrente.',
    input_schema: { type: 'object', properties: {} },
  },
];

// ─── Execution ──────────────────────────────────────────────────────────────

async function execute(toolName, input, userId, userRole) {
  input = input || {};
  var supabase = db.getClient ? db.getClient() : null;

  if (toolName === 'save_contact') {
    if (!supabase) return { error: 'DB non disponibile.' };
    if (!input.name) return { error: 'Nome mancante.' };
    try {
      // Try to link to existing lead
      var leadId = null;
      if (input.company) {
        var leads = await db.searchLeads({ company_name: input.company, limit: 1 });
        if (leads && leads.length > 0) leadId = leads[0].id;
      }
      var { data, error } = await supabase.from('contacts').insert({
        name: input.name,
        email: input.email || null,
        phone: input.phone || null,
        role: input.role || null,
        company: input.company || null,
        lead_id: leadId,
        notes: input.notes || null,
        tags: input.tags || [],
        created_by: userId,
      }).select().single();
      if (error) return { error: error.message };
      return { success: true, contact: data, linked_to_lead: !!leadId };
    } catch(e) { return { error: e.message }; }
  }

  if (toolName === 'search_contacts') {
    if (!supabase) return { error: 'DB non disponibile.' };
    try {
      var q = supabase.from('contacts').select('*');
      if (input.company) {
        q = q.ilike('company', '%' + input.company + '%');
      }
      if (input.query) {
        q = q.or('name.ilike.%' + input.query + '%,company.ilike.%' + input.query + '%,role.ilike.%' + input.query + '%,email.ilike.%' + input.query + '%');
      }
      var { data } = await q.order('updated_at', { ascending: false }).limit(10);
      return { contacts: data || [], count: (data || []).length };
    } catch(e) { return { error: e.message }; }
  }

  if (toolName === 'entity_card') {
    if (!input.name) return { error: 'Nome entità mancante.' };
    var card = { name: input.name, sources: {} };

    // 1. CRM
    try {
      var leads = await db.searchLeads({ company_name: input.name, limit: 3 });
      if (leads && leads.length > 0) card.sources.crm = leads;
    } catch(e) { /* ignore */ }

    // 2. Contacts
    if (supabase) {
      try {
        var { data: contacts } = await supabase.from('contacts')
          .select('*')
          .or('company.ilike.%' + input.name + '%,name.ilike.%' + input.name + '%')
          .limit(5);
        if (contacts && contacts.length > 0) card.sources.contacts = contacts;
      } catch(e) { /* ignore */ }
    }

    // 3. Projects
    try {
      var projects = await db.searchProjects({ client_name: input.name, limit: 5 });
      if (!projects || projects.length === 0) projects = await db.searchProjects({ name: input.name, limit: 5 });
      if (projects && projects.length > 0) card.sources.projects = projects;
    } catch(e) { /* ignore */ }

    // 4. Memories
    try {
      var mems = await db.searchMemories(userId, input.name);
      if (mems && mems.length > 0) card.sources.memories = mems.slice(0, 8).map(function(m) { return { content: m.content, type: m.memory_type, created: m.created_at || m.created }; });
    } catch(e) { /* ignore */ }

    // 5. KB
    try {
      var kb = await db.searchKB(input.name);
      if (kb && kb.length > 0) card.sources.kb = kb.slice(0, 5).map(function(k) { return { content: k.content, tier: k.confidence_tier }; });
    } catch(e) { /* ignore */ }

    // 6. Channel
    try {
      var channelMap = db.getChannelMapCache();
      var relatedChannels = [];
      for (var chId in channelMap) {
        var ch = channelMap[chId];
        if ((ch.cliente || '').toLowerCase().includes(input.name.toLowerCase()) ||
            (ch.channel_name || '').toLowerCase().includes(input.name.toLowerCase())) {
          relatedChannels.push({ channel: '#' + ch.channel_name, cliente: ch.cliente, progetto: ch.progetto });
        }
      }
      if (relatedChannels.length > 0) card.sources.channels = relatedChannels;
    } catch(e) { /* ignore */ }

    // 7. Drive
    try {
      var drive = await db.searchDriveContent(input.name, 5);
      if (drive && drive.length > 0) card.sources.drive = drive.map(function(d) { return { file: d.file_name, summary: (d.ai_summary || '').substring(0, 100), link: d.web_link }; });
    } catch(e) { /* ignore */ }

    // 8. Entity resolution
    try {
      var entity = await db.resolveEntity(input.name);
      if (entity) card.entity = entity;
    } catch(e) { /* ignore */ }

    var sourceCount = Object.keys(card.sources).length;
    card.completeness = sourceCount >= 5 ? 'alta' : (sourceCount >= 3 ? 'media' : 'bassa');
    return card;
  }

  if (toolName === 'remember_this') {
    if (!input.content) return { error: 'Contenuto mancante.' };
    var memType = input.shared ? 'semantic' : 'preference';
    var entry = await db.addMemory(userId, input.content, input.tags || [], {
      memory_type: memType,
      confidence_score: 0.95, // High — explicit save
    });
    // Also save to KB if shared
    if (input.shared) {
      db.addKBEntry(input.content, input.tags || [], userId, {
        confidenceTier: 'official',
        sourceType: 'explicit_save',
      });
    }
    return { success: true, saved: input.content.substring(0, 100), type: memType, shared: !!input.shared };
  }

  if (toolName === 'set_priorities') {
    if (!supabase) return { error: 'DB non disponibile.' };
    if (!input.priorities || input.priorities.length === 0) return { error: 'Lista priorità vuota.' };
    try {
      var now = new Date();
      var dayOfWeek = now.getDay();
      var monday = new Date(now);
      monday.setDate(now.getDate() - ((dayOfWeek + 6) % 7));
      var weekStart = monday.toISOString().slice(0, 10);

      await supabase.from('weekly_priorities').upsert({
        week_start: weekStart,
        priorities: input.priorities.map(function(p, i) { return { rank: i + 1, text: p, status: 'active' }; }),
        set_by: userId,
        updated_at: new Date().toISOString(),
      });

      // Also save as high-confidence memory
      var prioText = 'PRIORITÀ SETTIMANA ' + weekStart + ': ' + input.priorities.join(' | ');
      db.addMemory(userId, prioText, ['priorita', 'settimana'], { memory_type: 'procedural', confidence_score: 0.95 });

      return { success: true, week: weekStart, priorities: input.priorities };
    } catch(e) { return { error: e.message }; }
  }

  if (toolName === 'get_priorities') {
    if (!supabase) return { error: 'DB non disponibile.' };
    try {
      var { data } = await supabase.from('weekly_priorities')
        .select('*')
        .order('week_start', { ascending: false })
        .limit(1);
      if (data && data.length > 0) return { week: data[0].week_start, priorities: data[0].priorities, set_by: data[0].set_by };
      return { message: 'Nessuna priorità impostata. Usa set_priorities per impostarle.' };
    } catch(e) { return { error: e.message }; }
  }

  return { error: 'Tool sconosciuto: ' + toolName };
}

module.exports = { definitions: definitions, execute: execute };
