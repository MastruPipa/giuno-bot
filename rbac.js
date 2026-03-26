// ─── RBAC — Role-Based Access Control (5 livelli) ──────────────────────────
// admin > finance > manager > member > restricted
// ────────────────────────────────────────────────────────────────────────────

var createClient = null;
try { createClient = require('@supabase/supabase-js').createClient; } catch(e) {}

var supabase = null;
if (createClient && process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
}

// ─── Cache in-memory con TTL 5 minuti ───────────────────────────────────────

var _roleCache = new Map(); // slackUserId -> { role, ts }
var CACHE_TTL = 5 * 60 * 1000; // 5 minuti

async function getUserRole(slackUserId) {
  // Check cache
  var cached = _roleCache.get(slackUserId);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL) {
    return cached.role;
  }

  // Query Supabase
  if (supabase) {
    try {
      var res = await supabase.from('user_roles').select('role').eq('slack_user_id', slackUserId).single();
      if (res.data && res.data.role) {
        _roleCache.set(slackUserId, { role: res.data.role, ts: Date.now() });
        return res.data.role;
      }
    } catch(e) {
      // Supabase non raggiungibile → fail-safe: member
    }
  }

  // Default: member (fail-safe)
  _roleCache.set(slackUserId, { role: 'member', ts: Date.now() });
  return 'member';
}

function invalidateRoleCache(slackUserId) {
  _roleCache.delete(slackUserId);
}

// ─── Matrice permessi ───────────────────────────────────────────────────────

var PERMISSIONS = {
  view_financials:       { admin: true, finance: true, manager: false, member: false, restricted: false },
  view_margins:          { admin: true, finance: true, manager: false, member: false, restricted: false },
  view_cash_flow:        { admin: true, finance: true, manager: false, member: false, restricted: false },
  view_rate_card:        { admin: true, finance: true, manager: false, member: false, restricted: false },
  view_crm_full:         { admin: true, finance: true, manager: true,  member: false, restricted: false },
  view_quote_price:      { admin: true, finance: true, manager: true,  member: false, restricted: false },
  view_quote_margins:    { admin: true, finance: true, manager: false, member: false, restricted: false },
  view_all_memories:     { admin: true, finance: true, manager: false, member: false, restricted: false },
  manage_roles:          { admin: true, finance: false, manager: false, member: false, restricted: false },
  view_drive_finance:    { admin: true, finance: true, manager: false, member: false, restricted: false },
  view_drive_contracts:  { admin: true, finance: true, manager: true,  member: false, restricted: false },
  use_general_features:  { admin: true, finance: true, manager: true,  member: true,  restricted: true },
  use_offkatania_project:{ admin: true, finance: true, manager: true,  member: true,  restricted: true },
};

function checkPermission(role, action) {
  var perm = PERMISSIONS[action];
  if (!perm) return false;
  return perm[role] || false;
}

// ─── Filtro dati preventivo per ruolo ───────────────────────────────────────

function filterQuoteData(quote, role) {
  if (!quote) return quote;
  if (role === 'admin' || role === 'finance') return quote;

  var filtered = Object.assign({}, quote);

  if (role === 'manager') {
    delete filtered.total_cost_interno;
    delete filtered.markup_pct;
    delete filtered.ratecard_version;
    delete filtered.pricing_era;
    if (filtered.resources && Array.isArray(filtered.resources)) {
      filtered.resources = filtered.resources.map(function(r) {
        var fr = Object.assign({}, r);
        delete fr.day_rate;
        delete fr.hour_rate;
        return fr;
      });
    }
    return filtered;
  }

  // member / restricted → solo dati minimi
  return {
    service_category: filtered.service_category,
    service_tags: filtered.service_tags,
    deliverables: filtered.deliverables,
    status: filtered.status,
    quote_year: filtered.quote_year,
    quote_quarter: filtered.quote_quarter,
  };
}

// ─── System prompt per ruolo ────────────────────────────────────────────────

var ROLE_PROMPTS = {
  admin:
    "L'utente e' ADMIN (Antonio o Corrado).\n" +
    "Accesso completo senza restrizioni:\n" +
    "finanziari, margini, cassa, crediti, CRM, rate card, preventivi completi, memories di tutto il team.",

  finance:
    "L'utente e' FINANCE (Gianna, COO).\n" +
    "Accesso completo incluso finanza ed economics:\n" +
    "PUO' vedere: fatturato, cassa, crediti aperti, margini interni, costo interno preventivi,\n" +
    "rate card, CRM completo, tutti i dati operativi.\n" +
    "Nessuna restrizione sui dati economici.",

  manager:
    "L'utente e' MANAGER (Alessandra, Nicolo' o Gloria).\n" +
    "Accesso operativo e clienti.\n" +
    "PUO' vedere: CRM completo, prezzi quotati ai clienti, brief, deliverables, dati operativi,\n" +
    "memories proprie + KB aziendale.\n" +
    "NON PUO' vedere: margini interni, costo interno preventivi, rate card,\n" +
    "dati finanziari (fatturato, cassa, crediti aperti).\n" +
    "Se chiede dati finanziari o margini, rispondi che non sono disponibili per il suo ruolo.",

  member:
    "L'utente e' MEMBER (team operativo).\n" +
    "Accesso base.\n" +
    "PUO' vedere: riassunti canali, brief assegnati, calendario, info pubbliche clienti, memories proprie.\n" +
    "NON PUO' vedere: CRM, importi preventivi, dati finanziari, margini, rate card.\n" +
    "Se chiede dati riservati, rispondi gentilmente che non sono disponibili per il suo ruolo.",

  restricted:
    "L'utente e' RESTRICTED (Peppe).\n" +
    "Accesso limitato al progetto OffKatania e alle funzioni base di Giuno\n" +
    "(riassunti thread, calendario, info generali).\n" +
    "Se chiede qualcosa fuori da OffKatania o dalle funzioni base, rispondi:\n" +
    "'Per questo hai bisogno di un accesso diverso. Chiedi ad Antonio o Corrado.'",
};

function getRoleSystemPrompt(role) {
  return ROLE_PROMPTS[role] || ROLE_PROMPTS.member;
}

// ─── Messaggio accesso negato ───────────────────────────────────────────────

function getAccessDeniedMessage(role) {
  if (role === 'restricted') {
    return 'Questa funzione non e\' disponibile per il tuo profilo. Parla con Antonio o Corrado se hai bisogno di accesso aggiuntivo.';
  }
  return 'Queste informazioni non sono disponibili per il tuo livello di accesso. Se pensi di averne bisogno, chiedi ad Antonio o Corrado.';
}

// ─── Gestione ruoli via Supabase ────────────────────────────────────────────

async function setUserRole(slackUserId, role, displayName, assignedBy) {
  if (!supabase) return false;
  try {
    await supabase.from('user_roles').upsert({
      slack_user_id: slackUserId,
      role: role,
      display_name: displayName || null,
      assigned_by: assignedBy || 'system',
      updated_at: new Date().toISOString(),
    });
    invalidateRoleCache(slackUserId);
    return true;
  } catch(e) {
    return false;
  }
}

async function getAllRoles() {
  if (!supabase) return [];
  try {
    var res = await supabase.from('user_roles').select('*').order('display_name');
    return res.data || [];
  } catch(e) {
    return [];
  }
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  getUserRole: getUserRole,
  invalidateRoleCache: invalidateRoleCache,
  checkPermission: checkPermission,
  filterQuoteData: filterQuoteData,
  getRoleSystemPrompt: getRoleSystemPrompt,
  getAccessDeniedMessage: getAccessDeniedMessage,
  setUserRole: setUserRole,
  getAllRoles: getAllRoles,
};
