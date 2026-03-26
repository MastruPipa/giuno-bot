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
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

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

-- Abilita Row Level Security (opzionale, consigliato per produzione)
-- ALTER TABLE user_tokens ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE user_prefs ENABLE ROW LEVEL SECURITY;
-- etc.
