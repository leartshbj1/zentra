-- Installs a PAUSED, private relay. No provider call, secret provisioning or
-- renewal is enabled by this migration. D1 remains the financial authority.
-- Prerequisites: pg_cron, pg_net and Vault are already installed on this project.
do $$ begin
  if not exists(select 1 from pg_extension where extname='pg_cron')
    or not exists(select 1 from pg_extension where extname='pg_net')
    or not exists(select 1 from pg_extension where extname='supabase_vault') then
    raise exception 'PostFinance scheduler extensions are not ready';
  end if;
  if exists(select 1 from cron.job where jobname='zentra-postfinance') then
    raise exception 'An existing PostFinance job must be reviewed before replacement';
  end if;
end $$;

create schema if not exists zentra_internal;
revoke all on schema zentra_internal from public, anon, authenticated;
create table zentra_internal.postfinance_scheduler_settings (
  kind text primary key check(kind in ('reconcile','billing')),
  enabled boolean not null default false
);
insert into zentra_internal.postfinance_scheduler_settings(kind) values('reconcile'),('billing');
create table zentra_internal.postfinance_scheduler_requests (
  request_id bigint primary key,
  kind text not null references zentra_internal.postfinance_scheduler_settings(kind),
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  state text not null default 'pending'
    check(state in ('pending','uncertain','completed','partial','failed','expired')),
  status_code integer
);
create unique index postfinance_scheduler_active_kind
  on zentra_internal.postfinance_scheduler_requests(kind) where state in ('pending','uncertain');
create index postfinance_scheduler_recent
  on zentra_internal.postfinance_scheduler_requests(kind,started_at desc);
revoke all on zentra_internal.postfinance_scheduler_settings,zentra_internal.postfinance_scheduler_requests
  from public, anon, authenticated, service_role;
alter table zentra_internal.postfinance_scheduler_settings enable row level security;
alter table zentra_internal.postfinance_scheduler_requests enable row level security;

create function zentra_internal.dispatch_postfinance()
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  previous record; selected record; payload jsonb; valid boolean; partial boolean;
  token text; secret_name text; endpoint text; new_request_id bigint;
  dispatched bigint := 0; field_name text;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(721608429152::bigint) then return 0; end if;
  -- Correlate only this relay's exact request ID and observation time. Never
  -- store headers, provider bodies, company IDs, token values or payment data.
  for previous in
    select q.request_id,q.kind,q.started_at,r.status_code,r.timed_out,r.error_msg,r.content
    from zentra_internal.postfinance_scheduler_requests q
    join net._http_response r on r.id=q.request_id and r.created>=q.started_at
    where q.state='pending'
  loop
    if coalesce(previous.timed_out,false) or previous.error_msg is not null then
      update zentra_internal.postfinance_scheduler_requests
        set state='uncertain',status_code=previous.status_code where request_id=previous.request_id;
      continue;
    end if;
    payload := null; valid := false; partial := false;
    begin
      if previous.status_code=200 and octet_length(previous.content)<=8192 then
        payload := previous.content::jsonb;
        valid := jsonb_typeof(payload)='object';
        if previous.kind='reconcile' then
          valid := valid and payload->>'state'='processed';
          foreach field_name in array array['claimed','completed','waiting','lost'] loop
            valid := valid and jsonb_typeof(payload->field_name)='number'
              and (payload->>field_name) ~ '^[0-9]{1,4}$';
          end loop;
          if coalesce(valid,false) then
            valid := (payload->>'claimed')::int<=1 and
              (payload->>'completed')::int+(payload->>'waiting')::int+(payload->>'lost')::int
                =(payload->>'claimed')::int;
            partial := (payload->>'waiting')::int>0 or (payload->>'lost')::int>0;
          end if;
        else
          valid := valid and payload->>'renewal' in ('idle','submitted','uncertain','disabled');
          foreach field_name in array array['stopped','terminalObserved','uncertain'] loop
            valid := valid and jsonb_typeof(payload->field_name)='number'
              and (payload->>field_name) ~ '^[0-9]{1,4}$';
          end loop;
          if coalesce(valid,false) then
            valid := (payload->>'stopped')::int+(payload->>'terminalObserved')::int
              +(payload->>'uncertain')::int<=1;
            partial := (payload->>'uncertain')::int>0
              or payload->>'renewal' in ('uncertain','disabled');
          end if;
        end if;
      end if;
    exception when others then valid := false;
    end;
    update zentra_internal.postfinance_scheduler_requests set
      state=case when not coalesce(valid,false) then 'failed'
        when partial then 'partial' else 'completed' end,
      finished_at=clock_timestamp(),status_code=previous.status_code
      where request_id=previous.request_id;
  end loop;
  -- Expiry describes transport uncertainty, never financial failure. A new
  -- invocation still faces the durable D1 mutation ledger: no blind re-charge.
  update zentra_internal.postfinance_scheduler_requests
    set state='expired',finished_at=clock_timestamp()
    where state in ('pending','uncertain') and started_at<clock_timestamp()-interval '10 minutes';
  delete from zentra_internal.postfinance_scheduler_requests
    where state not in ('pending','uncertain') and started_at<clock_timestamp()-interval '30 days';
  delete from cron.job_run_details where jobid in
    (select jobid from cron.job where jobname='zentra-postfinance')
    and end_time<clock_timestamp()-interval '30 days';

  for selected in select kind from zentra_internal.postfinance_scheduler_settings where enabled loop
    if exists(select 1 from zentra_internal.postfinance_scheduler_requests
      where kind=selected.kind and state in ('pending','uncertain')) then continue; end if;
    if exists(select 1 from zentra_internal.postfinance_scheduler_requests
      where kind=selected.kind and state in ('failed','partial','expired')
      and started_at>clock_timestamp()-interval '10 minutes') then continue; end if;
    secret_name := case selected.kind when 'reconcile' then 'zentra_postfinance_reconciliation'
      else 'zentra_postfinance_billing' end;
    select decrypted_secret into token from vault.decrypted_secrets where name=secret_name;
    -- Missing credentials must fail before net.http_post; cron stores only the
    -- non-sensitive error. No new API key is made or printed by this function.
    if token is null or token !~ '^[A-Za-z0-9_-]{43,128}$' then
      raise exception 'PostFinance scheduler credential is not configured';
    end if;
    endpoint := case selected.kind when 'reconcile' then 'reconcile' else 'billing-worker' end;
    select net.http_post(
      url:='https://zentraapp.ch/api/payments/postfinance/'||endpoint,
      headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||token),
      body:='{}'::jsonb, timeout_milliseconds:=300000
    ) into new_request_id;
    insert into zentra_internal.postfinance_scheduler_requests(request_id,kind)
      values(new_request_id,selected.kind);
    dispatched := dispatched+1;
  end loop;
  return dispatched;
end;
$$;
revoke all on function zentra_internal.dispatch_postfinance() from public, anon, authenticated, service_role;

-- The job is invisible until commit and already paused in the same transaction.
do $$ declare new_job bigint; begin
  select cron.schedule('zentra-postfinance','* * * * *',
    'select zentra_internal.dispatch_postfinance()') into new_job;
  perform cron.alter_job(new_job,active:=false);
end $$;
