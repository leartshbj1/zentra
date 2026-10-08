-- Additive private declarations only: never tax authority, provider settings or CH data.
-- Fresh owner/Auth/D1 admission remains at the server boundary; this proposal
-- is tested locally and does not verify a tax provider or its environment.
begin;

do $$ begin
  if pg_catalog.to_regclass('public.zentra_workspace_country_configs') is null then
    raise exception 'Reconciled workspace country schema required before US tax declarations';
  end if;
end $$;

create function public.zentra_us_tax_text_valid(p_value text,p_maximum integer,p_canonical boolean) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare v_index integer;v_code integer;v_utf16_length integer:=0;
  v_trim_characters constant text:=U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
begin
  if p_value is null or p_maximum is null or p_maximum<1 or p_canonical is null
    or length(p_value) not between 1 and p_maximum or btrim(p_value,v_trim_characters)=''
    or (p_canonical and p_value<>btrim(p_value,v_trim_characters)) then return false;end if;
  for v_index in 1..length(p_value) loop
    v_code:=ascii(substr(p_value,v_index,1));
    if v_code<32 or v_code=127 then return false;end if;
    v_utf16_length:=v_utf16_length+(case when v_code>65535 then 2 else 1 end);
  end loop;
  return v_utf16_length<=p_maximum;
end $$;

create function public.zentra_us_tax_facts_valid(p_facts jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare v_origin jsonb;v_key text;v_maximum integer;
begin
  if jsonb_typeof(p_facts) is distinct from 'object'
    or not(p_facts ?& array['schemaVersion','legalName','taxOrigin','timeZone'])
    or p_facts-array['schemaVersion','legalName','taxOrigin','timeZone']<>'{}'::jsonb
    or p_facts->'schemaVersion' is distinct from '1'::jsonb
    or jsonb_typeof(p_facts->'legalName') is distinct from 'string'
    or not public.zentra_us_tax_text_valid(p_facts->>'legalName',256,true)
    or jsonb_typeof(p_facts->'timeZone') is distinct from 'string'
    or not public.zentra_us_tax_text_valid(p_facts->>'timeZone',80,true) then return false;end if;
  if p_facts->>'timeZone' not in (
    'America/New_York','America/Detroit','America/Kentucky/Louisville','America/Kentucky/Monticello',
    'America/Indiana/Indianapolis','America/Indiana/Vincennes','America/Indiana/Winamac',
    'America/Indiana/Marengo','America/Indiana/Petersburg','America/Indiana/Vevay',
    'America/Chicago','America/Indiana/Tell_City','America/Indiana/Knox','America/Menominee',
    'America/North_Dakota/Center','America/North_Dakota/New_Salem','America/North_Dakota/Beulah',
    'America/Denver','America/Boise','America/Phoenix','America/Los_Angeles',
    'America/Anchorage','America/Juneau','America/Sitka','America/Metlakatla',
    'America/Yakutat','America/Nome','America/Adak','Pacific/Honolulu'
  ) then return false;end if;
  v_origin:=p_facts->'taxOrigin';
  if jsonb_typeof(v_origin) is distinct from 'object'
    or not(v_origin ?& array['country','line1','city','subdivision','postalCode'])
    or v_origin-array['country','line1','line2','city','subdivision','postalCode']<>'{}'::jsonb
    or v_origin->>'country' is distinct from 'US' then return false;end if;
  foreach v_key in array array['country','line1','line2','city','subdivision','postalCode'] loop
    if v_origin ? v_key then
      v_maximum:=case v_key when 'country' then 2 when 'line1' then 200 when 'line2' then 200 when 'city' then 120 when 'subdivision' then 2 else 10 end;
      if jsonb_typeof(v_origin->v_key) is distinct from 'string'
        or not public.zentra_us_tax_text_valid(v_origin->>v_key,v_maximum,true) then return false;end if;
    end if;
  end loop;
  if v_origin->>'subdivision' not in ('AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY')
    or v_origin->>'postalCode' !~ '^[0-9]{5}(-[0-9]{4})?$' then return false;end if;
  return true;
exception when others then return false;
end $$;

create table public.zentra_us_tax_profiles(
  organization_id text primary key references public.zentra_workspace_country_configs(organization_id) on delete restrict,
  revision bigint not null check(revision between 1 and 9007199254740990),
  facts jsonb not null check(public.zentra_us_tax_facts_valid(facts)),
  updated_by text not null check(public.zentra_us_tax_text_valid(updated_by,256,false)),
  updated_at timestamptz not null check(isfinite(updated_at)
    and updated_at>=timestamptz '0001-01-01 00:00:00+00'
    and updated_at<timestamptz '10000-01-01 00:00:00+00')
);
create table public.zentra_us_tax_profile_changes(
  organization_id text not null references public.zentra_workspace_country_configs(organization_id) on delete restrict,
  request_id uuid not null check(request_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  previous_revision bigint not null check(previous_revision between 0 and 9007199254740989),
  revision bigint not null check(revision=previous_revision+1 and revision<=9007199254740990),
  previous_facts jsonb,
  facts jsonb not null check(public.zentra_us_tax_facts_valid(facts)),
  changed_by text not null check(public.zentra_us_tax_text_valid(changed_by,256,false)),
  changed_at timestamptz not null check(isfinite(changed_at)
    and changed_at>=timestamptz '0001-01-01 00:00:00+00'
    and changed_at<timestamptz '10000-01-01 00:00:00+00'),
  primary key(organization_id,request_id),unique(organization_id,revision),
  check((previous_revision=0 and previous_facts is null) or (previous_revision>0 and previous_facts is not null and public.zentra_us_tax_facts_valid(previous_facts)))
);
alter table public.zentra_us_tax_profiles add constraint zentra_us_tax_profile_receipt_fk
  foreign key(organization_id,revision) references public.zentra_us_tax_profile_changes(organization_id,revision)
  deferrable initially deferred;

create function public.zentra_guard_us_tax_history() returns trigger
language plpgsql security invoker set search_path='' as $$
declare v_head public.zentra_us_tax_profiles%rowtype;
begin
  if tg_op<>'INSERT' then raise exception using errcode='PT005',message='Tax declaration history is append-only';end if;
  perform 1 from public.zentra_workspaces where organization_id=new.organization_id for update;
  if not found then raise exception using errcode='PT003',message='Configured US workspace required';end if;
  perform 1 from public.zentra_workspace_country_configs where organization_id=new.organization_id and country='US' and currency='USD' for update;
  if not found then raise exception using errcode='PT003',message='Configured US workspace required';end if;
  select * into v_head from public.zentra_us_tax_profiles where organization_id=new.organization_id for update;
  if new.previous_revision is distinct from coalesce(v_head.revision,0) or new.previous_facts is distinct from v_head.facts then
    raise exception using errcode='PT005',message='Tax declaration audit chain does not match the current head';
  end if;
  return new;
end $$;
create trigger zentra_us_tax_history_guard before insert or update or delete on public.zentra_us_tax_profile_changes
  for each row execute function public.zentra_guard_us_tax_history();
create trigger zentra_us_tax_history_truncate_guard before truncate on public.zentra_us_tax_profile_changes
  for each statement execute function public.zentra_guard_us_tax_history();

create function public.zentra_guard_us_tax_head() returns trigger
language plpgsql security invoker set search_path='' as $$
declare v_receipt public.zentra_us_tax_profile_changes%rowtype;
begin
  if tg_op in ('DELETE','TRUNCATE') then raise exception using errcode='PT005',message='Tax declaration removal requires an explicit procedure';end if;
  if tg_op='UPDATE' and (new.organization_id is distinct from old.organization_id or new.revision<>old.revision+1) then
    raise exception using errcode='PT005',message='Tax declaration identity and revision chain are immutable';
  end if;
  if not exists(select 1 from public.zentra_workspace_country_configs where organization_id=new.organization_id and country='US' and currency='USD') then
    raise exception using errcode='PT003',message='Configured US workspace required';
  end if;
  select * into v_receipt from public.zentra_us_tax_profile_changes where organization_id=new.organization_id and revision=new.revision;
  if not found or v_receipt.facts is distinct from new.facts or v_receipt.changed_by is distinct from new.updated_by or v_receipt.changed_at is distinct from new.updated_at then
    raise exception using errcode='PT005',message='Tax declaration head requires its exact immutable receipt';
  end if;
  if tg_op='INSERT' and (new.revision<>1 or v_receipt.previous_revision<>0 or v_receipt.previous_facts is not null) then
    raise exception using errcode='PT005',message='Initial tax declaration requires an initial receipt';
  end if;
  if tg_op='UPDATE' and (v_receipt.previous_revision is distinct from old.revision or v_receipt.previous_facts is distinct from old.facts) then
    raise exception using errcode='PT005',message='Tax declaration head does not match its historical baseline';
  end if;
  return new;
end $$;
create trigger zentra_us_tax_head_guard before insert or update or delete on public.zentra_us_tax_profiles
  for each row execute function public.zentra_guard_us_tax_head();
create trigger zentra_us_tax_head_truncate_guard before truncate on public.zentra_us_tax_profiles
  for each statement execute function public.zentra_guard_us_tax_head();

create function public.zentra_guard_us_tax_complete_receipt() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if not exists(select 1 from public.zentra_us_tax_profiles where organization_id=new.organization_id and revision>=new.revision) then
    raise exception using errcode='PT005',message='Tax declaration receipt requires an atomically completed head';
  end if;
  return null;
end $$;
create constraint trigger zentra_us_tax_complete_receipt after insert on public.zentra_us_tax_profile_changes
  deferrable initially deferred for each row execute function public.zentra_guard_us_tax_complete_receipt();

create function public.zentra_read_us_tax_profile(p_organization text) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare v_head public.zentra_us_tax_profiles%rowtype;
begin
  if p_organization is null or p_organization !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' then
    raise exception using errcode='PT004',message='Invalid US tax declaration request';
  end if;
  if not exists(select 1 from public.zentra_workspace_country_configs where organization_id=p_organization and country='US' and currency='USD') then
    raise exception using errcode='PT003',message='Configured US workspace required';
  end if;
  select * into v_head from public.zentra_us_tax_profiles where organization_id=p_organization;
  if not found then return jsonb_build_object('status','unconfigured','organizationId',p_organization,'revision',0,'verification','unverified');end if;
  -- UTC projection is stable across session zones and cannot shift year bounds.
  return jsonb_build_object('status','declared','organizationId',p_organization,'revision',v_head.revision,'facts',v_head.facts,'updatedBy',v_head.updated_by,'updatedAt',to_char(v_head.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'verification','unverified');
end $$;

create function public.zentra_put_us_tax_profile(p_organization text,p_actor text,p_expected_revision bigint,p_request_id uuid,p_facts jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_head public.zentra_us_tax_profiles%rowtype;v_receipt public.zentra_us_tax_profile_changes%rowtype;v_now timestamptz:=clock_timestamp();
begin
  if p_organization is null or p_organization !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or not public.zentra_us_tax_text_valid(p_actor,256,false) or p_expected_revision is null or p_expected_revision not between 0 and 9007199254740989
    or p_request_id is null or p_request_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or not public.zentra_us_tax_facts_valid(p_facts) then raise exception using errcode='PT004',message='Invalid US tax declaration request';end if;
  -- Serialize even the initial declaration, in the existing workspace/country/head order.
  perform 1 from public.zentra_workspaces where organization_id=p_organization for update;
  if not found then raise exception using errcode='PT003',message='Configured US workspace required';end if;
  perform 1 from public.zentra_workspace_country_configs where organization_id=p_organization and country='US' and currency='USD' for update;
  if not found then raise exception using errcode='PT003',message='Configured US workspace required';end if;
  select * into v_receipt from public.zentra_us_tax_profile_changes where organization_id=p_organization and request_id=p_request_id;
  if found then
    if v_receipt.changed_by is distinct from p_actor or v_receipt.previous_revision is distinct from p_expected_revision or v_receipt.facts is distinct from p_facts then
      raise exception using errcode='PT002',message='Tax declaration request identifier conflict';
    end if;
    return jsonb_build_object('status','declared','organizationId',p_organization,'revision',v_receipt.revision,'facts',v_receipt.facts,'updatedBy',v_receipt.changed_by,'updatedAt',to_char(v_receipt.changed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'verification','unverified','requestId',p_request_id,'replayed',true);
  end if;
  select * into v_head from public.zentra_us_tax_profiles where organization_id=p_organization for update;
  if coalesce(v_head.revision,0)<>p_expected_revision then raise exception using errcode='PT001',message='Tax declaration revision conflict';end if;
  insert into public.zentra_us_tax_profile_changes(organization_id,request_id,previous_revision,revision,previous_facts,facts,changed_by,changed_at)
    values(p_organization,p_request_id,p_expected_revision,p_expected_revision+1,v_head.facts,p_facts,p_actor,v_now);
  if v_head.organization_id is null then
    insert into public.zentra_us_tax_profiles(organization_id,revision,facts,updated_by,updated_at) values(p_organization,1,p_facts,p_actor,v_now);
  else
    update public.zentra_us_tax_profiles set revision=p_expected_revision+1,facts=p_facts,updated_by=p_actor,updated_at=v_now where organization_id=p_organization;
  end if;
  return jsonb_build_object('status','declared','organizationId',p_organization,'revision',p_expected_revision+1,'facts',p_facts,'updatedBy',p_actor,'updatedAt',to_char(v_now at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'verification','unverified','requestId',p_request_id,'replayed',false);
end $$;

alter table public.zentra_us_tax_profiles enable row level security;
alter table public.zentra_us_tax_profile_changes enable row level security;
revoke all on public.zentra_us_tax_profiles,public.zentra_us_tax_profile_changes from public,anon,authenticated,service_role;
grant select,insert,update on public.zentra_us_tax_profiles to service_role;
grant select,insert on public.zentra_us_tax_profile_changes to service_role;
create policy zentra_us_tax_head_read on public.zentra_us_tax_profiles for select to service_role using(true);
create policy zentra_us_tax_head_insert on public.zentra_us_tax_profiles for insert to service_role with check(true);
create policy zentra_us_tax_head_update on public.zentra_us_tax_profiles for update to service_role using(true) with check(true);
create policy zentra_us_tax_changes_read on public.zentra_us_tax_profile_changes for select to service_role using(true);
create policy zentra_us_tax_changes_insert on public.zentra_us_tax_profile_changes for insert to service_role with check(true);
revoke all on function public.zentra_us_tax_text_valid(text,integer,boolean),public.zentra_us_tax_facts_valid(jsonb),public.zentra_guard_us_tax_history(),public.zentra_guard_us_tax_head(),public.zentra_guard_us_tax_complete_receipt(),public.zentra_read_us_tax_profile(text),public.zentra_put_us_tax_profile(text,text,bigint,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.zentra_us_tax_text_valid(text,integer,boolean),public.zentra_us_tax_facts_valid(jsonb),public.zentra_read_us_tax_profile(text),public.zentra_put_us_tax_profile(text,text,bigint,uuid,jsonb) to service_role;
comment on table public.zentra_us_tax_profiles is 'Private US owner declarations only, always unverified. No provider, environment, registration, exemption or tax authority is verified. Local proposal; no legacy CH write.';
comment on table public.zentra_us_tax_profile_changes is 'Append-only private CAS declarations and exact receipts. No evidence of legal/fiscal verification or production deployment.';
commit;
