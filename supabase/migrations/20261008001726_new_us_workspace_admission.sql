-- Additive, staging proposal only. No historical migration body or CH data is
-- rewritten. A fresh parent and immutable admission are one PostgreSQL commit.
begin;

do $$
begin
  if pg_catalog.to_regclass('public.zentra_workspace_content_blobs') is null
    or pg_catalog.to_regclass('public.zentra_workspace_country_config_changes') is null
    or not exists(select 1 from pg_catalog.pg_attribute where attrelid=pg_catalog.to_regclass('public.zentra_workspaces') and attname='number_floors' and not attisdropped) then
    raise exception 'Complete reconciled collaboration, content and country schemas required';
  end if;
  if exists(select 1 from pg_catalog.pg_roles where rolname='zentra_us_admission_owner') then
    raise exception 'Dedicated admission owner already exists; reconcile its privileges before applying';
  end if;
end $$;

create role zentra_us_admission_owner nologin noinherit nobypassrls;
grant zentra_us_admission_owner to current_user;
create schema zentra_admission_private;
revoke all on schema zentra_admission_private from public,anon,authenticated;
grant usage on schema zentra_admission_private to service_role,zentra_us_admission_owner;
grant create on schema zentra_admission_private to zentra_us_admission_owner;
grant usage on schema public to zentra_us_admission_owner;

create table public.zentra_workspace_us_admissions (
  organization_id text primary key references public.zentra_workspaces(organization_id) on delete restrict,
  creation_id uuid not null unique,
  actor_user_id uuid not null,
  request_id uuid not null,
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  configuration jsonb not null,
  admitted_at timestamptz not null,
  unique(actor_user_id,request_id),
  check (public.zentra_country_config_valid(configuration,organization_id)
    and configuration->>'country'='US' and configuration->>'currency'='USD'
    and configuration->'taxConfiguration'->>'status'='unconfigured'),
  foreign key(organization_id,request_id) references public.zentra_workspace_country_config_changes(organization_id,request_id)
    deferrable initially deferred
);
alter table public.zentra_workspace_us_admissions enable row level security;
revoke all on public.zentra_workspace_us_admissions from public,anon,authenticated,service_role;
grant select on public.zentra_workspace_us_admissions to service_role;
grant select,insert on public.zentra_workspace_us_admissions to zentra_us_admission_owner;
create policy zentra_us_admission_server_read on public.zentra_workspace_us_admissions for select to service_role using(true);
create policy zentra_us_admission_owner_read on public.zentra_workspace_us_admissions for select to zentra_us_admission_owner using(true);
create policy zentra_us_admission_owner_insert on public.zentra_workspace_us_admissions for insert to zentra_us_admission_owner with check(true);

-- The NOLOGIN owner is not granted to service_role. Its only definer operation
-- allocates a parent strictly; ordinary service code cannot forge admissions.
grant select,insert on public.zentra_workspaces to zentra_us_admission_owner;
grant update(organization_id) on public.zentra_workspaces to zentra_us_admission_owner;
create policy zentra_us_admission_parent_read on public.zentra_workspaces for select to zentra_us_admission_owner using(true);
create policy zentra_us_admission_parent_insert on public.zentra_workspaces for insert to zentra_us_admission_owner
  with check(revision=0 and snapshot_id is null and number_floors='[]'::jsonb);
create policy zentra_us_admission_parent_lock on public.zentra_workspaces for update to zentra_us_admission_owner using(true) with check(false);
grant select,insert,update on public.zentra_workspace_country_configs to zentra_us_admission_owner;
grant select,insert on public.zentra_workspace_country_config_changes to zentra_us_admission_owner;
create policy zentra_us_admission_config_owner on public.zentra_workspace_country_configs for all to zentra_us_admission_owner using(true) with check(true);
create policy zentra_us_admission_change_owner on public.zentra_workspace_country_config_changes for all to zentra_us_admission_owner using(true) with check(true);
grant execute on function public.zentra_country_config_valid(jsonb,text),public.zentra_put_workspace_country_config(text,text,bigint,uuid,jsonb) to zentra_us_admission_owner;

create function public.zentra_assert_legacy_workspace_writable_v1(p_organization text)
returns void language plpgsql security invoker set search_path='' as $$
begin
  -- Lock first, then read the admission in a new volatile-function query. A
  -- concurrent strict parent INSERT is serialized by the parent's unique key.
  perform 1 from public.zentra_workspaces where organization_id=p_organization for update;
  if exists(select 1 from public.zentra_workspace_us_admissions where organization_id=p_organization) then
    raise exception using errcode='PA004',message='Legacy workspace transport is unavailable for an admitted US workspace';
  end if;
end $$;

create function public.zentra_guard_legacy_workspace_write_v1()
returns trigger language plpgsql security invoker set search_path='' as $$
declare v_organization text;
begin
  -- Only the private admission definer can reach this role. Its strict parent
  -- INSERT must reach the unique constraint if a competing admission commits
  -- after its pre-read, allowing the definer to verify an exact durable replay.
  if tg_table_name='zentra_workspaces' and tg_op='INSERT' and current_user='zentra_us_admission_owner' then return new; end if;
  if tg_op='UPDATE' then
    for v_organization in select distinct value from pg_catalog.unnest(array[old.organization_id,new.organization_id]) value order by value loop
      perform public.zentra_assert_legacy_workspace_writable_v1(v_organization);
    end loop;
  else
    perform public.zentra_assert_legacy_workspace_writable_v1(case when tg_op='DELETE' then old.organization_id else new.organization_id end);
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;

create trigger zentra_us_legacy_parent_guard before insert or update or delete on public.zentra_workspaces for each row execute function public.zentra_guard_legacy_workspace_write_v1();
create trigger zentra_us_legacy_snapshot_guard before insert or update or delete on public.zentra_workspace_snapshots for each row execute function public.zentra_guard_legacy_workspace_write_v1();
create trigger zentra_us_legacy_chunk_guard before insert or update or delete on public.zentra_workspace_chunks for each row execute function public.zentra_guard_legacy_workspace_write_v1();
create trigger zentra_us_legacy_part_guard before insert or update or delete on public.zentra_workspace_content_parts for each row execute function public.zentra_guard_legacy_workspace_write_v1();
create trigger zentra_us_legacy_blob_guard before insert or update or delete on public.zentra_workspace_content_blobs for each row execute function public.zentra_guard_legacy_workspace_write_v1();
create trigger zentra_us_legacy_number_guard before insert or update or delete on public.zentra_workspace_number_reservations for each row execute function public.zentra_guard_legacy_workspace_write_v1();

create function public.zentra_guard_us_admission_v1()
returns trigger language plpgsql security invoker set search_path='' as $$
declare v_parent public.zentra_workspaces%rowtype;
begin
  if tg_op<>'INSERT' then
    raise exception using errcode='PA006',message='US workspace admission is immutable';
  end if;
  if current_user<>'zentra_us_admission_owner' then
    raise exception using errcode='PA005',message='US workspace admission requires strict server allocation';
  end if;
  select * into v_parent from public.zentra_workspaces where organization_id=new.organization_id for update;
  if not found or v_parent.revision<>0 or v_parent.snapshot_id is not null or v_parent.number_floors<>'[]'::jsonb
    or v_parent.updated_by<>new.actor_user_id::text then
    raise exception using errcode='PA005',message='US admission requires its exact fresh parent';
  end if;
  return new;
end $$;
create trigger zentra_us_admission_immutable_guard before insert or update or delete on public.zentra_workspace_us_admissions for each row execute function public.zentra_guard_us_admission_v1();

create function public.zentra_guard_initial_us_country_v1()
returns trigger language plpgsql security invoker set search_path='' as $$
declare v_admission public.zentra_workspace_us_admissions%rowtype; v_actor text; v_time timestamptz;
begin
  if new.config->>'country'<>'US' then return new; end if;
  if tg_table_name='zentra_workspace_country_config_changes' then
    if new.previous_revision<>0 then return new; end if;
    v_actor:=new.changed_by; v_time:=new.changed_at;
  else
    if exists(select 1 from public.zentra_workspace_country_configs where organization_id=new.organization_id) then return new; end if;
    v_actor:=new.updated_by; v_time:=new.updated_at;
  end if;
  perform 1 from public.zentra_workspaces where organization_id=new.organization_id for update;
  select * into v_admission from public.zentra_workspace_us_admissions where organization_id=new.organization_id;
  if not found or new.revision<>1 or v_admission.configuration is distinct from new.config
    or v_admission.actor_user_id::text is distinct from v_actor or v_admission.admitted_at is distinct from v_time then
    raise exception using errcode='PA005',message='Initial US country configuration requires its exact durable admission';
  end if;
  if tg_table_name='zentra_workspace_country_config_changes' then
    if v_admission.request_id is distinct from new.request_id then
      raise exception using errcode='PA005',message='Initial US country receipt must match the creation intention';
    end if;
  end if;
  return new;
end $$;
-- Run before the historical receipt guard so a missing US admission has the
-- admission-specific PA005 outcome; unattested CH still takes its old path.
create trigger zentra_admission_initial_country_guard before insert on public.zentra_workspace_country_configs for each row execute function public.zentra_guard_initial_us_country_v1();
create trigger zentra_admission_initial_receipt_guard before insert on public.zentra_workspace_country_config_changes for each row execute function public.zentra_guard_initial_us_country_v1();

create function zentra_admission_private.admit_new_us_workspace_v1(
  p_organization_id uuid,p_creation_id uuid,p_actor_user_id uuid,p_request_id uuid,p_configuration jsonb,p_fingerprint text
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_admission public.zentra_workspace_us_admissions%rowtype; v_replayed boolean:=true; v_now timestamptz:=pg_catalog.now();
begin
  if p_organization_id is null or p_creation_id is null or p_actor_user_id is null or p_request_id is null
    or p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$'
    or not public.zentra_country_config_valid(p_configuration,p_organization_id::text)
    or p_configuration->>'country' is distinct from 'US' or p_configuration->>'currency' is distinct from 'USD'
    or p_configuration->'taxConfiguration'->>'status' is distinct from 'unconfigured' then
    raise exception using errcode='PA001',message='Invalid new US workspace admission';
  end if;
  -- The opaque fingerprint comes only from the trusted D1 creation service;
  -- JSONB equality independently binds the exact configuration on every replay.
  select * into v_admission from public.zentra_workspace_us_admissions
    where organization_id=p_organization_id::text or creation_id=p_creation_id
      or (actor_user_id=p_actor_user_id and request_id=p_request_id) limit 1;
  if not found then
    begin
      insert into public.zentra_workspaces(organization_id,revision,snapshot_id,number_floors,updated_by,updated_at)
        values(p_organization_id::text,0,null,'[]'::jsonb,p_actor_user_id::text,v_now);
    exception when unique_violation then
      perform 1 from public.zentra_workspaces where organization_id=p_organization_id::text for update;
      select * into v_admission from public.zentra_workspace_us_admissions where organization_id=p_organization_id::text;
      if not found then raise exception using errcode='PA003',message='A pre-existing workspace cannot be admitted as a new US workspace'; end if;
    end;
    if v_admission.organization_id is null then
      begin
        insert into public.zentra_workspace_us_admissions(organization_id,creation_id,actor_user_id,request_id,fingerprint,configuration,admitted_at)
          values(p_organization_id::text,p_creation_id,p_actor_user_id,p_request_id,p_fingerprint,p_configuration,v_now)
          returning * into v_admission;
      exception when unique_violation then
        raise exception using errcode='PA002',message='US creation intention already belongs to different admission data';
      end;
      perform public.zentra_put_workspace_country_config(p_organization_id::text,p_actor_user_id::text,0,p_request_id,p_configuration);
      v_replayed:=false;
    end if;
  end if;
  if v_admission.organization_id is distinct from p_organization_id::text or v_admission.creation_id is distinct from p_creation_id
    or v_admission.actor_user_id is distinct from p_actor_user_id or v_admission.request_id is distinct from p_request_id
    or v_admission.fingerprint is distinct from p_fingerprint or v_admission.configuration is distinct from p_configuration then
    raise exception using errcode='PA002',message='US creation intention already belongs to different admission data';
  end if;
  perform 1 from public.zentra_workspaces where organization_id=p_organization_id::text for update;
  if not exists(select 1 from public.zentra_workspace_country_config_changes where organization_id=v_admission.organization_id
    and request_id=v_admission.request_id and previous_revision=0 and revision=1 and previous_config is null
    and config=v_admission.configuration and changed_by=v_admission.actor_user_id::text and changed_at=v_admission.admitted_at) then
    raise exception using errcode='PA005',message='US admission requires its matching initial country receipt';
  end if;
  return pg_catalog.jsonb_build_object('creationId',v_admission.creation_id,'organizationId',v_admission.organization_id,
    'actorUserId',v_admission.actor_user_id,'requestId',v_admission.request_id,'configurationFingerprint',v_admission.fingerprint,
    'configuration',v_admission.configuration,'revision',1,'updatedBy',v_admission.actor_user_id,'updatedAt',v_admission.admitted_at,'replayed',v_replayed);
end $$;
alter function zentra_admission_private.admit_new_us_workspace_v1(uuid,uuid,uuid,uuid,jsonb,text) owner to zentra_us_admission_owner;
revoke create on schema zentra_admission_private from zentra_us_admission_owner;
revoke all on function zentra_admission_private.admit_new_us_workspace_v1(uuid,uuid,uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function zentra_admission_private.admit_new_us_workspace_v1(uuid,uuid,uuid,uuid,jsonb,text) to service_role;

create function public.zentra_admit_new_us_workspace_v1(
  p_organization_id uuid,p_creation_id uuid,p_actor_user_id uuid,p_request_id uuid,p_configuration jsonb,p_fingerprint text
)
returns jsonb language sql security invoker set search_path='' as $$
  select zentra_admission_private.admit_new_us_workspace_v1(p_organization_id,p_creation_id,p_actor_user_id,p_request_id,p_configuration,p_fingerprint);
$$;
revoke all on function public.zentra_admit_new_us_workspace_v1(uuid,uuid,uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.zentra_admit_new_us_workspace_v1(uuid,uuid,uuid,uuid,jsonb,text) to service_role;

-- Preserve original bodies and signatures, adding a jurisdiction guard before
-- all legacy RPC branches, including read/replay branches that do not write.
alter function public.zentra_commit_workspace(text,uuid,text,text) set schema zentra_admission_private;
alter function public.zentra_reserve_workspace_numbers(text,text,uuid,text,integer,bigint,integer) set schema zentra_admission_private;
alter function public.zentra_prepare_content(text,uuid,text,text,bigint,jsonb,jsonb,text,boolean,jsonb) set schema zentra_admission_private;
alter function public.zentra_reserve_content_blob(text,uuid,text,text,text,integer) set schema zentra_admission_private;
alter function public.zentra_claim_content_cleanup(text) set schema zentra_admission_private;

create function public.zentra_commit_workspace(p_organization text,p_snapshot uuid,p_installation text,p_actor text)
returns jsonb language plpgsql security invoker set search_path='' as $$ begin
  perform public.zentra_assert_legacy_workspace_writable_v1(p_organization);
  return zentra_admission_private.zentra_commit_workspace(p_organization,p_snapshot,p_installation,p_actor);
end $$;
create function public.zentra_reserve_workspace_numbers(p_organization text,p_installation text,p_request uuid,p_prefix text,p_year integer,p_minimum bigint,p_count integer)
returns jsonb language plpgsql security invoker set search_path='' as $$ begin
  perform public.zentra_assert_legacy_workspace_writable_v1(p_organization);
  return zentra_admission_private.zentra_reserve_workspace_numbers(p_organization,p_installation,p_request,p_prefix,p_year,p_minimum,p_count);
end $$;
create function public.zentra_prepare_content(p_organization text,p_snapshot uuid,p_installation text,p_actor text,p_base bigint,p_manifest jsonb,p_entries jsonb,p_digest text,p_activate boolean,p_numbers jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$ begin
  perform public.zentra_assert_legacy_workspace_writable_v1(p_organization);
  return zentra_admission_private.zentra_prepare_content(p_organization,p_snapshot,p_installation,p_actor,p_base,p_manifest,p_entries,p_digest,p_activate,p_numbers);
end $$;
create function public.zentra_reserve_content_blob(p_organization text,p_snapshot uuid,p_installation text,p_actor text,p_hash text,p_size integer)
returns jsonb language plpgsql security invoker set search_path='' as $$ begin
  perform public.zentra_assert_legacy_workspace_writable_v1(p_organization);
  return zentra_admission_private.zentra_reserve_content_blob(p_organization,p_snapshot,p_installation,p_actor,p_hash,p_size);
end $$;
create function public.zentra_claim_content_cleanup(p_organization text)
returns jsonb language plpgsql security invoker set search_path='' as $$ begin
  perform public.zentra_assert_legacy_workspace_writable_v1(p_organization);
  return zentra_admission_private.zentra_claim_content_cleanup(p_organization);
end $$;
revoke all on function public.zentra_commit_workspace(text,uuid,text,text),public.zentra_reserve_workspace_numbers(text,text,uuid,text,integer,bigint,integer),public.zentra_prepare_content(text,uuid,text,text,bigint,jsonb,jsonb,text,boolean,jsonb),public.zentra_reserve_content_blob(text,uuid,text,text,text,integer),public.zentra_claim_content_cleanup(text) from public,anon,authenticated;
grant execute on function public.zentra_commit_workspace(text,uuid,text,text),public.zentra_reserve_workspace_numbers(text,text,uuid,text,integer,bigint,integer),public.zentra_prepare_content(text,uuid,text,text,bigint,jsonb,jsonb,text,boolean,jsonb),public.zentra_reserve_content_blob(text,uuid,text,text,text,integer),public.zentra_claim_content_cleanup(text) to service_role;
revoke all on function public.zentra_assert_legacy_workspace_writable_v1(text),public.zentra_guard_legacy_workspace_write_v1(),public.zentra_guard_us_admission_v1(),public.zentra_guard_initial_us_country_v1() from public,anon,authenticated;
grant execute on function public.zentra_assert_legacy_workspace_writable_v1(text) to service_role,zentra_us_admission_owner;

comment on table public.zentra_workspace_us_admissions is 'Immutable server-only new-US admission; opaque trusted D1 intention fingerprint; initial configuration snapshot may contain private EIN; never expose publicly.';
comment on function public.zentra_admit_new_us_workspace_v1(uuid,uuid,uuid,uuid,jsonb,text) is 'Strict new-parent US allocation. Does not attest D1 readiness, owner rights, entitlement, distributed atomicity or tax configuration. Migration administrator remains trusted to administer roles/triggers.';
commit;
