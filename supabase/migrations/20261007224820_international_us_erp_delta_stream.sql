-- Additive US-only cursor stream. Staging/local until explicit production
-- approval. Financial tables are never added to a Realtime publication here.
begin;
do $$ begin
  if pg_catalog.to_regclass('public.zentra_us_erp_heads') is null
    or pg_catalog.to_regclass('public.zentra_us_erp_records') is null
    or pg_catalog.to_regclass('public.zentra_us_erp_receipts') is null
    or pg_catalog.to_regclass('public.zentra_us_erp_ledger_audit') is null then
    raise exception 'US ERP persistence migration required before cursor stream';
  end if;
end $$;

-- Existing heads keep their real history. We record the revision at which the
-- new stream starts, rather than manufacturing unavailable earlier deltas.
create table public.zentra_us_erp_streams (
  organization_id text primary key references public.zentra_us_erp_heads on delete restrict,
  baseline_revision bigint not null check (baseline_revision between 0 and 9007199254740991),
  created_at timestamptz not null default now()
);
insert into public.zentra_us_erp_streams(organization_id,baseline_revision)
  select organization_id,revision from public.zentra_us_erp_heads;

create table public.zentra_us_erp_events (
  organization_id text not null references public.zentra_us_erp_streams on delete restrict,
  revision bigint not null check (revision between 1 and 9007199254740991),
  event jsonb not null,
  created_at timestamptz not null default now(),
  primary key(organization_id,revision),
  foreign key(organization_id,revision) references public.zentra_us_erp_receipts(organization_id,revision) on delete restrict,
  check (jsonb_typeof(event)='object' and event->>'schemaVersion'='1'
    and event->>'organizationId'=organization_id and event->>'revision'=revision::text
    and event->'header'->>'revision'=revision::text
    and event->'header'->'configuration'->>'organizationId'=organization_id
    and event->'receipt'->>'revision'=revision::text
    and jsonb_typeof(event->'changes')='array' and jsonb_typeof(event->'ledgerAudit')='array'),
  check (octet_length(event::text)<=2097152)
);
-- Primary key (tenant,revision) supports both resume and bounded ordered reads.
create table public.zentra_us_erp_wakeups (
  organization_id text primary key references public.zentra_us_erp_heads on delete restrict,
  revision bigint not null check (revision between 1 and 9007199254740991),
  updated_at timestamptz not null default now()
);
insert into public.zentra_us_erp_wakeups(organization_id,revision)
  select organization_id,revision from public.zentra_us_erp_heads;

create trigger zentra_us_erp_stream_immutable before update or delete on public.zentra_us_erp_streams
  for each row execute function public.zentra_us_erp_guard_history();
create trigger zentra_us_erp_event_immutable before update or delete on public.zentra_us_erp_events
  for each row execute function public.zentra_us_erp_guard_history();
create function public.zentra_us_erp_guard_wakeup() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='DELETE' or new.organization_id is distinct from old.organization_id or new.revision<>old.revision+1 then
    raise exception using errcode='PU003',message='US ERP wakeup revision must advance once per commit';
  end if;
  return new;
end $$;
create trigger zentra_us_erp_wakeup_guard before update or delete on public.zentra_us_erp_wakeups
  for each row execute function public.zentra_us_erp_guard_wakeup();

-- Receipts are inserted last by the existing atomic commit RPC. Capturing here
-- preserves exactly this revision's header, changed records and new audit,
-- while a receipt replay never executes this trigger again.
create function public.zentra_us_erp_capture_event() returns trigger
language plpgsql security invoker set search_path='' as $$
declare v_header jsonb; v_previous bigint; v_baseline bigint; v_changes jsonb; v_audit jsonb; v_event jsonb;
begin
  select header into v_header from public.zentra_us_erp_heads where organization_id=new.organization_id and revision=new.revision;
  if not found or new.receipt->>'revision' is distinct from new.revision::text then
    raise exception using errcode='PU004',message='US ERP event requires matching committed head and receipt';
  end if;
  insert into public.zentra_us_erp_streams(organization_id,baseline_revision) values(new.organization_id,0)
    on conflict(organization_id) do nothing;
  select baseline_revision into v_baseline from public.zentra_us_erp_streams where organization_id=new.organization_id;
  select coalesce(max(revision),v_baseline) into v_previous from public.zentra_us_erp_events where organization_id=new.organization_id;
  if new.revision<>v_previous+1 then raise exception using errcode='PU004',message='US ERP event sequence must be contiguous'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('kind',r.kind,'id',r.id,'payload',r.payload) order by r.kind,r.id),'[]'::jsonb)
    into v_changes from public.zentra_us_erp_records r where r.organization_id=new.organization_id and r.state_revision=new.revision;
  select coalesce(jsonb_agg(a.payload order by a.revision),'[]'::jsonb)
    into v_audit from public.zentra_us_erp_ledger_audit a where a.organization_id=new.organization_id and a.state_revision=new.revision;
  v_event:=jsonb_build_object('schemaVersion',1,'organizationId',new.organization_id,'revision',new.revision,
    'header',v_header,'changes',v_changes,'ledgerAudit',v_audit,'receipt',new.receipt,'actorId',new.actor_id,
    'occurredAt',to_char(new.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  if octet_length(v_event::text)>2097152 then raise exception using errcode='PU007',message='US ERP event exceeds safe transport limit'; end if;
  insert into public.zentra_us_erp_events values(new.organization_id,new.revision,v_event,new.created_at);
  insert into public.zentra_us_erp_wakeups values(new.organization_id,new.revision,new.created_at)
    on conflict(organization_id) do update set revision=excluded.revision,updated_at=excluded.updated_at;
  return new;
end $$;
create trigger zentra_us_erp_capture_receipt after insert on public.zentra_us_erp_receipts
  for each row execute function public.zentra_us_erp_capture_event();

create function public.zentra_us_erp_revision(p_organization text) returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('schemaVersion',1,'organizationId',organization_id,'revision',revision)
    from public.zentra_us_erp_heads where organization_id=p_organization;
$$;
create function public.zentra_us_erp_delta(p_organization text,p_after_revision bigint,p_limit integer default 50) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare v_head bigint; v_baseline bigint; v_events jsonb:='[]'::jsonb; v_count integer:=0; v_last bigint; v_bytes integer:=0; v_size integer;
  v_page record; v_byte_limited boolean:=false; v_gap boolean:=false;
begin
  if p_organization is null or p_organization !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_after_revision is null or p_after_revision not between 0 and 9007199254740991 or p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode='PU004',message='Invalid US ERP cursor or page limit';
  end if;
  select revision into v_head from public.zentra_us_erp_heads where organization_id=p_organization;
  if not found then return null; end if;
  if p_after_revision>v_head then raise exception using errcode='PU004',message='US ERP cursor is ahead of the workspace'; end if;
  select baseline_revision into v_baseline from public.zentra_us_erp_streams where organization_id=p_organization;
  if not found then raise exception using errcode='PU004',message='US ERP stream metadata missing'; end if;
  if p_after_revision<v_baseline then
    return jsonb_build_object('schemaVersion',1,'organizationId',p_organization,'fromRevision',p_after_revision,'toRevision',p_after_revision,'headRevision',v_head,'hasMore',false,'resetRequired',true,'events','[]'::jsonb);
  end if;
  v_last:=p_after_revision;
  for v_page in select revision,event from public.zentra_us_erp_events where organization_id=p_organization and revision>p_after_revision and revision<=v_head order by revision limit p_limit loop
    if v_page.revision<>v_last+1 then v_gap:=true; exit; end if;
    v_size:=octet_length(v_page.event::text)+2;
    if v_size>2097154 then raise exception using errcode='PU007',message='US ERP event exceeds safe transport limit'; end if;
    -- 4 MiB wire page, with a conservative 4 KiB reserve for the envelope.
    if v_bytes+v_size>4190208 then v_byte_limited:=true; exit; end if;
    v_events:=v_events||jsonb_build_array(v_page.event); v_bytes:=v_bytes+v_size; v_count:=v_count+1; v_last:=v_page.revision;
  end loop;
  -- A gap must trigger an explicit full snapshot recovery; never advance a
  -- cursor over a missing operation or silently return a partial corrupt page.
  if v_gap or (v_last<v_head and v_count<p_limit and not v_byte_limited) then
    return jsonb_build_object('schemaVersion',1,'organizationId',p_organization,'fromRevision',p_after_revision,'toRevision',p_after_revision,'headRevision',v_head,'hasMore',false,'resetRequired',true,'events','[]'::jsonb);
  end if;
  if v_count=0 and v_last<v_head then raise exception using errcode='PU007',message='US ERP event cannot fit in a safe page'; end if;
  return jsonb_build_object('schemaVersion',1,'organizationId',p_organization,'fromRevision',p_after_revision,'toRevision',v_last,'headRevision',v_head,'hasMore',v_last<v_head,'resetRequired',false,'events',v_events);
end $$;

alter table public.zentra_us_erp_streams enable row level security;
alter table public.zentra_us_erp_events enable row level security;
alter table public.zentra_us_erp_wakeups enable row level security;
revoke all on public.zentra_us_erp_streams,public.zentra_us_erp_events,public.zentra_us_erp_wakeups from public,anon,authenticated;
grant select,insert on public.zentra_us_erp_streams,public.zentra_us_erp_events to service_role;
grant select,insert,update on public.zentra_us_erp_wakeups to service_role;
create policy zentra_us_erp_streams_server on public.zentra_us_erp_streams for all to service_role using(true) with check(true);
create policy zentra_us_erp_events_server on public.zentra_us_erp_events for all to service_role using(true) with check(true);
create policy zentra_us_erp_wakeups_server on public.zentra_us_erp_wakeups for all to service_role using(true) with check(true);
revoke all on function public.zentra_us_erp_guard_wakeup(),public.zentra_us_erp_capture_event(),public.zentra_us_erp_revision(text),public.zentra_us_erp_delta(text,bigint,integer) from public,anon,authenticated;
grant execute on function public.zentra_us_erp_revision(text),public.zentra_us_erp_delta(text,bigint,integer) to service_role;

-- Realtime preparation: zentra_us_erp_wakeups contains metadata only.
-- A later, reviewed private server bridge can publish these wakeups. This
-- migration does not change pg_publication or supabase_realtime; neither events
-- nor accounting rows may be made publicly subscribable for the D1-auth model.
commit;
