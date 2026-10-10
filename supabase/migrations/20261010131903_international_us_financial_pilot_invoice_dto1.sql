-- Private local TEST DTO1 invoice preparation. These invoker wrappers retain
-- the existing V5 fiscal tables, immutable evidence and authoritative guards.
-- The living pilot opt-in is locked in the SAME transaction as every fiscal
-- operation. No automatic opt-in, context, grant, promotion or provider call.
begin;

create function public.zentra_us_financial_pilot_invoice_test_context_v1(p_organization text,p_actor jsonb,p_grant_version bigint,p_opt_in_version bigint,p_capability text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
begin
 perform public.zentra_us_financial_pilot_test_admit(p_organization,p_actor,p_grant_version,p_opt_in_version,p_capability);
 return public.zentra_us_invoicing_context(p_organization);
end $$;

create function public.zentra_read_us_financial_pilot_invoice_test_operation_v1(p_organization text,p_actor jsonb,p_grant_version bigint,p_opt_in_version bigint,p_capability text,p_idempotency_key text,p_financial_command_hash text,p_erp_command_hash text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
begin
 perform public.zentra_us_financial_pilot_test_admit(p_organization,p_actor,p_grant_version,p_opt_in_version,p_capability);
 return public.zentra_read_us_financial_invoice_test_operation_v5(p_organization,p_actor,p_grant_version,'postgres-test-invoicing-v5',p_idempotency_key,p_financial_command_hash,p_erp_command_hash);
end $$;

create function public.zentra_preflight_us_financial_pilot_invoice_test_v1(p_organization text,p_actor jsonb,p_grant_version bigint,p_opt_in_version bigint,p_capability text,p_request jsonb,p_financial_command_hash text,p_erp_command_hash text,p_previous_fingerprint text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
begin
 perform public.zentra_us_financial_pilot_test_admit(p_organization,p_actor,p_grant_version,p_opt_in_version,p_capability);
 return public.zentra_preflight_us_financial_invoice_test_v5(p_organization,p_actor,p_grant_version,'postgres-test-invoicing-v5',p_request,p_financial_command_hash,p_erp_command_hash,p_previous_fingerprint);
end $$;

create function public.zentra_reserve_us_financial_pilot_invoice_test_v1(p_organization text,p_actor jsonb,p_grant_version bigint,p_opt_in_version bigint,p_capability text,p_preparation jsonb,p_resolved_body text,p_resolved_sha256 text,p_params_body text,p_params_sha256 text,p_provider_idempotency_key text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
begin
 perform public.zentra_us_financial_pilot_test_admit(p_organization,p_actor,p_grant_version,p_opt_in_version,p_capability);
 return public.zentra_reserve_us_financial_invoice_test_v5(p_organization,p_actor,p_grant_version,'postgres-test-invoicing-v5',p_preparation,p_resolved_body,p_resolved_sha256,p_params_body,p_params_sha256,p_provider_idempotency_key);
end $$;

create function public.zentra_record_us_financial_pilot_invoice_test_calculation_v1(p_organization text,p_actor jsonb,p_grant_version bigint,p_opt_in_version bigint,p_capability text,p_operation_id uuid,p_proof_body text,p_proof_sha256 text,p_assessment jsonb) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
begin
 perform public.zentra_us_financial_pilot_test_admit(p_organization,p_actor,p_grant_version,p_opt_in_version,p_capability);
 return public.zentra_record_us_financial_invoice_test_calculation_v5(p_organization,p_actor,p_grant_version,'postgres-test-invoicing-v5',p_operation_id,p_proof_body,p_proof_sha256,p_assessment);
end $$;

do $$declare f record;begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('zentra_us_financial_pilot_invoice_test_context_v1','zentra_read_us_financial_pilot_invoice_test_operation_v1','zentra_preflight_us_financial_pilot_invoice_test_v1','zentra_reserve_us_financial_pilot_invoice_test_v1','zentra_record_us_financial_pilot_invoice_test_calculation_v1') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
commit;
