-- LOCAL ONLY: run after the proposed migration on an isolated PostgreSQL /
-- PGlite fixture. The runner supplies zentra_workspaces and Supabase roles.
-- No customer records or credentials. All fixtures roll back at the end.
begin;
create temporary table international_country_test_results (name text primary key);
create function pg_temp.country_assert(p_name text, p_pass boolean)
returns void language plpgsql as $$
begin
  if p_pass is distinct from true then raise exception 'Test failed: %', p_name; end if;
  insert into international_country_test_results(name) values(p_name);
end
$$;
create function pg_temp.country_expect_error(p_statement text, p_state text)
returns boolean language plpgsql as $$
declare v_state text;
begin
  begin
    execute p_statement;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> p_state then raise exception 'Expected SQLSTATE %, got %', p_state, v_state; end if;
    return true;
  end;
  raise exception 'Expected SQLSTATE %, operation succeeded', p_state;
end
$$;
create temporary table international_country_fixture (config jsonb);
insert into international_country_fixture values ('{
  "schemaVersion":1,"organizationId":"international-test-org-a","country":"US","currency":"USD","language":"en","timeZone":"America/New_York",
  "address":{"country":"US","line1":"10 Example Road","postalCode":"10001","city":"New York","subdivision":"NY"},
  "accountingBasis":"cash","invoiceNumberPrefix":"INV","taxConfiguration":{"status":"unconfigured"}
}'::jsonb);

select pg_temp.country_assert('01_no_backfill', not exists(select 1 from public.zentra_workspace_country_configs));
select pg_temp.country_assert('02_rls_enabled', (select count(*) = 2 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('zentra_workspace_country_configs','zentra_workspace_country_config_changes') and c.relrowsecurity));
select pg_temp.country_assert('03_anon_denied', not has_table_privilege('anon','public.zentra_workspace_country_configs','SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('anon','public.zentra_workspace_country_config_changes','SELECT,INSERT,UPDATE,DELETE') and not has_function_privilege('anon','public.zentra_put_workspace_country_config(text,text,bigint,uuid,jsonb)','EXECUTE'));
select pg_temp.country_assert('04_authenticated_denied', not has_table_privilege('authenticated','public.zentra_workspace_country_configs','SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('authenticated','public.zentra_workspace_country_config_changes','SELECT,INSERT,UPDATE,DELETE') and not has_function_privilege('authenticated','public.zentra_put_workspace_country_config(text,text,bigint,uuid,jsonb)','EXECUTE'));
select pg_temp.country_assert('05_service_invoker_minimum', has_table_privilege('service_role','public.zentra_workspace_country_configs','SELECT,INSERT,UPDATE') and has_table_privilege('service_role','public.zentra_workspace_country_config_changes','SELECT,INSERT') and not has_table_privilege('service_role','public.zentra_workspace_country_config_changes','UPDATE,DELETE,TRUNCATE') and has_function_privilege('service_role','public.zentra_put_workspace_country_config(text,text,bigint,uuid,jsonb)','EXECUTE') and not (select prosecdef from pg_proc where oid='public.zentra_put_workspace_country_config(text,text,bigint,uuid,jsonb)'::regprocedure));

do $$
declare v_denied boolean := false;
begin
  set local role anon;
  begin perform public.zentra_put_workspace_country_config('international-test-org-a','actor',0,'10000000-0000-4000-8000-000000000001','{}'::jsonb); exception when insufficient_privilege then v_denied := true; end;
  reset role;
  perform pg_temp.country_assert('06_anon_rpc_execution_denied', v_denied);
end
$$;
do $$
declare v_denied boolean := false;
begin
  set local role authenticated;
  begin perform public.zentra_put_workspace_country_config('international-test-org-a','actor',0,'10000000-0000-4000-8000-000000000001','{}'::jsonb); exception when insufficient_privilege then v_denied := true; end;
  reset role;
  perform pg_temp.country_assert('07_authenticated_rpc_execution_denied', v_denied);
end
$$;

select pg_temp.country_assert('08_missing_workspace_not_created', pg_temp.country_expect_error(format('select public.zentra_put_workspace_country_config(%L,%L,0,%L,%L::jsonb)', 'international-test-org-a','actor-a','10000000-0000-4000-8000-000000000001',(select config from international_country_fixture)), 'PZ004'));
-- The harness stub needs only this key. A reconciled full schema should use its
-- own workspace fixture creator instead of this minimal fixture statement.
insert into public.zentra_workspaces(organization_id) values ('international-test-org-a'),('international-test-org-b');
select pg_temp.country_assert('09_cross_organization_rejected', pg_temp.country_expect_error(format('select public.zentra_put_workspace_country_config(%L,%L,0,%L,%L::jsonb)', 'international-test-org-b','actor-a','10000000-0000-4000-8000-000000000001',(select config from international_country_fixture)), '22023'));
select pg_temp.country_assert('10_invalid_config_rejected', pg_temp.country_expect_error(format('select public.zentra_put_workspace_country_config(%L,%L,0,%L,%L::jsonb)', 'international-test-org-a','actor-a','10000000-0000-4000-8000-000000000001',(select jsonb_set(config,'{currency}','"CHF"') from international_country_fixture)), '22023') and not public.zentra_country_config_valid((select config || '{"role":"owner"}'::jsonb from international_country_fixture),'international-test-org-a') and not public.zentra_country_config_valid((select jsonb_set(config,'{address,subdivision}','"ZZ"') from international_country_fixture),'international-test-org-a'));

-- Exercise the actual least-privileged invoker role, not postgres ownership.
grant select on international_country_fixture to service_role;
set local role service_role;
select public.zentra_put_workspace_country_config('international-test-org-a','actor-a',0,'10000000-0000-4000-8000-000000000001',(select config from international_country_fixture));
reset role;
select pg_temp.country_assert('11_initial_write_atomic', (select count(*)=1 from public.zentra_workspace_country_configs where organization_id='international-test-org-a' and revision=1 and country='US' and currency='USD') and (select count(*)=1 from public.zentra_workspace_country_config_changes where organization_id='international-test-org-a' and revision=1 and previous_revision=0 and previous_config is null));
select pg_temp.country_assert('12_exact_retry_is_durable', (public.zentra_put_workspace_country_config('international-test-org-a','actor-a',0,'10000000-0000-4000-8000-000000000001',(select config from international_country_fixture))->>'replayed')::boolean and (select count(*)=1 from public.zentra_workspace_country_config_changes));
select pg_temp.country_assert('13_reused_id_refused', pg_temp.country_expect_error(format('select public.zentra_put_workspace_country_config(%L,%L,0,%L,%L::jsonb)', 'international-test-org-a','actor-b','10000000-0000-4000-8000-000000000001',(select config from international_country_fixture)), 'PZ002'));
select pg_temp.country_assert('14_stale_cas_has_no_side_effect', pg_temp.country_expect_error(format('select public.zentra_put_workspace_country_config(%L,%L,0,%L,%L::jsonb)', 'international-test-org-a','actor-a','10000000-0000-4000-8000-000000000002',(select config from international_country_fixture)), 'PZ001') and (select count(*)=1 from public.zentra_workspace_country_config_changes));

do $$
declare v_ch jsonb; v_basis jsonb;
begin
  select config || '{"country":"CH","currency":"CHF","timeZone":"Europe/Zurich","address":{"country":"CH","line1":"10 Rue Exemple","postalCode":"1201","city":"Geneve","subdivision":"GE"}}'::jsonb into v_ch from international_country_fixture;
  select jsonb_set(config,'{accountingBasis}','"accrual"') into v_basis from international_country_fixture;
  perform pg_temp.country_assert('15_jurisdiction_and_basis_locked',
    pg_temp.country_expect_error(format('select public.zentra_put_workspace_country_config(%L,%L,1,%L,%L::jsonb)','international-test-org-a','actor-a','10000000-0000-4000-8000-000000000002',v_ch),'PZ003')
    and pg_temp.country_expect_error(format('select public.zentra_put_workspace_country_config(%L,%L,1,%L,%L::jsonb)','international-test-org-a','actor-a','10000000-0000-4000-8000-000000000002',v_basis),'PZ003')
    and (select count(*)=1 from public.zentra_workspace_country_config_changes));
end
$$;
select public.zentra_put_workspace_country_config('international-test-org-a','actor-a',1,'10000000-0000-4000-8000-000000000002',(select jsonb_set(config,'{invoiceNumberPrefix}','"NEW"') from international_country_fixture));
select pg_temp.country_assert('16_edit_audited_and_old_retry_preserved', (select revision=2 and config->>'invoiceNumberPrefix'='NEW' from public.zentra_workspace_country_configs where organization_id='international-test-org-a') and (select count(*)=2 from public.zentra_workspace_country_config_changes) and public.zentra_put_workspace_country_config('international-test-org-a','actor-a',0,'10000000-0000-4000-8000-000000000001',(select config from international_country_fixture))->>'revision'='1');
select pg_temp.country_assert('17_history_append_only_and_receipt_required', pg_temp.country_expect_error('update public.zentra_workspace_country_config_changes set changed_by=''different'' where organization_id=''international-test-org-a''','PZ005') and pg_temp.country_expect_error('delete from public.zentra_workspace_country_config_changes where organization_id=''international-test-org-a''','PZ005') and pg_temp.country_expect_error('update public.zentra_workspace_country_configs set revision=3 where organization_id=''international-test-org-a''','PZ005') and pg_temp.country_expect_error('delete from public.zentra_workspace_country_configs where organization_id=''international-test-org-a''','PZ003'));

select name, true as passed from international_country_test_results order by name;
do $$ begin if (select count(*) from international_country_test_results) <> 17 then raise exception 'Expected 17 country SQL assertions'; end if; end $$;
rollback;
