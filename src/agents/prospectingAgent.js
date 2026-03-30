// ─── Prospecting Agent ────────────────────────────────────────────────────────
// Valuta il fit di un'azienda con l'ICP di Katania Studio.
// Trigger: /giuno prospect [nome azienda o URL]
'use strict';

var logger = require('../utils/logger');
var db = require('../../supabase');
var { callGeminiWithSearch } = require('../services/geminiService');
var { safeParse } = require('../utils/safeCall');

var ICP_PROFILES = {
  A: { label: 'PMI con brand da riposizionare', sectors: ['food', 'vino', 'beverage', 'lifestyle', 'retail', 'moda', 'artigianato'], examples: 'Gambino Wines, Tomarchio, Spagnolo&Associati' },
  B: { label: 'Startup/scale-up', sectors: ['fintech', 'saas', 'marketplace', 'wellness', 'tech', 'app', 'startup'], examples: 'Guardian, Drype, Fiscozen' },
  C: { label: 'Corporate per progetti specifici', sectors: ['corporate', 'enterprise', 'banche', 'energia', 'telco'], examples: 'Enel, VinoKilo' },
};

var ANTI_ICP = ['fornitore sotto altra agenzia', 'micro-locale senza scala', 'PA come cliente principale', 'budget sotto €4k', 'solo gestione social senza strategia'];

var KS_CASE_STUDIES = [
  { sector: 'vino', client: 'Gambino Wines', result: 'marketing + ads ongoing' },
  { sector: 'food', client: 'Tomarchio Bibite', result: 'rebranding brand storico 1920' },
  { sector: 'food', client: 'Agromonte', result: 'TikTok strategy nazionale' },
  { sector: 'hospitality', client: 'Clubhouse', result: 'brand + sito + social ongoing' },
  { sector: 'startup', client: 'Guardian', result: 'prima su App Store' },
  { sector: 'startup', client: 'Buona Crociera', result: 'growth campaign' },
  { sector: 'fintech', client: 'Fiscozen', result: 'influencer marketing' },
  { sector: 'branding', client: 'Spagnolo&Associati', result: 'rebranding completo' },
  { sector: 'social', client: 'Red Etna', result: '+25k follower in 6 mesi' },
  { sector: 'lead_gen', client: 'Green Tech', result: 'lead generation' },
  { sector: 'ecommerce', client: 'Palazzolo', result: '30k raccolti con video' },
];

var SCORECARD = [
  { key: 'geographic_ambition', label: 'Ambizione geografica', weight: 0.25, levels: { 5: 'Nazionale/internazionale', 3: 'Regionale', 1: 'Solo locale' } },
  { key: 'budget_signal', label: 'Budget percepito', weight: 0.25, levels: { 5: '>€50k/anno o investitori', 3: '€15-50k/anno', 1: '<€15k/anno' } },
  { key: 'brand_maturity', label: 'Maturità brand', weight: 0.20, levels: { 5: 'Brand da evolvere', 3: 'Da costruire, consapevole', 1: 'Nessuna consapevolezza' } },
  { key: 'sector_fit', label: 'Settore fit KS', weight: 0.15, levels: { 5: 'Food, fintech, startup, lifestyle', 3: 'Hospitality, services', 1: 'PA, micro-locale' } },
  { key: 'decision_maker', label: 'Decisore accessibile', weight: 0.10, levels: { 5: 'CEO/founder diretto', 3: 'Marketing manager', 1: 'Non identificabile' } },
  { key: 'portfolio_fit', label: 'Fit portfolio', weight: 0.05, levels: { 5: 'Caso studio potenziale', 3: 'Neutro', 1: 'Non vogliamo nel portfolio' } },
];

function findRelevantCaseStudy(text) {
  var best = null, bestScore = 0;
  KS_CASE_STUDIES.forEach(function(cs) {
    var score = 0;
    if ((text || '').toLowerCase().includes(cs.sector)) score += 3;
    if (score > bestScore) { bestScore = score; best = cs; }
  });
  return best || KS_CASE_STUDIES[0];
}

async function run(companyInput, ctx) {
  logger.info('[PROSPECTING] Analisi per:', companyInput);

  var isUrl = /^https?:\/\//.test(companyInput);
  var companyName = isUrl ? companyInput.replace(/^https?:\/\/(www\.)?/, '').split('/')[0] : companyInput;

  // 1. CRM check
  var alreadyInCRM = false;
  try {
    var existing = await db.searchLeads({ company_name: companyName, limit: 1 });
    if (existing && existing.length > 0) alreadyInCRM = true;
  } catch(e) { logger.warn('[PROSPECTING] CRM check error:', e.message); }

  // 2. KB context
  var kbContext = '';
  try {
    var kbResults = db.searchKB(companyName);
    if (kbResults && kbResults.length > 0) {
      kbContext = '\nSAPPIAMO GIÀ:\n' + kbResults.slice(0, 3).map(function(k) { return '• ' + k.content; }).join('\n');
    }
  } catch(e) {}

  // 3. Gemini search
  var externalData = '';
  try {
    var geminiResult = await callGeminiWithSearch(
      (isUrl ? 'Analizza questa azienda: ' + companyInput : 'Analizza l\'azienda italiana "' + companyName + '". ') +
      'Dimmi: settore, dimensione, sede, presenza digitale, posizionamento, decisore marketing, news recenti.',
      { maxTokens: 800 }
    );
    if (geminiResult && !geminiResult.error) externalData = geminiResult.text || '';
  } catch(e) { logger.warn('[PROSPECTING] Gemini error:', e.message); }

  // 4. Claude scoring
  var icpContext = Object.keys(ICP_PROFILES).map(function(k) {
    var p = ICP_PROFILES[k]; return 'Profilo ' + k + ': ' + p.label + ' | Settori: ' + p.sectors.join(', ');
  }).join('\n');
  var scorecardContext = SCORECARD.map(function(s) {
    return s.label + ' (' + Math.round(s.weight * 100) + '%): 5=' + s.levels[5] + ', 3=' + s.levels[3] + ', 1=' + s.levels[1];
  }).join('\n');

  var Anthropic = require('@anthropic-ai/sdk');
  var client = new Anthropic();
  var analysis = null;

  try {
    var response = await client.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 1200,
      system: 'Analista commerciale di Katania Studio (agenzia creativa Catania, 9 persone).\n' +
        'PROFILI ICP:\n' + icpContext + '\nANTI-ICP: ' + ANTI_ICP.join(', ') + '\n' +
        'SCORECARD:\n' + scorecardContext + '\n\n' +
        'Rispondi SOLO JSON:\n{"company_name":"","sector":"","size":"","location":"","what_they_do":"","digital_quality":"","decision_maker":"","scores":{"geographic_ambition":1-5,"budget_signal":1-5,"brand_maturity":1-5,"sector_fit":1-5,"decision_maker":1-5,"portfolio_fit":1-5},"icp_profile":"A/B/C","anti_flags":[],"main_problem":"","why_ks":"","approach_angle":"","who_contacts":"Antonio/Corrado","channel":"email/LinkedIn/referral","first_message_draft":"3-4 righe"}',
      messages: [{ role: 'user', content: 'AZIENDA: ' + companyInput + '\n\nDATI WEB:\n' + (externalData || 'Nessuno.') + kbContext }],
    });
    var rawText = response.content.filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('');
    var jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) analysis = safeParse('PROSPECTING', jsonMatch[0], null);
  } catch(e) { logger.error('[PROSPECTING] Claude error:', e.message); }

  if (!analysis) return '⚠️ Non sono riuscito ad analizzare "' + companyName + '". Riprova con URL completo.';

  // 5. Score
  var scores = analysis.scores || {};
  var totalScore = 0;
  SCORECARD.forEach(function(c) { totalScore += ((scores[c.key] || 1) - 1) / 4 * c.weight * 100; });
  totalScore = Math.round(totalScore);
  var cls, emoji;
  if (totalScore >= 75) { cls = 'HOT'; emoji = '🔥'; }
  else if (totalScore >= 50) { cls = 'WARM'; emoji = '🟡'; }
  else if (totalScore >= 25) { cls = 'COLD'; emoji = '🔵'; }
  else { cls = 'SKIP'; emoji = '⚫'; }

  var caseStudy = findRelevantCaseStudy(externalData + ' ' + (analysis.sector || ''));

  // 6. Format
  var crmNote = alreadyInCRM ? '\n⚠️ _Già presente in CRM_' : '';
  var out = emoji + ' *' + (analysis.company_name || companyName) + '*' + crmNote + '\n';
  out += '*FIT SCORE: ' + totalScore + '/100 — ' + cls + '*\n\n';
  out += '*Settore:* ' + (analysis.sector || '—') + ' | *Dimensione:* ' + (analysis.size || '—') + '\n';
  out += '*Sede:* ' + (analysis.location || '—') + ' | *Digitale:* ' + (analysis.digital_quality || '—') + '\n';
  out += '*Cosa fanno:* ' + (analysis.what_they_do || '—') + '\n';
  out += '*Decisore:* ' + (analysis.decision_maker || '—') + '\n\n';
  out += '*Score:*\n';
  SCORECARD.forEach(function(c) { var s = scores[c.key] || 1; out += (s >= 5 ? '●●●' : s >= 3 ? '●●○' : '●○○') + ' ' + c.label + '\n'; });
  out += '\n*ICP:* ' + (analysis.icp_profile || '?') + ' — ' + (ICP_PROFILES[analysis.icp_profile] ? ICP_PROFILES[analysis.icp_profile].label : '—') + '\n';
  if (analysis.anti_flags && analysis.anti_flags.length > 0) out += '*⚠️ Anti-flag:* ' + analysis.anti_flags.join(', ') + '\n';
  out += '\n*Problema:* ' + (analysis.main_problem || '—') + '\n';
  out += '*Perché KS:* ' + (analysis.why_ks || '—') + '\n';
  out += '*Angolo:* ' + (analysis.approach_angle || '—') + '\n';
  out += '*Case study:* ' + caseStudy.client + ' → ' + caseStudy.result + '\n';
  out += '*Chi:* ' + (analysis.who_contacts || '—') + ' | *Canale:* ' + (analysis.channel || '—') + '\n\n';
  out += '---\n*BOZZA:*\n' + (analysis.first_message_draft || '—') + '\n---\n';
  if (!alreadyInCRM && cls !== 'SKIP') out += '\n_💾 "aggiungi al crm ' + (analysis.company_name || companyName) + '" per salvare._';
  return out;
}

module.exports = { run: run };
