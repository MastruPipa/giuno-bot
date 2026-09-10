// ─── Tool packs — quali strumenti mandare al modello in ogni turno ───────────
// Con 140+ tool ogni chiamata portava ~21k token di sole definizioni, prima
// ancora del contesto: costo, latenza e scelte peggiori. Qui un NUCLEO stabile
// (lettura Slack/mail/calendario/Drive, memoria, KB, progetti, CRM in lettura,
// invio DM e campagne) va sempre; il resto è diviso in pacchetti caricati
// solo quando il messaggio (o le ultime battute) li riguarda. Il modello ha
// comunque `more_tools` per chiedere un pacchetto che gli manca. Il nucleo
// porta il breakpoint di cache, così resta cacheato qualunque pacchetto segua.

'use strict';

var CORE = [
  // Slack
  'get_slack_users', 'send_dm', 'send_campaign', 'campaign_status', 'search_slack_messages', 'summarize_thread', 'summarize_channel', 'read_channel', 'list_channels', 'set_reminder',
  // Mail e calendario in lettura
  'find_emails', 'read_email', 'read_thread', 'list_events', 'find_event',
  // Drive in lettura
  'search_drive', 'read_doc', 'browse_folder', 'get_project_documents',
  // Memoria e KB
  'save_memory', 'recall_memory', 'resolve_entity', 'search_kb', 'add_to_kb', 'get_channel_digest', 'remember_this', 'entity_card',
  // Progetti, standup, ore
  'get_project_dossier', 'list_project_dossiers', 'list_projects', 'get_project_details', 'query_standup', 'query_time_logs', 'get_my_day', 'get_priorities', 'set_priorities',
  // CRM in lettura
  'search_leads', 'crm_compare', 'attio_search', 'attio_get_record', 'search_quotes',
  // Vari
  'ask_gemini', 'web_search', 'search_everywhere', 'get_user_profile',
];

var PACKS = [
  { name: 'email_write', label: 'scrivere/inviare email', tools: ['send_email', 'reply_email', 'forward_email', 'draft_email', 'send_draft'],
    match: /\b(invia|manda|rispondi|inoltra|bozza|scriv\w*|prepara)\b[\s\S]{0,60}\b(mail|email|e-mail)\b|\b(mail|email)\b[\s\S]{0,40}\b(invia|manda|rispondi|inoltra|bozza)/i },
  { name: 'calendar_write', label: 'creare/modificare eventi e trovare slot', tools: ['create_event', 'update_event', 'add_attendees', 'delete_event', 'find_free_slots'],
    match: /\b(crea|fissa|metti|sposta|cancella|elimina|aggiungi|invita|organizza|prenota|trova)\b[\s\S]{0,60}\b(evento|appuntamento|riunione|call|meeting|slot|calendario|invito)\b|\b(disponibilit|slot liber|quando (siamo|sono|è) liber)/i },
  { name: 'drive_write', label: 'creare/modificare documenti, slide, fogli e cartelle su Drive', tools: ['create_doc', 'edit_doc', 'edit_slides', 'share_file', 'summarize_doc', 'read_slides', 'cataloga_preventivi', 'list_shared_drives', 'search_in_shared_drive', 'read_doc_comments', 'create_sheet', 'create_folder', 'move_file', 'rename_file', 'link_doc_to_project', 'get_file_permissions', 'export_file', 'get_doc_changes', 'read_sheet', 'write_sheet'],
    match: /\b(doc\w*|drive|cartell\w|slide\w*|presentazion\w|fogli\w|sheet|spreadsheet|condivid\w*|permess\w|esport\w*|rinomin\w*|spost\w*|pdf|commenti|modifiche al|cataloga|preventiv\w*)\b/i },
  { name: 'crm_write', label: 'aggiornare CRM, lead, deal e note Attio', tools: ['update_lead', 'create_lead', 'delete_lead', 'query_leads_db', 'attio_create_record', 'attio_update_record', 'attio_add_note'],
    match: /\b(lead|crm|attio|deal|pipeline|trattativ\w|prospect|contatt\w|nuovo cliente|stage|won|lost|chiuso|firmat\w|€|euro)\b/i },
  { name: 'projects_write', label: 'creare/aggiornare progetti, fasi, allocazioni, ore, template', tools: ['refresh_project_dossier', 'create_project', 'update_project', 'allocate_resource', 'log_hours', 'get_team_workload', 'list_templates', 'create_project_from_template', 'update_phase', 'get_project_timeline'],
    match: /\b(progett\w*|alloc\w*|carico|workload|fas[ei]|timeline|template|ore|consuntiv\w*|budget|scadenz\w*|milestone|dossier|scheda)\b/i },
  { name: 'agency', label: 'account, brand, contenuti, fatture, fornitori, tariffe, competitor, revisioni', tools: ['manage_account', 'list_accounts', 'manage_brand', 'manage_content', 'manage_invoice', 'manage_supplier_rate', 'manage_competitor', 'log_time', 'get_time_report', 'search_suppliers', 'get_supplier', 'get_rate_card', 'evaluate_supplier_quote', 'review_content', 'review_email_draft'],
    match: /\b(fattur\w*|brand|competitor|concorren\w*|fornitor\w*|tariff\w*|rate card|listino|account|contenut\w*|piano editoriale|ped|revision\w*|rivedi|correggi|post|caption|copy)\b/i },
  { name: 'team_admin', label: 'team (ingressi/uscite), Google, preferenze, feedback, daily e planner forzati, costi', tools: ['team_member_joined', 'team_member_left', 'send_google_link', 'set_user_prefs', 'update_user_profile', 'get_connected_users', 'start_feedback', 'get_feedback_results', 'set_feedback_questions', 'trigger_daily_request', 'trigger_checkin_request', 'trigger_planner_request', 'get_api_costs', 'cancel_campaign', 'get_team_presence', 'analyze_team_activity'],
    match: /\b(team|roster|entrat\w|uscit\w|andat\w via|lasciat\w|nuovo membro|collega google|google|feedback|daily|planner|check-?in|standup|cost\w|preferenz\w|notific\w|routine|campagn\w|sollecit\w|profilo|presenza|attivit\w del team)\b/i },
  { name: 'slack_admin', label: 'pin, sondaggi, topic, inviti, file, emoji, reaction, gruppi', tools: ['create_poll', 'get_pinned_messages', 'pin_message', 'unpin_message', 'search_files', 'upload_file', 'get_slack_profile', 'list_usergroups', 'set_channel_topic', 'invite_to_channel', 'get_reactions', 'list_emoji', 'get_channel_map'],
    match: /\b(pin\w*|fissat\w|sondaggi\w|poll|topic|argomento del canale|invit\w|file|allegat\w|carica|emoji|reaction|reazion\w|gruppo|usergroup|mappa canali)\b/i },
  { name: 'memory_admin', label: 'gestire memorie, KB, contatti e relazioni', tools: ['list_memories', 'delete_memory', 'delete_from_kb', 'get_entity_relationships', 'search_drive_index', 'save_contact', 'search_contacts'],
    match: /\b(memori\w|ricord\w*|dimentic\w*|cancell\w*|elimin\w*|kb|knowledge|relazion\w|collegament\w|contatt\w|rubrica|indice)\b/i },
];

var MORE_TOOLS = {
  name: 'more_tools',
  description: 'Carica un pacchetto di strumenti aggiuntivi non presenti in questo turno. Chiamalo SOLO se l\'azione richiesta non è coperta dai tool già disponibili. Pacchetti: ' +
    PACKS.map(function(p) { return p.name + ' (' + p.label + ')'; }).join('; ') + '.',
  input_schema: { type: 'object', properties: { pack: { type: 'string', enum: PACKS.map(function(p) { return p.name; }) } }, required: ['pack'] },
};

function packsEnabled() { return process.env.GIUNO_TOOL_PACKS !== 'off'; }

function _tail(transcript, n) {
  return (transcript || []).slice(-(n || 2)).map(function(t) { return t && typeof t.content === 'string' ? t.content : ''; }).join('\n');
}

// Pacchetti attivati dal testo del turno e dalle ultime due battute.
function detectPacks(message, transcript) {
  var text = String(message || '') + '\n' + _tail(transcript, 2);
  return PACKS.filter(function(p) { return p.match.test(text); }).map(function(p) { return p.name; });
}

function _withCacheBreakpoint(tools, index) {
  return tools.map(function(t, i) {
    if (i !== index) return t;
    return Object.assign({}, t, { cache_control: { type: 'ephemeral' } });
  });
}

// Costruisce la lista ordinata: nucleo (stesso ordine del registro, con il
// breakpoint di cache sull'ultimo), poi i pacchetti in ordine fisso, poi
// more_tools. Ritorna { tools, packs, core }.
function selectTools(allTools, opts) {
  opts = opts || {};
  var byName = {};
  (allTools || []).forEach(function(t) { byName[t.name] = t; });
  var coreSet = new Set(CORE);
  var core = (allTools || []).filter(function(t) { return coreSet.has(t.name); });
  var packNames = (opts.packs || []).slice();
  var picked = new Set(core.map(function(t) { return t.name; }));
  var extra = [];
  PACKS.forEach(function(p) {
    if (packNames.indexOf(p.name) === -1) return;
    p.tools.forEach(function(n) { if (byName[n] && !picked.has(n)) { picked.add(n); extra.push(byName[n]); } });
  });
  var tools = _withCacheBreakpoint(core, core.length - 1).concat(extra);
  var missing = PACKS.filter(function(p) { return packNames.indexOf(p.name) === -1; });
  if (missing.length) tools.push(MORE_TOOLS);
  return { tools: tools, packs: packNames, core: core.length };
}

function selectForTurn(allTools, message, transcript, opts) {
  opts = opts || {};
  if (!packsEnabled()) return { tools: allTools, packs: ['all'], core: allTools.length };
  var packs = detectPacks(message, transcript).concat(opts.extraPacks || []);
  return selectTools(allTools, { packs: packs.filter(function(p, i, a) { return a.indexOf(p) === i; }) });
}

function addPack(allTools, selection, packName) {
  var p = PACKS.find(function(x) { return x.name === packName; });
  if (!p) return { selection: selection, error: 'Pacchetto sconosciuto: ' + packName + '. Disponibili: ' + PACKS.map(function(x) { return x.name; }).join(', ') };
  if (selection.packs.indexOf(packName) !== -1) return { selection: selection, loaded: [], note: 'già caricato' };
  var next = selectTools(allTools, { packs: selection.packs.concat([packName]) });
  return { selection: next, loaded: p.tools };
}

module.exports = { CORE: CORE, PACKS: PACKS, MORE_TOOLS: MORE_TOOLS, packsEnabled: packsEnabled, detectPacks: detectPacks, selectTools: selectTools, selectForTurn: selectForTurn, addPack: addPack };
