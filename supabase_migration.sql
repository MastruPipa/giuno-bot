-- ============================================================================
-- Giuno Bot - Supabase Migration
-- Esegui questo SQL nella console SQL di Supabase (supabase.com > SQL Editor)
-- ============================================================================

-- 1. Token Google OAuth per utente
CREATE TABLE IF NOT EXISTS user_tokens (
  slack_user_id TEXT PRIMARY KEY,
  refresh_token TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Preferenze utente
CREATE TABLE IF NOT EXISTS user_prefs (
  slack_user_id TEXT PRIMARY KEY,
  routine_enabled BOOLEAN DEFAULT TRUE,
  notifiche_enabled BOOLEAN DEFAULT TRUE,
  standup_enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Conversazioni (storia per thread)
CREATE TABLE IF NOT EXISTS conversations (
  conv_key TEXT PRIMARY KEY,  -- formato: userId:threadTs
  messages JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Memorie per utente
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  slack_user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(slack_user_id);

-- 5. Profili utente
CREATE TABLE IF NOT EXISTS user_profiles (
  slack_user_id TEXT PRIMARY KEY,
  ruolo TEXT,
  progetti TEXT[] DEFAULT '{}',
  clienti TEXT[] DEFAULT '{}',
  competenze TEXT[] DEFAULT '{}',
  stile_comunicativo TEXT,
  note TEXT[] DEFAULT '{}',
  ultimo_aggiornamento TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Knowledge base aziendale
CREATE TABLE IF NOT EXISTS knowledge_base (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  tags TEXT[] DEFAULT '{}',
  added_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Standup data
CREATE TABLE IF NOT EXISTS standup_data (
  id TEXT PRIMARY KEY DEFAULT 'current',
  oggi TEXT,
  risposte JSONB NOT NULL DEFAULT '{}',
  inattesa JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE standup_data ADD COLUMN IF NOT EXISTS inattesa JSONB NOT NULL DEFAULT '[]';

-- 8. Drive index
CREATE TABLE IF NOT EXISTS drive_index (
  slack_user_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  name TEXT,
  type TEXT,
  link TEXT,
  modified TIMESTAMPTZ,
  owner TEXT,
  description TEXT,
  indexed_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (slack_user_id, file_id)
);

CREATE INDEX IF NOT EXISTS idx_drive_index_user ON drive_index(slack_user_id);

-- 9. Feedback
CREATE TABLE IF NOT EXISTS feedback (
  id SERIAL PRIMARY KEY,
  ts TEXT,
  slack_user_id TEXT,
  feedback TEXT,
  message_text TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 10. Channel map (canale → progetto/cliente)
CREATE TABLE IF NOT EXISTS channel_map (
  channel_id TEXT PRIMARY KEY,
  channel_name TEXT,
  cliente TEXT,
  progetto TEXT,
  tags TEXT[] DEFAULT '{}',
  note TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 11. Channel digests (riassunti periodici dei canali)
CREATE TABLE IF NOT EXISTS channel_digests (
  channel_id TEXT PRIMARY KEY,
  last_digest TEXT,
  last_ts TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 12. Ruoli utente (RBAC 5 livelli)
CREATE TABLE IF NOT EXISTS user_roles (
  slack_user_id  TEXT PRIMARY KEY,
  role           TEXT NOT NULL CHECK (
                   role IN (
                     'admin',
                     'finance',
                     'manager',
                     'member',
                     'restricted'
                   )
                 ),
  display_name   TEXT,
  assigned_by    TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_roles_slack_id
  ON user_roles(slack_user_id);

-- 13. Preventivi (quotes)
CREATE TABLE IF NOT EXISTS quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_name TEXT,
  project_name TEXT,
  service_category TEXT,
  service_tags TEXT[] DEFAULT '{}',
  deliverables TEXT[] DEFAULT '{}',
  status TEXT,
  date DATE,
  quote_year INTEGER,
  quote_quarter TEXT,
  price_quoted NUMERIC,
  total_days NUMERIC,
  total_cost_interno NUMERIC,
  markup_pct NUMERIC,
  pricing_era TEXT,
  resources JSONB DEFAULT '[]',
  source_doc_id TEXT UNIQUE,
  source_doc_name TEXT,
  needs_review BOOLEAN DEFAULT false,
  confidence TEXT,
  notes TEXT,
  cataloged_at TIMESTAMPTZ DEFAULT NOW()
);

-- 14. Storico rate card
CREATE TABLE IF NOT EXISTS rate_card_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version TEXT NOT NULL,
  effective_from DATE,
  resources JSONB NOT NULL DEFAULT '[]',
  source_doc_id TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Abilita Row Level Security (opzionale, consigliato per produzione)
-- ALTER TABLE user_tokens ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE user_prefs ENABLE ROW LEVEL SECURITY;
-- etc.


-- 15. Runtime metrics (persistenza KPI operativi)
CREATE TABLE IF NOT EXISTS runtime_metrics (
  metric_name TEXT PRIMARY KEY,
  metric_value NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_runtime_metrics_updated_at ON runtime_metrics(updated_at);

-- 16. Learning/context hardening (Round 2 — thread awareness & dedup)
ALTER TABLE memories ADD COLUMN IF NOT EXISTS thread_ts TEXT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS content_hash TEXT;
CREATE INDEX IF NOT EXISTS memories_thread_ts_idx ON memories(thread_ts) WHERE thread_ts IS NOT NULL;
CREATE INDEX IF NOT EXISTS memories_content_hash_idx ON memories(slack_user_id, content_hash) WHERE content_hash IS NOT NULL;

ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS source_thread_ts TEXT;
CREATE INDEX IF NOT EXISTS kb_source_thread_ts_idx ON knowledge_base(source_thread_ts) WHERE source_thread_ts IS NOT NULL;

-- 17. Per-user sticky facts (Round 3B — durable 1:1 memory).
-- Stable truths about each team member: role, style, recurring projects, etc.
-- Extracted asynchronously from the DM rolling summary.
CREATE TABLE IF NOT EXISTS user_facts (
  id TEXT PRIMARY KEY,
  slack_user_id TEXT NOT NULL,
  fact TEXT NOT NULL,
  category TEXT,
  confidence NUMERIC DEFAULT 0.6,
  source TEXT DEFAULT 'dm_summary',
  last_confirmed_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS user_facts_user_idx ON user_facts(slack_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS user_facts_unique_idx ON user_facts(slack_user_id, category, fact);

-- 18. Proactive followups (one row per sent nudge, per user+item).
-- Used to avoid spamming: at most one follow-up per item, cooldown 3 days.
CREATE TABLE IF NOT EXISTS followup_log (
  slack_user_id TEXT NOT NULL,
  item_hash TEXT NOT NULL,
  item_description TEXT,
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  attempts INT DEFAULT 1,
  PRIMARY KEY (slack_user_id, item_hash)
);
CREATE INDEX IF NOT EXISTS followup_log_sent_idx ON followup_log(sent_at);
