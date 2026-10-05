-- PREPARATION ONLY. No cron activation, HTTP invocation or secret provisioning.
-- The already applied 20261004171300 migration remains unchanged. Pause the
-- named job before this replacement, publish/validate the private Sites probe
-- first, then explicitly resume that same job after operational review.
do $$ begin
  if exists(select 1 from cron.job where jobname='zentra-support-mail' and active) then
    raise exception 'Pause the existing Zentra mail job before applying this preparation';
  end if;
end $$;

-- D1 owns the business queues. Postgres stores only closed control observations,
-- never guessed Supabase mailbox/workflow counters or content/tenant metadata.
create table zentra_internal.mail_scheduler_plans (
  request_id bigint primary key,
  singleton smallint not null default 1 check(singleton=1),
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  state text not null default 'pending'
    check(state in ('pending','uncertain','ready','consumed','failed','expired')),
  status_code integer,
  observed_at bigint,
  desired_workers smallint check(desired_workers between 0 and 8)
);
revoke all on zentra_internal.mail_scheduler_plans from public, anon, authenticated;
alter table zentra_internal.mail_scheduler_plans enable row level security;
create unique index mail_scheduler_one_pending_plan
  on zentra_internal.mail_scheduler_plans(singleton) where state in ('pending','uncertain');

create or replace function zentra_internal.sync_support_mail()
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  token text; field_name text; new_request_id bigint; slot_number integer; dispatched integer := 0;
  previous record; payload jsonb; valid boolean; partial boolean;
  plan record; desired integer := 0; epoch bigint;
  mail_due bigint; workflows_due bigint; expired_workflows bigint; calculated integer;
begin
  -- Same global lock and eight worker slots as before, including overlapping
  -- manual/cron transactions. The single read-only probe is not a worker slot.
  if not pg_catalog.pg_try_advisory_xact_lock(721608429151::bigint) then return 0; end if;
  for previous in
    select q.request_id,q.started_at,r.status_code,r.timed_out,r.error_msg,r.content
    from zentra_internal.mail_scheduler_requests q
    join net._http_response r on r.id=q.request_id and r.created>=q.started_at
    where q.state='pending'
  loop
    if coalesce(previous.timed_out,false) or previous.error_msg is not null then
      update zentra_internal.mail_scheduler_requests
        set state='uncertain',status_code=previous.status_code,failed=true
        where request_id=previous.request_id;
      continue;
    end if;
    payload := null; valid := false; partial := false;
    begin
      payload := previous.content::jsonb;
      valid := previous.status_code=200 and jsonb_typeof(payload)='object'
        and jsonb_typeof(payload->'failed')='boolean'
        and jsonb_typeof(payload->'idle')='boolean';
      if valid then
        partial := coalesce((payload->>'more')::boolean,false)
          or coalesce((payload->>'incomplete')::boolean,false)
          or coalesce((payload->>'syncing')::boolean,false)
          or coalesce((payload->>'paused')::boolean,false)
          or coalesce((payload#>>'{workflows,more}')::boolean,false);
      end if;
    exception when others then valid := false;
    end;
    update zentra_internal.mail_scheduler_requests set
      state=case when not coalesce(valid,false) then 'failed'
        when payload->'failed'='true'::jsonb then 'failed'
        when partial then 'partial' else 'completed' end,
      finished_at=clock_timestamp(),status_code=previous.status_code,
      failed=case when coalesce(valid,false) then (payload->>'failed')::boolean else true end,
      more=case when coalesce(valid,false) then partial else null end
      where request_id=previous.request_id;
  end loop;
  -- Keep the original conservative uncertainty window: a transport timeout
  -- cannot release a worker still holding a ten-minute business mailbox lease.
  update zentra_internal.mail_scheduler_requests
    set state='expired',finished_at=clock_timestamp(),failed=true
    where state in ('pending','uncertain') and started_at<clock_timestamp()-interval '10 minutes';
  delete from zentra_internal.mail_scheduler_requests
    where state not in ('pending','uncertain') and started_at<clock_timestamp()-interval '7 days';
  delete from cron.job_run_details
    where jobid in (select jobid from cron.job where jobname='zentra-support-mail')
      and end_time<clock_timestamp()-interval '7 days';

  epoch := floor(extract(epoch from clock_timestamp()))::bigint;
  for previous in
    select p.request_id,p.started_at,r.status_code,r.timed_out,r.error_msg,r.content
    from zentra_internal.mail_scheduler_plans p
    join net._http_response r on r.id=p.request_id and r.created>=p.started_at
    where p.state='pending'
  loop
    if coalesce(previous.timed_out,false) or previous.error_msg is not null then
      update zentra_internal.mail_scheduler_plans
        set state='uncertain',status_code=previous.status_code where request_id=previous.request_id;
      continue;
    end if;
    payload := null; valid := false;
    begin
      payload := previous.content::jsonb;
      -- Exact closed nine-field protocol; no tenant IDs, arbitrary error text,
      -- counts represented as strings, clocks outside the TTL, or raw bodies.
      valid := previous.status_code=200 and jsonb_typeof(payload)='object'
        and payload->>'protocol'='zentra-scheduler-demand'
        and payload->'version'='1'::jsonb
        and (select count(*)=9 and bool_and(k=any(array[
          'protocol','version','observedAt','desiredWorkers','mailboxesDue',
          'workflowsDue','expiredWorkflows','activeMailboxes','activeWorkflows'
        ])) from jsonb_object_keys(payload) as keys(k));
      if valid then
        for slot_number in 1..7 loop
          -- All seven numeric fields must be exact nonnegative JS-safe integers.
          field_name := (array['observedAt','desiredWorkers','mailboxesDue','workflowsDue',
            'expiredWorkflows','activeMailboxes','activeWorkflows'])[slot_number];
          if jsonb_typeof(payload->field_name)<>'number'
            or (payload->>field_name)::numeric<>trunc((payload->>field_name)::numeric)
            or (payload->>field_name)::numeric<0
            or (payload->>field_name)::numeric>9007199254740991 then valid := false; exit; end if;
        end loop;
      end if;
      if valid then
        mail_due := (payload->>'mailboxesDue')::bigint;
        workflows_due := (payload->>'workflowsDue')::bigint;
        expired_workflows := (payload->>'expiredWorkflows')::bigint;
        calculated := least(8,greatest((mail_due+1)/2,(workflows_due+19)/20,
          case when expired_workflows>0 then 1 else 0 end))::integer;
        valid := (payload->>'observedAt')::bigint between epoch-90 and epoch+5
          and (payload->>'desiredWorkers')::integer=calculated;
      end if;
    exception when others then valid := false;
    end;
    update zentra_internal.mail_scheduler_plans set
      state=case when coalesce(valid,false) then 'ready' else 'failed' end,
      finished_at=clock_timestamp(),status_code=previous.status_code,
      observed_at=case when coalesce(valid,false) then (payload->>'observedAt')::bigint else null end,
      desired_workers=case when coalesce(valid,false) then calculated else null end
      where request_id=previous.request_id;
  end loop;
  -- Probe only reads demand (and may record an honestly idle heartbeat). It
  -- never owns a business lease, so a shorter lost-probe retry is safe.
  update zentra_internal.mail_scheduler_plans
    set state='expired',finished_at=clock_timestamp()
    where state in ('pending','uncertain') and started_at<clock_timestamp()-interval '2 minutes';
  update zentra_internal.mail_scheduler_plans set state='expired'
    where state='ready' and (observed_at<epoch-90 or observed_at>epoch+5);
  select request_id,desired_workers into plan from zentra_internal.mail_scheduler_plans
    where state='ready' order by observed_at desc,request_id desc limit 1;
  if found then
    desired := plan.desired_workers;
    -- Consume once even when all slots are occupied: old demand is never replayed
    -- as soon as a slot clears. A later probe observes current queues afresh.
    update zentra_internal.mail_scheduler_plans set state='consumed' where request_id=plan.request_id and state='ready';
  end if;
  update zentra_internal.mail_scheduler_plans set state='expired' where state='ready';
  delete from zentra_internal.mail_scheduler_plans
    where state not in ('pending','uncertain') and started_at<clock_timestamp()-interval '7 days';

  select decrypted_secret into token from vault.decrypted_secrets
    where name='zentra_support_mail_sync';
  if token is null or length(token)=0 then raise exception 'Mail scheduler credential is missing'; end if;
  for slot_number in 1..8 loop
    exit when dispatched>=desired;
    if exists(select 1 from zentra_internal.mail_scheduler_requests
      where slot=slot_number and state in ('pending','uncertain')) then continue; end if;
    select net.http_post(
      url:='https://zentraapp.ch/api/support/mail-sync',
      headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||token),
      body:='{}'::jsonb,timeout_milliseconds:=300000
    ) into new_request_id;
    insert into zentra_internal.mail_scheduler_requests(request_id,slot) values(new_request_id,slot_number);
    dispatched := dispatched+1;
  end loop;
  if not exists(select 1 from zentra_internal.mail_scheduler_plans where state in ('pending','uncertain')) then
    select net.http_post(
      url:='https://zentraapp.ch/api/support/mail-sync/dispatch',
      headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||token),
      body:='{}'::jsonb,timeout_milliseconds:=30000
    ) into new_request_id;
    insert into zentra_internal.mail_scheduler_plans(request_id) values(new_request_id);
  end if;
  return dispatched;
end;
$$;
revoke all on function zentra_internal.sync_support_mail() from public, anon, authenticated;

-- No cron.schedule here. Explicit future operator action resumes the existing
-- named job only after source/SQL review, private endpoint and credential match.
-- Observe plan/request IDs, states and counts only, never request headers/Vault.
-- pg_net starts HTTP after transaction commit. The first probe is consumed on
-- the following tick: initial useful-work admission adds up to one cron period.
-- Pending/uncertain workers remain capacity reservations; a fresh demand plan
-- cannot authorize duplicates, revoke checks, bypass quota or exceed eight.
