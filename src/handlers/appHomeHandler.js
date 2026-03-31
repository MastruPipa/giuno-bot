// ─── App Home Handler ──────────────────────────────────────────────────────────
// Renders the Slack App Home tab for Giuno using Block Kit.
// Shows user profile, daily standup, Google status, recent memories, and quick tips.

'use strict';

var logger = require('../utils/logger');
var db = require('../../supabase');
var { getUserRole } = require('../../rbac');
var { getUserTokens } = require('../services/googleAuthService');
var { app } = require('../services/slackService');

// ─── Block Kit helpers ────────────────────────────────────────────────────────

function header(text) {
  return { type: 'header', text: { type: 'plain_text', text: text, emoji: true } };
}

function section(text) {
  return { type: 'section', text: { type: 'mrkdwn', text: text } };
}

function sectionWithAccessory(text, accessory) {
  return { type: 'section', text: { type: 'mrkdwn', text: text }, accessory: accessory };
}

function divider() {
  return { type: 'divider' };
}

function context(elements) {
  return {
    type: 'context',
    elements: elements.map(function(text) {
      return { type: 'mrkdwn', text: text };
    }),
  };
}

function fields(pairs) {
  return {
    type: 'section',
    fields: pairs.map(function(p) {
      return { type: 'mrkdwn', text: p };
    }),
  };
}

// ─── Data fetchers ────────────────────────────────────────────────────────────

function getUserProfile(userId) {
  var profiles = db.getProfileCache();
  return profiles[userId] || {};
}

function getUserPrefs(userId) {
  return Object.assign(
    { routine_enabled: true, notifiche_enabled: true, standup_enabled: true },
    db.getPrefsCache()[userId] || {}
  );
}

function getGoogleStatus(userId) {
  var tokens = getUserTokens();
  return !!tokens[userId];
}

function getStandupStatus(userId) {
  var sd = db.getStandupCache();
  var oggi = new Date().toISOString().slice(0, 10);
  if (sd.oggi !== oggi) return { active: false };
  var hasResponded = !!(sd.risposte && sd.risposte[userId]);
  var totalResponses = sd.risposte ? Object.keys(sd.risposte).length : 0;
  return { active: true, responded: hasResponded, totalResponses: totalResponses };
}

function getRecentMemories(userId) {
  var memCache = db.getMemCache();
  if (!memCache || !memCache[userId]) return [];
  var now = Date.now();
  return memCache[userId]
    .filter(function(m) {
      if (m.expires_at && new Date(m.expires_at).getTime() < now) return false;
      return true;
    })
    .sort(function(a, b) {
      return new Date(b.created).getTime() - new Date(a.created).getTime();
    })
    .slice(0, 5);
}

function getActiveLeadsCount() {
  try {
    var pipeline = db.getLeadsPipeline ? db.getLeadsPipeline() : null;
    if (pipeline) return pipeline;
  } catch(e) { /* ignore */ }
  return null;
}

// ─── Build blocks ─────────────────────────────────────────────────────────────

async function buildHomeBlocks(userId) {
  var blocks = [];
  var profile = getUserProfile(userId);
  var prefs = getUserPrefs(userId);
  var googleConnected = getGoogleStatus(userId);
  var standup = getStandupStatus(userId);
  var recentMems = getRecentMemories(userId);
  var userRole = await getUserRole(userId);

  var now = new Date();
  var dateStr = now.toLocaleDateString('it-IT', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'Europe/Rome',
  });
  var timeStr = now.toLocaleTimeString('it-IT', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome',
  });

  // ── Welcome ──────────────────────────────────────────────────────────────

  blocks.push(header('Giuno — Katania Studio'));
  blocks.push(section('Ciao! Sono *Giuno*, il tuo assistente interno. Scrivimi in DM o taggami con *@Giuno* in qualsiasi canale.'));
  blocks.push(context([dateStr + ' — ' + timeStr]));
  blocks.push(divider());

  // ── User profile ─────────────────────────────────────────────────────────

  blocks.push(header('Il tuo profilo'));

  var profileFields = [];
  profileFields.push('*Ruolo di accesso:*\n' + (userRole || 'member').toUpperCase());
  if (profile.ruolo) {
    profileFields.push('*Mansione:*\n' + profile.ruolo);
  }
  if (profile.progetti && profile.progetti.length > 0) {
    profileFields.push('*Progetti:*\n' + profile.progetti.join(', '));
  }
  if (profile.clienti && profile.clienti.length > 0) {
    profileFields.push('*Clienti:*\n' + profile.clienti.join(', '));
  }
  if (profile.competenze && profile.competenze.length > 0) {
    profileFields.push('*Competenze:*\n' + profile.competenze.join(', '));
  }
  if (profileFields.length > 0) {
    // Block Kit fields max 10, pairs of 2
    blocks.push(fields(profileFields.slice(0, 10)));
  } else {
    blocks.push(section('_Nessun dato profilo ancora. Giuno imparerà man mano che interagisci._'));
  }

  blocks.push(divider());

  // ── Status panel ─────────────────────────────────────────────────────────

  blocks.push(header('Stato'));

  var googleIcon = googleConnected ? ':white_check_mark:' : ':x:';
  var googleText = googleConnected
    ? googleIcon + ' *Google collegato* — Calendario, Gmail e Drive attivi.'
    : googleIcon + ' *Google non collegato* — Scrivimi _"collega il mio Google"_ per attivare calendario, email e Drive.';
  blocks.push(section(googleText));

  // Standup status
  if (prefs.standup_enabled) {
    var standupIcon = standup.active
      ? (standup.responded ? ':white_check_mark:' : ':hourglass_flowing_sand:')
      : ':zzz:';
    var standupText = standup.active
      ? (standup.responded
        ? standupIcon + ' *Daily completato* — risposta inviata. Recap alle 11:30 in #daily.'
        : standupIcon + ' *Daily in attesa* — rispondi in DM con il tuo update!')
      : standupIcon + ' *Nessun daily attivo oggi.*';
    if (standup.active && standup.totalResponses > 0) {
      standupText += '\n_' + standup.totalResponses + ' risposta/e ricevute finora._';
    }
    blocks.push(section(standupText));
  }

  // Preferences
  var prefsItems = [];
  prefsItems.push('Briefing mattutino: ' + (prefs.routine_enabled ? ':white_check_mark: attivo' : ':no_entry_sign: disattivato'));
  prefsItems.push('Notifiche: ' + (prefs.notifiche_enabled ? ':white_check_mark: attive' : ':no_entry_sign: disattivate'));
  prefsItems.push('Daily standup: ' + (prefs.standup_enabled ? ':white_check_mark: attivo' : ':no_entry_sign: disattivato'));
  blocks.push(context(prefsItems));

  blocks.push(divider());

  // ── Recent memories ──────────────────────────────────────────────────────

  blocks.push(header('Ultime cose che ricordo di te'));

  if (recentMems.length > 0) {
    var memText = recentMems.map(function(m, idx) {
      var typeIcon = {
        'preference': ':brain:',
        'semantic':   ':books:',
        'procedural': ':gear:',
        'intent':     ':dart:',
        'episodic':   ':calendar:',
      }[m.memory_type] || ':memo:';
      var dateLabel = m.created
        ? new Date(m.created).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })
        : '';
      var content = (m.content || '').substring(0, 120);
      if ((m.content || '').length > 120) content += '…';
      return typeIcon + ' ' + content + (dateLabel ? '  _(' + dateLabel + ')_' : '');
    }).join('\n');
    blocks.push(section(memText));
  } else {
    blocks.push(section('_Nessuna memoria ancora. Più interagiamo, più imparo._'));
  }

  blocks.push(divider());

  // ── CRM snapshot (admin/finance/manager) ─────────────────────────────────

  if (userRole === 'admin' || userRole === 'finance' || userRole === 'manager') {
    blocks.push(header('Pipeline CRM'));
    try {
      var leads = await db.searchLeads({ is_active: true, limit: 100 });
      if (leads && leads.length > 0) {
        var byStatus = {};
        leads.forEach(function(l) {
          var s = l.status || 'unknown';
          if (!byStatus[s]) byStatus[s] = 0;
          byStatus[s]++;
        });
        var statusLabels = {
          'new': ':new: Nuovi',
          'contacted': ':speech_balloon: Contattati',
          'proposal_sent': ':envelope: Proposta inviata',
          'negotiating': ':handshake: In trattativa',
          'won': ':trophy: Vinti',
          'lost': ':no_entry: Persi',
          'dormant': ':zzz: Dormienti',
        };
        var pipelineFields = [];
        for (var status in statusLabels) {
          if (byStatus[status]) {
            pipelineFields.push('*' + statusLabels[status] + ':*\n' + byStatus[status]);
          }
        }
        if (pipelineFields.length > 0) {
          blocks.push(fields(pipelineFields.slice(0, 10)));
        }
        blocks.push(context(['Totale lead attivi: ' + leads.length + ' — Usa `/giuno leads` per dettagli']));
      } else {
        blocks.push(section('_Nessun lead attivo nel CRM._'));
      }
    } catch(e) {
      blocks.push(section('_Dati CRM non disponibili._'));
    }
    blocks.push(divider());
  }

  // ── Quick tips ───────────────────────────────────────────────────────────

  blocks.push(header('Cosa posso fare'));
  blocks.push(section(
    ':mag: *Cerca ovunque* — _"Cerca info su Aitho"_\n' +
    ':email: *Email* — _"Mail non lette di oggi"_\n' +
    ':calendar: *Calendario* — _"Cosa ho in agenda domani?"_\n' +
    ':file_folder: *Drive* — _"Trova il deck di Elfo su Drive"_\n' +
    ':bar_chart: *CRM* — _"Stato pipeline"_\n' +
    ':busts_in_silhouette: *Fornitori* — _"Chi è Andrea Lo Pinzi?"_'
  ));
  blocks.push(section(
    ':speech_balloon: *Slack* — _"Cosa si dice nel canale operation?"_\n' +
    ':bulb: *Knowledge* — _"Qual è la rate card?"_\n' +
    ':pencil: *Review* — _"Rivedi questa email prima che la mandi"_\n' +
    ':globe_with_meridians: *Web* — _"Cerca info su azienda X"_'
  ));

  blocks.push(divider());
  blocks.push(context([
    'Giuno v2 — Katania Studio · Scrivi `/giuno help` per i comandi · Powered by Claude'
  ]));

  return blocks;
}

// ─── Publish home tab ─────────────────────────────────────────────────────────

async function publishHome(userId) {
  try {
    var blocks = await buildHomeBlocks(userId);

    await app.client.views.publish({
      user_id: userId,
      view: {
        type: 'home',
        blocks: blocks,
      },
    });

    logger.info('[APP-HOME] Home pubblicata per', userId);
  } catch(e) {
    logger.error('[APP-HOME] Errore pubblicazione home per', userId + ':', e.message);
  }
}

// ─── Register event ───────────────────────────────────────────────────────────

function register() {
  app.event('app_home_opened', async function(args) {
    var event = args.event;
    if (event.tab !== 'home') return;

    try {
      await publishHome(event.user);
    } catch(e) {
      logger.error('[APP-HOME] Errore gestione app_home_opened:', e.message);
    }
  });

  logger.info('[APP-HOME] Event handler registrato.');
}

module.exports = {
  register: register,
  publishHome: publishHome,
  buildHomeBlocks: buildHomeBlocks,
};
