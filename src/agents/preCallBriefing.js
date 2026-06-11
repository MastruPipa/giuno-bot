// ─── Pre-Call Briefing Agent ────────────────────────────────────────────────
// Runs every 30 minutes during work hours.
// Checks calendar for meetings starting in 15-45 minutes.
// Sends DM with briefing: attendees, client status, recent slack activity, docs.
'use strict';

var logger = require('../utils/logger');
var dates = require('../utils/dates');
var db = require('../../supabase');
var { acquireCronLock, releaseCronLock } = require('../../supabase');
var { app, getUtenti } = require('../services/slackService');
var { getCalendarPerUtente } = require('../services/googleAuthService');
var { formatPerSlack } = require('../utils/slackFormat');
var { withTimeout } = require('../utils/timeout');

var { extractSearchTerms } = require('../utils/precallTerms');

async function buildBriefing(userId, event) {
  var title = event.summary || 'Meeting senza titolo';
  var startTime = event.start.dateTime
    ? new Date(event.start.dateTime).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' })
    : 'tutto il giorno';

  // Collect raw data
  var rawData = { title: title, time: startTime, attendees: [], crmData: null, crmChecked: false, crmUnavailable: false, channelDigest: null, projectInfo: null, ownerFacts: null, ownerMemory: null, ownerOpenItems: null };

  var searchTerms = extractSearchTerms(title);

  function relevantToMeeting(text) {
    if (!text) return false;
    var low = String(text).toLowerCase();
    return searchTerms.some(function(t) { return t.length >= 3 && low.indexOf(t.toLowerCase()) !== -1; });
  }

  // Owner context — ONLY what is actually relevant to THIS meeting. Generic open
  // items / summaries (e.g. internal effort-tracking) must not leak into an
  // unrelated client briefing.
  try {
    var userFacts = await db.getUserFacts(userId, 8);
    if (userFacts && userFacts.length > 0) {
      var byCat = {};
      userFacts.forEach(function(f) {
        if (!relevantToMeeting(f.fact)) return;
        (byCat[f.category] = byCat[f.category] || []).push(f.fact);
      });
      if (Object.keys(byCat).length > 0) rawData.ownerFacts = byCat;
    }
  } catch(e) { /* user_facts may not exist */ }

  try {
    var supabase = db.getClient && db.getClient();
    if (supabase) {
      var summ = await supabase.from('conversation_summaries')
        .select('summary, proposed_actions')
        .eq('conv_key', userId)
        .limit(1);
      if (summ.data && summ.data.length > 0) {
        if (summ.data[0].summary && relevantToMeeting(summ.data[0].summary)) {
          rawData.ownerMemory = summ.data[0].summary.substring(0, 600);
        }
        var openItems = (summ.data[0].proposed_actions || []).filter(function(a) {
          return a && a.type === 'open_item' && a.description && relevantToMeeting(a.description);
        });
        if (openItems.length > 0) rawData.ownerOpenItems = openItems.slice(0, 3).map(function(a) { return a.description; });
      }
    }
  } catch(e) { /* non-blocking */ }

  // Attendees
  if (event.attendees) {
    rawData.attendees = event.attendees.filter(function(a) { return !a.self; }).map(function(a) {
      return { name: a.displayName || null, email: a.email, external: a.email && !a.email.endsWith('@kataniastudio.com') };
    });
  }

  // CRM — riusa il grounding Attio condiviso (cerca aziende E deal: una call
  // "Proposta per Kultura" è un deal, non un'azienda) sul titolo + nomi dei
  // partecipanti esterni. Le email esterne cercano la persona in Attio: chiave
  // molto più affidabile dei token del titolo.
  var externalAttendees = rawData.attendees.filter(function(a) { return a.external; });
  try {
    var attioSvc = require('../services/attioService');
    if (attioSvc.isConfigured()) {
      var attioCtxMod = require('../orchestrator/attioContext');
      var crmQueryText = title + ' ' + externalAttendees.map(function(a) { return a.name || ''; }).join(' ');
      var attioData = await withTimeout(attioCtxMod.buildAttioContext(crmQueryText, []), 6000, 'precall_attio');
      rawData.crmChecked = true;
      if (attioData) {
        rawData.crmData = {
          companies: (attioData.companies || []).slice(0, 2).map(function(c) {
            return (c.values && c.values.name) || null;
          }).filter(Boolean),
          deals: (attioData.deals || []).slice(0, 2).map(function(d) {
            var v = d.values || {};
            return {
              name: v.name || null,
              stage: v.stage ? [].concat(v.stage).join('/') : (v.status_trattativa ? [].concat(v.status_trattativa).join('/') : null),
              value: v.value != null ? v.value : null,
              servizio: v.servizio_proposto ? [].concat(v.servizio_proposto).join(', ') : null,
            };
          }),
        };
      }
      // Persona dal CRM via email esterna
      for (var pa = 0; pa < externalAttendees.length && pa < 2; pa++) {
        var em = externalAttendees[pa].email;
        if (!em) continue;
        try {
          var ppl = await withTimeout(attioSvc.queryRecords('people', { email_addresses: { '$contains': em } }, 1), 4000, 'precall_attio_people');
          if (ppl && ppl.length > 0 && ppl[0].values) {
            rawData.crmData = rawData.crmData || {};
            rawData.crmData.person = {
              name: ppl[0].values.name || externalAttendees[pa].name || em,
              email: em,
            };
            break;
          }
        } catch(pe) { logger.debug('[PRECALL] Attio people lookup fallita per', em + ':', pe.message); }
      }
      logger.info('[PRECALL] CRM lookup "' + title.substring(0, 50) + '" →',
        rawData.crmData ? JSON.stringify(rawData.crmData).substring(0, 150) : 'nessun match');
    }
  } catch(e) {
    // Attio giù/timeout ≠ "non ci sono dati": il briefing deve dirlo.
    logger.warn('[PRECALL] Attio non consultabile:', e.message);
    rawData.crmUnavailable = true;
  }

  // Fallback to the internal leads CRM only if Attio gave nothing.
  if (!rawData.crmData) {
    for (var wi = 0; wi < Math.min(searchTerms.length, 5); wi++) {
      if (searchTerms[wi].length < 4) continue;
      try {
        var leads = await db.searchLeads({ company_name: searchTerms[wi], limit: 1 });
        if (leads && leads.length > 0) {
          var l = leads[0];
          rawData.crmData = { company: l.company_name, services: l.services || null, contact: l.contact_name || null };
          break;
        }
      } catch(e) { /* ignore */ }
    }
  }

  // Channel digest
  try {
    var channelMap = db.getChannelMapCache();
    for (var chId in channelMap) {
      var mapping = channelMap[chId];
      if (!mapping.cliente) continue;
      var isRelated = searchTerms.some(function(w) {
        return (mapping.cliente || '').toLowerCase().includes(w.toLowerCase()) ||
               (mapping.channel_name || '').toLowerCase().includes(w.toLowerCase());
      });
      if (isRelated) {
        var digests = db.getChannelDigestCache();
        if (digests[chId] && digests[chId].last_digest) {
          rawData.channelDigest = { channel: mapping.channel_name, digest: digests[chId].last_digest };
        }
        break;
      }
    }
  } catch(e) { /* ignore */ }

  // Projects
  try {
    for (var si = 0; si < Math.min(searchTerms.length, 3); si++) {
      var projects = await db.searchProjects({ client_name: searchTerms[si], limit: 1 });
      if (!projects || projects.length === 0) projects = await db.searchProjects({ name: searchTerms[si], limit: 1 });
      if (projects && projects.length > 0) { rawData.projectInfo = projects[0]; break; }
    }
  } catch(e) { /* ignore */ }

  // Meet link
  var meetLink = null;
  if (event.hangoutLink) meetLink = event.hangoutLink;
  else if (event.conferenceData && event.conferenceData.entryPoints && event.conferenceData.entryPoints[0]) {
    meetLink = event.conferenceData.entryPoints[0].uri;
  }

  // Generate briefing with LLM — no raw dumps, only useful info
  try {
    var Anthropic = require('@anthropic-ai/sdk');
    var llmClient = new Anthropic();
    var res = await llmClient.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: 'Briefing pre-call per agenzia marketing. Max 6 righe, tono naturale.\n' +
        'Scrivi SOLO quello che SAI dai dati. Non inventare scopi, cifre, o strategie.\n' +
        'Non usare CAPS. Non dire "BRIEFING CALL". Non mostrare status CRM tecnici ("lost", "won").\n' +
        'Non inventare valori in € se non sono nei dati.\n' +
        'Stati CRM (campo crmChecked/crmUnavailable):\n' +
        '- crmUnavailable=true → di\' "non sono riuscito a consultare il CRM prima della call", MAI "non ci sono dati".\n' +
        '- crmChecked=true e crmData presente → usa companies/deals/person: nome azienda, nome e servizio del deal, nome del contatto.\n' +
        '- crmChecked=true e crmData assente → puoi dire che sul CRM non risulta nulla di collegato.\n' +
        'Se crmData non combacia chiaramente col titolo/partecipanti, NON ipotizzare azienda o contatto: ' +
        'dai solo orario, partecipanti ed eventuale link.\n' +
        'NON aggiungere promemoria su attività interne (tracking ore, recap, report, effort) o progetti ' +
        'che non riguardano DIRETTAMENTE questo meeting.\n' +
        'Se c\'è un partecipante esterno, metti solo il nome (no email gmail/hotmail).\n' +
        'Se ownerFacts/ownerMemory/ownerOpenItems sono presenti, usali per ricordare al destinatario ' +
        '(che è l\'owner del calendario) cosa stava facendo con questo cliente/progetto: cita 1 fatto pertinente ' +
        'o 1 open item se aiuta. NON riferire tutto il contenuto di ownerMemory, solo quello rilevante al meeting.\n' +
        'Quando citi un collega usa il tag <@U...> dal ROSTER TEAM. Non confondere membri del team con clienti che hanno nomi simili.\n' +
        'Formato: frasi normali, *grassetto* solo per nomi. Conciso.',
      messages: [{ role: 'user',
        content: (db.formatTeamRosterForPrompt ? db.formatTeamRosterForPrompt() + '\n\n' : '') + JSON.stringify(rawData).substring(0, 2000) }],
    });
    var briefingText = res.content[0].text.trim();

    var output = '*📞 ' + title + '* — ' + startTime + '\n\n' + briefingText;
    if (meetLink) output += '\n\n<' + meetLink + '|Entra nella call>';
    return output;
  } catch(e) {
    // Fallback: basic info only
    var fallback = '*📞 ' + title + '* — ' + startTime;
    if (rawData.crmData) fallback += '\nCliente: ' + rawData.crmData.company_name + ' [' + (rawData.crmData.status || '') + ']';
    if (meetLink) fallback += '\n<' + meetLink + '|Entra nella call>';
    return fallback.length > 80 ? fallback : null; // Don't send if too short
  }
}

async function checkUpcomingCalls() {
  var locked = await acquireCronLock('precall_briefing', 5);
  if (!locked) return;
  try {
    var utenti = await getUtenti();
    var now = new Date();
    var from = new Date(now.getTime() + 15 * 60000); // 15 min from now
    var to = new Date(now.getTime() + 45 * 60000);   // 45 min from now
    var sent = 0;

    for (var i = 0; i < utenti.length; i++) {
      var uid = utenti[i].id;
      var cal = getCalendarPerUtente(uid);
      if (!cal) continue;

      try {
        var res = await withTimeout(
          cal.events.list({
            calendarId: 'primary',
            timeMin: from.toISOString(),
            timeMax: to.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 3,
          }),
          8000, 'precall_calendar'
        );

        var events = (res.data.items || []).filter(function(ev) {
          var t = (ev.summary || '').toLowerCase();
          // Skip ALL recurring events (weekly 1:1, daily standups, etc.)
          if (ev.recurringEventId) return false;
          // Skip known routine patterns even if not marked recurring
          if (/stand-?up|daily|sync|check-?in|scrum|weekly|1[:-]1|one.on.one|retrospective|retro|planning|sprint|huddle|coffee|pranzo|lunch|pausa/i.test(t)) return false;
          // Skip events without other attendees (personal blocks, focus time)
          if (!ev.attendees || ev.attendees.length <= 1) return false;
          // Skip all-day events (not calls)
          if (ev.start && ev.start.date && !ev.start.dateTime) return false;
          // Only brief for events with external attendees or client-related titles
          var hasExternal = ev.attendees && ev.attendees.some(function(a) {
            return a.email && !a.email.endsWith('@kataniastudio.com');
          });
          var isClientRelated = /call|meeting|riunione|presentazione|brainstorm|kick.?off|review|demo/i.test(t);
          return hasExternal || isClientRelated;
        });

        for (var ei = 0; ei < events.length; ei++) {
          var ev = events[ei];
          // Check if we already sent a briefing for this event today — use direct DB check
          var briefingKey = 'precall_' + uid + '_' + ev.id + '_' + dates.todayISO();
          try {
            var supabaseCheck = require('../services/db/client').getClient();
            if (supabaseCheck) {
              var { data: existCheck } = await supabaseCheck.from('memories')
                .select('id')
                .ilike('content', '%' + briefingKey + '%')
                .limit(1);
              if (existCheck && existCheck.length > 0) continue; // Already sent today
            }
          } catch(e) { /* proceed if DB check fails */ }

          var briefing = await buildBriefing(uid, ev);

          // Don't send if briefing is too short/empty (no useful info found)
          if (!briefing || briefing.length < 100) {
            logger.debug('[PRECALL] Briefing troppo vuoto per', uid, '— skip');
            continue;
          }
          await app.client.chat.postMessage({ channel: uid, text: formatPerSlack(briefing), unfurl_links: false });
          sent++;

          // Mark as sent
          db.addMemory(uid, briefingKey + ' — briefing inviato', ['precall', 'system', 'internal'], {
            memory_type: 'episodic',
            confidence_score: 0.1, // Low — just a dedup marker, not real memory
          }).catch(function() {});
        }
      } catch(e) {
        logger.debug('[PRECALL] Calendar error for', uid + ':', e.message);
      }
    }

    if (sent > 0) logger.info('[PRECALL] Inviati', sent, 'briefing pre-call.');
  } finally { await releaseCronLock('precall_briefing'); }
}

module.exports = { checkUpcomingCalls: checkUpcomingCalls };
