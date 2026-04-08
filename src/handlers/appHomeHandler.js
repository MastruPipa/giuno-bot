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
  var prefs = getUserPrefs(userId);
  var googleConnected = getGoogleStatus(userId);
  var standup = getStandupStatus(userId);
  var userRole = await getUserRole(userId);

  var now = new Date();
  var dateStr = now.toLocaleDateString('it-IT', {
    weekday: 'long', day: 'numeric', month: 'long',
    timeZone: 'Europe/Rome',
  });

  // ── Header ──────────────────────────────────────────────────────────────
  blocks.push(header('Giuno'));
  blocks.push(context([dateStr + ' · Katania Studio']));
  blocks.push(divider());

  // ── Stato rapido ────────────────────────────────────────────────────────
  var statusItems = [];
  statusItems.push(googleConnected ? '✅ Google collegato' : '❌ Google non collegato');
  if (standup.active) {
    statusItems.push(standup.responded ? '✅ Daily fatto' : '⏳ Daily in attesa');
  }
  blocks.push(section(statusItems.join('  ·  ')));
  blocks.push(divider());

  // ── CRM snapshot (admin/finance/manager) ────────────────────────────────
  if (userRole === 'admin' || userRole === 'finance' || userRole === 'manager') {
    try {
      var leads = await db.searchLeads({ is_active: true, limit: 100 });
      if (leads && leads.length > 0) {
        var byStatus = {};
        leads.forEach(function(l) {
          var s = l.status || 'unknown';
          if (!byStatus[s]) byStatus[s] = 0;
          byStatus[s]++;
        });
        var pipelineText = '*Pipeline:* ';
        var parts = [];
        if (byStatus.new) parts.push(byStatus.new + ' nuovi');
        if (byStatus.contacted) parts.push(byStatus.contacted + ' contattati');
        if (byStatus.proposal_sent) parts.push(byStatus.proposal_sent + ' proposta');
        if (byStatus.negotiating) parts.push(byStatus.negotiating + ' trattativa');
        if (byStatus.won) parts.push(byStatus.won + ' vinti');
        blocks.push(section(pipelineText + parts.join(' · ') + ' (' + leads.length + ' totali)'));
        blocks.push(divider());
      }
    } catch(e) { /* ignore */ }
  }

  // ── Quick actions ───────────────────────────────────────────────────────
  blocks.push(header('Chiedimi'));
  blocks.push(section(
    '🔍 _"Info su Aitho"_  ·  📧 _"Mail non lette"_  ·  📅 _"Agenda domani"_\n' +
    '📂 _"Trova il deck su Drive"_  ·  📊 _"Stato pipeline"_  ·  🌐 _"Cerca azienda X"_'
  ));

  blocks.push(divider());
  blocks.push(context(['Giuno v2 · `/giuno help` per i comandi']));

  return blocks;
}

// ─── Publish home tab ─────────────────────────────────────────────────────────

async function publishHome(userId) {
  try {
    var blocks;
    try {
      blocks = await buildHomeBlocks(userId);
    } catch(buildErr) {
      logger.error('[APP-HOME] buildHomeBlocks error:', buildErr.message);
      // Fallback: show basic home even if build fails
      blocks = [
        header('Giuno — Katania Studio'),
        section('Ciao! Scrivimi in DM o taggami con *@Giuno* in qualsiasi canale.'),
        divider(),
        header('Cosa posso fare'),
        section(
          ':mag: *Cerca ovunque* — _"Cerca info su Aitho"_\n' +
          ':email: *Email* — _"Mail non lette di oggi"_\n' +
          ':calendar: *Calendario* — _"Cosa ho in agenda domani?"_\n' +
          ':bar_chart: *CRM* — _"Stato pipeline"_'
        ),
      ];
    }

    if (!blocks || blocks.length === 0) {
      blocks = [header('Giuno — Katania Studio'), section('Home in caricamento...')];
    }

    await app.client.views.publish({
      user_id: userId,
      view: { type: 'home', blocks: blocks },
    });

    logger.info('[APP-HOME] Home pubblicata per', userId);
  } catch(e) {
    logger.error('[APP-HOME] Errore pubblicazione:', e.message);
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
