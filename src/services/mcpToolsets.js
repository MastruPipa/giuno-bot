// ─── MCP Toolsets — quali server MCP allegare a una richiesta ────────────────
// Il connettore MCP dell'API Anthropic fa vedere al modello i tool di un server
// remoto (Higgsfield: 90+ tool). Allegarli a OGNI richiesta costerebbe decine
// di migliaia di token per turno e romperebbe la cache del prefisso, quindi
// si allegano solo quando il messaggio (o il turno precedente) parla di
// generare immagini/video, e solo con una lista di tool consentiti.

'use strict';

var mcpConnections = require('./mcpConnections');

var GENERATION_RE = /\b(genera|generami|crea|creami|fammi|fai|produci|realizza|renderizza|anima|animami|upscal\w*|migliora la qualit\w*)\b[\s\S]{0,80}\b(immagin[ei]|foto|video|clip|reel|render|animazion[ei]|illustrazion[ei]|visual|grafic[ah]|poster|mockup|moodboard|thumbnail|copertin[ae])\b|\bhiggsfield\b|\b(immagin[ei]|video|foto)\s+(ai|generat\w+|con l'?ai)\b|\btext.to.(image|video)\b/i;

// Tool Higgsfield che hanno senso da Slack. Fuori: website builder, TikTok,
// 3D scene builder, shorts studio, personal clipper, wallet.
var HIGGSFIELD_ALLOWED_TOOLS = [
  'generate_image', 'generate_image_batch', 'generate_video', 'generate_video_batch',
  'jobs_wait', 'job_display', 'show_generation_by_ids', 'show_generations', 'show_medias',
  'models_explore', 'presets_show', 'get_explainer_presets',
  'media_import_url', 'upscale_image', 'upscale_video', 'remove_background', 'reframe', 'outpaint_image',
  'balance',
];

function isGenerationRequest(message, transcript) {
  if (GENERATION_RE.test(String(message || ''))) return true;
  // Seguito di un turno di generazione ("più scuro", "anche in verticale"):
  // guarda le ultime due battute.
  var tail = (transcript || []).slice(-2).map(function(t) { return t && typeof t.content === 'string' ? t.content : ''; }).join('\n');
  return /higgsfield|generazion[ei]|immagine generata|video generato|jobs?_wait|job (in corso|avviato)/i.test(tail);
}

function parseAllowedUsers(envValue) {
  return String(envValue || '').split(',').map(function(s) { return s.trim(); }).filter(Boolean);
}

// Chi può generare: HIGGSFIELD_ALLOWED_USERS (lista di id Slack) oppure tutti
// tranne i 'restricted'.
function userCanGenerate(userId, userRole, envValue) {
  var allowed = parseAllowedUsers(envValue === undefined ? process.env.HIGGSFIELD_ALLOWED_USERS : envValue);
  if (allowed.length > 0) return allowed.indexOf(userId) !== -1;
  return userRole !== 'restricted';
}

// Ritorna { mcp_servers, tools, betas, section } da fondere nella richiesta,
// oppure { section } con la spiegazione quando non si può, oppure null.
async function buildAttachment(opts) {
  opts = opts || {};
  if (!isGenerationRequest(opts.message, opts.transcript)) return null;
  var status = mcpConnections.getStatus('higgsfield');
  if (!status.connected) {
    return { section: 'GENERAZIONE IMMAGINI/VIDEO (Higgsfield): NON COLLEGATO. ' +
      (opts.isAdmin ? 'Per collegarlo usa /giuno admin higgsfield e apri il link.' : 'Solo Antonio o Corrado possono collegarlo (/giuno admin higgsfield).') +
      ' Non promettere generazioni: dillo e basta.' };
  }
  if (!userCanGenerate(opts.userId, opts.userRole)) {
    return { section: 'GENERAZIONE IMMAGINI/VIDEO (Higgsfield): questa persona NON è abilitata a generare. Rispondi che serve l\'abilitazione da Antonio.' };
  }
  var token = await mcpConnections.getAccessToken('higgsfield');
  if (!token) {
    return { section: 'GENERAZIONE IMMAGINI/VIDEO (Higgsfield): il collegamento è scaduto e va rifatto (/giuno admin higgsfield). Non promettere generazioni.' };
  }
  var srv = mcpConnections.getServer('higgsfield');
  return {
    mcp_servers: [{
      type: 'url', url: srv.mcpUrl, name: 'higgsfield', authorization_token: token,
      tool_configuration: { enabled: true, allowed_tools: HIGGSFIELD_ALLOWED_TOOLS },
    }],
    tools: [{ type: 'mcp_toolset', mcp_server_name: 'higgsfield' }],
    betas: ['mcp-client-2025-11-20'],
    section: 'GENERAZIONE IMMAGINI/VIDEO: hai i tool Higgsfield (account unico dello studio, i crediti sono condivisi). ' +
      'Per un\'immagine: generate_image e riporta l\'URL del risultato. Per un video: generate_video, poi jobs_wait finché non è pronto (può volerci qualche minuto: non rispondere prima di avere l\'URL). ' +
      'Riporta sempre gli URL puliti su una riga a sé così Slack li mostra. Se serve un modello o uno stile specifico, models_explore/presets_show. ' +
      'Non generare contenuti su persone reali riconoscibili senza richiesta esplicita.',
  };
}

module.exports = {
  GENERATION_RE: GENERATION_RE,
  HIGGSFIELD_ALLOWED_TOOLS: HIGGSFIELD_ALLOWED_TOOLS,
  isGenerationRequest: isGenerationRequest,
  parseAllowedUsers: parseAllowedUsers,
  userCanGenerate: userCanGenerate,
  buildAttachment: buildAttachment,
};
