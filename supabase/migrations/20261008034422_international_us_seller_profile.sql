-- Local additive proposal. No CH profile is read, copied, inferred or updated.
-- Auth/D1 owns fresh owner authorization; only the internal service-role RPC is exposed.
begin;
do $$ begin
  if pg_catalog.to_regclass('public.zentra_workspace_country_configs') is null then
    raise exception 'Reconciled workspace country schema required before US seller profiles';
  end if;
end $$;

create function public.zentra_us_seller_profile_valid(p_profile jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare v_key text;v_value text;v_index integer;v_utf16_length integer;
  v_trim_characters constant text:=U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
begin
  if jsonb_typeof(p_profile) is distinct from 'object' or not(p_profile ? 'displayName')
    or p_profile-array['displayName','contactEmail','contactPhone']<>'{}'::jsonb then return false;end if;
  foreach v_key in array array['displayName','contactEmail','contactPhone'] loop
    if p_profile ? v_key then
      if jsonb_typeof(p_profile->v_key) is distinct from 'string' then return false;end if;
      v_value:=p_profile->>v_key;
      if length(v_value) not between 1 and (case v_key when 'displayName' then 256 when 'contactEmail' then 254 else 80 end)
        or v_value<>btrim(v_value,v_trim_characters) or v_value ~ '[[:cntrl:]]' then return false;end if;
      -- Browser string bounds use UTF-16 code units, not PostgreSQL characters.
      v_utf16_length:=0;
      for v_index in 1..length(v_value) loop
        v_utf16_length:=v_utf16_length+(case when ascii(substr(v_value,v_index,1))>65535 then 2 else 1 end);
      end loop;
      if v_utf16_length>(case v_key when 'displayName' then 256 when 'contactEmail' then 254 else 80 end) then return false;end if;
      if v_key='contactEmail' and (v_value !~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$' or v_value ~ ('['||v_trim_characters||']')) then return false;end if;
    end if;
  end loop;
  return true;
end $$;

create table public.zentra_us_seller_profiles(
  organization_id text primary key references public.zentra_workspace_country_configs(organization_id) on delete restrict,
  revision bigint not null check(revision between 1 and 9007199254740990),
  profile jsonb not null check(public.zentra_us_seller_profile_valid(profile)),
  updated_by text not null check(length(updated_by) between 1 and 256 and btrim(updated_by)<>'' and updated_by !~ '[[:cntrl:]]'),
  updated_at timestamptz not null
);
create table public.zentra_us_seller_profile_changes(
  organization_id text not null references public.zentra_workspace_country_configs(organization_id) on delete restrict,
  request_id uuid not null,
  previous_revision bigint not null check(previous_revision between 0 and 9007199254740989),
  revision bigint not null check(revision=previous_revision+1 and revision<=9007199254740990),
  previous_profile jsonb,
  profile jsonb not null check(public.zentra_us_seller_profile_valid(profile)),
  changed_by text not null check(length(changed_by) between 1 and 256 and btrim(changed_by)<>'' and changed_by !~ '[[:cntrl:]]'),
  changed_at timestamptz not null,
  primary key(organization_id,request_id),unique(organization_id,revision),
  check((previous_revision=0 and previous_profile is null) or (previous_revision>0 and previous_profile is not null and public.zentra_us_seller_profile_valid(previous_profile)))
);
alter table public.zentra_us_seller_profiles add constraint zentra_us_seller_receipt_fk
  foreign key(organization_id,revision) references public.zentra_us_seller_profile_changes(organization_id,revision);

create function public.zentra_guard_us_seller_history() returns trigger
language plpgsql security invoker set search_path='' as $$
declare v_head public.zentra_us_seller_profiles%rowtype;
begin
  if tg_op<>'INSERT' then raise exception using errcode='PS005',message='Seller history is append-only';end if;
  perform 1 from public.zentra_workspaces where organization_id=new.organization_id for update;
  if not exists(select 1 from public.zentra_workspace_country_configs where organization_id=new.organization_id and country='US' and currency='USD') then
    raise exception using errcode='PS003',message='Configured US workspace required';
  end if;
  select * into v_head from public.zentra_us_seller_profiles where organization_id=new.organization_id;
  if new.previous_revision is distinct from coalesce(v_head.revision,0) or new.previous_profile is distinct from v_head.profile then
    raise exception using errcode='PS005',message='Seller audit chain does not match the current head';
  end if;
  return new;
end $$;
create trigger zentra_us_seller_history_guard before insert or update or delete on public.zentra_us_seller_profile_changes
  for each row execute function public.zentra_guard_us_seller_history();

create function public.zentra_guard_us_seller_head() returns trigger
language plpgsql security invoker set search_path='' as $$
declare v_receipt public.zentra_us_seller_profile_changes%rowtype;
begin
  if tg_op='DELETE' then raise exception using errcode='PS005',message='Seller removal requires an explicit procedure';end if;
  if tg_op='UPDATE' and (new.organization_id is distinct from old.organization_id or new.revision<>old.revision+1) then
    raise exception using errcode='PS005',message='Seller identity and revision chain are immutable';
  end if;
  if not exists(select 1 from public.zentra_workspace_country_configs where organization_id=new.organization_id and country='US' and currency='USD') then
    raise exception using errcode='PS003',message='Configured US workspace required';
  end if;
  select * into v_receipt from public.zentra_us_seller_profile_changes where organization_id=new.organization_id and revision=new.revision;
  if not found or v_receipt.profile is distinct from new.profile or v_receipt.changed_by is distinct from new.updated_by or v_receipt.changed_at is distinct from new.updated_at then
    raise exception using errcode='PS005',message='Seller head requires its exact immutable receipt';
  end if;
  if tg_op='INSERT' and (new.revision<>1 or v_receipt.previous_revision<>0 or v_receipt.previous_profile is not null) then
    raise exception using errcode='PS005',message='Initial seller profile requires an initial receipt';
  end if;
  if tg_op='UPDATE' and (v_receipt.previous_revision is distinct from old.revision or v_receipt.previous_profile is distinct from old.profile) then
    raise exception using errcode='PS005',message='Seller head does not match its historical baseline';
  end if;
  return new;
end $$;
create trigger zentra_us_seller_head_guard before insert or update or delete on public.zentra_us_seller_profiles
  for each row execute function public.zentra_guard_us_seller_head();

-- A direct privileged receipt insert cannot claim a write that never updated the head.
create function public.zentra_guard_us_seller_complete_receipt() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if not exists(select 1 from public.zentra_us_seller_profiles where organization_id=new.organization_id and revision>=new.revision) then
    raise exception using errcode='PS005',message='Seller receipt requires an atomically completed head';
  end if;
  return null;
end $$;
create constraint trigger zentra_us_seller_complete_receipt after insert on public.zentra_us_seller_profile_changes
  deferrable initially deferred for each row execute function public.zentra_guard_us_seller_complete_receipt();

create function public.zentra_read_us_seller_profile(p_organization text) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare v_head public.zentra_us_seller_profiles%rowtype;
begin
  if not exists(select 1 from public.zentra_workspace_country_configs where organization_id=p_organization and country='US' and currency='USD') then
    raise exception using errcode='PS003',message='Configured US workspace required';
  end if;
  select * into v_head from public.zentra_us_seller_profiles where organization_id=p_organization;
  if not found then return jsonb_build_object('status','unconfigured','organizationId',p_organization,'revision',0);end if;
  return jsonb_build_object('status','configured','organizationId',p_organization,'revision',v_head.revision,'profile',v_head.profile,'updatedBy',v_head.updated_by,'updatedAt',v_head.updated_at);
end $$;
create function public.zentra_put_us_seller_profile(p_organization text,p_actor text,p_expected_revision bigint,p_request_id uuid,p_profile jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_head public.zentra_us_seller_profiles%rowtype;v_receipt public.zentra_us_seller_profile_changes%rowtype;v_now timestamptz:=clock_timestamp();
begin
  if p_organization is null or p_organization !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' or p_actor is null or length(p_actor) not between 1 and 256 or btrim(p_actor)='' or p_actor ~ '[[:cntrl:]]'
    or p_expected_revision is null or p_expected_revision not between 0 and 9007199254740989 or p_request_id is null or not public.zentra_us_seller_profile_valid(p_profile) then
    raise exception using errcode='PS004',message='Invalid US seller request';
  end if;
  -- Same lock order as country/ERP: serialize even the very first seller write.
  perform 1 from public.zentra_workspaces where organization_id=p_organization for update;
  if not found then raise exception using errcode='PS003',message='Configured US workspace required';end if;
  perform 1 from public.zentra_workspace_country_configs where organization_id=p_organization and country='US' and currency='USD' for update;
  if not found then raise exception using errcode='PS003',message='Configured US workspace required';end if;
  select * into v_receipt from public.zentra_us_seller_profile_changes where organization_id=p_organization and request_id=p_request_id;
  if found then
    if v_receipt.changed_by is distinct from p_actor or v_receipt.previous_revision is distinct from p_expected_revision or v_receipt.profile is distinct from p_profile then
      raise exception using errcode='PS002',message='Seller request identifier conflict';
    end if;
    return jsonb_build_object('status','configured','organizationId',p_organization,'revision',v_receipt.revision,'profile',v_receipt.profile,'updatedBy',v_receipt.changed_by,'updatedAt',v_receipt.changed_at,'requestId',p_request_id,'replayed',true);
  end if;
  select * into v_head from public.zentra_us_seller_profiles where organization_id=p_organization for update;
  if coalesce(v_head.revision,0)<>p_expected_revision then raise exception using errcode='PS001',message='Seller revision conflict';end if;
  insert into public.zentra_us_seller_profile_changes(organization_id,request_id,previous_revision,revision,previous_profile,profile,changed_by,changed_at)
    values(p_organization,p_request_id,p_expected_revision,p_expected_revision+1,v_head.profile,p_profile,p_actor,v_now);
  if v_head.organization_id is null then
    insert into public.zentra_us_seller_profiles(organization_id,revision,profile,updated_by,updated_at) values(p_organization,1,p_profile,p_actor,v_now);
  else
    update public.zentra_us_seller_profiles set revision=p_expected_revision+1,profile=p_profile,updated_by=p_actor,updated_at=v_now where organization_id=p_organization;
  end if;
  return jsonb_build_object('status','configured','organizationId',p_organization,'revision',p_expected_revision+1,'profile',p_profile,'updatedBy',p_actor,'updatedAt',v_now,'requestId',p_request_id,'replayed',false);
end $$;

alter table public.zentra_us_seller_profiles enable row level security;
alter table public.zentra_us_seller_profile_changes enable row level security;
revoke all on public.zentra_us_seller_profiles,public.zentra_us_seller_profile_changes from public,anon,authenticated;
grant select,insert,update on public.zentra_us_seller_profiles to service_role;
grant select,insert on public.zentra_us_seller_profile_changes to service_role;
create policy zentra_us_seller_profiles_server on public.zentra_us_seller_profiles for all to service_role using(true) with check(true);
create policy zentra_us_seller_changes_server on public.zentra_us_seller_profile_changes for all to service_role using(true) with check(true);
revoke all on function public.zentra_us_seller_profile_valid(jsonb),public.zentra_guard_us_seller_history(),public.zentra_guard_us_seller_head(),public.zentra_guard_us_seller_complete_receipt(),public.zentra_read_us_seller_profile(text),public.zentra_put_us_seller_profile(text,text,bigint,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.zentra_us_seller_profile_valid(jsonb),public.zentra_read_us_seller_profile(text),public.zentra_put_us_seller_profile(text,text,bigint,uuid,jsonb) to service_role;
comment on table public.zentra_us_seller_profiles is 'US-only public seller identity; Auth/D1 owner authorization remains at the server boundary; no tax/payment certification.';
comment on table public.zentra_us_seller_profile_changes is 'Append-only CAS seller receipts; no backfill or changes to legacy company profiles.';
commit;
