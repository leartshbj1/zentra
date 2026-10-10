-- PRIVATE LOCAL TEST PILOT ONLY. Browser DTO1 is not public ERP5. This adds no
-- grant, opt-in, promotion, hosted data or merchant effect automatically.
begin;

create table public.zentra_us_financial_pilot_test_opt_ins (
 organization_id text primary key references public.zentra_us_financial_test_heads on delete restrict,
 version bigint not null check(version between 1 and 9007199254740990),
 enabled boolean not null default false
);
create function public.zentra_us_financial_pilot_test_opt_in_guard() returns trigger
language plpgsql volatile security invoker set search_path='' as $$
begin
 if current_user is distinct from (select pg_get_userbyid(relowner) from pg_class where oid='public.zentra_us_financial_pilot_test_opt_ins'::regclass)
 or tg_op not in('INSERT','UPDATE') then raise exception using errcode='PF003',message='DB-owner TEST pilot administration required';end if;
 if tg_op='UPDATE' and (new.organization_id is distinct from old.organization_id or new.version<>old.version+1) then raise exception using errcode='PF006',message='Exact TEST pilot version advancement required';end if;
 -- Administrative callers should lock workspace before UPDATE as well. PG
 -- may safely abort a conflicting lock order; no distributed fence is claimed.
 perform 1 from public.zentra_workspaces where organization_id=new.organization_id for update;
 return new;
end $$;
create trigger zentra_financial_pilot_opt_in_guard before insert or update or delete on public.zentra_us_financial_pilot_test_opt_ins for each row execute function public.zentra_us_financial_pilot_test_opt_in_guard();
create trigger zentra_financial_pilot_opt_in_truncate before truncate on public.zentra_us_financial_pilot_test_opt_ins for each statement execute function public.zentra_us_financial_pilot_test_opt_in_guard();

create function public.zentra_us_financial_pilot_test_admit(org text,a jsonb,v bigint,opt_in_version bigint,cap text) returns void
language plpgsql volatile security invoker set search_path='' as $$
declare o public.zentra_us_financial_pilot_test_opt_ins%rowtype;
begin
 if cap is distinct from 'postgres-test-financial-pilot-dto1' then raise exception using errcode='PF009',message='Private TEST financial pilot capability required';end if;
 -- Same authoritative workspace -> country -> ERP4 head -> grant lock order.
 -- Existing admission compares identity, role, enabled grant/version, policy
 -- and exact frozen country configuration before any private result is served.
 perform public.zentra_us_invoicing_admit(org,a,v,'postgres-test-invoicing-v5');
 select * into o from public.zentra_us_financial_pilot_test_opt_ins where organization_id=org for update;
 if not found or not o.enabled then raise exception using errcode='PF005',message='Living TEST pilot opt-in required';end if;
 if opt_in_version is null or o.version<>opt_in_version then raise exception using errcode='PF006',message='TEST pilot opt-in version changed';end if;
end $$;

-- Initial capture has both expected versions NULL. Every subsequent read,
-- receipt, append and head pins both versions. No actor/grant comes from a
-- browser request: this invoker RPC is available only to the private server.
create function public.zentra_us_financial_pilot_test_scope_v1(p_organization text,p_actor jsonb,p_capability text,p_expected_grant_version bigint,p_expected_opt_in_version bigint) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare g public.zentra_us_financial_test_grants%rowtype;o public.zentra_us_financial_pilot_test_opt_ins%rowtype;
begin
 if (p_expected_grant_version is null) is distinct from (p_expected_opt_in_version is null) then raise exception using errcode='PF004',message='Paired expected pilot versions required';end if;
 -- This first lookup supplies a version, never authority. Admission below
 -- locks/rechecks the authoritative grant and policy after any lock wait.
 select * into g from public.zentra_us_financial_test_grants where organization_id=p_organization and user_id=p_actor->>'userId';
 if not found then raise exception using errcode='PF005',message='Living financial TEST grant required';end if;
 perform public.zentra_us_invoicing_admit(p_organization,p_actor,coalesce(p_expected_grant_version,g.version),'postgres-test-invoicing-v5');
 select * into o from public.zentra_us_financial_pilot_test_opt_ins where organization_id=p_organization for update;
 if not found then raise exception using errcode='PF005',message='Living TEST pilot opt-in required';end if;
 perform public.zentra_us_financial_pilot_test_admit(p_organization,p_actor,coalesce(p_expected_grant_version,g.version),coalesce(p_expected_opt_in_version,o.version),p_capability);
 -- Re-read under retained grant lock: the unlocked preliminary snapshot is
 -- not used as the returned role/policy/version authority.
 select * into g from public.zentra_us_financial_test_grants where organization_id=p_organization and user_id=p_actor->>'userId';
 return jsonb_build_object('scope',jsonb_build_object('organizationId',p_organization,'actor',p_actor,'policy',g.policy,'grantVersion',g.version),'optInVersion',o.version);
end $$;

create function public.zentra_us_financial_pilot_test_head_v1(p_organization text,p_actor jsonb,p_grant_version bigint,p_opt_in_version bigint,p_capability text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare r bigint;
begin
 perform public.zentra_us_financial_pilot_test_admit(p_organization,p_actor,p_grant_version,p_opt_in_version,p_capability);
 select revision into r from public.zentra_us_financial_test_cursors where organization_id=p_organization for update;
 if not found then raise exception using errcode='PF004',message='Promoted financial cursor required';end if;
 -- Deliberately no book aggregation, replay, hash, ledger or financial totals.
 return jsonb_build_object('consumer','financial-pilot','schemaVersion',1,'organizationId',p_organization,'revision',r);
end $$;

-- The pilot opt-in is checked and locked in the SAME transaction as these
-- existing independent book RPCs, including historical receipts/replays.
-- Auth/D1 checks remain separate pre/post fences in the HTTP server.
create function public.zentra_read_us_financial_pilot_test_v1(p_organization text,p_actor jsonb,p_grant_version bigint,p_opt_in_version bigint,p_capability text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
begin
 perform public.zentra_us_financial_pilot_test_admit(p_organization,p_actor,p_grant_version,p_opt_in_version,p_capability);
 return public.zentra_read_us_financial_invoicing_test_v5(p_organization,p_actor,p_grant_version,'postgres-test-invoicing-v5');
end $$;
create function public.zentra_us_financial_pilot_test_receipt_v1(p_organization text,p_actor jsonb,p_grant_version bigint,p_opt_in_version bigint,p_capability text,p_idempotency_key text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
begin
 perform public.zentra_us_financial_pilot_test_admit(p_organization,p_actor,p_grant_version,p_opt_in_version,p_capability);
 return public.zentra_us_financial_invoicing_test_receipt_v5(p_organization,p_actor,p_grant_version,'postgres-test-invoicing-v5',p_idempotency_key);
end $$;
create function public.zentra_append_us_financial_pilot_test_v1(p_organization text,p_actor jsonb,p_grant_version bigint,p_opt_in_version bigint,p_capability text,p_expected_revision bigint,p_previous_fingerprint text,p_book jsonb,p_receipt jsonb) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
begin
 perform public.zentra_us_financial_pilot_test_admit(p_organization,p_actor,p_grant_version,p_opt_in_version,p_capability);
 return public.zentra_append_us_financial_invoicing_test_v5(p_organization,p_actor,p_grant_version,'postgres-test-invoicing-v5',p_expected_revision,p_previous_fingerprint,p_book,p_receipt);
end $$;

alter table public.zentra_us_financial_pilot_test_opt_ins enable row level security;
revoke all on public.zentra_us_financial_pilot_test_opt_ins from public,anon,authenticated,service_role;
-- UPDATE is needed by SELECT FOR UPDATE, not permission to administer opt-in.
-- The trigger independently refuses all service-role INSERT/UPDATE/DELETE.
grant select,update on public.zentra_us_financial_pilot_test_opt_ins to service_role;
create policy zentra_financial_pilot_private_server on public.zentra_us_financial_pilot_test_opt_ins for all to service_role using(true) with check(true);
do $$declare f record;begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('zentra_us_financial_pilot_test_opt_in_guard','zentra_us_financial_pilot_test_admit','zentra_us_financial_pilot_test_scope_v1','zentra_us_financial_pilot_test_head_v1','zentra_read_us_financial_pilot_test_v1','zentra_us_financial_pilot_test_receipt_v1','zentra_append_us_financial_pilot_test_v1') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
commit;
