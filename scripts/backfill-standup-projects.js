#!/usr/bin/env node
// Backfill project_id/project_name dentro i task jsonb di standup_entries:
// le entry storiche sono state salvate prima del projectMatcher, quindi i
// task non sono agganciati ai progetti veri.
// Idempotente: i task che hanno già project_id vengono saltati.
// Usage: node scripts/backfill-standup-projects.js [--dry-run] [--llm]
//   --dry-run  mostra cosa cambierebbe senza scrivere
//   --llm      abilita il fallback LLM sui task senza match deterministico
//              (una chiamata Anthropic per entry: usare con criterio)

'use strict';

require('dotenv').config();

var DRY_RUN = process.argv.includes('--dry-run');
var USE_LLM = process.argv.includes('--llm');

var { createClient } = require('@supabase/supabase-js');
var norm = require('../src/jobs/projectFilters').norm;
var matcher = require('../src/services/projectMatcher');

var url = process.env.SUPABASE_URL;
var key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY (or SUPABASE_KEY) in env.');
  process.exit(1);
}

var supabase = createClient(url, key, { auth: { persistSession: false } });

async function loadCatalog() {
  var res = await supabase.from('projects').select('id, name').eq('status', 'active').limit(200);
  if (res.error) throw res.error;
  return (res.data || [])
    .filter(function(p) { return p.id && p.name; })
    .map(function(p) { return { id: String(p.id), name: String(p.name), norm: norm(p.name) }; });
}

function enrichListDeterministic(list, catalog) {
  var changed = 0;
  (list || []).forEach(function(t) {
    if (!t || !t.task || t.project_id) return;
    var hit = matcher.matchTaskAgainstCatalog(t.task, catalog);
    if (hit) { t.project_id = hit.id; t.project_name = hit.name; changed++; }
  });
  return changed;
}

async function main() {
  var catalog = await loadCatalog();
  console.log('Catalogo progetti attivi:', catalog.length);

  var res = await supabase.from('standup_entries')
    .select('id, slack_user_id, date, ieri_tasks, oggi_tasks')
    .order('date', { ascending: true })
    .limit(2000);
  if (res.error) throw res.error;
  var rows = res.data || [];
  console.log('Entry da esaminare:', rows.length, DRY_RUN ? '(dry-run)' : '');

  var updated = 0, matchedTasks = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var ieri = r.ieri_tasks || [];
    var oggi = r.oggi_tasks || [];
    var changed = enrichListDeterministic(ieri, catalog) + enrichListDeterministic(oggi, catalog);

    if (USE_LLM) {
      var before = JSON.stringify([ieri, oggi]);
      await matcher.enrichTasksWithProjects(ieri, { useLlm: true });
      await matcher.enrichTasksWithProjects(oggi, { useLlm: true });
      if (JSON.stringify([ieri, oggi]) !== before) changed++;
    }

    if (changed === 0) continue;
    matchedTasks += changed;
    if (DRY_RUN) {
      console.log('[dry] entry', r.id, r.slack_user_id, r.date, '→', changed, 'task agganciati');
      updated++;
      continue;
    }
    var upd = await supabase.from('standup_entries')
      .update({ ieri_tasks: ieri, oggi_tasks: oggi })
      .eq('id', r.id);
    if (upd.error) {
      console.error('Errore update entry', r.id + ':', upd.error.message);
      continue;
    }
    updated++;
  }
  console.log('Fatto. Entry aggiornate:', updated, '| task agganciati:', matchedTasks);
}

main().catch(function(e) { console.error('Backfill fallito:', e.message); process.exit(1); });
