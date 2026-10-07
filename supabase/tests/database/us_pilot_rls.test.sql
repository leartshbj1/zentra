-- Standalone assertions, matching the repository's transactional database tests.
-- No fixture survives this test and no existing product data is changed.
begin;
do $$
declare relation text; role_name text; privilege text;
begin
  foreach relation in array array['us_pilot_leads','us_pilot_events','us_pilot_rate_limits'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || relation)::regclass) then raise exception 'RLS disabled: %', relation; end if;
    foreach role_name in array array['anon','authenticated'] loop
      foreach privilege in array array['SELECT','INSERT','UPDATE','DELETE'] loop
        if has_table_privilege(role_name, 'public.' || relation, privilege) then raise exception 'Unexpected client privilege: % % %', role_name, relation, privilege; end if;
      end loop;
    end loop;
    if not has_table_privilege('service_role', 'public.' || relation, 'INSERT') then raise exception 'Server cannot insert: %', relation; end if;
  end loop;
  if has_function_privilege('anon','public.us_pilot_consume_rate_limit(text,integer)','EXECUTE') or has_function_privilege('authenticated','public.us_pilot_consume_rate_limit(text,integer)','EXECUTE') then raise exception 'Client can invoke privileged rate limiter'; end if;
  if (select prosecdef from pg_proc where oid='public.us_pilot_consume_rate_limit(text,integer)'::regprocedure) then raise exception 'Rate limiter must use invoker security'; end if;
end;
$$;

set local role anon;
do $$ begin
  begin perform * from public.us_pilot_leads; raise exception 'Anonymous read was allowed'; exception when insufficient_privilege then null; end;
  begin insert into public.us_pilot_events(id,event_name) values(gen_random_uuid(),'page_view'); raise exception 'Anonymous insert was allowed'; exception when insufficient_privilege then null; end;
  begin perform public.us_pilot_consume_rate_limit(repeat('a',64),2); raise exception 'Anonymous RPC was allowed'; exception when insufficient_privilege then null; end;
end; $$;
reset role;

set local role authenticated;
do $$ begin
  begin perform * from public.us_pilot_leads; raise exception 'Authenticated read was allowed'; exception when insufficient_privilege then null; end;
  begin update public.us_pilot_leads set status='converted'; raise exception 'Authenticated update was allowed'; exception when insufficient_privilege then null; end;
end; $$;
reset role;

set local role service_role;
do $$
declare submission uuid := gen_random_uuid(); limiter text := md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text);
begin
  insert into public.us_pilot_leads(submission_id,first_name,last_name,email,company,industry,employee_count,pain_point,current_tools,demo_interest)
    values(submission,'Fixture','Only','fixture@example.test','Test fixture','Services','11–30','Test task','Test tools',true);
  if not exists(select 1 from public.us_pilot_leads where submission_id=submission and status='new' and source='us_landing' and offer_version='us-pilot-free-month-v1') then raise exception 'Lead defaults, offer version or server insert failed'; end if;
  begin update public.us_pilot_leads set offer_version='unlimited-free-forever' where submission_id=submission; raise exception 'Invalid offer accepted'; exception when check_violation then null; end;
  begin update public.us_pilot_leads set status='unknown' where submission_id=submission; raise exception 'Invalid status accepted'; exception when check_violation then null; end;
  begin update public.us_pilot_leads set employee_count='invalid' where submission_id=submission; raise exception 'Invalid employee count accepted'; exception when check_violation then null; end;
  begin update public.us_pilot_leads set email='invalid' where submission_id=submission; raise exception 'Invalid email accepted'; exception when check_violation then null; end;
  if not public.us_pilot_consume_rate_limit(limiter,2) then raise exception 'First request rejected'; end if;
  if not public.us_pilot_consume_rate_limit(limiter,2) then raise exception 'Second request rejected'; end if;
  if public.us_pilot_consume_rate_limit(limiter,2) then raise exception 'Over-limit request accepted'; end if;
end; $$;
reset role;
select 'US pilot RLS, client denial, server insert, defaults, constraints and rate limit: PASS' as result;
rollback;
