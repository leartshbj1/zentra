-- Local H2b recovery port only. No data backfill, table, policy or hosted apply.
-- Includes uncompleted reservations: an ACK-lost reserve must be recoverable.
begin;
create function public.zentra_find_us_supplier_document_by_sha256(
  p_organization text,p_actor jsonb,p_supported_schema_version integer,p_content_sha256 text
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_id uuid;
begin
  perform public.zentra_us_supplier_scope(p_organization,p_actor,p_supported_schema_version);
  if p_content_sha256 is null or p_content_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception using errcode='PD001',message='invalid supplier document digest';
  end if;
  select id into v_id from public.zentra_us_supplier_documents
    where organization_id=p_organization and content_sha256=p_content_sha256;
  if not found then return null; end if;
  return public.zentra_us_supplier_document_projection(p_organization,v_id);
end $$;
revoke all on function public.zentra_find_us_supplier_document_by_sha256(text,jsonb,integer,text) from public,anon,authenticated,service_role;
grant execute on function public.zentra_find_us_supplier_document_by_sha256(text,jsonb,integer,text) to service_role;
commit;
