-- Additive proposal only. Requires the reconciled deployed workspace schema.
-- No legacy row is inferred, backfilled, or changed by this migration.
do $$
begin
  if pg_catalog.to_regclass('public.zentra_workspaces') is null then
    raise exception 'Workspace schema missing: reconcile deployed migrations first';
  end if;
end
$$;

-- Defense in depth for privileged writes. The application also validates the
-- complete country registry, IANA zones, subdivisions, lengths and plain JSON.
create function public.zentra_country_config_valid(p_config jsonb, p_organization text)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_country text;
  v_address jsonb;
  v_tax jsonb;
  v_key text;
begin
  if p_config is null or jsonb_typeof(p_config) <> 'object' then return false; end if;
  if not (p_config ?& array['schemaVersion','organizationId','country','currency','language','timeZone','address','accountingBasis','invoiceNumberPrefix','taxConfiguration']) then return false; end if;
  for v_key in select jsonb_object_keys(p_config) loop
    if not (v_key = any(array['schemaVersion','organizationId','country','currency','language','timeZone','address','ein','accountingBasis','invoiceNumberPrefix','taxConfiguration'])) then return false; end if;
  end loop;
  if p_config->'schemaVersion' <> '1'::jsonb or jsonb_typeof(p_config->'organizationId') <> 'string' or p_config->>'organizationId' is distinct from p_organization then return false; end if;
  if p_organization is null or p_organization !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' then return false; end if;
  v_country := p_config->>'country';
  if v_country is null or not (v_country = any(array['CH','US'])) then return false; end if;
  if p_config->>'currency' is distinct from (case v_country when 'CH' then 'CHF' else 'USD' end) then return false; end if;
  if jsonb_typeof(p_config->'language') <> 'string' or not (p_config->>'language' = any(array['fr','de','it','en'])) then return false; end if;
  if jsonb_typeof(p_config->'timeZone') <> 'string' or length(p_config->>'timeZone') not between 1 and 80 then return false; end if;
  if v_country = 'CH' and p_config->>'timeZone' <> 'Europe/Zurich' then return false; end if;
  if v_country = 'US' and not (p_config->>'timeZone' = any(array['America/New_York','America/Detroit','America/Kentucky/Louisville','America/Kentucky/Monticello','America/Indiana/Indianapolis','America/Indiana/Vincennes','America/Indiana/Winamac','America/Indiana/Marengo','America/Indiana/Petersburg','America/Indiana/Vevay','America/Chicago','America/Indiana/Tell_City','America/Indiana/Knox','America/Menominee','America/North_Dakota/Center','America/North_Dakota/New_Salem','America/North_Dakota/Beulah','America/Denver','America/Boise','America/Phoenix','America/Los_Angeles','America/Anchorage','America/Juneau','America/Sitka','America/Metlakatla','America/Yakutat','America/Nome','America/Adak','Pacific/Honolulu'])) then return false; end if;
  if jsonb_typeof(p_config->'accountingBasis') <> 'string' or not (p_config->>'accountingBasis' = any(array['cash','accrual'])) then return false; end if;
  if jsonb_typeof(p_config->'invoiceNumberPrefix') <> 'string' or length(p_config->>'invoiceNumberPrefix') not between 1 and 32 or p_config->>'invoiceNumberPrefix' !~ '^[A-Za-z0-9][A-Za-z0-9_-]*$' then return false; end if;
  v_tax := p_config->'taxConfiguration';
  if jsonb_typeof(v_tax) <> 'object' or not (v_tax ? 'status') or (v_tax - 'status') <> '{}'::jsonb or jsonb_typeof(v_tax->'status') <> 'string' or not (v_tax->>'status' = any(array['unconfigured','configured'])) then return false; end if;
  v_address := p_config->'address';
  if jsonb_typeof(v_address) <> 'object' or not (v_address ?& array['country','line1','postalCode','city','subdivision']) then return false; end if;
  for v_key in select jsonb_object_keys(v_address) loop
    if not (v_key = any(array['country','line1','line2','postalCode','city','subdivision'])) then return false; end if;
  end loop;
  if v_address->>'country' is distinct from v_country then return false; end if;
  foreach v_key in array array['line1','postalCode','city','subdivision'] loop
    if jsonb_typeof(v_address->v_key) <> 'string' or length(v_address->>v_key) = 0 or v_address->>v_key <> btrim(v_address->>v_key) or v_address->>v_key ~ '[[:cntrl:]]' then return false; end if;
  end loop;
  if length(v_address->>'line1') > 200 or length(v_address->>'city') > 120 or length(v_address->>'subdivision') <> 2 then return false; end if;
  if v_address ? 'line2' then
    if jsonb_typeof(v_address->'line2') <> 'string' or length(v_address->>'line2') not between 1 and 200 or v_address->>'line2' <> btrim(v_address->>'line2') or v_address->>'line2' ~ '[[:cntrl:]]' then return false; end if;
  end if;
  if v_country = 'CH' then
    if v_address->>'postalCode' !~ '^[1-9][0-9]{3}$' or not (v_address->>'subdivision' = any(array['AG','AI','AR','BE','BL','BS','FR','GE','GL','GR','JU','LU','NE','NW','OW','SG','SH','SO','SZ','TG','TI','UR','VD','VS','ZG','ZH'])) or p_config ? 'ein' then return false; end if;
  else
    if v_address->>'postalCode' !~ '^[0-9]{5}(-[0-9]{4})?$' or not (v_address->>'subdivision' = any(array['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'])) then return false; end if;
    if p_config ? 'ein' and (jsonb_typeof(p_config->'ein') <> 'string' or p_config->>'ein' !~ '^[0-9]{2}-[0-9]{7}$') then return false; end if;
  end if;
  return true;
end
$$;

create table public.zentra_workspace_country_configs (
  organization_id text primary key references public.zentra_workspaces(organization_id) on delete restrict,
  schema_version integer not null default 1 check (schema_version = 1),
  config jsonb not null,
  country text not null check (country in ('CH','US')),
  currency text not null check ((country = 'CH' and currency = 'CHF') or (country = 'US' and currency = 'USD')),
  revision bigint not null check (revision between 1 and 9007199254740991),
  updated_by text not null check (length(updated_by) between 1 and 256),
  updated_at timestamptz not null default now(),
  constraint zentra_country_config_document_valid check (
    public.zentra_country_config_valid(config, organization_id)
    and config->>'country' = country and config->>'currency' = currency
  )
);

create table public.zentra_workspace_country_config_changes (
  organization_id text not null references public.zentra_workspaces(organization_id) on delete restrict,
  request_id uuid not null,
  previous_revision bigint not null check (previous_revision >= 0),
  revision bigint not null check (revision = previous_revision + 1 and revision <= 9007199254740991),
  previous_config jsonb,
  config jsonb not null,
  changed_by text not null check (length(changed_by) between 1 and 256),
  changed_at timestamptz not null default now(),
  primary key (organization_id, request_id),
  unique (organization_id, revision),
  constraint zentra_country_change_document_valid check (public.zentra_country_config_valid(config, organization_id)),
  constraint zentra_country_change_previous_valid check (
    (previous_revision = 0 and previous_config is null)
    or (previous_revision > 0 and previous_config is not null and public.zentra_country_config_valid(previous_config, organization_id))
  ),
  constraint zentra_country_change_jurisdiction_locked check (
    previous_revision = 0 or (
      previous_config->>'country' = config->>'country'
      and previous_config->>'currency' = config->>'currency'
      and previous_config->>'accountingBasis' = config->>'accountingBasis'
    )
  )
);

-- Every current revision must have a durable receipt, including direct writes
-- by trusted service code. This is not a client-visible audit endpoint.
alter table public.zentra_workspace_country_configs
  add constraint zentra_country_config_audit_revision_fk foreign key (organization_id, revision)
  references public.zentra_workspace_country_config_changes(organization_id, revision);

create function public.zentra_guard_country_configuration()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  v_receipt public.zentra_workspace_country_config_changes%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'PZ003', message = 'Country configuration removal requires an explicit migration procedure';
  end if;
  if tg_op = 'UPDATE' and (new.organization_id is distinct from old.organization_id or new.country is distinct from old.country or new.currency is distinct from old.currency or new.config->>'accountingBasis' is distinct from old.config->>'accountingBasis') then
    raise exception using errcode = 'PZ003', message = 'Confirmed jurisdiction is immutable';
  end if;
  if tg_op = 'UPDATE' and new.revision <> old.revision + 1 then
    raise exception using errcode = 'PZ001', message = 'Country configuration revision conflict';
  end if;
  select * into v_receipt from public.zentra_workspace_country_config_changes where organization_id = new.organization_id and revision = new.revision;
  if not found or v_receipt.config is distinct from new.config or v_receipt.changed_by is distinct from new.updated_by or v_receipt.changed_at is distinct from new.updated_at then
    raise exception using errcode = 'PZ005', message = 'Country configuration requires its matching audit receipt';
  end if;
  -- INSERT triggers also run before ON CONFLICT UPDATE. Only enforce the
  -- initial-chain rule when no current row exists for this organization.
  if tg_op = 'INSERT' and not exists(select 1 from public.zentra_workspace_country_configs where organization_id = new.organization_id)
    and (new.revision <> 1 or v_receipt.previous_revision <> 0 or v_receipt.previous_config is not null) then
    raise exception using errcode = 'PZ005', message = 'Initial country configuration requires an initial receipt';
  end if;
  if tg_op = 'UPDATE' and (v_receipt.previous_revision is distinct from old.revision or v_receipt.previous_config is distinct from old.config) then
    raise exception using errcode = 'PZ005', message = 'Country configuration requires the matching previous state';
  end if;
  return new;
end
$$;
create trigger zentra_country_configuration_guard before insert or update or delete on public.zentra_workspace_country_configs
  for each row execute function public.zentra_guard_country_configuration();

create function public.zentra_guard_country_change_log()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  raise exception using errcode = 'PZ005', message = 'Country configuration history is append-only';
end
$$;
create trigger zentra_country_change_log_append_only before update or delete on public.zentra_workspace_country_config_changes
  for each row execute function public.zentra_guard_country_change_log();

create function public.zentra_put_workspace_country_config(
  p_organization text, p_actor text, p_expected_revision bigint,
  p_request_id uuid, p_config jsonb
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_current public.zentra_workspace_country_configs%rowtype;
  v_receipt public.zentra_workspace_country_config_changes%rowtype;
  v_revision bigint;
  v_now timestamptz := now();
begin
  if p_actor is null or length(p_actor) not between 1 and 256 or p_request_id is null
    or p_expected_revision is null or p_expected_revision < 0 or p_expected_revision >= 9007199254740991
    or not public.zentra_country_config_valid(p_config, p_organization) then
    raise exception using errcode = '22023', message = 'Invalid country configuration request';
  end if;
  -- One lock serializes initial creation and updates for this company. D1
  -- membership must already have been checked by the server before this call.
  perform 1 from public.zentra_workspaces where organization_id = p_organization for update;
  if not found then
    raise exception using errcode = 'PZ004', message = 'Workspace has not been provisioned';
  end if;
  select * into v_receipt from public.zentra_workspace_country_config_changes
    where organization_id = p_organization and request_id = p_request_id;
  if found then
    if v_receipt.changed_by is distinct from p_actor or v_receipt.previous_revision is distinct from p_expected_revision or v_receipt.config is distinct from p_config then
      raise exception using errcode = 'PZ002', message = 'Request identifier was already used for a different change';
    end if;
    return jsonb_build_object('organizationId',p_organization,'revision',v_receipt.revision,'configuration',v_receipt.config,'updatedBy',v_receipt.changed_by,'updatedAt',v_receipt.changed_at,'replayed',true);
  end if;
  select * into v_current from public.zentra_workspace_country_configs where organization_id = p_organization;
  v_revision := coalesce(v_current.revision, 0);
  if p_expected_revision <> v_revision then
    raise exception using errcode = 'PZ001', message = 'Country configuration revision conflict';
  end if;
  if v_revision > 0 and (p_config->>'country' is distinct from v_current.country or p_config->>'currency' is distinct from v_current.currency or p_config->>'accountingBasis' is distinct from v_current.config->>'accountingBasis') then
    raise exception using errcode = 'PZ003', message = 'Confirmed jurisdiction is immutable';
  end if;
  insert into public.zentra_workspace_country_config_changes(organization_id,request_id,previous_revision,revision,previous_config,config,changed_by,changed_at)
    values(p_organization,p_request_id,v_revision,v_revision+1,v_current.config,p_config,p_actor,v_now);
  insert into public.zentra_workspace_country_configs(organization_id,schema_version,config,country,currency,revision,updated_by,updated_at)
    values(p_organization,1,p_config,p_config->>'country',p_config->>'currency',v_revision+1,p_actor,v_now)
    on conflict (organization_id) do update set config=excluded.config, revision=excluded.revision, updated_by=excluded.updated_by, updated_at=excluded.updated_at;
  return jsonb_build_object('organizationId',p_organization,'revision',v_revision+1,'configuration',p_config,'updatedBy',p_actor,'updatedAt',v_now,'replayed',false);
end
$$;

alter table public.zentra_workspace_country_configs enable row level security;
alter table public.zentra_workspace_country_config_changes enable row level security;
revoke all on public.zentra_workspace_country_configs, public.zentra_workspace_country_config_changes from public, anon, authenticated;
grant select, insert, update on public.zentra_workspace_country_configs to service_role;
grant select, insert on public.zentra_workspace_country_config_changes to service_role;
create policy zentra_country_configs_server_only on public.zentra_workspace_country_configs for all to service_role using (true) with check (true);
create policy zentra_country_changes_server_only on public.zentra_workspace_country_config_changes for all to service_role using (true) with check (true);

revoke all on function public.zentra_country_config_valid(jsonb,text) from public, anon, authenticated;
revoke all on function public.zentra_guard_country_configuration() from public, anon, authenticated;
revoke all on function public.zentra_guard_country_change_log() from public, anon, authenticated;
revoke all on function public.zentra_put_workspace_country_config(text,text,bigint,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.zentra_country_config_valid(jsonb,text) to service_role;
grant execute on function public.zentra_put_workspace_country_config(text,text,bigint,uuid,jsonb) to service_role;
-- SECURITY INVOKER needs the existing privileged workspace SELECT + UPDATE
-- grants/policy for FOR UPDATE. This proposal does not broaden legacy grants.
comment on table public.zentra_workspace_country_configs is 'Explicit organization jurisdiction; server-only; no inferred legacy country.';
comment on table public.zentra_workspace_country_config_changes is 'Append-only administrative configuration receipts, not financial or tax certification.';
