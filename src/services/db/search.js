// ─── Shared search utilities ────────────────────────────────────────────────
// Used by both memories.js and kb.js for keyword scoring and blacklisting.

'use strict';

var SINONIMI = {
  'foto': ['fotografico', 'fotografia', 'shooting', 'servizio fotografico', 'photo'],
  'fotografico': ['foto', 'fotografia', 'shooting', 'photo'],
  'sito': ['website', 'web', 'sito web', 'portale', 'landing'],
  'website': ['sito', 'web', 'sito web', 'portale', 'landing'],
  'web': ['sito', 'website', 'sito web', 'portale'],
  'branding': ['brand', 'marchio', 'identità visiva', 'logo', 'rebrand', 'rebranding'],
  'brand': ['branding', 'marchio', 'identità visiva', 'logo', 'rebrand'],
  'logo': ['branding', 'brand', 'marchio', 'logotipo'],
  'social': ['social media', 'instagram', 'facebook', 'tiktok', 'linkedin'],
  'marketing': ['promozione', 'campagna', 'adv', 'advertising', 'ads'],
  'campagna': ['marketing', 'promozione', 'adv', 'advertising'],
  'video': ['filmato', 'clip', 'reel', 'montaggio', 'riprese'],
  'design': ['grafica', 'progettazione', 'layout', 'mockup', 'ui', 'ux'],
  'grafica': ['design', 'progettazione', 'layout', 'visual'],
  'progetto': ['progettazione', 'lavoro', 'commessa', 'incarico'],
  'cliente': ['client', 'committente', 'azienda'],
  'preventivo': ['quotazione', 'offerta', 'stima', 'quote', 'budget'],
  'contratto': ['accordo', 'agreement', 'incarico'],
  'fattura': ['invoice', 'pagamento', 'fatturazione'],
  'meeting': ['riunione', 'call', 'incontro', 'appuntamento'],
  'riunione': ['meeting', 'call', 'incontro', 'appuntamento'],
  'task': ['compito', 'attività', 'todo', 'da fare', 'azione'],
  'deadline': ['scadenza', 'consegna', 'termine'],
  'scadenza': ['deadline', 'consegna', 'termine'],
  'packaging': ['etichetta', 'etichette', 'confezione', 'label'],
  'shooting': ['riprese', 'servizio fotografico', 'set'],
  'foto': ['fotografia', 'shooting', 'servizio fotografico'],
  'copy': ['copywriting', 'testi', 'scrittura'],
  'sito': ['website', 'web', 'landing'],
  'ped': ['piano editoriale', 'calendario editoriale', 'content plan'],
  'piano editoriale': ['ped', 'calendario editoriale'],
  'output': ['deliverable', 'consegna', 'materiale', 'prodotto finito'],
  'deliverable': ['output', 'consegna', 'materiale'],
  'brief': ['briefing', 'richiesta', 'requisiti'],
  'moodboard': ['concept', 'visual', 'ispirazione'],
  'presentazione': ['deck', 'pitch', 'slides'],
  'fornitore': ['freelance', 'collaboratore', 'esterno'],
  'budget': ['costo', 'spesa', 'investimento'],
};

function expandQueryTokens(query) {
  if (!query || typeof query !== 'string') return [];
  var tokens = query.toLowerCase().split(/\s+/).filter(function(t) { return t.length > 2; });
  var seen = {};
  var expanded = [];
  tokens.forEach(function(t) { if (!seen[t]) { seen[t] = true; expanded.push(t); } });
  tokens.forEach(function(token) {
    if (SINONIMI[token]) {
      SINONIMI[token].forEach(function(syn) {
        if (!seen[syn]) { seen[syn] = true; expanded.push(syn); }
      });
    }
  });
  return expanded.slice(0, 15);
}

function scoreMemory(memory, tokens, now) {
  var contentLow = (memory.content || '').toLowerCase();
  var tagsLow = (memory.tags || []).map(function(t) { return t.toLowerCase(); });

  var isOfficial = tagsLow.some(function(t) { return t === 'fonte:ufficiale'; });
  // A correction is a high-trust statement from the user — let it outweigh the
  // older memories it's intended to replace.
  var isCorrection = tagsLow.some(function(t) { return t === 'correzione' || t === 'feedback'; });
  // Memories that have been explicitly invalidated should never resurface.
  if (memory.superseded_by) return 0;

  var baseScore = 0;
  tokens.forEach(function(token) {
    if (contentLow.includes(token)) baseScore += 3;
    tagsLow.forEach(function(t) {
      if (t.includes(token)) baseScore += 2;
    });
  });

  var fullQuery = tokens.slice(0, 3).join(' ');
  if (fullQuery.length > 5 && contentLow.includes(fullQuery)) baseScore += 5;

  if (baseScore === 0) return 0;
  if (isOfficial) return baseScore + 100;

  var TYPE_WEIGHT = { 'semantic': 1.0, 'procedural': 1.0, 'preference': 0.95, 'intent': 0.9, 'episodic': 0.7, 'observation': 0.6 };
  var typeWeight = TYPE_WEIGHT[memory.memory_type] || 0.7;

  var temporalScore = 1.0;
  if (memory.created && now) {
    var ageDays = (now - new Date(memory.created).getTime()) / (1000 * 60 * 60 * 24);
    var perishable = (memory.memory_type === 'episodic' || memory.memory_type === 'observation' ||
                      memory.memory_type === 'intent' || !memory.memory_type);
    if (perishable) {
      // Time-bound facts (what happened / what someone intended) age out fast.
      temporalScore = Math.max(0.3, 1 - (ageDays / 180) * 0.7);
    } else {
      // semantic / procedural / preference: gentle decay so that, all else equal,
      // fresh info wins ties and year-old facts don't masquerade as current truth.
      temporalScore = Math.max(0.6, 1 - (ageDays / 365) * 0.4);
    }
  }

  if (memory.expires_at && new Date(memory.expires_at).getTime() < now) return 0;

  // confidence_score was previously ignored: a 0.3 auto-learn memory weighed
  // as much as a 0.9 hand-written semantic one. Now it acts as a multiplier
  // (corrections get a 1.5× boost because the user just told us the truth).
  var rawConfidence = (memory.confidence_score != null) ? memory.confidence_score : 0.5;
  var confidenceMultiplier = isCorrection ? 1.5 : Math.max(0.3, Math.min(1.0, rawConfidence));

  var combined = (baseScore * 0.4) + (baseScore * typeWeight * 0.2) + (baseScore * temporalScore * 0.2);
  return combined * confidenceMultiplier;
}

var BLACKLIST_PATTERNS = [
  'slack_user_token', 'search:read', 'limitazioni tecniche',
  'problema tecnico con slack', 'token non ha', 'permessi.*slack',
  'non riesco ad accedere ai canali', 'configurare.*permessi',
  'serve che.*configur', 'accesso.*canali.*limitat',
];
var _blacklistRegex = new RegExp(BLACKLIST_PATTERNS.join('|'), 'i');
var _financialBlacklist = /€\s*\d{1,3}([.,]\d{3})*|contratt[oi]\s+attiv|pipeline\s+totale|subtotale|totale\s+confermati|fatturato\s+\d{4}|revenue|ricavi\s+\d/i;

function isBlacklisted(content) {
  return _blacklistRegex.test(content) || _financialBlacklist.test(content);
}

module.exports = { expandQueryTokens: expandQueryTokens, scoreMemory: scoreMemory, isBlacklisted: isBlacklisted };
