-- 12one Shark Tank: event library, lifecycle, transactional switching and v1 backups
-- Run ONCE in Supabase SQL Editor. Preserves existing rows; take a Supabase backup first.
BEGIN;

CREATE TABLE IF NOT EXISTS public.st_events (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'paused' CHECK (status IN ('active','paused','ended','archived')),
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.st_event_control (
  id integer PRIMARY KEY CHECK (id=1),
  current_event_id uuid NOT NULL REFERENCES public.st_events(id) ON DELETE RESTRICT
);
ALTER TABLE public.st_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.st_event_control ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.st_events, public.st_event_control FROM PUBLIC, anon, authenticated;

-- Snapshot includes every original row, including anonymous voter UUIDs and codes.
-- Never copy the host's admin_hash to the saved snapshot or downloaded backup.
CREATE OR REPLACE FUNCTION public.st_event_capture()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object(
  'settings',(SELECT to_jsonb(s)-'admin_hash' FROM public.st_settings s WHERE id=1),
  'businesses',coalesce((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.created_at,b.id) FROM public.st_businesses b),'[]'::jsonb),
  'investors',coalesce((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.created_at,i.id) FROM public.st_investors i),'[]'::jsonb),
  'offers',coalesce((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.created_at,o.id) FROM public.st_offers o),'[]'::jsonb),
  'votes',coalesce((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.created_at,v.business_id) FROM public.st_votes v),'[]'::jsonb),
  'logs',coalesce((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM public.st_log l),'[]'::jsonb)
 );
$$;
REVOKE ALL ON FUNCTION public.st_event_capture() FROM PUBLIC, anon, authenticated;

-- Replaces the single live workspace; caller MUST hold the st_settings row lock.
-- All writes happen in the calling transaction and roll back on any error.
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
 DELETE FROM public.st_offers;
 DELETE FROM public.st_votes;
 DELETE FROM public.st_businesses;
 DELETE FROM public.st_investors;
 DELETE FROM public.st_log;
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

-- Existing live data becomes the first registered event.
INSERT INTO public.st_events(name,status,snapshot)
SELECT coalesce(nullif(trim(s.display_title),''),'Original Shark Tank'), 'active',public.st_event_capture()
FROM public.st_settings s WHERE s.id=1
AND NOT EXISTS(SELECT 1 FROM public.st_event_control WHERE id=1)
AND NOT EXISTS(SELECT 1 FROM public.st_events);
INSERT INTO public.st_event_control(id,current_event_id)
SELECT 1,e.id FROM public.st_events e ORDER BY e.created_at,e.id LIMIT 1
ON CONFLICT (id) DO NOTHING;

-- Keep the old API intact, under a private name; wrapper enforces event states.
ALTER FUNCTION public.st_api(text,jsonb) RENAME TO st_api_legacy;
REVOKE ALL ON FUNCTION public.st_api_legacy(text,jsonb) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.st_api(p_action text, p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 s public.st_settings%rowtype;
 actor_code text := coalesce(p->>'code','');
 is_admin boolean;
 current_id uuid;
 current_status text;
 target_id uuid;
 target public.st_events%rowtype;
 current_name text;
 payload jsonb;
 data jsonb;
 result jsonb;
 new_name text;
 new_id uuid;
 allowed_status text;
BEGIN
 -- Serialize all old API actions with switches, preventing races mid-event.
 SELECT * INTO s FROM public.st_settings WHERE id=1 FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Settings unavailable'; END IF;
 SELECT c.current_event_id,e.status,e.name
 INTO current_id,current_status,current_name
 FROM public.st_event_control c JOIN public.st_events e ON e.id=c.current_event_id
 WHERE c.id=1;
 IF current_id IS NULL THEN RAISE EXCEPTION 'Event library not initialized'; END IF;
 is_admin := length(actor_code)>0 AND s.admin_hash=extensions.crypt(actor_code,s.admin_hash);

 IF p_action='state' THEN
  result := public.st_api_legacy(p_action,p);
  result := jsonb_set(result,'{settings}',(result->'settings') ||
    jsonb_build_object('event_id',current_id,'event_name',current_name,'event_status',current_status));
  RETURN result;
 END IF;

 IF p_action='investor_login' THEN
  RETURN public.st_api_legacy(p_action,p);
 END IF;

 IF p_action IN ('event_list','event_export','event_import','event_create',
                  'event_select','event_status','event_delete') THEN
  IF NOT is_admin THEN RAISE EXCEPTION 'Invalid host code'; END IF;
  IF p_action='event_list' THEN
   RETURN jsonb_build_object('current_event_id',current_id,'events',
    coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id',e.id,'name',e.name,'status',e.status,'created_at',e.created_at,
      'updated_at',e.updated_at,'ended_at',e.ended_at,
      'current',e.id=current_id) ORDER BY e.created_at DESC)
      FROM public.st_events e),'[]'::jsonb));
  ELSIF p_action='event_export' THEN
   target_id := coalesce(nullif(p->>'id','')::uuid,current_id);
   SELECT * INTO target FROM public.st_events WHERE id=target_id;
   IF NOT FOUND THEN RAISE EXCEPTION 'Event not found'; END IF;
   data := CASE WHEN target_id=current_id THEN public.st_event_capture() ELSE target.snapshot END;
   RETURN jsonb_build_object('format','12one-sharktank-backup','version',1,
       'exported_at',now(),'event',jsonb_build_object(
        'name',target.name,'status',target.status,'created_at',target.created_at,
        'ended_at',target.ended_at),'snapshot',data);
  ELSIF p_action='event_import' THEN
   payload := p->'backup';
   IF jsonb_typeof(payload)<>'object'
     OR payload->>'format' IS DISTINCT FROM '12one-sharktank-backup'
     OR payload->>'version' IS DISTINCT FROM '1'
     OR jsonb_typeof(payload->'event')<>'object'
     OR jsonb_typeof(payload->'snapshot')<>'object'
     OR jsonb_typeof(payload->'snapshot'->'settings')<>'object'
     OR jsonb_typeof(payload->'snapshot'->'businesses')<>'array'
     OR jsonb_typeof(payload->'snapshot'->'investors')<>'array'
     OR jsonb_typeof(payload->'snapshot'->'offers')<>'array'
     OR jsonb_typeof(payload->'snapshot'->'votes')<>'array'
     OR jsonb_typeof(payload->'snapshot'->'logs')<>'array'
     OR pg_column_size(payload)>10485760 THEN
     RAISE EXCEPTION 'Unsupported or invalid Shark Tank backup';
   END IF;
   -- Imported events stay dormant until explicitly selected.
   new_name:=left(coalesce(nullif(trim(payload->'event'->>'name'),''),'Imported Event'),120);
   INSERT INTO public.st_events(name,status,snapshot)
   VALUES(new_name,'paused',payload->'snapshot') RETURNING id INTO new_id;
   RETURN jsonb_build_object('ok',true,'event_id',new_id);
  ELSIF p_action='event_create' THEN
   new_name:=left(coalesce(nullif(trim(p->>'name'),''),'New Shark Tank Event'),120);
   data:=jsonb_build_object(
    'settings',jsonb_build_object('display_title',new_name,
      'starting_budget',s.starting_budget,'mode','live','locked',true,
      'active_business',NULL,'presentation_view','business',
      'audience_qr_mode','welcome','audience_qr_visible',true),
    'businesses','[]'::jsonb,'investors','[]'::jsonb,
    'offers','[]'::jsonb,'votes','[]'::jsonb,'logs','[]'::jsonb);
   INSERT INTO public.st_events(name,status,snapshot)
   VALUES(new_name,'paused',data) RETURNING id INTO new_id;
   RETURN jsonb_build_object('ok',true,'event_id',new_id);
  ELSIF p_action='event_delete' THEN
   target_id:=(p->>'id')::uuid;
   IF target_id=current_id THEN RAISE EXCEPTION 'Switch to another event before deleting this one'; END IF;
   DELETE FROM public.st_events WHERE id=target_id;
   IF NOT FOUND THEN RAISE EXCEPTION 'Event not found'; END IF;
   RETURN jsonb_build_object('ok',true);
  ELSIF p_action='event_status' THEN
   target_id:=(p->>'id')::uuid;
   allowed_status:=p->>'status';
   IF allowed_status NOT IN ('active','paused','ended','archived') THEN
    RAISE EXCEPTION 'Invalid event status';
   END IF;
   SELECT * INTO target FROM public.st_events WHERE id=target_id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Event not found'; END IF;
   IF allowed_status='active' AND target_id<>current_id THEN
    RAISE EXCEPTION 'Select this event before activating it';
   END IF;
   IF allowed_status='archived' AND target_id=current_id THEN
    RAISE EXCEPTION 'Switch events before archiving the current one';
   END IF;
   IF allowed_status='ended' AND target_id=current_id THEN
    UPDATE public.st_settings SET locked=true,presentation_view='summary',updated_at=now() WHERE id=1;
   ELSIF allowed_status='paused' AND target_id=current_id THEN
    UPDATE public.st_settings SET locked=true,updated_at=now() WHERE id=1;
   ELSIF allowed_status='active' AND target_id=current_id THEN
    UPDATE public.st_settings SET locked=false,updated_at=now() WHERE id=1;
   END IF;
   UPDATE public.st_events SET status=allowed_status,updated_at=now(),
    ended_at=CASE WHEN allowed_status='ended' THEN now()
                  WHEN allowed_status='active' THEN NULL ELSE ended_at END
   WHERE id=target_id;
   UPDATE public.st_signal SET revision=revision+1,changed_at=now() WHERE id=1;
   RETURN jsonb_build_object('ok',true);
  ELSIF p_action='event_select' THEN
   target_id:=(p->>'id')::uuid;
   IF target_id=current_id THEN RETURN jsonb_build_object('ok',true); END IF;
   SELECT * INTO target FROM public.st_events WHERE id=target_id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Event not found'; END IF;
   IF target.status='archived' THEN RAISE EXCEPTION 'Unarchive the event before selecting it'; END IF;
   -- Save outgoing live tables, then replace the workspace atomically.
   UPDATE public.st_events SET snapshot=public.st_event_capture(),
    status=CASE WHEN status='active' THEN 'paused' ELSE status END,
    updated_at=now() WHERE id=current_id;
   PERFORM public.st_event_load(target.snapshot);
   UPDATE public.st_event_control SET current_event_id=target_id WHERE id=1;
   -- A selected event must be explicitly resumed; never auto-open on restore.
   UPDATE public.st_events SET status=CASE WHEN status='active' THEN 'paused' ELSE status END,
    updated_at=now() WHERE id=target_id;
   UPDATE public.st_settings SET locked=true WHERE id=1;
   UPDATE public.st_signal SET revision=revision+1,changed_at=now() WHERE id=1;
   RETURN jsonb_build_object('ok',true);
  END IF;
 END IF;

 -- Concluded events are immutable until a host reopens them.
 IF current_status IN ('ended','archived') THEN
  RAISE EXCEPTION 'This event has ended. Reopen it from the host event library.';
 END IF;
 -- A paused event is read-only; the original Master Lock remains independent.
 IF current_status<>'active' THEN
  RAISE EXCEPTION 'Activate this event from the host event library first';
 END IF;
 RETURN public.st_api_legacy(p_action,p);
END;
$$;
GRANT EXECUTE ON FUNCTION public.st_api(text,jsonb) TO anon,authenticated;
REVOKE ALL ON FUNCTION public.st_api(text,jsonb) FROM PUBLIC;

COMMIT;

-- Verify without modifying data:
-- SELECT id,name,status FROM public.st_events;
-- SELECT * FROM public.st_event_control;
