-- FIX: Supabase safe-update guard requires a WHERE predicate on DELETE.
-- Run this in SQL Editor on an existing installation; does NOT delete data when applied.
-- Do NOT rerun the original event-library migration.
BEGIN;
CREATE OR REPLACE FUNCTION public.st_event_load(j jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE cfg jsonb := j->'settings'; max_log bigint;
BEGIN
 IF jsonb_typeof(j) <> 'object' OR jsonb_typeof(cfg) <> 'object'
  OR jsonb_typeof(j->'businesses') <> 'array'
  OR jsonb_typeof(j->'investors') <> 'array'
  OR jsonb_typeof(j->'offers') <> 'array'
  OR jsonb_typeof(j->'votes') <> 'array'
  OR jsonb_typeof(j->'logs') <> 'array' THEN
  RAISE EXCEPTION 'Invalid event snapshot';
 END IF;
 UPDATE public.st_settings SET active_business=NULL WHERE id=1;
 DELETE FROM public.st_offers WHERE id IS NOT NULL;
 DELETE FROM public.st_votes WHERE business_id IS NOT NULL;
 DELETE FROM public.st_businesses WHERE id IS NOT NULL;
 DELETE FROM public.st_investors WHERE id IS NOT NULL;
 DELETE FROM public.st_log WHERE id IS NOT NULL;
 INSERT INTO public.st_investors(id,name,title,code,enabled,created_at)
 SELECT x.id,x.name,x.title,x.code,x.enabled,x.created_at
 FROM jsonb_populate_recordset(NULL::public.st_investors,j->'investors') x;
 INSERT INTO public.st_businesses(id,name,entrepreneur,description,ask_amount,ask_equity,sort_order,status,mode,created_at)
 SELECT x.id,x.name,x.entrepreneur,x.description,x.ask_amount,x.ask_equity,x.sort_order,x.status,x.mode,x.created_at
 FROM jsonb_populate_recordset(NULL::public.st_businesses,j->'businesses') x;
 INSERT INTO public.st_offers(id,business_id,investor_id,amount,equity,terms,status,created_at,updated_at)
 SELECT x.id,x.business_id,x.investor_id,x.amount,x.equity,x.terms,x.status,x.created_at,x.updated_at
 FROM jsonb_populate_recordset(NULL::public.st_offers,j->'offers') x;
 INSERT INTO public.st_votes(business_id,voter_id,rating,created_at)
 SELECT x.business_id,x.voter_id,x.rating,x.created_at
 FROM jsonb_populate_recordset(NULL::public.st_votes,j->'votes') x;
 INSERT INTO public.st_log(id,actor,action,details,at)
 SELECT x.id,x.actor,x.action,x.details,x.at
 FROM jsonb_populate_recordset(NULL::public.st_log,j->'logs') x;
 SELECT max(id) INTO max_log FROM public.st_log;
 IF max_log IS NOT NULL THEN
  PERFORM setval(pg_get_serial_sequence('public.st_log','id'),greatest(max_log,1),true);
 END IF;
 UPDATE public.st_settings SET
  display_title=left(coalesce(cfg->>'display_title','Shark Tank Night'),120),
  starting_budget=coalesce((cfg->>'starting_budget')::numeric,0),
  mode=coalesce(cfg->>'mode','live'),
  locked=coalesce((cfg->>'locked')::boolean,true),
  active_business=NULLIF(cfg->>'active_business','')::uuid,
  presentation_view=coalesce(cfg->>'presentation_view','business'),
  audience_qr_mode=coalesce(cfg->>'audience_qr_mode','welcome'),
  audience_qr_visible=coalesce((cfg->>'audience_qr_visible')::boolean,true),
  updated_at=now()
 WHERE id=1;
END;
$$;
REVOKE ALL ON FUNCTION public.st_event_load(jsonb) FROM PUBLIC, anon, authenticated;
COMMIT;
