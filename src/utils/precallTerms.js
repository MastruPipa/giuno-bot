// ─── Pre-call search terms ───────────────────────────────────────────────────
// Estrae dal titolo di un evento calendario i termini utili per cercare nel
// CRM, togliendo il nome della nostra agenzia e il filler da meeting — così
// token generici come "Studio" o "Proposta" non matchano righe CRM sbagliate.
// Modulo puro (niente dipendenze Slack) per essere testabile.
//
// NB: simboli e parole vanno rimossi separatamente — un'alternation con `x` e
// `-` senza \b cancellava ogni 'x' e trattino DENTRO le parole ("Maxi"→"Mai").
'use strict';

function extractSearchTerms(title) {
  return (title || '')
    .replace(/<>|×/g, ' ')
    .replace(/\b(kataniastudio|katania|studio|ks|x|meet|call|meeting|sync|check|con|per|brainstorm|kick.?off|review|demo|riunione|presentazione|deep\s*dive|proposta|preventivo|offerta|workshop|onboarding|follow.?up|intro)\b/gi, ' ')
    .replace(/-/g, ' ')
    .trim().split(/\s+/)
    .map(function(w) { return w.replace(/[^\wÀ-ÿ']/g, ''); })
    .filter(function(w) { return w.length > 2 && !/^(del|dei|delle|della|alle|per|con|che|una|uno|gli|the|and)$/i.test(w); });
}

module.exports = { extractSearchTerms: extractSearchTerms };
