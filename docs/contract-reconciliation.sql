-- Stage source evidence separately from canonical hours and verified budgets.
CREATE TABLE IF NOT EXISTS public.project_contract_sources (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES public.projects(id),
  input jsonb NOT NULL CHECK (jsonb_typeof(input)='object'),
  assessment jsonb NOT NULL CHECK (jsonb_typeof(assessment)='object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.project_contract_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_contract_sources FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.project_contract_sources TO service_role;
