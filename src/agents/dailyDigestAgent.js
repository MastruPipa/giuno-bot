// ─── Daily Digest Agent V3 ───────────────────────────────────────────────────
// Personalized briefing: admin sees everything, team sees only their projects.
'use strict';

var logger = require('../utils/logger');
var registry = require('../tools/registry');
var dbClient = require('../services/db/client');
var {
  isInternalProjectText,
  isLikelyStaleEvent,
  extractExcludedPhrases,
  shouldExcludeText,
} = require('../utils/briefingFilters');

var SYSTEM_PROMPT_ADMIN =
  'Sei Giuno, assistente di Katania Studio (agenzia creativa, 9 persone).\n' +
  'Costruisci il BRIEFING COMPLETO per il CEO/admin.\n\n' +
  'STRUTTURA (max 30 righe):\n' +
  '1. *Priorità* — scadenze e azioni urgenti\n' +
  '2. *Agenda* — eventi calendario\n' +
  '3. *Tutti i progetti* — stato veloce per ognuno\n' +
  '4. *Pipeline CRM* — lead in movimento\n' +
  '5. *Mail importanti*\n' +
  '6. *Alert* — ritardi, blocchi, canali silenti\n\n' +
  'Sii OPERATIVO: nomi, date, azioni. Zero frasi generiche. Ometti sezioni vuote.\n' +
  'Usa *grassetto* singolo. MAI ** o ##. Non chiedere chiarimenti.';

var SYSTEM_PROMPT_TEAM =
  'Sei Giuno, assistente di Katania Studio.\n' +
  'Costruisci il BRIEFING PERSONALIZZATO per questo membro del team.\n\n' +
  'REGOLA CHIAVE: mostra SOLO i progetti dove questa persona è coinvolta.\n' +
  'NON mostrare progetti di altri colleghi.\n\n' +
  'STRUTTURA (max 20 righe):\n' +
  '1. *Le tue priorità* — scadenze e task che ti riguardano\n' +
  '2. *Agenda* — eventi calendario\n' +
  '3. *I tuoi progetti* — stato dei progetti dove sei nel team\n' +
  '4. *Mail importanti*\n\n' +
  'Sii diretto e personale. Usa "tu" non "il team".\n' +
  'Usa *grassetto* singolo. MAI ** o ##.';

var TOOLS = registry.getToolsForAgent('dailyDigest');

// ─── Build personalized context ──────────────────────────────────────────────

async function buildPersonalizedContext(ctx) {
  var parts = [];
  var supabase = dbClient.getClient();
  var now = new Date();
  var excludedPhrases = [];

  parts.push('DATA: ' + now.toLocaleDateString('it-IT', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Europe/Rome' }) +
    ' ore ' + now.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' }));

  if (!supabase) return { parts: parts, isAdmin: false, userName: null };

  // Get user profile with name and digest scope
  var isAdmin = ctx.userRole === 'admin' || ctx.userRole === 'finance';
  var userName = null;
  var digestScope = isAdmin ? 'full' : 'team';

  try {
    var { data: profile } = await supabase.from('user_profiles')
      .select('nome, digest_scope, is_admin')
      .eq('slack_user_id', ctx.userId)
      .maybeSingle();
    if (profile) {
      userName = profile.nome || null;
      if (profile.digest_scope) digestScope = profile.digest_scope;
      if (profile.is_admin) isAdmin = true;
    }
  } catch(e) {
    logger.warn('[DAILY-DIGEST] fetch fallito:', e.message);
  }

  // User correction memories used as hard constraints for briefing generation
  try {
    var { data: corrections } = await supabase.from('memories')
      .select('content')
      .ilike('content', '%CORREZIONE_BRIEFING:%')
      .order('created_at', { ascending: false })
      .limit(20);
    excludedPhrases = extractExcludedPhrases(corrections || []);
  } catch (e) {
    logger.warn('[DAILY-DIGEST] fetch correzioni fallito:', e.message);
  }

  if (userName) parts.push('UTENTE: ' + userName + ' | Scope: ' + digestScope);
  if (ctx.profile && ctx.profile.ruolo) {
    var pStr = 'RUOLO: ' + ctx.profile.ruolo;
    if (ctx.profile.progetti && ctx.profile.progetti.length > 0) pStr += ' | Progetti: ' + ctx.profile.progetti.join(', ');
    parts.push(pStr);
  }

  // Deadlines from memories
  try {
    var memQuery = supabase.from('memories')
      .select('content, memory_type, entity_refs')
      .or('memory_type.eq.intent,content.ilike.%scadenza%,content.ilike.%deadline%,content.ilike.%entro%,content.ilike.%consegna%')
      .is('superseded_by', null)
      .or('expires_at.is.null,expires_at.gt.' + now.toISOString())
      .order('created_at', { ascending: false }).limit(15);

    var { data: deadlines } = await memQuery;
    if (deadlines && deadlines.length > 0) {
      // For team members: filter deadlines that mention their name
      if (!isAdmin && userName) {
        var personalDeadlines = deadlines.filter(function(m) {
          return (m.content || '').toLowerCase().includes(userName.toLowerCase());
        });
        // If few personal ones, add generic unattributed deadlines
        if (personalDeadlines.length < 3) {
          var generic = deadlines.filter(function(m) {
            var c = (m.content || '').toLowerCase();
            // No specific person mentioned
            return !(/alessandra|nicolò|giusy|paolo|corrado|gianna|gloria|claudia|teresa/i.test(c));
          });
          personalDeadlines = personalDeadlines.concat(generic).slice(0, 8);
        }
        deadlines = personalDeadlines;
      }
      if (deadlines.length > 0) {
        parts.push('SCADENZE:\n' + deadlines.map(function(m) { return '• [' + m.memory_type + '] ' + m.content; }).join('\n'));
      }
    }
  } catch(e) {
    logger.warn('[DAILY-DIGEST] fetch fallito:', e.message);
  }

  // Active projects from channel_profiles
  try {
    var projQuery = supabase.from('channel_profiles')
      .select('channel_name, cliente, progetto, project_phase, team_members, description')
      .not('cliente', 'is', null).not('project_phase', 'eq', 'chiuso')
      .order('updated_at', { ascending: false }).limit(20);

    var { data: projects } = await projQuery;
    if (projects && projects.length > 0) {
      projects = projects.filter(function(p) {
        var text = [p.channel_name, p.cliente, p.progetto, p.description].filter(Boolean).join(' | ');
        if (shouldExcludeText(text, excludedPhrases)) return false;
        return true;
      });

      // For team members: filter to their projects only
      if (!isAdmin && userName) {
        projects = projects.filter(function(p) {
          if (!p.team_members) return false;
          var members = Array.isArray(p.team_members) ? p.team_members : [];
          return members.some(function(m) {
            return (m || '').toLowerCase().includes(userName.toLowerCase()) ||
              userName.toLowerCase().includes((m || '').toLowerCase());
          });
        });
      }
      if (projects.length > 0) {
        var clientProjects = projects.filter(function(p) {
          var text = [p.cliente, p.progetto, p.channel_name, p.description].filter(Boolean).join(' | ');
          return !isInternalProjectText(text);
        });
        var internalProjects = projects.filter(function(p) {
          var text = [p.cliente, p.progetto, p.channel_name, p.description].filter(Boolean).join(' | ');
          return isInternalProjectText(text);
        });

        function renderProjects(label, rows) {
          if (!rows || rows.length === 0) return;
          parts.push(label + ':\n' + rows.map(function(p) {
            var line = '• #' + p.channel_name;
            if (p.cliente) line += ' [' + p.cliente + ']';
            if (p.project_phase) line += ' fase: ' + p.project_phase;
            if (p.description && !isLikelyStaleEvent(p.description)) line += ' — ' + p.description;
            if (isAdmin && p.team_members) {
              var members = Array.isArray(p.team_members) ? p.team_members : [];
              if (members.length > 0) line += ' (team: ' + members.slice(0, 3).join(', ') + ')';
            }
            return line;
          }).join('\n'));
        }

        if (isAdmin) {
          renderProjects('PROGETTI CLIENTE ATTIVI', clientProjects);
          renderProjects('PROGETTI INTERNI ATTIVI', internalProjects);
        } else {
          renderProjects('I TUOI PROGETTI', clientProjects.concat(internalProjects));
        }
      }
    }
  } catch(e) {
    logger.warn('[DAILY-DIGEST] fetch fallito:', e.message);
  }

  // Projects from projects table (with budget/hours data)
  try {
    var db = require('../../supabase');
    var dbProjects = await db.searchProjects({ status: 'active', limit: 20 });
    if (dbProjects && dbProjects.length > 0) {
      // For team members: filter to their projects
      if (!isAdmin && ctx.userId) {
        var userAllocs = await db.getUserAllocations(ctx.userId);
        var userProjectIds = {};
        (userAllocs || []).forEach(function(a) { userProjectIds[a.project_id] = true; });
        if (Object.keys(userProjectIds).length > 0) {
          dbProjects = dbProjects.filter(function(p) { return userProjectIds[p.id]; });
        }
      }
      if (dbProjects.length > 0) {
        var projLines = dbProjects.map(function(p) {
          var line = '• ' + p.name;
          if (p.client_name) line += ' [' + p.client_name + ']';
          if (p.budget_quoted && p.budget_actual) {
            var delta = parseFloat(p.budget_actual) - parseFloat(p.budget_quoted);
            var deltaPct = Math.round((delta / parseFloat(p.budget_quoted)) * 100);
            var icon = deltaPct > 25 ? '🔴' : (deltaPct > 10 ? '🟡' : '🟢');
            line += ' ' + icon + ' €' + Math.round(p.budget_actual) + '/€' + Math.round(p.budget_quoted) + ' (' + (delta > 0 ? '+' : '') + deltaPct + '%)';
          } else if (p.budget_quoted) {
            line += ' budget: €' + Math.round(p.budget_quoted);
          }
          if (p.end_date) {
            var daysLeft = Math.ceil((new Date(p.end_date) - now) / 86400000);
            if (daysLeft < 0) line += ' ⚠️ scaduto da ' + Math.abs(daysLeft) + 'gg';
            else if (daysLeft <= 7) line += ' ⏰ ' + daysLeft + 'gg rimasti';
          }
          return line;
        });
        parts.push('PROGETTI (con metriche):\n' + projLines.join('\n'));
      }
    }
  } catch(e) {
    logger.warn('[DAILY-DIGEST] fetch progetti fallito:', e.message);
  }

  // Admin-only: CRM pipeline summary
  if (isAdmin) {
    try {
      var { data: pipeline } = await supabase.from('leads')
        .select('status, company_name, source, notes')
        .not('status', 'in', '("won","lost")');
      if (pipeline && pipeline.length > 0) {
        pipeline = pipeline.filter(function(l) {
          var text = [l.company_name, l.source, l.notes].filter(Boolean).join(' | ');
          if (shouldExcludeText(text, excludedPhrases)) return false;
          return !isInternalProjectText(text);
        });
      }
      if (pipeline && pipeline.length > 0) {
        var byStatus = {};
        pipeline.forEach(function(l) { byStatus[l.status] = (byStatus[l.status] || 0) + 1; });
        var pipeStr = 'PIPELINE CRM: ';
        var labels = { 'new': 'Nuovi', 'contacted': 'Contattati', 'proposal_sent': 'Proposta', 'negotiating': 'Trattativa' };
        var pipeParts = [];
        for (var s in labels) { if (byStatus[s]) pipeParts.push(labels[s] + ': ' + byStatus[s]); }
        if (pipeParts.length > 0) parts.push(pipeStr + pipeParts.join(' | '));
      }
    } catch(e) {
      logger.warn('[DAILY-DIGEST] fetch fallito:', e.message);
    }

    // Admin: PM signals
    try {
      var { data: signals } = await supabase.from('pm_signals')
        .select('signal_type, message_excerpt, urgency_score')
        .eq('status', 'open').gte('urgency_score', 3)
        .order('urgency_score', { ascending: false }).limit(5);
      if (signals && signals.length > 0) {
        parts.push('ALERT PM:\n' + signals.map(function(s) {
          return '• ' + (s.urgency_score >= 5 ? '🔴' : '🟡') + ' ' + s.message_excerpt;
        }).join('\n'));
      }
    } catch(e) {
      logger.warn('[DAILY-DIGEST] fetch fallito:', e.message);
    }
  }

  // Recent KB entries (24h)
  try {
    var { data: recentKB } = await supabase.from('knowledge_base')
      .select('content, confidence_tier')
      .gte('created_at', new Date(now - 86400000).toISOString())
      .eq('validation_status', 'approved')
      .order('confidence_score', { ascending: false }).limit(3);
    if (recentKB && recentKB.length > 0) {
      parts.push('NUOVE INFO:\n' + recentKB.map(function(k) { return '• ' + (k.content || '').substring(0, 120); }).join('\n'));
    }
  } catch(e) {
    logger.warn('[DAILY-DIGEST] fetch fallito:', e.message);
  }

  return { parts: parts, isAdmin: isAdmin, userName: userName };
}

// ─── Main agent ──────────────────────────────────────────────────────────────

async function run(message, ctx) {
  var Anthropic = require('@anthropic-ai/sdk');
  var client = new Anthropic();

  var contextData = await buildPersonalizedContext(ctx);
  var systemPrompt = contextData.isAdmin ? SYSTEM_PROMPT_ADMIN : SYSTEM_PROMPT_TEAM;
  var fullSystem = systemPrompt + '\n\n---\nCONTESTO OPERATIVO:\n' + contextData.parts.join('\n\n');

  var messages = [{ role: 'user', content: message }];
  var finalReply = '';

  while (true) {
    var response;
    try {
      response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: contextData.isAdmin ? 1000 : 700,
        system: fullSystem, messages: messages, tools: TOOLS,
      });
    } catch(e) { logger.error('[DIGEST-V3]', e.message); throw e; }

    if (response.stop_reason !== 'tool_use') {
      finalReply = response.content.filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('\n');
      break;
    }
    messages.push({ role: 'assistant', content: response.content });
    var toolResults = await Promise.all(response.content.filter(function(b) { return b.type === 'tool_use'; }).map(async function(tu) {
      var result = await registry.executeToolCall(tu.name, tu.input, ctx.userId, ctx.userRole);
      return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) };
    }));
    messages.push({ role: 'user', content: toolResults });
  }

  var { autoLearn } = require('../services/anthropicService');
  if (finalReply && finalReply.length > 20) {
    autoLearn(ctx.userId, message, finalReply, { channelId: ctx.channelId, channelType: ctx.channelType, isDM: ctx.isDM }).catch(function() {});
  }
  return finalReply;
}

module.exports = { run: run };
