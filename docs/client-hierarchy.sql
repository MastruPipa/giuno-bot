-- 2026-09-12: additive client hierarchy. Legacy projects and time logs remain intact.
CREATE TABLE IF NOT EXISTS public.agency_clients (
 id text PRIMARY KEY, name text NOT NULL,
 aliases text[] NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.work_nodes (
 id text PRIMARY KEY,
 client_id text NOT NULL REFERENCES public.agency_clients(id),
 parent_id text,
 kind text NOT NULL CHECK (kind IN ('engagement','objective','deliverable','activity')),
 name text NOT NULL,
 period_start date, period_end date,
 state text NOT NULL DEFAULT 'unverified',
 source_url text NOT NULL CHECK (source_url LIKE 'https://%'),
 metadata jsonb NOT NULL DEFAULT '{}',
 UNIQUE (id,client_id),
 FOREIGN KEY (parent_id,client_id) REFERENCES public.work_nodes(id,client_id),
 CHECK ((period_start IS NULL AND period_end IS NULL) OR
        (period_start IS NOT NULL AND period_end IS NOT NULL AND period_start <= period_end)),
 CHECK (parent_id IS NOT NULL OR kind='engagement')
);
CREATE TABLE IF NOT EXISTS public.project_client_links (
 project_id text PRIMARY KEY REFERENCES public.projects(id),
 client_id text NOT NULL REFERENCES public.agency_clients(id),
 node_id text,
 source_url text NOT NULL CHECK (source_url LIKE 'https://%'),
 note text,
 FOREIGN KEY (node_id,client_id) REFERENCES public.work_nodes(id,client_id)
);
CREATE TABLE IF NOT EXISTS public.client_evidence (
 id text PRIMARY KEY,
 client_id text NOT NULL REFERENCES public.agency_clients(id),
 kind text NOT NULL CHECK (kind IN ('accounting','operational','contract','closure')),
 valid_from date NOT NULL, valid_until date NOT NULL,
 source_url text NOT NULL CHECK (source_url LIKE 'https://%'),
 detail text NOT NULL,
 CHECK (valid_from <= valid_until)
);
CREATE OR REPLACE FUNCTION public.validate_work_node_parent() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
DECLARE parent_kind text;
BEGIN
 -- Parentage is immutable once inserted: corrections create an explicit new node.
 IF TG_OP='UPDATE' AND (NEW.parent_id IS DISTINCT FROM OLD.parent_id OR
 NEW.client_id IS DISTINCT FROM OLD.client_id OR NEW.kind IS DISTINCT FROM OLD.kind) THEN
   RAISE EXCEPTION 'work node parent, client and kind are immutable';
 END IF;
 IF NEW.parent_id IS NOT NULL THEN
   SELECT kind INTO parent_kind FROM public.work_nodes WHERE id=NEW.parent_id AND client_id=NEW.client_id;
   IF parent_kind IS NULL OR array_position(ARRAY['engagement','objective','deliverable','activity'], parent_kind)
     >= array_position(ARRAY['engagement','objective','deliverable','activity'], NEW.kind) THEN
     RAISE EXCEPTION 'work node parent must belong to an earlier level of the same client';
   END IF;
 END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS work_node_parent_guard ON public.work_nodes;
CREATE TRIGGER work_node_parent_guard BEFORE INSERT OR UPDATE ON public.work_nodes
FOR EACH ROW EXECUTE FUNCTION public.validate_work_node_parent();
ALTER TABLE public.agency_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_client_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agency_clients,public.work_nodes,public.project_client_links,public.client_evidence FROM anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.agency_clients,public.work_nodes,public.project_client_links,public.client_evidence TO service_role;
CREATE INDEX IF NOT EXISTS work_nodes_client_idx ON public.work_nodes(client_id);
CREATE INDEX IF NOT EXISTS client_evidence_client_dates_idx ON public.client_evidence(client_id,valid_from,valid_until);
-- 2026-09-12: explicit general posting account for a reconciled client.
ALTER TABLE public.agency_clients ADD COLUMN IF NOT EXISTS default_project_id text REFERENCES public.projects(id);
CREATE UNIQUE INDEX IF NOT EXISTS agency_clients_default_project_unique ON public.agency_clients(default_project_id) WHERE default_project_id IS NOT NULL;
