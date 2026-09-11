BEGIN;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS lifecycle_evidence jsonb;
ALTER TABLE public.projects DROP CONSTRAINT IF EXISTS projects_status_check;
ALTER TABLE public.projects ADD CONSTRAINT projects_status_check
  CHECK (status IN ('planning','active','on_hold','completed','cancelled','archived','merged'));
COMMIT;
