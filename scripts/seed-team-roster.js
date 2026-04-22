#!/usr/bin/env node
// Seed team_members (and kb_entities with entity_category='team') from the
// hardcoded MANSIONI_TEAM map in src/handlers/slackHandlers.js + Slack's
// users.list API to resolve first_name -> slack_user_id. Idempotent.
//
// Usage: node scripts/seed-team-roster.js [--dry-run]

'use strict';

require('dotenv').config();

var { createClient } = require('@supabase/supabase-js');
var { WebClient } = require('@slack/web-api');

var DRY_RUN = process.argv.includes('--dry-run');

var supabaseUrl = process.env.SUPABASE_URL;
var supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
var slackToken  = process.env.SLACK_BOT_TOKEN;

if (!supabaseUrl || !supabaseKey || !slackToken) {
  console.error('Missing env: need SUPABASE_URL, SUPABASE_SERVICE_KEY (or SUPABASE_KEY), SLACK_BOT_TOKEN.');
  process.exit(1);
}

var supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
var slack = new WebClient(slackToken);

// Hand-curated baseline. Same shape as MANSIONI_TEAM but enriched with the
// aliases / main projects / clients that actually matter for disambiguation.
var SEED = [
  { first: 'antonio',   canonical: 'Antonio',    aliases: [],                                role: 'CEO — visione strategica, decisioni finali',             projects: [],                              clients: [] },
  { first: 'corrado',   canonical: 'Corrado',    aliases: [],                                role: 'GM — supervisione operativa, coordinamento reparti',    projects: [],                              clients: [] },
  { first: 'gianna',    canonical: 'Gianna',     aliases: [],                                role: 'COO / PM — controllo finanza e economics',              projects: [],                              clients: [] },
  { first: 'alessandra',canonical: 'Alessandra', aliases: ['ale'],                           role: 'CCO — relazioni commerciali, contatto clienti',         projects: [],                              clients: [] },
  { first: 'nicolò',    canonical: 'Nicolò',     aliases: ['nicolo', 'nico'],                role: 'Direttore Creativo e Digital Strategist',               projects: [],                              clients: [] },
  { first: 'giusy',     canonical: 'Giusy',      aliases: ['giuseppina'],                    role: 'Social Media Manager, Digital Strategist, Junior Copy', projects: [],                              clients: [] },
  { first: 'paolo',     canonical: 'Paolo',      aliases: [],                                role: 'Graphic Designer',                                      projects: [],                              clients: [] },
  { first: 'claudia',   canonical: 'Claudia',    aliases: ['clà', 'cla'],                    role: 'Graphic Designer',                                      projects: [],                              clients: [] },
  { first: 'gloria',    canonical: 'Gloria',     aliases: [],                                role: 'Marketing e Strategist Manager',                        projects: [],                              clients: [] },
  { first: 'peppe',     canonical: 'Peppe',      aliases: ['giuseppe', 'peppino'],           role: 'Logistica — referente progetto OffKatania',             projects: ['OffKatania'],                  clients: [] },
];

async function listSlackUsers() {
  var users = [];
  var cursor;
  while (true) {
    var res = await slack.users.list({ limit: 200, cursor: cursor });
    (res.members || []).forEach(function(u) {
      if (u.deleted || u.is_bot || u.id === 'USLACKBOT') return;
      users.push({
        id: u.id,
        real_name: u.real_name || u.name || '',
        display_name: (u.profile && u.profile.display_name) || '',
      });
    });
    cursor = res.response_metadata && res.response_metadata.next_cursor;
    if (!cursor) break;
  }
  return users;
}

function matchUser(slackUsers, first) {
  var needle = first.toLowerCase();
  return slackUsers.find(function(u) {
    var realFirst = (u.real_name || '').toLowerCase().split(/\s+/)[0] || '';
    var disp = (u.display_name || '').toLowerCase();
    return realFirst === needle || disp === needle || (u.real_name || '').toLowerCase().startsWith(needle + ' ');
  });
}

async function main() {
  var slackUsers = await listSlackUsers();
  console.log('Slack users fetched:', slackUsers.length);

  var upserted = 0, missing = 0;

  for (var i = 0; i < SEED.length; i++) {
    var seed = SEED[i];
    var match = matchUser(slackUsers, seed.first);
    if (!match) {
      console.warn('[SKIP]', seed.canonical, '— nessun Slack user trovato con first_name = "' + seed.first + '"');
      missing++;
      continue;
    }
    console.log('[MATCH]', seed.canonical, '→', match.id, '(' + match.real_name + ')');

    if (DRY_RUN) { upserted++; continue; }

    var teamRow = {
      slack_user_id: match.id,
      canonical_name: seed.canonical,
      aliases: seed.aliases,
      role: seed.role,
      primary_projects: seed.projects,
      primary_clients: seed.clients,
      active: true,
      updated_at: new Date().toISOString(),
    };
    var r1 = await supabase.from('team_members').upsert(teamRow, { onConflict: 'slack_user_id' });
    if (r1.error) { console.error('  team_members upsert error:', r1.error.message); continue; }

    // Also register in kb_entities so the existing entity resolver in
    // memories.addMemory matches these names and tags them with entity refs.
    var entityRow = {
      canonical_name: seed.canonical,
      aliases: seed.aliases,
      entity_category: 'team',
      context: seed.role || null,
    };
    try {
      await supabase.from('kb_entities').upsert(entityRow, { onConflict: 'canonical_name' });
    } catch(e) {
      console.warn('  kb_entities upsert skipped:', e.message);
    }
    upserted++;
  }

  console.log('\nDone.', DRY_RUN ? '(dry-run)' : '', 'Upserted:', upserted, '| Missing:', missing);
}

main().catch(function(e) {
  console.error('Fatal:', e.stack || e.message);
  process.exit(1);
});
