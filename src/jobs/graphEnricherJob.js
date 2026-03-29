// ─── Graph Enricher Job ──────────────────────────────────────────────────────
// Analyzes profiles, memories, KB to extract real relationships.
// Runs weekly Sunday 3:00 AM.
'use strict';

var dbClient = require('../services/db/client');
var logger = require('../utils/logger');

async function runGraphEnricher() {
  var supabase = dbClient.getClient();
  if (!supabase) return;
  logger.info('[GRAPH-ENRICH] Starting...');

  var stats = { edges: 0, skipped: 0 };

  try {
    // 1. From channel_profiles: person works_on project
    var { data: channels } = await supabase.from('channel_profiles')
      .select('channel_id, channel_name, cliente, progetto, team_members')
      .not('cliente', 'is', null).limit(50);

    if (channels) {
      for (var ci = 0; ci < channels.length; ci++) {
        var ch = channels[ci];
        var members = Array.isArray(ch.team_members) ? ch.team_members : [];
        var projectName = ch.progetto || ch.cliente || ch.channel_name;

        for (var mi = 0; mi < members.length; mi++) {
          var added = await addEdgeIfNew(supabase, 'person', members[mi], 'works_on', 'project', projectName, 0.8);
          if (added) stats.edges++; else stats.skipped++;
        }

        // client_of relationship
        if (ch.cliente) {
          var added2 = await addEdgeIfNew(supabase, 'company', ch.cliente, 'client_of', 'project', projectName, 0.9);
          if (added2) stats.edges++; else stats.skipped++;
        }
      }
    }

    // 2. From user_profiles: person has role
    var { data: profiles } = await supabase.from('user_profiles')
      .select('slack_user_id, nome, ruolo, progetti, clienti').limit(20);

    if (profiles) {
      for (var pi = 0; pi < profiles.length; pi++) {
        var p = profiles[pi];
        var name = p.nome || p.slack_user_id;

        if (p.ruolo) {
          await addEdgeIfNew(supabase, 'person', name, 'has_role', 'role', p.ruolo, 0.9);
          stats.edges++;
        }

        var progetti = Array.isArray(p.progetti) ? p.progetti : [];
        for (var pri = 0; pri < progetti.length; pri++) {
          var added3 = await addEdgeIfNew(supabase, 'person', name, 'works_on', 'project', progetti[pri], 0.7);
          if (added3) stats.edges++; else stats.skipped++;
        }

        var clienti = Array.isArray(p.clienti) ? p.clienti : [];
        for (var cli = 0; cli < clienti.length; cli++) {
          var added4 = await addEdgeIfNew(supabase, 'person', name, 'manages', 'company', clienti[cli], 0.7);
          if (added4) stats.edges++; else stats.skipped++;
        }
      }
    }

    // 3. From leads: company has status
    var { data: leads } = await supabase.from('leads')
      .select('company_name, status, owner_slack_id')
      .not('status', 'in', '("lost")').limit(50);

    if (leads) {
      for (var li = 0; li < leads.length; li++) {
        var lead = leads[li];
        await addEdgeIfNew(supabase, 'company', lead.company_name, 'has_status', 'status', lead.status, 0.8);
        stats.edges++;
      }
    }
  } catch(e) {
    logger.error('[GRAPH-ENRICH] Error:', e.message);
  }

  logger.info('[GRAPH-ENRICH] Done. New edges:', stats.edges, '| Skipped:', stats.skipped);
  return stats;
}

async function addEdgeIfNew(supabase, fromType, fromId, relationship, toType, toId, weight) {
  try {
    // Check if edge exists
    var { data } = await supabase.from('memory_graph')
      .select('id').eq('from_type', fromType).eq('from_id', fromId)
      .eq('relationship', relationship).eq('to_type', toType).eq('to_id', toId)
      .limit(1);
    if (data && data.length > 0) return false;

    await supabase.from('memory_graph').insert({
      from_type: fromType, from_id: fromId, relationship: relationship,
      to_type: toType, to_id: toId, weight: weight || 0.7, created_by: 'graph_enricher',
    });
    return true;
  } catch(e) { return false; }
}

module.exports = { runGraphEnricher: runGraphEnricher };
