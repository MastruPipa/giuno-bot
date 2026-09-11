// ─── Sessioni di lavoro ricostruite dai timestamp ────────────────────────────
// Ogni artefatto della giornata ha un orario: una revisione di un documento su
// Drive, una versione di un file Figma, un messaggio in un canale, una
// riunione con inizio e fine. Messi in fila per persona formano blocchi di
// lavoro: le pause sopra GAP_MINUTES spezzano il blocco. La durata di una
// sessione esce dai dati, non dal modello; il modello serve solo a darle un
// nome. Il numero di eventi non pesa: contano gli estremi temporali.
//
// Evento: { at: ISO, kind: 'drive'|'figma'|'slack'|'calendar', name, link,
//           minutes (solo calendario: durata reale), channel }

'use strict';

var GAP_MINUTES = 45;
var MIN_SESSION_MINUTES = 15;
var MAX_SESSION_MINUTES = 5 * 60;

function ms(iso) { var t = Date.parse(iso); return isFinite(t) ? t : null; }

function hhmm(t, offset) {
  var d = new Date(t + (offset || 0) * 60000);
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}

function fmtMinutes(m) {
  var h = Math.floor(m / 60), r = m % 60;
  return (h ? h + 'h' : '') + (r ? r + 'min' : '') || '0min';
}

// events → [{ start, end, minutes, events, refs: [{kind,name,count,link,channel}] }]
function buildSessions(events, opts) {
  opts = opts || {};
  var gap = (opts.gapMinutes || GAP_MINUTES) * 60000;
  var pts = [];
  (events || []).forEach(function(e) {
    var t = ms(e.at);
    if (t == null) return;
    var end = e.kind === 'calendar' && Number(e.minutes) > 0 ? t + Number(e.minutes) * 60000 : t;
    pts.push({ start: t, end: end, e: e });
  });
  pts.sort(function(a, b) { return a.start - b.start; });
  var sessions = [];
  var cur = null;
  pts.forEach(function(p) {
    if (cur && p.start - cur.end <= gap) {
      cur.end = Math.max(cur.end, p.end);
      cur.items.push(p.e);
    } else {
      cur = { start: p.start, end: p.end, items: [p.e] };
      sessions.push(cur);
    }
  });
  return sessions.map(function(s) {
    var minutes = Math.round((s.end - s.start) / 60000);
    minutes = Math.max(MIN_SESSION_MINUTES, Math.min(MAX_SESSION_MINUTES, minutes));
    // Riunioni: la durata reale conta anche se è l'unico evento
    var refs = {};
    s.items.forEach(function(e) {
      var key = e.kind + ':' + (e.channel || e.name || '');
      if (!refs[key]) refs[key] = { kind: e.kind, name: e.name || null, channel: e.channel || null, link: e.link || null, count: 0 };
      refs[key].count++;
    });
    return { start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString(), minutes: minutes, events: s.items.length,
      refs: Object.keys(refs).map(function(k) { return refs[k]; }) };
  });
}

function totalMinutes(sessions) { return (sessions || []).reduce(function(a, s) { return a + s.minutes; }, 0); }

// Testo per il prompt: una riga per sessione, con orari locali (offsetMinutes
// rispetto a UTC, es. 120 per Roma d'estate).
function formatSessions(sessions, offsetMinutes) {
  return (sessions || []).map(function(s) {
    var parts = s.refs.map(function(r) {
      if (r.kind === 'slack') return '#' + r.channel + ' (' + r.count + ' messaggi)';
      if (r.kind === 'calendar') return 'riunione "' + r.name + '"';
      if (r.kind === 'figma') return 'Figma "' + r.name + '" (' + r.count + ' versioni)';
      return 'Drive "' + r.name + '" (' + r.count + ' modifiche)';
    });
    return '- ' + hhmm(Date.parse(s.start), offsetMinutes) + '–' + hhmm(Date.parse(s.end), offsetMinutes) + ' (' + fmtMinutes(s.minutes) + '): ' + parts.join('; ');
  }).join('\n');
}

module.exports = { GAP_MINUTES: GAP_MINUTES, buildSessions: buildSessions, totalMinutes: totalMinutes, formatSessions: formatSessions, fmtMinutes: fmtMinutes };
