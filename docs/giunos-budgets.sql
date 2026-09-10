-- Optional baseline store. Apply through the normal DB migration workflow.
-- No frontend writes. Automated contract extraction must reconcile accepted
-- revision, person/role attribution, units and dates before verified=true.
CREATE TABLE IF NOT EXISTS giunos_budgets (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  slack_user_id TEXT,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL CHECK (period_end >= period_start),
  scope TEXT NOT NULL DEFAULT 'period' CHECK (scope IN ('period','project')),
  hours NUMERIC NOT NULL CHECK (hours >= 0),
  source_url TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS giunos_budget_scope ON giunos_budgets
  (scope,project_id,COALESCE(slack_user_id,''),period_start,period_end);
ALTER TABLE giunos_budgets ENABLE ROW LEVEL SECURITY;
-- No anon/authenticated policies: access only via the existing trusted backend.
