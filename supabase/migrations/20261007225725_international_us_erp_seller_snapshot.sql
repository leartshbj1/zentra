-- Additive archive validation for the experimental US book. No seller name is
-- fabricated or copied into historical documents. Approval is required before
-- applying any of these US migrations to production.
begin;
do $$ begin
  if pg_catalog.to_regclass('public.zentra_us_erp_records') is null
    or pg_catalog.to_regclass('public.zentra_us_erp_heads') is null then
    raise exception 'US ERP persistence schema required before seller archive validation';
  end if;
end $$;

create function public.zentra_us_erp_public_seller_valid(p_seller jsonb,p_organization text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare v_key text; v_value text; v_logo jsonb;
begin
  if jsonb_typeof(p_seller) is distinct from 'object' or not(p_seller ?& array['organizationId','displayName'])
    or p_seller-array['organizationId','displayName','contactEmail','contactPhone','logoRef']<>'{}'::jsonb
    or jsonb_typeof(p_seller->'organizationId') is distinct from 'string' or p_seller->>'organizationId' is distinct from p_organization
    or jsonb_typeof(p_seller->'displayName') is distinct from 'string' then return false; end if;
  v_value:=p_seller->>'displayName';
  if length(v_value) not between 1 and 256 or v_value<>btrim(v_value) or v_value='' or v_value ~ '[[:cntrl:]]' then return false; end if;
  foreach v_key in array array['contactEmail','contactPhone'] loop
    if p_seller ? v_key then
      if jsonb_typeof(p_seller->v_key) is distinct from 'string' then return false; end if;
      v_value:=p_seller->>v_key;
      if length(v_value) not between 1 and (case v_key when 'contactEmail' then 254 else 80 end)
        or v_value<>btrim(v_value) or v_value='' or v_value ~ '[[:cntrl:]]' then return false; end if;
      if v_key='contactEmail' and v_value !~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$' then return false; end if;
    end if;
  end loop;
  if p_seller ? 'logoRef' then
    v_logo:=p_seller->'logoRef';
    if jsonb_typeof(v_logo) is distinct from 'object' or not(v_logo ?& array['assetId','contentSha256'])
      or v_logo-array['assetId','contentSha256']<>'{}'::jsonb
      or jsonb_typeof(v_logo->'assetId') is distinct from 'string' or v_logo->>'assetId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or jsonb_typeof(v_logo->'contentSha256') is distinct from 'string' or v_logo->>'contentSha256' !~ '^[0-9a-f]{64}$' then return false; end if;
  end if;
  return true;
end $$;

-- NOT VALID preserves old US rows, while new inserts/updates require the public
-- archived identity. Old invoices without it remain blocked by the current
-- reader pending an explicit, fact-based administrative migration. No backfill.
alter table public.zentra_us_erp_records add constraint zentra_us_erp_invoice_seller_archive
  check(kind<>'invoice' or public.zentra_us_erp_public_seller_valid(payload->'sellerSnapshot',organization_id)) not valid;

-- The old commit already fixes accounts, periods and exact counters. Add the
-- missing allowlist defense for the small header and its nested structures.
create function public.zentra_us_erp_guard_header_shape() returns trigger
language plpgsql security invoker set search_path='' as $$
declare v_header jsonb:=new.header; v_ledger jsonb; v_item jsonb;
begin
  if jsonb_typeof(v_header) is distinct from 'object' or not(v_header ?& array['schemaVersion','revision','configuration','counters','ledger'])
    or v_header-array['schemaVersion','revision','configuration','counters','ledger']<>'{}'::jsonb
    or jsonb_typeof(v_header->'counters') is distinct from 'object' or not(v_header->'counters' ?& array['estimate','invoice'])
    or (v_header->'counters')-array['estimate','invoice']<>'{}'::jsonb then
    raise exception using errcode='PU004',message='US ERP header shape is not supported';
  end if;
  v_ledger:=v_header->'ledger';
  if jsonb_typeof(v_ledger) is distinct from 'object' or not(v_ledger ?& array['organizationId','currency','basis','revision','accounts','periods'])
    or v_ledger-array['organizationId','currency','basis','revision','accounts','periods']<>'{}'::jsonb
    or jsonb_typeof(v_ledger->'accounts') is distinct from 'array' or jsonb_typeof(v_ledger->'periods') is distinct from 'array' then
    raise exception using errcode='PU004',message='US ERP ledger header shape is not supported';
  end if;
  for v_item in select value from jsonb_array_elements(v_ledger->'accounts') loop
    if jsonb_typeof(v_item) is distinct from 'object' or not(v_item ?& array['id','code','name','type'])
      or v_item-array['id','code','name','type','cash']<>'{}'::jsonb then
      raise exception using errcode='PU004',message='US ERP account shape is not supported';
    end if;
  end loop;
  for v_item in select value from jsonb_array_elements(v_ledger->'periods') loop
    if jsonb_typeof(v_item) is distinct from 'object' or not(v_item ?& array['id','start','end','status'])
      or v_item-array['id','start','end','status']<>'{}'::jsonb then
      raise exception using errcode='PU004',message='US ERP period shape is not supported';
    end if;
  end loop;
  return new;
end $$;
create trigger zentra_us_erp_header_shape before insert or update on public.zentra_us_erp_heads
  for each row execute function public.zentra_us_erp_guard_header_shape();

revoke all on function public.zentra_us_erp_public_seller_valid(jsonb,text),public.zentra_us_erp_guard_header_shape() from public,anon,authenticated;
grant execute on function public.zentra_us_erp_public_seller_valid(jsonb,text) to service_role;
-- Existing validated invoice immutability includes sellerSnapshot and logoRef.
-- Tenant ownership and content of a logo asset are checked by the trusted
-- seller loader; a UUID/hash syntax check is not proof of access to its bytes.
commit;
