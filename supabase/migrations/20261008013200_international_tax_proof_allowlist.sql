-- Additive boundary for stored public tax evidence. Never rewrite old invoices,
-- receipts or cursor events to hide a raw provider response. Staging/local only
-- until explicit production approval and an administrative historical review.
begin;

do $$ begin
  if pg_catalog.to_regclass('public.zentra_us_erp_records') is null then
    raise exception 'US ERP persistence schema required before tax proof validation';
  end if;
end $$;

create function public.zentra_us_erp_tax_proof_valid(p_proof jsonb,p_organization text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare v_key text; v_line jsonb;
begin
  if jsonb_typeof(p_proof) is distinct from 'object'
    or not(p_proof ?& array['organizationId','country','currency','documentId','documentRevision','fingerprint','source','providerReference','determinedAt','validUntil','lines'])
    or p_proof-array['organizationId','country','currency','documentId','documentRevision','fingerprint','source','providerReference','determinedAt','validUntil','lines']<>'{}'::jsonb then
    return false;
  end if;
  foreach v_key in array array['organizationId','country','currency','documentId','fingerprint','source','providerReference','determinedAt','validUntil'] loop
    if jsonb_typeof(p_proof->v_key) is distinct from 'string' then return false; end if;
  end loop;
  if p_organization is null or p_proof->>'organizationId' is distinct from p_organization
    or p_proof->>'country' is distinct from 'US' or p_proof->>'currency' is distinct from 'USD'
    or p_proof->>'source' not in ('external-provider','documented-exemption')
    or jsonb_typeof(p_proof->'documentRevision') is distinct from 'number'
    or p_proof->>'documentRevision' !~ '^[1-9][0-9]{0,15}$'
    or (p_proof->>'documentRevision')::numeric>9007199254740991
    or jsonb_typeof(p_proof->'lines') is distinct from 'array' then return false; end if;
  if jsonb_array_length(p_proof->'lines') not between 1 and 1000 then return false; end if;
  for v_line in select value from jsonb_array_elements(p_proof->'lines') loop
    if jsonb_typeof(v_line) is distinct from 'object'
      or not(v_line ?& array['id','taxMinor','jurisdiction','evidenceReference'])
      or v_line-array['id','taxMinor','jurisdiction','evidenceReference']<>'{}'::jsonb then return false; end if;
    foreach v_key in array array['id','taxMinor','jurisdiction','evidenceReference'] loop
      if jsonb_typeof(v_line->v_key) is distinct from 'string' then return false; end if;
    end loop;
    if v_line->>'taxMinor' !~ '^(0|[1-9][0-9]{0,35})$' then return false; end if;
  end loop;
  return true;
exception when others then return false;
end $$;

-- NOT VALID deliberately preserves historical raw objects byte-for-byte. The
-- constraint still applies to new inserts and updates, including appended
-- payments on a historical invalid invoice. Those records require explicit
-- review; no fabricated proof, silent sanitization or historical backfill.
alter table public.zentra_us_erp_records add constraint zentra_us_erp_invoice_tax_proof_allowlist
  check(kind<>'invoice' or public.zentra_us_erp_tax_proof_valid(payload->'taxAssessment',organization_id)) not valid;

revoke all on function public.zentra_us_erp_tax_proof_valid(jsonb,text) from public,anon,authenticated;
grant execute on function public.zentra_us_erp_tax_proof_valid(jsonb,text) to service_role;
comment on function public.zentra_us_erp_tax_proof_valid(jsonb,text) is 'Shape of public US tax evidence only. Does not determine nexus, rates, exemptions or trust in a tax provider.';
comment on constraint zentra_us_erp_invoice_tax_proof_allowlist on public.zentra_us_erp_records is 'New public proofs use exact fields; old raw invoice evidence is preserved pending review. Not a fiscal certification.';
commit;
