-- Quizzy live patch 2026-11-04
-- Run this SQL in the EXISTING Shark Tank Supabase project SQL Editor.
-- Preserves all existing sessions and players. Replaces ONLY the Quizzy RPC.
-- Restart clears question answers, score adjustments and canceled questions,
-- but retains player identities, nicknames, teams and game PIN.
-- Deletion permanently removes the selected session and dependent data.

create or replace function public.quizzy_api(p_action text,p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  h public.quizzy_hosts%rowtype;
  q public.quizzy_quizzes%rowtype;
  s public.quizzy_sessions%rowtype;
  player public.quizzy_players%rowtype;
  question jsonb;
  questions jsonb;
  opts jsonb;
  answer jsonb;
  selected text[];
  expected text[];
  idx integer;
  secs integer;
  elapsed numeric;
  credit numeric;
  pts integer;
  multiplier numeric;
  is_correct boolean;
  pid uuid;
  sid uuid;
  code text;
  host_code text := coalesce(p->>'host_code','');
  response jsonb;
  entries jsonb;
  result jsonb;
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Sign in anonymously first'; end if;
  if p_action in ('host_login','host_quizzes','host_sessions','duplicate_session','delete_session','shared_quiz','save_quiz','delete_quiz','create_session','host_state','control','adjust','remove_player','create_host','export') then
    select * into h from public.quizzy_hosts where active and code_hash=extensions.crypt(host_code,code_hash) limit 1;
    if h.id is null then raise exception 'Invalid Quizzy host code'; end if;
  end if;
  if p_action='host_login' then
    return jsonb_build_object('host',h.label);
  elsif p_action='create_host' then
    if h.label <> 'Administrator' then raise exception 'Administrator only'; end if;
    if length(coalesce(p->>'code',''))<12 then raise exception 'Use a host code at least 12 characters'; end if;
    insert into public.quizzy_hosts(label,code_hash) values(left(p->>'label',80),extensions.crypt(p->>'code',extensions.gen_salt('bf')));
    return jsonb_build_object('ok',true);
  elsif p_action='host_sessions' then
    select coalesce(jsonb_agg(jsonb_build_object('pin',pin,'title',title,'phase',phase,'created_at',created_at) order by created_at desc),'[]'::jsonb)
      into result from public.quizzy_sessions where host_id=h.id;
    return result;
  elsif p_action='duplicate_session' then
    select * into s from public.quizzy_sessions where pin=p->>'pin' and host_id=h.id;
    if s.id is null then raise exception 'Game not found or not owned by you'; end if;
    loop
      code:=lpad((floor(random()*1000000))::int::text,6,'0');
      begin
        insert into public.quizzy_sessions(pin,host_id,quiz_id,snapshot,title,mode,score_mode,team_mode,streak_enabled,randomize_options,display_mode,teams)
        values(code,h.id,s.quiz_id,s.snapshot,s.title,s.mode,s.score_mode,s.team_mode,s.streak_enabled,s.randomize_options,s.display_mode,s.teams) returning id into sid;
        exit;
      exception when unique_violation then continue;
      end;
    end loop;
    insert into public.quizzy_signal(session_id) values(sid);
    return jsonb_build_object('pin',code);
  elsif p_action='summary' then
    select * into s from public.quizzy_sessions where pin=p->>'pin';
    if s.id is null then raise exception 'Game not found'; end if;
    if s.phase<>'finished' then raise exception 'Summary available after game ends'; end if;
    select coalesce(jsonb_agg(jsonb_build_object(
      'index',n.ordinality,'text',n.question->>'text',
      'cancelled',s.cancelled_questions @> jsonb_build_array((n.ordinality-1)::int),
      'answers',(select count(*) from public.quizzy_answers a where a.session_id=s.id and a.question_index=n.ordinality-1),
      'correct',(select count(*) from public.quizzy_answers a where a.session_id=s.id and a.question_index=n.ordinality-1 and a.correct),
      'accuracy',coalesce((select round(100.0*count(*) filter(where a.correct)/nullif(count(*),0)) from public.quizzy_answers a where a.session_id=s.id and a.question_index=n.ordinality-1),0)
    ) order by n.ordinality),'[]'::jsonb) into entries
    from jsonb_array_elements(s.snapshot->'questions') with ordinality n(question,ordinality);
    return jsonb_build_object('title',s.title,'question_stats',entries);
  elsif p_action='delete_session' then
    select * into s from public.quizzy_sessions where pin=p->>'pin' and host_id=h.id for update;
    if s.id is null then raise exception 'Game not found or not owned by you'; end if;
    if p->>'confirm' <> s.pin then raise exception 'Enter the game PIN to confirm deletion'; end if;
    delete from public.quizzy_sessions where id=s.id;
    return jsonb_build_object('ok',true,'deleted_pin',s.pin);
  elsif p_action='host_quizzes' then
    select coalesce(jsonb_agg(jsonb_build_object('id',id,'title',title,'content',content,'share_token',share_token,'owner',owner_id=h.id) order by updated_at desc),'[]'::jsonb)
    into result from public.quizzy_quizzes where owner_id=h.id;
    return result;
  elsif p_action='shared_quiz' then
    select * into q from public.quizzy_quizzes where share_token=p->>'token';
    if q.id is null then raise exception 'Quiz not found'; end if;
    return jsonb_build_object('title',q.title,'content',q.content);
  elsif p_action='save_quiz' then
    questions:=p->'questions';
    if jsonb_typeof(questions)<>'array' or jsonb_array_length(questions)<1 or jsonb_array_length(questions)>100 then raise exception 'Quiz needs 1–100 questions'; end if;
    if length(trim(coalesce(p->>'title','')))<1 then raise exception 'Give the quiz a title'; end if;
    for question in select value from jsonb_array_elements(questions) loop
      if (question->>'type') not in ('single','multi','tf','poll','numeric') then raise exception 'Unsupported question type'; end if;
      if length(trim(coalesce(question->>'text','')))<1 then raise exception 'Question text required'; end if;
      if coalesce((question->>'seconds')::integer,0) not between 5 and 300 then raise exception 'Time limit must be 5–300 seconds'; end if;
      if (question->>'type') in ('single','multi','tf','poll') and (jsonb_typeof(question->'options')<>'array' or jsonb_array_length(question->'options') not between 2 and 6) then raise exception 'Question needs 2–6 options'; end if;
      if (question->>'type') in ('single','tf','multi') and jsonb_typeof(question->'correct')<>'array' then raise exception 'Correct options required'; end if;
      if (question->>'type')='numeric' and (question->>'value' is null or question->>'tolerance' is null or (question->>'tolerance')::numeric<0) then raise exception 'Numeric answer and nonnegative tolerance required'; end if;
    end loop;
    if nullif(p->>'id','') is not null then
      update public.quizzy_quizzes set title=left(p->>'title',150),content=jsonb_build_object('questions',questions),updated_at=now()
      where id=(p->>'id')::uuid and owner_id=h.id returning * into q;
      if q.id is null then raise exception 'Only the owner can edit this quiz'; end if;
    else
      insert into public.quizzy_quizzes(owner_id,title,content) values(h.id,left(p->>'title',150),jsonb_build_object('questions',questions)) returning * into q;
    end if;
    return jsonb_build_object('id',q.id,'share_token',q.share_token);
  elsif p_action='delete_quiz' then
    delete from public.quizzy_quizzes where id=(p->>'id')::uuid and owner_id=h.id;
    return jsonb_build_object('ok',true);
  elsif p_action='create_session' then
    select * into q from public.quizzy_quizzes where id=(p->>'quiz_id')::uuid and (owner_id=h.id or share_token=p->>'share_token');
    if q.id is null then raise exception 'Quiz inaccessible'; end if;
    if (p->>'mode') not in ('team','solo') or (p->>'score_mode') not in ('accuracy','speed') or (p->>'team_mode') not in ('sum','average') or (p->>'display_mode') not in ('both','projector') then raise exception 'Invalid session settings'; end if;
    if p->>'mode'='team' and (jsonb_typeof(p->'teams')<>'array' or jsonb_array_length(p->'teams')<2) then raise exception 'Create at least two teams'; end if;
    loop
      code:=lpad((floor(random()*1000000))::int::text,6,'0');
      begin
        insert into public.quizzy_sessions(pin,host_id,quiz_id,snapshot,title,mode,score_mode,team_mode,streak_enabled,randomize_options,display_mode,teams)
        values(code,h.id,q.id,q.content,q.title,p->>'mode',p->>'score_mode',p->>'team_mode',coalesce((p->>'streak_enabled')::boolean,false),coalesce((p->>'randomize_options')::boolean,true),p->>'display_mode',coalesce(p->'teams','[]'::jsonb)) returning * into s;
        exit;
      exception when unique_violation then continue;
      end;
    end loop;
    insert into public.quizzy_signal(session_id) values(s.id);
    return jsonb_build_object('pin',s.pin);
  elsif p_action='join' then
    select * into s from public.quizzy_sessions where pin=p->>'pin' for update;
    if s.id is null then raise exception 'Game PIN not found'; end if;
    select * into player from public.quizzy_players where session_id=s.id and auth_user=uid;
    if player.id is not null then
      if player.removed then raise exception 'You were removed from this game'; end if;
      return jsonb_build_object('pin',s.pin,'nickname',player.nickname);
    end if;
    if s.phase<>'lobby' or s.joining_locked then raise exception 'Joining is closed'; end if;
    if (select count(*) from public.quizzy_players where session_id=s.id and not removed)>=100 then raise exception 'Game is full'; end if;
    if length(trim(coalesce(p->>'nickname',''))) not between 1 and 30 then raise exception 'Nickname must be 1–30 characters'; end if;
    if s.mode='team' and not exists(select 1 from jsonb_array_elements_text(s.teams) as x(value) where x.value=p->>'team') then raise exception 'Choose a valid team'; end if;
    begin
      insert into public.quizzy_players(session_id,auth_user,nickname,team)
      values(s.id,uid,trim(p->>'nickname'),case when s.mode='team' then p->>'team' else null end) returning * into player;
    exception when unique_violation then raise exception 'Nickname already taken, or already joined on this device'; end;
    return jsonb_build_object('pin',s.pin,'nickname',player.nickname);
  elsif p_action in ('public_state','host_state','export') then
    select * into s from public.quizzy_sessions where pin=p->>'pin';
    if s.id is null then raise exception 'Game not found'; end if;
    if p_action in ('host_state','export') and s.host_id<>h.id then raise exception 'Not your game'; end if;
    select coalesce(jsonb_agg(jsonb_build_object('id',z.id,'nickname',z.nickname,'team',z.team,'score',z.score,'removed',z.removed) order by z.score desc,z.nickname),'[]'::jsonb) into entries
    from (
      select a.id,a.nickname,a.team,a.removed,
        coalesce((select sum(v.points) from public.quizzy_answers v where v.player_id=a.id and not (s.cancelled_questions @> jsonb_build_array(v.question_index))),0)
        +coalesce((select sum(d.delta) from public.quizzy_adjustments d where d.player_id=a.id),0) score
      from public.quizzy_players a where a.session_id=s.id
    ) z;
    questions:=s.snapshot->'questions';
    if s.question_index>=0 then
      question:=questions->s.question_index;
      if p_action='public_state' then
        select * into player from public.quizzy_players where session_id=s.id and auth_user=uid;
        if player.id is not null and s.randomize_options and s.display_mode='both' and (question->>'type')<>'numeric' then
          select coalesce(jsonb_agg(v.option_text order by md5(player.id::text||v.option_text)), '[]'::jsonb) into opts
          from jsonb_array_elements_text(question->'options') v(option_text);
          question:=jsonb_set(question,'{options}',opts);
        end if;
        question:=question - 'correct' - 'value' - 'tolerance' - 'explanation';
      end if;
    else question:=null;
    end if;
    if p_action='export' then
      return jsonb_build_object('title',s.title,'players',entries,'answers',(select coalesce(jsonb_agg(to_jsonb(a)),'[]'::jsonb) from public.quizzy_answers a where a.session_id=s.id),'adjustments',(select coalesce(jsonb_agg(to_jsonb(a)),'[]'::jsonb) from public.quizzy_adjustments a where a.session_id=s.id));
    end if;
    response:=jsonb_build_object('pin',s.pin,'title',s.title,'mode',s.mode,'team_mode',s.team_mode,'score_mode',s.score_mode,'teams',s.teams,'display_mode',s.display_mode,'phase',s.phase,'question_index',s.question_index,'question_count',jsonb_array_length(questions),'question',question,'seconds',coalesce((question->>'seconds')::integer,0),'started_at',s.started_at,'paused_at',s.paused_at,'server_time',clock_timestamp(),'joining_locked',s.joining_locked,'rankings_visible',s.rankings_visible,'players',case when p_action='host_state' or s.phase='finished' or (s.rankings_visible and s.phase in ('leaderboard','reveal')) then entries else (select coalesce(jsonb_agg(jsonb_build_object('nickname',x->>'nickname','team',x->>'team')),'[]'::jsonb) from jsonb_array_elements(entries) x) end);
    if p_action='host_state' then
      response:=response||jsonb_build_object('questions',questions,'cancelled_questions',s.cancelled_questions,'answers',(select coalesce(jsonb_agg(to_jsonb(a)),'[]'::jsonb) from public.quizzy_answers a where a.session_id=s.id));
    else
      select * into player from public.quizzy_players where session_id=s.id and auth_user=uid;
      if player.id is not null and not player.removed then
        response:=response||jsonb_build_object('me',jsonb_build_object('id',player.id,'nickname',player.nickname,'team',player.team),'my_answer',(select a.response from public.quizzy_answers a where a.player_id=player.id and a.question_index=s.question_index));
      end if;
      if s.phase in ('reveal','leaderboard','finished') and s.question_index>=0 then
        response:=response||jsonb_build_object('correct',questions->s.question_index->'correct','numeric_value',questions->s.question_index->'value','explanation',questions->s.question_index->'explanation','stats',(select coalesce(jsonb_agg(jsonb_build_object('response',a.response,'correct',a.correct)),'[]'::jsonb) from public.quizzy_answers a where a.session_id=s.id and a.question_index=s.question_index));
      end if;
    end if;
    return response;
  elsif p_action='submit' then
    select * into s from public.quizzy_sessions where pin=p->>'pin' for update;
    if s.id is null or s.phase<>'question' or s.question_index<0 then raise exception 'Answers are closed'; end if;
    select * into player from public.quizzy_players where session_id=s.id and auth_user=uid and not removed;
    if player.id is null then raise exception 'Join the game first'; end if;
    question:=s.snapshot->'questions'->s.question_index;
    secs:=(question->>'seconds')::int;
    elapsed:=extract(epoch from (clock_timestamp()-s.started_at));
    if elapsed>secs+1 then raise exception 'Time is up'; end if;
    answer:=p->'answer';
    if jsonb_typeof(answer) is null then raise exception 'Answer required'; end if;
    is_correct:=false; credit:=0;
    if question->>'type'='numeric' then
      if jsonb_typeof(answer)<>'number' then raise exception 'Enter a number'; end if;
      is_correct:=abs((answer::text)::numeric-(question->>'value')::numeric)<=(question->>'tolerance')::numeric;
      credit:=case when is_correct then 1 else 0 end;
    elsif question->>'type'='poll' then
      if jsonb_typeof(answer)<>'string' or not exists(select 1 from jsonb_array_elements_text(question->'options') as v(value) where v.value=(answer #>> '{}')) then raise exception 'Invalid selection'; end if;
    else
      if jsonb_typeof(answer)<>'array' then raise exception 'Select answer options'; end if;
      select array_agg(distinct v order by v) into selected from jsonb_array_elements_text(answer) v;
      select array_agg(distinct v order by v) into expected from jsonb_array_elements_text(question->'correct') v;
      if cardinality(selected) is null or cardinality(selected)=0 then raise exception 'Select an answer'; end if;
      if exists(select 1 from unnest(selected) v where not exists(select 1 from jsonb_array_elements_text(question->'options') as o(value) where o.value=v)) then raise exception 'Invalid option'; end if;
      if question->>'type' in ('single','tf') and cardinality(selected)<>1 then raise exception 'Choose one option'; end if;
      is_correct:=selected=expected;
      if is_correct then credit:=1;
      elsif question->>'type'='multi' and coalesce(question->>'multi_scoring','all')='partial' then
        credit:=greatest(0,(select count(*) from unnest(selected) v where v=any(expected))::numeric / greatest(1,cardinality(expected)) - (select count(*) from unnest(selected) v where not v=any(expected))::numeric / greatest(1,cardinality(expected)));
      end if;
    end if;
    multiplier:=case when s.score_mode='speed' then 0.5+0.5*greatest(0,1-elapsed/secs) else 1 end;
    pts:=floor(credit*coalesce((question->>'points')::integer,1000)*multiplier);
    if s.streak_enabled and is_correct and exists(select 1 from public.quizzy_answers a where a.player_id=player.id and a.question_index=s.question_index-1 and a.correct) then pts:=pts+100; end if;
    insert into public.quizzy_answers(session_id,player_id,question_index,response,correct,points) values(s.id,player.id,s.question_index,answer,is_correct,pts);
    return jsonb_build_object('accepted',true);
  elsif p_action='control' then
    select * into s from public.quizzy_sessions where pin=p->>'pin' and host_id=h.id for update;
    if s.id is null then raise exception 'Game not found or not owned by you'; end if;
    code:=p->>'command';
    if code='restart' then
      if p->>'confirm'<>'RESTART' then raise exception 'Explicit restart confirmation required'; end if;
      delete from public.quizzy_answers where session_id=s.id;
      delete from public.quizzy_adjustments where session_id=s.id;
      update public.quizzy_sessions set phase='lobby',question_index=-1,started_at=null,paused_at=null,joining_locked=false,rankings_visible=true,cancelled_questions='[]'::jsonb where id=s.id;
    elsif code='start' or code='next' then
      if s.question_index+1>=jsonb_array_length(s.snapshot->'questions') then raise exception 'No more questions'; end if;
      update public.quizzy_sessions set question_index=question_index+1,phase=case when exists(select 1 from public.quizzy_answers a where a.session_id=s.id and a.question_index=s.question_index+1) then 'reveal' else 'question' end,started_at=clock_timestamp(),paused_at=null where id=s.id;
    elsif code='pause' then
      if s.phase<>'question' then raise exception 'No active question'; end if;
      update public.quizzy_sessions set phase='paused',paused_at=clock_timestamp() where id=s.id;
    elsif code='resume' then
      if s.phase<>'paused' then raise exception 'Not paused'; end if;
      update public.quizzy_sessions set phase='question',started_at=started_at+(clock_timestamp()-paused_at),paused_at=null where id=s.id;
    elsif code='reveal' then
      if s.phase not in ('question','paused') then raise exception 'No question to reveal'; end if;
      update public.quizzy_sessions set phase='reveal' where id=s.id;
    elsif code='leaderboard' then
      update public.quizzy_sessions set phase='leaderboard',rankings_visible=true where id=s.id;
    elsif code='previous' then
      if s.question_index<=0 then raise exception 'Already at first question'; end if;
      update public.quizzy_sessions set question_index=question_index-1,phase='reveal',started_at=null,paused_at=null where id=s.id;
    elsif code='reopen' then
      if coalesce(p->>'confirm','')<>'REOPEN' then raise exception 'Explicit confirmation required'; end if;
      delete from public.quizzy_answers where session_id=s.id and question_index=s.question_index;
      update public.quizzy_sessions set phase='question',started_at=clock_timestamp(),paused_at=null,cancelled_questions=coalesce((select jsonb_agg(v.value) from jsonb_array_elements(s.cancelled_questions) v where v.value<>to_jsonb(s.question_index)),'[]'::jsonb) where id=s.id;
    elsif code='skip' then
      update public.quizzy_sessions set phase='reveal',cancelled_questions=cancelled_questions||jsonb_build_array(s.question_index) where id=s.id;
    elsif code='finish' then
      update public.quizzy_sessions set phase='finished' where id=s.id;
    elsif code='joining' then
      update public.quizzy_sessions set joining_locked=not joining_locked where id=s.id;
    elsif code='rankings' then
      update public.quizzy_sessions set rankings_visible=not rankings_visible where id=s.id;
    else raise exception 'Unknown control'; end if;
    update public.quizzy_signal set version=version+1 where session_id=s.id;
    return jsonb_build_object('ok',true);
  elsif p_action in ('adjust','remove_player') then
    select * into s from public.quizzy_sessions where pin=p->>'pin' and host_id=h.id;
    select * into player from public.quizzy_players where id=(p->>'player_id')::uuid and session_id=s.id;
    if player.id is null then raise exception 'Player not found'; end if;
    if p_action='adjust' then
      if abs((p->>'delta')::integer)>100000 then raise exception 'Adjustment too large'; end if;
      insert into public.quizzy_adjustments(session_id,player_id,delta,reason) values(s.id,player.id,(p->>'delta')::integer,left(coalesce(p->>'reason','Host adjustment'),200));
    else
      update public.quizzy_players set removed=true where id=player.id;
    end if;
    update public.quizzy_signal set version=version+1 where session_id=s.id;
    return jsonb_build_object('ok',true);
  else raise exception 'Unknown Quizzy action'; end if;
end $$;

revoke all on function public.quizzy_api(text,jsonb) from public;
grant execute on function public.quizzy_api(text,jsonb) to authenticated;
