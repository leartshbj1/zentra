-- PREPARATION ONLY. Does not create/enable a cron job or invoke an endpoint.
-- Apply only after the Supabase project is operational (planned Pro recovery),
-- then provision zentra_support_mail_sync in Vault from the administrator vault.
-- It must match Sites SUPPORT_MAIL_SYNC_TOKEN. Never put its value in SQL/logs.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
-- Do not replace the body used by a job that is already running. An operator
-- must explicitly pause that known job before applying this preparation.
do $$ begin
  if exists(select 1 from cron.job where jobname='zentra-support-mail' and active) then
    raise exception 'Pause the existing Zentra mail job before applying this preparation';
  end if;
end $$;
create schema if not exists zentra_internal;
revoke all on schema zentra_internal from public, anon, authenticated;

create table if not exists zentra_internal.mail_scheduler_requests (
  request_id bigint primary key,
  slot smallint not null check(slot between 1 and 8),
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  state text not null default 'pending'
    check(state in ('pending','uncertain','completed','partial','failed','expired')),
  status_code integer,
  failed boolean,
  more boolean
);
revoke all on zentra_internal.mail_scheduler_requests from public, anon, authenticated;
create unique index if not exists mail_scheduler_active_slot
  on zentra_internal.mail_scheduler_requests(slot) where state in ('pending','uncertain');

create or replace function zentra_internal.sync_support_mail()
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  token text; new_request_id bigint; slot_number integer; dispatched integer := 0;
  previous record; payload jsonb; valid boolean; partial boolean;
begin
  -- Serializes cron/manual invocations and makes the eight-slot ceiling global.
  if not pg_catalog.pg_try_advisory_xact_lock(721608429151::bigint) then return 0; end if;
  -- pg_net success is HTTP transport completion, never application success.
  -- Match the exact request ID, not the three latest responses of all services.
  for previous in
    select q.request_id,q.started_at,r.status_code,r.timed_out,r.error_msg,r.content
    from zentra_internal.mail_scheduler_requests q
    join net._http_response r on r.id=q.request_id and r.created>=q.started_at
    where q.state='pending'
  loop
    if coalesce(previous.timed_out,false) or previous.error_msg is not null then
      -- A timed-out HTTP request may still own its server lease. Do not refill
      -- this slot before the conservative ten-minute uncertainty window.
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
  -- Never call a missing HTTP result a success; interrupted/crashed pg_net
  -- requests remain visible before their slot becomes available again.
  update zentra_internal.mail_scheduler_requests
    set state='expired',finished_at=clock_timestamp(),failed=true
    where state in ('pending','uncertain') and started_at<clock_timestamp()-interval '10 minutes';
  delete from zentra_internal.mail_scheduler_requests
    where state not in ('pending','uncertain') and started_at<clock_timestamp()-interval '7 days';

  select decrypted_secret into token from vault.decrypted_secrets
    where name='zentra_support_mail_sync';
  if token is null or length(token)=0 then raise exception 'Mail scheduler credential is missing'; end if;
  for slot_number in 1..8 loop
    if exists(select 1 from zentra_internal.mail_scheduler_requests
      where slot=slot_number and state in ('pending','uncertain')) then continue; end if;
    select net.http_post(
      url:='https://zentraapp.ch/api/support/mail-sync',
      headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||token),
      body:='{}'::jsonb,timeout_milliseconds:=300000
    ) into new_request_id;
    insert into zentra_internal.mail_scheduler_requests(request_id,slot)
      values(new_request_id,slot_number);
    dispatched := dispatched+1;
  end loop;
  return dispatched;
end;
$$;
revoke all on function zentra_internal.sync_support_mail() from public, anon, authenticated;

-- READ ONLY preflight (run before considering activation; never select secrets):
-- select extname,extversion from pg_extension where extname in ('pg_cron','pg_net','supabase_vault');
-- select name from vault.secrets where name='zentra_support_mail_sync';
-- select jobname,active,schedule from cron.job where jobname='zentra-support-mail';
--
-- ACTIVATION IS INTENTIONALLY COMMENTED OUT. Only after project recovery and
-- validated matching secret, use the named existing job, not a duplicate:
-- select cron.schedule('zentra-support-mail','* * * * *',
--   'select zentra_internal.sync_support_mail()');
--
-- VERIFY actual HTTP/application outcomes and several server heartbeats with
-- applications closed before setting Sites SUPPORT_MAIL_BACKGROUND_ENABLED=1:
-- select request_id,slot,started_at,finished_at,state,status_code,failed,more
-- from zentra_internal.mail_scheduler_requests order by started_at desc limit 24;
-- A cron.job_run_details success alone is NOT a successful mail/Automation run.
-- Do not log net.http_request_queue headers or vault.decrypted_secrets.
