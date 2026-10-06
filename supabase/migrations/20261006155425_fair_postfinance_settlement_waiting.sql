-- Keep partial observations honest; only explicit, bounded normal settlement
-- waits bypass the existing global cooldown. No scheduler or flag is enabled.
alter table zentra_internal.postfinance_scheduler_requests
  add column normal_settlement_wait boolean not null default false;
alter table zentra_internal.postfinance_scheduler_requests
  add constraint postfinance_scheduler_normal_wait
    check(not normal_settlement_wait or
      (kind='reconcile' and state='partial' and status_code is not distinct from 200));

create or replace function zentra_internal.dispatch_postfinance()
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  previous record; selected record; payload jsonb; valid boolean; partial boolean; normal_wait boolean; normal_counters boolean;
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
    payload := null; valid := false; partial := false; normal_wait := false;
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
            -- Missing, legacy or malformed extra counters keep the old cooldown.
            normal_counters := true;
            foreach field_name in array array['settlementWaiting','failures'] loop
              normal_counters := normal_counters and jsonb_typeof(payload->field_name)='number'
                and (payload->>field_name) ~ '^[0-9]{1,4}$';
            end loop;
            if coalesce(valid,false) and coalesce(normal_counters,false) then
              normal_wait := (payload->>'waiting')::int>0 and (payload->>'lost')::int=0
                and (payload->>'failures')::int=0
                and (payload->>'settlementWaiting')::int=(payload->>'waiting')::int
                and (payload->>'settlementWaiting')::int+(payload->>'failures')::int
                  =(payload->>'waiting')::int;
            end if;
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
    exception when others then valid := false; normal_wait := false;
    end;
    update zentra_internal.postfinance_scheduler_requests set
      state=case when not coalesce(valid,false) then 'failed'
        when partial then 'partial' else 'completed' end,
      finished_at=clock_timestamp(),status_code=previous.status_code,
      normal_settlement_wait=coalesce(valid,false) and partial and coalesce(normal_wait,false)
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
      where kind=selected.kind and
        (state in ('failed','expired') or (state='partial' and
          not (kind='reconcile' and normal_settlement_wait)))
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

