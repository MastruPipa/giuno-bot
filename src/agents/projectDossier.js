// ─── Dossier di progetto ─────────────────────────────────────────────────────
// Per ogni progetto attivo Giuno tiene una scheda strutturata e aggiornata:
// obiettivi, deliverable, scadenze, team, referenti, decisioni recenti, rischi,
// prossimi passi. Le fonti: documento di kick-off, recap delle call (appunti
// Gemini), canale Slack del progetto (digest + messaggi recenti), ore
// consuntivate, allocazioni, segnali PM. Ogni rebuild produce anche la lista
// dei cambiamenti rispetto alla versione precedente: quelli importanti
// vengono segnalati in DM al responsabile (o agli admin), con throttle.

'use strict';

var logger = require('../utils/logger');
var { MODELS } = require('../config/models');
var { safeParse } = require('../utils/safeCall');

var DOSSIER_MODEL = process.env.GIUNO_MODEL_DOSSIER || MODELS.UTILITY;
var MAX_PER_RUN = Number(process.env.DOSSIER_MAX_PER_RUN) || 10;
var STALE_DAYS = Number(process.env.DOSSIER_STALE_DAYS) || 7;
var NOTIFY_ENABLED = process.env.DOSSIER_NOTIFY_ENABLED !== 'false';
var KICKOFF_MAX_CHARS = 12000;
var CHANNEL_DAYS = 14;

function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9àèéìòù]+/g, ' ').trim(); }

function _db() { return require('../../supabase'); }
function _dossiers() { return require('../services/db/dossiers'); }

// Canali Slack collegati al progetto: per id (progetti chan_*), per nome
// progetto o per cliente nella channel_map.
function channelsForProject(project, channelMap) {
  var out = [];
  var pn = norm(project.name);
  var cn = norm(project.client_name);
  var chanFromId = /^chan_(C[A-Z0-9]+)$/.exec(project.id || '');
  Object.keys(channelMap || {}).forEach(function(chId) {
    var m = channelMap[chId] || {};
    var mp = norm(m.progetto), mc = norm(m.cliente), mn = norm(m.channel_name);
    var hit = (chanFromId && chanFromId[1] === chId) ||
      (pn && (mp === pn || (mp && pn.indexOf(mp) !== -1 && mp.length > 3) || mn.indexOf(pn) !== -1)) ||
      (cn && (mc === cn || mn.indexOf(cn) !== -1));
    if (hit) out.push({ channel_id: chId, channel_name: m.channel_name || chId, cliente: m.cliente || null, progetto: m.progetto || null });
  });
  return out.slice(0, 4);
}

function _cleanSlackText(t) {
  return String(t || '').replace(/<@[A-Z0-9]+(\|[^>]+)?>/g, '@persona').replace(/<(https?:[^|>]+)(\|[^>]+)?>/g, '$1').replace(/\s+/g, ' ').trim();
}

async function fetchChannelActivity(app, channels, sinceMs) {
  var out = [];
  var digests = _db().getChannelDigestCache ? _db().getChannelDigestCache() : {};
  for (var i = 0; i < channels.length; i++) {
    var ch = channels[i];
    var entry = { channel_name: ch.channel_name, digest: (digests[ch.channel_id] && digests[ch.channel_id].last_digest) || null, recent: [] };
    if (app && app.client && app.client.conversations) {
      try {
        var hist = await app.client.conversations.history({ channel: ch.channel_id, oldest: String(Math.floor(sinceMs / 1000)), limit: 80 });
        entry.recent = (hist.messages || [])
          .filter(function(m) { return m.type === 'message' && !m.subtype && m.text; })
          .slice(0, 40)
          .map(function(m) { return { ts: m.ts, text: _cleanSlackText(m.text).substring(0, 240) }; })
          .reverse();
      } catch(e) {
        logger.debug('[DOSSIER] history non leggibile per ' + ch.channel_name + ':', e.message);
      }
    }
    out.push(entry);
  }
  return out;
}

async function readKickoffText(doc, deps) {
  var gauth = deps.gauth || require('../services/googleAuthService');
  var tokens = gauth.getUserTokens() || {};
  var userIds = Object.keys(tokens);
  for (var i = 0; i < userIds.length; i++) {
    var docsApi = deps.docs ? deps.docs[userIds[i]] : gauth.getDocsPerUtente(userIds[i]);
    if (!docsApi) continue;
    try {
      var res = await docsApi.documents.get({ documentId: doc.file_id });
      var { extractDocText } = require('../tools/driveTools');
      var text = extractDocText(res.data.body.content);
      if (text && text.length > 100) return text.substring(0, KICKOFF_MAX_CHARS);
    } catch(e) { /* prova col prossimo utente */ }
  }
  return null;
}

function kbEntriesForProject(kbCache, project, days) {
  var pn = norm(project.name), cn = norm(project.client_name);
  var since = Date.now() - (days || 120) * 86400000;
  return (kbCache || []).filter(function(e) {
    if (!e || !Array.isArray(e.tags)) return false;
    var isRecap = e.tags.indexOf('tipo:meeting_recap') !== -1 || e.tags.indexOf('tipo:kickoff') !== -1;
    if (!isRecap) return false;
    var created = e.created_at ? new Date(e.created_at).getTime() : 0;
    if (created && created < since) return false;
    return e.tags.some(function(t) {
      var m = /^(progetto|cliente):(.+)$/.exec(t);
      if (!m) return false;
      var v = norm(m[2]);
      return v && ((pn && (v === pn || pn.indexOf(v) !== -1 || v.indexOf(pn) !== -1)) || (cn && (v === cn || cn.indexOf(v) !== -1)));
    });
  }).sort(function(a, b) { return new Date(b.created_at || 0) - new Date(a.created_at || 0); }).slice(0, 12);
}

async function collectSources(project, deps) {
  deps = deps || {};
  var db = deps.db || _db();
  var dossiers = deps.dossiers || _dossiers();
  var channelMap = db.getChannelMapCache ? db.getChannelMapCache() : {};
  var kbCache = db.getKBCache ? db.getKBCache() : [];
  var docs = await dossiers.getProjectDocuments(project.id);
  var kickoffDoc = docs.find(function(d) { return d.doc_role === 'kickoff'; }) || null;
  var kickoffText = kickoffDoc ? await readKickoffText(kickoffDoc, deps) : null;
  var channels = channelsForProject(project, channelMap);
  var app = deps.app !== undefined ? deps.app : (function() { try { return require('../services/slackService').app; } catch(_) { return null; } })();
  var activity = await fetchChannelActivity(app, channels, Date.now() - CHANNEL_DAYS * 86400000);
  var since30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  var logs = await dossiers.getProjectTimeLogs(project.id, since30);
  var byPerson = {};
  logs.forEach(function(l) { byPerson[l.slack_user_id] = (byPerson[l.slack_user_id] || 0) + Number(l.hours || 0); });
  var allocations = db.getProjectAllocations ? await db.getProjectAllocations(project.id) : [];
  var signals = await dossiers.getProjectSignals(project.name, 30);
  return {
    kickoff: kickoffDoc ? { file_name: kickoffDoc.file_name, link: kickoffDoc.drive_link, text: kickoffText } : null,
    documents: docs.filter(function(d) { return d.doc_role !== 'kickoff'; }).slice(0, 15),
    recaps: kbEntriesForProject(kbCache, project, 120),
    channels: activity,
    hours30: { total: Object.keys(byPerson).reduce(function(s, k) { return s + byPerson[k]; }, 0), byPerson: byPerson },
    allocations: allocations,
    signals: signals,
  };
}

function hasUsableSources(s) {
  return !!(s.kickoff || (s.recaps && s.recaps.length) || (s.documents && s.documents.length) ||
    (s.channels || []).some(function(c) { return c.digest || (c.recent && c.recent.length); }) || (s.hours30 && s.hours30.total > 0));
}

var DOSSIER_SYSTEM =
  'Sei il project management assistant di Katania Studio. Costruisci o aggiorna la SCHEDA DI PROGETTO usando solo le fonti fornite. ' +
  'Non inventare: se un\'informazione manca scrivi null o lascia la lista vuota. Date in formato YYYY-MM-DD quando note. Italiano, frasi brevi.\n' +
  'Rispondi con un unico JSON valido:\n' +
  '{"stato_sintesi":"3-5 righe: a che punto è il progetto oggi","fase":"kick-off|in corso|in consegna|in attesa cliente|fermo|chiuso|null",' +
  '"obiettivi":["..."],"deliverable":[{"nome":"...","stato":"da fare|in corso|consegnato|null"}],' +
  '"scadenze":[{"cosa":"...","quando":"YYYY-MM-DD o testo","chi":"...|null","stato":"aperta|scaduta|fatta"}],' +
  '"team":["nome — ruolo"],"referenti_cliente":["nome (ruolo)"],"budget":"...|null",' +
  '"decisioni_recenti":["... (data)"],"rischi_blocchi":["..."],"prossimi_passi":[{"cosa":"...","chi":"...|null","entro":"...|null"}],' +
  '"domande_aperte":["..."],' +
  '"cambiamenti":[{"tipo":"scadenza|decisione|rischio|blocco|consegna|budget|team|altro","testo":"cosa è cambiato rispetto alla scheda precedente","importanza":"alta|media|bassa"}]}\n' +
  'Regole per "cambiamenti": confronta con la SCHEDA PRECEDENTE se c\'è; se non c\'è, lista vuota. importanza alta = nuova scadenza entro 10 giorni, blocco, rischio alto, cambio budget/scope, decisione del cliente. ' +
  'Ignora informazioni personali o private non legate al lavoro.';

function buildPrompt(project, sources, previous) {
  var parts = [];
  parts.push('PROGETTO: ' + project.name + (project.client_name ? ' | cliente: ' + project.client_name : '') +
    (project.service_category ? ' | servizi: ' + project.service_category : '') +
    (project.budget_quoted ? ' | budget preventivato: ' + project.budget_quoted + '€' : '') +
    (project.end_date ? ' | fine prevista: ' + project.end_date : '') +
    (project.description ? '\nDescrizione: ' + String(project.description).substring(0, 600) : ''));
  parts.push('OGGI: ' + new Date().toISOString().slice(0, 10));
  if (previous && previous.dossier && Object.keys(previous.dossier).length) {
    var prev = Object.assign({}, previous.dossier); delete prev.cambiamenti;
    parts.push('SCHEDA PRECEDENTE (v' + (previous.version || 1) + ', del ' + String(previous.built_at || previous.updated_at || '').slice(0, 10) + '):\n' + JSON.stringify(prev).substring(0, 6000));
  }
  if (sources.kickoff && sources.kickoff.text) parts.push('DOCUMENTO DI KICK-OFF (' + sources.kickoff.file_name + '):\n' + sources.kickoff.text);
  if (sources.recaps && sources.recaps.length) {
    parts.push('RECAP CALL E RIUNIONI (dal più recente):\n' + sources.recaps.map(function(r) { return '— ' + String(r.created_at || '').slice(0, 10) + '\n' + String(r.content || '').substring(0, 1500); }).join('\n\n'));
  }
  (sources.channels || []).forEach(function(c) {
    var block = [];
    if (c.digest) block.push('Digest: ' + String(c.digest).substring(0, 1500));
    if (c.recent && c.recent.length) block.push('Messaggi ultimi ' + CHANNEL_DAYS + ' giorni:\n' + c.recent.map(function(m) { return '• ' + m.text; }).join('\n'));
    if (block.length) parts.push('CANALE SLACK #' + c.channel_name + ':\n' + block.join('\n'));
  });
  if (sources.documents && sources.documents.length) {
    parts.push('ALTRI DOCUMENTI COLLEGATI:\n' + sources.documents.map(function(d) { return '• ' + d.file_name + (d.doc_role ? ' [' + d.doc_role + ']' : '') + (d.notes ? ' — ' + String(d.notes).substring(0, 160) : ''); }).join('\n'));
  }
  if (sources.hours30 && sources.hours30.total > 0) {
    parts.push('ORE CONSUNTIVATE ULTIMI 30 GIORNI: ' + Math.round(sources.hours30.total * 10) / 10 + 'h totali (' +
      Object.keys(sources.hours30.byPerson).map(function(u) { return '<@' + u + '>: ' + Math.round(sources.hours30.byPerson[u] * 10) / 10 + 'h'; }).join(', ') + ')');
  }
  if (sources.allocations && sources.allocations.length) {
    parts.push('ALLOCAZIONI: ' + sources.allocations.map(function(a) { return '<@' + a.slack_user_id + '>' + (a.role ? ' ' + a.role : '') + (a.hours_allocated ? ' ' + a.hours_allocated + 'h' : ''); }).join(', '));
  }
  if (sources.signals && sources.signals.length) {
    parts.push('SEGNALI PM RECENTI:\n' + sources.signals.map(function(s) { return '• [' + s.signal_type + '] ' + String(s.message_excerpt || '').substring(0, 200); }).join('\n'));
  }
  return parts.join('\n\n');
}

function parseDossier(text) {
  var m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  var d = safeParse('dossier-json', m[0], null);
  if (!d || typeof d !== 'object') return null;
  ['obiettivi', 'deliverable', 'scadenze', 'team', 'referenti_cliente', 'decisioni_recenti', 'rischi_blocchi', 'prossimi_passi', 'domande_aperte', 'cambiamenti'].forEach(function(k) {
    if (!Array.isArray(d[k])) d[k] = [];
  });
  return d;
}

// Fallback deterministico se il modello non compila "cambiamenti": confronta
// scadenze, rischi e prossimi passi come testo normalizzato.
function diffChanges(prevDossier, nextDossier) {
  if (!prevDossier || !Object.keys(prevDossier).length) return [];
  var out = [];
  function texts(list, key) { return (list || []).map(function(x) { return norm(typeof x === 'string' ? x : (x && (x[key] || x.cosa || x.nome || x.testo)) || ''); }).filter(Boolean); }
  var pairs = [['scadenze', 'scadenza', 'cosa'], ['rischi_blocchi', 'rischio', null], ['prossimi_passi', 'altro', 'cosa'], ['decisioni_recenti', 'decisione', null]];
  pairs.forEach(function(p) {
    var before = texts(prevDossier[p[0]], p[2]);
    (nextDossier[p[0]] || []).forEach(function(item) {
      var t = typeof item === 'string' ? item : (item && (item[p[2]] || item.cosa || item.testo)) || '';
      if (t && before.indexOf(norm(t)) === -1) out.push({ tipo: p[1], testo: t, importanza: p[1] === 'scadenza' || p[1] === 'rischio' ? 'alta' : 'media' });
    });
  });
  return out.slice(0, 8);
}

async function buildDossier(project, opts) {
  opts = opts || {};
  var deps = opts.deps || {};
  var dossiers = deps.dossiers || _dossiers();
  var client = deps.client || require('../services/anthropicService').client;
  var previous = opts.previous !== undefined ? opts.previous : await dossiers.getDossier(project.id);
  var sources = opts.sources || await collectSources(project, deps);
  if (!hasUsableSources(sources)) return null;
  var res = await client.messages.create({
    model: opts.model || DOSSIER_MODEL,
    max_tokens: 3000,
    system: DOSSIER_SYSTEM,
    messages: [{ role: 'user', content: buildPrompt(project, sources, previous) }],
  });
  var text = (res.content || []).filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('\n');
  var dossier = parseDossier(text);
  if (!dossier) throw new Error('dossier non parsabile per ' + project.name);
  var changes = dossier.cambiamenti.length ? dossier.cambiamenti : diffChanges(previous && previous.dossier, dossier);
  if (!previous || !previous.dossier || !Object.keys(previous.dossier).length) changes = [];
  var now = new Date().toISOString();
  var row = {
    project_id: project.id,
    dossier: dossier,
    summary: formatDossier(project, { dossier: dossier, built_at: now, version: ((previous && previous.version) || 0) + 1 }, { compact: true }),
    sources: {
      kickoff: sources.kickoff ? { file_name: sources.kickoff.file_name, link: sources.kickoff.link } : null,
      recaps: (sources.recaps || []).length, documents: (sources.documents || []).length,
      channels: (sources.channels || []).map(function(c) { return c.channel_name; }),
      hours30: sources.hours30 ? Math.round(sources.hours30.total * 10) / 10 : 0,
    },
    changelog: ((previous && previous.changelog) || []).concat(changes.length ? [{ at: now, changes: changes }] : []).slice(-20),
    version: ((previous && previous.version) || 0) + 1,
    needs_refresh: false,
    last_source_at: (previous && previous.last_source_at) || now,
    built_at: now,
  };
  await dossiers.saveDossier(row);
  return { row: row, changes: changes, sources: sources };
}

function _list(items, fmt, max) {
  return (items || []).slice(0, max || 6).map(function(x) { return '• ' + fmt(x); }).join('\n');
}

function formatDossier(project, row, opts) {
  opts = opts || {};
  var d = (row && row.dossier) || {};
  var built = row && row.built_at ? String(row.built_at).slice(0, 10) : null;
  var lines = ['*' + project.name + '*' + (project.client_name && norm(project.client_name) !== norm(project.name) ? ' — ' + project.client_name : '') +
    (d.fase ? ' · _' + d.fase + '_' : '') + (built ? ' · scheda v' + (row.version || 1) + ' del ' + built : '')];
  if (d.stato_sintesi) lines.push(d.stato_sintesi);
  if (d.scadenze.length) lines.push('*Scadenze:*\n' + _list(d.scadenze.filter(function(s) { return s.stato !== 'fatta'; }), function(s) { return s.cosa + (s.quando ? ' — ' + s.quando : '') + (s.chi ? ' (' + s.chi + ')' : '') + (s.stato === 'scaduta' ? ' ⚠️ scaduta' : ''); }, opts.compact ? 5 : 10));
  if (d.rischi_blocchi.length) lines.push('*Rischi e blocchi:*\n' + _list(d.rischi_blocchi, String, opts.compact ? 4 : 8));
  if (d.prossimi_passi.length) lines.push('*Prossimi passi:*\n' + _list(d.prossimi_passi, function(p) { return p.cosa + (p.chi ? ' — ' + p.chi : '') + (p.entro ? ' entro ' + p.entro : ''); }, opts.compact ? 5 : 10));
  if (!opts.compact) {
    if (d.obiettivi.length) lines.push('*Obiettivi:*\n' + _list(d.obiettivi, String, 8));
    if (d.deliverable.length) lines.push('*Deliverable:*\n' + _list(d.deliverable, function(x) { return x.nome + (x.stato ? ' [' + x.stato + ']' : ''); }, 12));
    if (d.decisioni_recenti.length) lines.push('*Decisioni recenti:*\n' + _list(d.decisioni_recenti, String, 8));
    if (d.domande_aperte.length) lines.push('*Domande aperte:*\n' + _list(d.domande_aperte, String, 6));
    if (d.team.length) lines.push('*Team:* ' + d.team.join(', '));
    if (d.referenti_cliente.length) lines.push('*Referenti cliente:* ' + d.referenti_cliente.join(', '));
    if (d.budget) lines.push('*Budget:* ' + d.budget);
    if (row && row.sources) {
      var s = row.sources;
      lines.push('_Fonti: ' + [s.kickoff ? 'kick-off' : null, s.recaps ? s.recaps + ' recap' : null, s.channels && s.channels.length ? '#' + s.channels.join(', #') : null, s.hours30 ? s.hours30 + 'h consuntivate (30gg)' : null].filter(Boolean).join(' · ') + '_');
    }
  }
  return lines.join('\n\n');
}

// Candidati al refresh: progetti attivi (non categorie) con fonti nuove o
// scheda vecchia. Prima quelli marcati needs_refresh, poi i mai costruiti.
async function pickCandidates(deps) {
  var db = deps.db || _db();
  var dossiers = deps.dossiers || _dossiers();
  var projects = (await db.searchProjects({ status: 'active', limit: 200 })).filter(function(p) { return p.id && !/^cat_/.test(p.id); });
  var rows = await dossiers.listDossiers();
  var byId = {};
  rows.forEach(function(r) { byId[r.project_id] = r; });
  var staleMs = STALE_DAYS * 86400000;
  var scored = projects.map(function(p) {
    var r = byId[p.id];
    var score = 0;
    if (r && r.needs_refresh) score = 3;
    else if (!r || !r.built_at) score = 1;
    else if (Date.now() - new Date(r.built_at).getTime() > staleMs) score = 2;
    return { project: p, row: r || null, score: score };
  }).filter(function(x) { return x.score > 0; });
  scored.sort(function(a, b) { return b.score - a.score; });
  return scored;
}

async function refreshDossiers(opts) {
  opts = opts || {};
  var deps = opts.deps || {};
  var candidates = opts.projects ? opts.projects.map(function(p) { return { project: p, row: null, score: 9 }; }) : await pickCandidates(deps);
  var limit = opts.limit || MAX_PER_RUN;
  var report = { considered: candidates.length, built: 0, skipped: 0, errors: 0, notified: 0, items: [] };
  for (var i = 0; i < candidates.length && report.built + report.skipped + report.errors < limit; i++) {
    var c = candidates[i];
    try {
      var out = await buildDossier(c.project, { deps: deps, previous: c.row || undefined, model: opts.model });
      if (!out) {
        report.skipped++;
        if (c.row && c.row.needs_refresh) { c.row.needs_refresh = false; await (deps.dossiers || _dossiers()).saveDossier(c.row); }
        continue;
      }
      report.built++;
      report.items.push({ project: c.project.name, version: out.row.version, changes: out.changes.length });
      if (out.changes.length && !opts.silent) {
        var n = await notifyChanges(c.project, out.row, out.changes, deps);
        report.notified += n;
      }
    } catch(e) {
      report.errors++;
      logger.error('[DOSSIER] ' + c.project.name + ':', e.message);
    }
  }
  logger.info('[DOSSIER] refresh: ' + report.built + ' costruiti, ' + report.skipped + ' senza fonti, ' + report.errors + ' errori, ' + report.notified + ' avvisi');
  return report;
}

function formatChangesMessage(project, changes) {
  return '📌 *' + project.name + '* — novità dal dossier:\n' +
    changes.map(function(ch) { return '• ' + (ch.tipo ? '[' + ch.tipo + '] ' : '') + ch.testo; }).join('\n') +
    '\n_Scheda completa: "Giuno, a che punto è ' + project.name + '?"_';
}

// Avvisa il responsabile (o gli admin) dei cambiamenti importanti, con
// throttle su followup_log: stesso cambiamento non più di una volta.
async function notifyChanges(project, row, changes, deps) {
  if (!NOTIFY_ENABLED) return 0;
  var important = (changes || []).filter(function(c) { return c && c.importanza === 'alta' && c.testo; });
  if (important.length === 0) return 0;
  var gate = deps.gate || require('../utils/proactiveGate');
  var supabase = deps.supabase !== undefined ? deps.supabase : (function() { try { return require('../services/db/client').getClient(); } catch(_) { return null; } })();
  var app = deps.app !== undefined ? deps.app : (function() { try { return require('../services/slackService').app; } catch(_) { return null; } })();
  if (!app || !app.client) return 0;
  var recipients = [];
  if (project.owner_slack_id) recipients.push(project.owner_slack_id);
  else {
    var roles = deps.roles || (await (async function() { try { return await require('../../rbac').getAllRoles(); } catch(_) { return []; } })());
    recipients = roles.filter(function(r) { return r.role === 'admin'; }).map(function(r) { return r.slack_user_id; });
  }
  var sent = 0;
  for (var i = 0; i < recipients.length; i++) {
    var uid = recipients[i];
    if (!gate.notificheEnabled(uid)) continue;
    var fresh = [];
    for (var j = 0; j < important.length; j++) {
      var hash = gate.itemHash('dossier:' + project.id + ':' + important[j].testo);
      var allowed = supabase ? await gate.followupAllowed(supabase, uid, hash, { cooldownDays: 30, maxAttempts: 1 }) : { allowed: true, attempts: 0 };
      if (allowed.allowed) fresh.push({ change: important[j], hash: hash, attempts: allowed.attempts });
    }
    if (fresh.length === 0) continue;
    try {
      await app.client.chat.postMessage({ channel: uid, text: formatChangesMessage(project, fresh.map(function(f) { return f.change; })) });
      sent++;
      for (var k = 0; k < fresh.length; k++) if (supabase) await gate.recordFollowup(supabase, uid, fresh[k].hash, project.name + ': ' + fresh[k].change.testo, fresh[k].attempts);
    } catch(e) { logger.warn('[DOSSIER] avviso a ' + uid + ' fallito:', e.message); }
  }
  return sent;
}

// Lunedì mattina: una riga per progetto con scheda, agli admin.
function formatWeeklyBrief(entries) {
  if (!entries.length) return null;
  var lines = ['*Stato progetti — settimana del ' + new Date().toISOString().slice(0, 10) + '*'];
  entries.forEach(function(e) {
    var d = e.row.dossier || {};
    var next = (d.scadenze || []).filter(function(s) { return s.stato !== 'fatta'; })[0];
    var risk = (d.rischi_blocchi || [])[0];
    lines.push('• *' + e.project.name + '*' + (d.fase ? ' (' + d.fase + ')' : '') + (d.stato_sintesi ? ': ' + String(d.stato_sintesi).split(/(?<=[.!?])\s/)[0] : '') +
      (next ? '\n   ⏰ ' + next.cosa + (next.quando ? ' — ' + next.quando : '') : '') + (risk ? '\n   ⚠️ ' + risk : ''));
  });
  lines.push('_Per la scheda completa: "a che punto è <progetto>?"_');
  return lines.join('\n');
}

async function weeklyProjectsBrief(deps) {
  deps = deps || {};
  var db = deps.db || _db();
  var dossiers = deps.dossiers || _dossiers();
  var rows = await dossiers.listDossiers();
  var projects = await db.searchProjects({ status: 'active', limit: 200 });
  var byId = {};
  projects.forEach(function(p) { byId[p.id] = p; });
  var entries = rows.filter(function(r) { return r.dossier && Object.keys(r.dossier).length && byId[r.project_id]; })
    .map(function(r) { return { row: r, project: byId[r.project_id] }; })
    .sort(function(a, b) { return String(a.project.name).localeCompare(String(b.project.name)); })
    .slice(0, 25);
  var text = formatWeeklyBrief(entries);
  if (!text) return 0;
  var app = deps.app !== undefined ? deps.app : require('../services/slackService').app;
  var roles = deps.roles || await require('../../rbac').getAllRoles();
  var admins = roles.filter(function(r) { return r.role === 'admin'; });
  var sent = 0;
  for (var i = 0; i < admins.length; i++) {
    try { await app.client.chat.postMessage({ channel: admins[i].slack_user_id, text: text }); sent++; } catch(e) { logger.warn('[DOSSIER] brief settimanale a ' + admins[i].slack_user_id + ' fallito:', e.message); }
  }
  return sent;
}

// Trova un progetto attivo per nome (catalogo + ricerca DB).
async function findProject(name, deps) {
  deps = deps || {};
  var db = deps.db || _db();
  var matcher = deps.matcher || require('../services/projectMatcher');
  var catalog = await matcher.getCatalog();
  var hit = matcher.matchTaskAgainstCatalog(name, catalog);
  if (!hit) {
    var n = norm(name);
    hit = catalog.find(function(p) { return p.norm && (p.norm.indexOf(n) !== -1 || n.indexOf(p.norm) !== -1); }) || null;
  }
  if (hit) return await db.getProject(hit.id);
  var found = await db.searchProjects({ name: name, status: 'active', limit: 1 });
  return (found && found[0]) || null;
}

function formatRefreshReport(r) {
  var lines = ['*Dossier progetti:* ' + r.built + ' aggiornati, ' + r.skipped + ' senza fonti, ' + r.errors + ' errori, ' + r.notified + ' avvisi inviati (' + r.considered + ' candidati)'];
  (r.items || []).forEach(function(it) { lines.push('• ' + it.project + ' → v' + it.version + (it.changes ? ' (' + it.changes + ' cambiamenti)' : '')); });
  return lines.join('\n');
}

module.exports = {
  channelsForProject: channelsForProject,
  kbEntriesForProject: kbEntriesForProject,
  collectSources: collectSources,
  hasUsableSources: hasUsableSources,
  buildPrompt: buildPrompt,
  parseDossier: parseDossier,
  diffChanges: diffChanges,
  buildDossier: buildDossier,
  formatDossier: formatDossier,
  pickCandidates: pickCandidates,
  refreshDossiers: refreshDossiers,
  formatChangesMessage: formatChangesMessage,
  notifyChanges: notifyChanges,
  formatWeeklyBrief: formatWeeklyBrief,
  weeklyProjectsBrief: weeklyProjectsBrief,
  findProject: findProject,
  formatRefreshReport: formatRefreshReport,
  DOSSIER_MODEL: DOSSIER_MODEL,
};
