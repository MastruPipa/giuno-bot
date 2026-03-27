// ─── Suppliers Tools ──────────────────────────────────────────────────────────
// search_suppliers, get_supplier — fornitori e collaboratori esterni

'use strict';

var logger = require('../utils/logger');
var db = require('../../supabase');

var definitions = [
  {
    name: 'search_suppliers',
    description: 'Cerca fornitori, freelance e professionisti esterni di Katania Studio. ' +
      'USARE SEMPRE quando vengono menzionati nomi di fornitori, videomaker, fotografi, creator, ' +
      'tipografie, attori, figuranti o collaboratori esterni. ' +
      'IMPORTANTE: nomi comuni (Andrea, Alessandro) possono avere OMONIMI — disambigua dal contesto. ' +
      'Non rispondere mai da memoria su fornitori.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Nome/cognome fornitore o ruolo/specialità' },
        category: { type: 'string', description: 'Filtra: video, foto, creator, smm, attori_figuranti, tipografie, web, design' },
        limit: { type: 'number', description: 'Max risultati (default 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_supplier',
    description: 'Dettagli completi di un fornitore per nome esatto. Usa dopo search_suppliers.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nome canonico del fornitore' },
      },
      required: ['name'],
    },
  },
];

async function execute(toolName, input) {
  var supabase = db.getClient();
  if (!supabase) return { error: 'Supabase non configurato.' };

  if (toolName === 'search_suppliers') {
    try {
      var res = await supabase.rpc('search_suppliers', {
        p_query: (input.query || '').trim(),
        p_category: input.category || null,
        p_limit: input.limit || 5,
      });
      if (res.error) return { error: 'Errore ricerca fornitori: ' + res.error.message };
      var data = res.data || [];
      if (data.length === 0) return { found: false, message: 'Nessun fornitore trovato per: ' + input.query };

      var firstNames = data.map(function(s) { return (s.canonical_name || '').split(' ')[0]; });
      var seen = {};
      var hasDuplicates = false;
      firstNames.forEach(function(n) { if (seen[n]) hasDuplicates = true; seen[n] = true; });

      return {
        found: true,
        count: data.length,
        has_homonyms: hasDuplicates,
        disambiguation_note: hasDuplicates ? 'Trovati più fornitori con nome simile. Disambigua dal contesto.' : null,
        suppliers: data.map(function(s) {
          return {
            name: s.canonical_name, category: s.category, roles: s.roles,
            location: s.location, email: s.email, phone: s.phone,
            level: s.level, quality_price: s.quality_price, notes: s.notes,
            score: s.match_score,
          };
        }),
      };
    } catch(e) {
      logger.error('[SUPPLIERS] Search error:', e.message);
      return { error: 'Errore: ' + e.message };
    }
  }

  if (toolName === 'get_supplier') {
    try {
      var res = await supabase.from('suppliers')
        .select('*')
        .ilike('canonical_name', '%' + (input.name || '') + '%')
        .limit(1);
      if (res.error || !res.data || res.data.length === 0) return { error: 'Fornitore non trovato: ' + input.name };
      return res.data[0];
    } catch(e) { return { error: 'Errore: ' + e.message }; }
  }

  return { error: 'Tool sconosciuto: ' + toolName };
}

module.exports = { definitions: definitions, execute: execute };
