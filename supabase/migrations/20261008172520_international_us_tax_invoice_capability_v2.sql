-- Additive private TEST issuer capability fence. No tax provider is enabled,
-- no historical migration/row is rewritten, and no CH scope is admitted.
-- p_supported_schema_version is captured by the trusted server store factory;
-- a caller-supplied HTTP header is not a credential, entitlement or tax grant.
create function public.zentra_commit_us_tax_invoice_test_v2(
  p_organization text,p_operation_id uuid,p_expected_revision bigint,p_header jsonb,
  p_changes jsonb,p_ledger_audit jsonb,p_receipt jsonb,p_actor jsonb,
  p_supported_schema_version integer
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare o public.zentra_us_tax_operations%rowtype;r jsonb;h jsonb;e jsonb;head_version integer;candidate_version integer;j jsonb;line_fingerprints jsonb;fingerprint jsonb;
begin
  if not coalesce(public.zentra_us_tax_actor_valid(p_actor,p_organization),false) then
    raise exception using errcode='PX007',message='Trusted financial authority required';
  end if;
  if not coalesce(p_supported_schema_version in (1,2,3,4),false)
    or not coalesce(p_header->'schemaVersion' in ('1'::jsonb,'2'::jsonb,'3'::jsonb,'4'::jsonb),false) then
    raise exception using errcode='PU008',message='Trusted US ERP capability required';
  end if;
  perform public.zentra_lock_us_tax_context(p_organization);
  -- Same organization/configuration lock order as the historical tax commit,
  -- followed by the current book lock. Check capability BEFORE any receipt.
  select header into h from public.zentra_us_erp_heads where organization_id=p_organization for update;
  if not found then raise exception using errcode='PX003',message='US tax book unavailable';end if;
  head_version:=(h->>'schemaVersion')::integer;
  candidate_version:=(p_header->>'schemaVersion')::integer;
  if head_version not in (1,2,3,4) or head_version>p_supported_schema_version
    or candidate_version>p_supported_schema_version then
    raise exception using errcode='PU008',message='US ERP capability required before fiscal replay';
  end if;
  select * into o from public.zentra_us_tax_operations where organization_id=p_organization and operation_id=p_operation_id for update;
  if not found then raise exception using errcode='PX003',message='Tax operation unavailable';end if;
  if o.actor_id is distinct from p_actor->>'userId' or o.erp_idempotency_key is distinct from p_receipt->>'idempotencyKey'
    or o.command_hash is distinct from p_receipt->>'commandHash' or p_receipt->>'action' is distinct from 'issue_invoice'
    or p_receipt->>'entityId' is distinct from o.invoice_id or p_expected_revision is distinct from o.expected_erp_revision then
    raise exception using errcode='PX002',message='Invoice operation identifier conflict';
  end if;
  if o.status='committed' then
    -- ErpReceipt has no schemaVersion. Recover the original schema only from
    -- the append-only event correlated to this exact committed receipt. A book
    -- may have been promoted since issuance; that does not rewrite its history
    -- or permit a caller to forge a lower schema for an original schema4 commit.
    select event into e from public.zentra_us_erp_events
      where organization_id=p_organization and revision=(o.receipt->>'revision')::bigint;
    if e is null or not coalesce(e->'header'->'schemaVersion' in ('1'::jsonb,'2'::jsonb,'3'::jsonb,'4'::jsonb),false)
      or e->'schemaVersion' is distinct from e->'header'->'schemaVersion'
      or e->'receipt' is distinct from o.receipt
      or p_header->'schemaVersion' is distinct from e->'header'->'schemaVersion' then
      raise exception using errcode='PU008',message='Original fiscal receipt schema required';
    end if;
    perform public.zentra_assert_us_tax_completed(p_organization,p_operation_id);
    return o.receipt;
  end if;
  if candidate_version<head_version then
    raise exception using errcode='PU008',message='Current US ERP schema required before fiscal mutation';
  end if;
  if o.status<>'calculated' then raise exception using errcode='PX003',message='Calculated TEST proof required';end if;
  perform public.zentra_assert_us_tax_operation_snapshot(o);
  if candidate_version=4 then
    -- Reconstruct the shared journalFingerprint array exactly, including line
    -- order and null optional values. Semantic JSON equality is insufficient:
    -- a pretty-printed/private forged string would poison future book reads.
    for j in select value->'payload' from jsonb_array_elements(p_changes) where value->>'kind'='journal' loop
      if j->'source' is distinct from jsonb_build_object('type','customer_invoice','id',o.invoice_id) then
        raise exception using errcode='PU004',message='Invoice journal source does not match its private proof';
      end if;
      select jsonb_agg(jsonb_build_array(l->>'accountId',l->>'debitMinor',l->>'creditMinor',l->>'description') order by n)
        into line_fingerprints from jsonb_array_elements(j->'lines') with ordinality a(l,n);
      fingerprint:=jsonb_build_array(p_organization,'USD',j->>'basis',j->>'transactionDate',j->>'accountingDate',
        j->>'paymentDate',j->>'periodId',j->>'description',j->'source'->>'type',j->'source'->>'id',
        j->>'cashFlowCategory',j->>'reversesEntryId',line_fingerprints);
      if jsonb_typeof(j->'fingerprint') is distinct from 'string'
        or j->>'fingerprint' is distinct from public.zentra_us_erp_v4_canonical(fingerprint) then
        raise exception using errcode='PU004',message='Exact invoice journal fingerprint required';
      end if;
    end loop;
  end if;
  insert into public.zentra_us_tax_invoice_links(organization_id,invoice_id,operation_id,erp_idempotency_key,command_hash,erp_revision)
    values(p_organization,o.invoice_id,p_operation_id,o.erp_idempotency_key,o.command_hash,o.expected_erp_revision+1);
  r:=public.zentra_commit_us_erp(p_organization,p_expected_revision,p_header,p_changes,p_ledger_audit,p_receipt,p_actor);
  update public.zentra_us_tax_operations set status='committed',receipt=r,committed_at=clock_timestamp()
    where organization_id=p_organization and operation_id=p_operation_id;
  return r;
end $$;

-- The old eight-argument entry point can declare no protected capability4.
-- Preserve its books1..3 behavior through a fixed legacy ceiling3 instead of
-- deriving a new authority from candidate_version or upgrading stored grants.
create or replace function public.zentra_commit_us_tax_invoice_test(
  p_organization text,p_operation_id uuid,p_expected_revision bigint,p_header jsonb,
  p_changes jsonb,p_ledger_audit jsonb,p_receipt jsonb,p_actor jsonb
) returns jsonb language sql security invoker set search_path='' as $$
  select public.zentra_commit_us_tax_invoice_test_v2(p_organization,p_operation_id,p_expected_revision,p_header,p_changes,p_ledger_audit,p_receipt,p_actor,3);
$$;

revoke all on function public.zentra_commit_us_tax_invoice_test_v2(text,uuid,bigint,jsonb,jsonb,jsonb,jsonb,jsonb,integer) from public,anon,authenticated;
grant execute on function public.zentra_commit_us_tax_invoice_test_v2(text,uuid,bigint,jsonb,jsonb,jsonb,jsonb,jsonb,integer) to service_role;
revoke all on function public.zentra_commit_us_tax_invoice_test(text,uuid,bigint,jsonb,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.zentra_commit_us_tax_invoice_test(text,uuid,bigint,jsonb,jsonb,jsonb,jsonb,jsonb) to service_role;
comment on function public.zentra_commit_us_tax_invoice_test_v2(text,uuid,bigint,jsonb,jsonb,jsonb,jsonb,jsonb,integer) is
  'Private atomic TEST issuer with trusted captured ERP capability checked before historical replay. Fresh US device/browser Auth/D1 role, entitlement and capability admission around every awaited phase remains mandatory at the server boundary.';
comment on function public.zentra_commit_us_tax_invoice_test(text,uuid,bigint,jsonb,jsonb,jsonb,jsonb,jsonb) is
  'Historical private TEST issuer wrapper with fixed legacy ceiling3. Never admits a schema4 book, candidate or receipt.';
