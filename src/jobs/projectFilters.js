// ─── Project Filters ─────────────────────────────────────────────────────────
// Helper condivisi tra i sync job (Attio + canali Slack) per tenere pulita la
// lista progetti: finestra di attività, denylist di canali generici e nomi
// spazzatura, e match di nomi per dedup/gate. Tutte le liste sono ESTENDIBILI:
// aggiungere voci qui per filtrare di più senza toccare la logica.
'use strict';

// Finestra di attività: un canale conta come "attivo" se ha avuto ≥1 messaggio
// in questo numero di giorni. Usata sia per i progetti da canale sia per il
// gate dei deal Won (un Won resta solo se il suo canale è attivo).
var ACTIVITY_WINDOW_DAYS = 30;

function norm(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/\\/g, '').trim();
}

// Canali generici/di servizio che NON devono diventare progetti, anche se il
// mapper li ha taggati "interno". Denylist estendibile.
var GENERIC_CHANNEL_NAMES = new Set([
  'daily', 'generale', 'general', 'random', 'casuale', 'test', 'varie',
  'lounge', 'off-topic', 'offtopic', 'social', 'bar', 'chiacchiere',
  'watercooler', 'annunci', 'announcements', 'welcome', 'benvenuto',
]);

// Nomi-progetto troppo generici (servizi/deliverable) da non mostrare come
// progetti selezionabili. Match ESATTO sul nome normalizzato. Denylist estendibile.
var JUNK_PROJECT_NAMES = new Set([
  'branding', 'eventi', 'evento', 'ped', 'piano editoriale',
  'content production', 'content-production', 'infotainment', 'packaging',
  'packaging e cartoline', 'shooting', 'shooting video', 'social', 'adv',
  'marketing', 'performance marketing', 'video', 'video contenuto', 'casuale',
]);

function isGenericChannel(name) {
  return GENERIC_CHANNEL_NAMES.has(norm(name));
}

function isJunkProjectName(name) {
  var n = norm(name);
  return n.length < 3 || JUNK_PROJECT_NAMES.has(n);
}

// Match fra due nomi per dedup/gate: uguali normalizzati, oppure uno contiene
// l'altro purché la parte più corta sia ≥ 4 caratteri (evita falsi positivi
// su sigle corte tipo "ks").
function nameMatches(a, b) {
  var na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  var shorter = na.length <= nb.length ? na : nb;
  var longer = na.length <= nb.length ? nb : na;
  return shorter.length >= 4 && longer.indexOf(shorter) !== -1;
}

module.exports = {
  ACTIVITY_WINDOW_DAYS: ACTIVITY_WINDOW_DAYS,
  norm: norm,
  GENERIC_CHANNEL_NAMES: GENERIC_CHANNEL_NAMES,
  JUNK_PROJECT_NAMES: JUNK_PROJECT_NAMES,
  isGenericChannel: isGenericChannel,
  isJunkProjectName: isJunkProjectName,
  nameMatches: nameMatches,
};
