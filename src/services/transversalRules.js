// ─── Attività trasversali (gruppo "Interno") ─────────────────────────────────
// Il tempo che non va a un cliente va comunque contato: daily e riunioni di
// team, management, team building, formazione, amministrazione, commerciale.
// Sono commesse fisse del cliente "Interno" (righe cat_* in projects) e i
// task del daily o gli eventi in calendario ci finiscono con regole
// deterministiche, PRIMA del modello e DOPO il match sui clienti: una
// riunione interna su Elios resta su Elios, un "daily team" va qui.

'use strict';

var INTERNAL_CLIENT = 'Interno';

var BUCKETS = [
  { id: 'cat_riunioni_team',    name: 'Daily e riunioni di team',           re: /\bdaily\b|\bweekly\b|stand.?up|riunion[ei] (di |del )?team|allineament[oi] (interno|di team|del team)|team meeting|meeting (di |del )?team|riunione interna|check.?in\b|retrospettiva|planning (settimanale|di team)/i },
  { id: 'cat_management',       name: 'Management e direzione',             re: /management|direzion|riunione soci|\bsoci\b|\bceo\b|pianificazione aziendale|strategia aziendale|riunione (con )?antonio|riunione (con )?gloria|riunione (con )?corrado|budget aziendale|one.?to.?one|1:1|colloquio/i },
  { id: 'cat_team_building',    name: 'Team building e cultura',            re: /team.?building|pranzo (di |del )?team|cena (di |del )?team|aperitivo|festa|evento interno|compleanno|uscita di team|cultura aziendale/i },
  { id: 'cat_formazione_admin', name: 'Formazione',                         re: /formazion|\bcorso\b|\bcorsi\b|tutorial|webinar|studio (di|su)\b|approfondimento|onboarding|affiancamento|scuola di content|masterclass|lettur[ae] (di|su)\b/i },
  { id: 'cat_flussi_interni',   name: 'Amministrazione e flussi interni',   re: /amministr|fattur|\bcassa\b|contabil|pagament|\bbanca\b|\bnote spese\b|\bgiuno\b|strumenti interni|flussi interni|\bslack\b setup|organizzazione (interna|ufficio)|ufficio|\bhr\b|contratti dipendenti|\bpulizi/i },
  { id: 'cat_prospect',         name: 'Commerciale e prospect',             re: /prospect|preventiv|proposta commerciale|\blead\b|trattativ|\bpitch\b|nuovo cliente|call conoscitiv|primo contatto|offerta/i },
];

// Parole che indicano un cliente o un progetto specifico: se ci sono, il task
// NON è trasversale anche se contiene "daily" (es. "daily con il cliente X").
var CLIENT_HINT_RE = /\bcliente\b|\bclient\b|\bsal\b/i;

function matchTransversal(text) {
  var t = String(text || '');
  if (!t.trim()) return null;
  for (var i = 0; i < BUCKETS.length; i++) {
    if (BUCKETS[i].re.test(t)) {
      // "daily con il cliente" / "SAL": non è interno, è la commessa del cliente
      if (BUCKETS[i].id === 'cat_riunioni_team' && CLIENT_HINT_RE.test(t)) return null;
      return { id: BUCKETS[i].id, name: BUCKETS[i].name };
    }
  }
  return null;
}

function isInternalId(id) { return /^cat_/.test(String(id || '')); }

module.exports = { INTERNAL_CLIENT: INTERNAL_CLIENT, BUCKETS: BUCKETS, matchTransversal: matchTransversal, isInternalId: isInternalId };
