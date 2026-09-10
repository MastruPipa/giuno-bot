-- Apply before deploying the unified writer. Existing rows are preserved.
BEGIN;
-- The previous daily minimum rejected legitimate 15-minute activities.
ALTER TABLE public.time_logs DROP CONSTRAINT IF EXISTS time_logs_hours_check;
ALTER TABLE public.time_logs ADD CONSTRAINT time_logs_hours_check CHECK (
  hours > 0 AND ((log_type = 'daily' AND hours <= 24) OR
                (log_type = 'weekly' AND hours <= 60))
);

CREATE TABLE IF NOT EXISTS public.time_log_write_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  written_at timestamptz NOT NULL DEFAULT now(),
  slack_user_id text NOT NULL,
  log_date date NOT NULL,
  log_type text NOT NULL,
  previous_rows jsonb NOT NULL,
  resulting_rows jsonb NOT NULL
);
ALTER TABLE public.time_log_write_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.time_log_write_history FROM anon, authenticated;
GRANT SELECT, INSERT ON public.time_log_write_history TO service_role;
GRANT USAGE ON SEQUENCE public.time_log_write_history_id_seq TO service_role;

-- A write is a daily/weekly snapshot, not an additive increment. Replays are
-- idempotent. p_replace=false updates just the named projects. The lock also
-- serializes writes for different projects on the same person/day.
CREATE OR REPLACE FUNCTION public.write_time_logs(
  p_user text, p_date date, p_type text, p_rows jsonb,
  p_replace boolean DEFAULT false, p_estimate boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_removed jsonb;
  v_row jsonb;
  v_total numeric;
BEGIN
  IF p_user IS NULL OR length(trim(p_user)) = 0 OR p_date IS NULL
     OR p_type NOT IN ('daily', 'weekly') OR p_type IS NULL
     OR p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array'
     OR p_replace IS NULL OR p_estimate IS NULL THEN
    RAISE EXCEPTION 'Invalid time log scope';
  END IF;
  IF p_estimate AND p_type <> 'daily' THEN
    RAISE EXCEPTION 'Only daily logs may be estimated';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) r
             GROUP BY r->>'project_id' HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate project in snapshot';
  END IF;
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    IF coalesce(v_row->>'project_id','') = ''
       OR jsonb_typeof(v_row->'hours') IS DISTINCT FROM 'number'
       OR (v_row->>'hours')::numeric <= 0
       OR (v_row->>'hours')::numeric > (CASE WHEN p_type='daily' THEN 24 ELSE 60 END)
       OR (v_row->>'hours')::numeric <> round((v_row->>'hours')::numeric,2)
       OR coalesce(v_row->'validation'->>'status' = 'estimate',false) <> p_estimate THEN
      RAISE EXCEPTION 'Invalid time log row';
    END IF;
  END LOOP;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user || ':' || p_date::text || ':' || p_type,0));
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY project_id),'[]'::jsonb) INTO v_before
    FROM public.time_logs t WHERE slack_user_id=p_user AND log_date=p_date AND log_type=p_type;

  IF p_replace THEN
    DELETE FROM public.time_logs t
      WHERE slack_user_id=p_user AND log_date=p_date AND log_type=p_type
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) r WHERE r->>'project_id'=t.project_id)
      AND (NOT p_estimate OR coalesce(validation->>'status','')='estimate');
  END IF;
  INSERT INTO public.time_logs(slack_user_id,project_id,log_date,log_type,hours,notes,validation)
    SELECT p_user,r->>'project_id',p_date,p_type,(r->>'hours')::numeric,r->>'notes',nullif(r->'validation','null'::jsonb)
    FROM jsonb_array_elements(p_rows) r
    ON CONFLICT (slack_user_id,project_id,log_date,log_type) DO UPDATE
      SET hours=excluded.hours, notes=excluded.notes, validation=excluded.validation, updated_at=now()
      WHERE (NOT p_estimate OR coalesce(time_logs.validation->>'status','')='estimate')
        AND (time_logs.hours,time_logs.notes,time_logs.validation)
          IS DISTINCT FROM (excluded.hours,excluded.notes,excluded.validation);

  SELECT coalesce(sum(hours),0) INTO v_total FROM public.time_logs
    WHERE slack_user_id=p_user AND log_date=p_date AND log_type=p_type;
  IF p_type='daily' AND v_total>24 THEN RAISE EXCEPTION 'Daily total exceeds 24 hours'; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY project_id),'[]'::jsonb) INTO v_after
    FROM public.time_logs t WHERE slack_user_id=p_user AND log_date=p_date AND log_type=p_type;
  SELECT coalesce(jsonb_agg(r->>'project_id'),'[]'::jsonb) INTO v_removed
    FROM jsonb_array_elements(v_before) r WHERE NOT EXISTS
      (SELECT 1 FROM jsonb_array_elements(v_after) a WHERE a->>'project_id'=r->>'project_id');
  IF v_before IS DISTINCT FROM v_after THEN
    INSERT INTO public.time_log_write_history(slack_user_id,log_date,log_type,previous_rows,resulting_rows)
      VALUES(p_user,p_date,p_type,v_before,v_after);
  END IF;
  RETURN jsonb_build_object('saved',v_after,'removedProjectIds',v_removed);
END;
$$;
REVOKE ALL ON FUNCTION public.write_time_logs(text,date,text,jsonb,boolean,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_time_logs(text,date,text,jsonb,boolean,boolean) TO service_role;
COMMIT;
