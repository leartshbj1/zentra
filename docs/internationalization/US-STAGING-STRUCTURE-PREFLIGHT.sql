-- Read-only STRUCTURAL inventory, safe before the US tables exist.
-- Reads PostgreSQL catalogues only: no customer rows, secrets or RPC invocation.
-- Absence is reported, never converted into an instruction to replay a baseline.
-- Reconcile actual definitions/owners/grants and migration history separately.
begin read only;

with expected(name, scope) as (
  values
    ('zentra_company_profiles', 'legacy'),
    ('zentra_workspaces', 'legacy'),
    ('zentra_workspace_snapshots', 'legacy'),
    ('zentra_workspace_chunks', 'legacy'),
    ('zentra_workspace_number_reservations', 'legacy'),
    ('zentra_workspace_content_parts', 'legacy'),
    ('zentra_workspace_content_blobs', 'legacy'),
    ('zentra_workspace_country_configs', 'international'),
    ('zentra_workspace_country_config_changes', 'international'),
    ('zentra_us_erp_heads', 'international'),
    ('zentra_us_erp_records', 'international'),
    ('zentra_us_erp_receipts', 'international'),
    ('zentra_us_erp_ledger_audit', 'international'),
    ('zentra_us_erp_streams', 'international'),
    ('zentra_us_erp_events', 'international'),
    ('zentra_us_erp_wakeups', 'international'),
    ('zentra_workspace_us_admissions', 'international'),
    ('zentra_us_seller_profiles', 'international'),
    ('zentra_us_seller_profile_changes', 'international'),
    ('zentra_us_tax_profiles', 'international'),
    ('zentra_us_tax_profile_changes', 'international'),
    ('zentra_us_tax_provider_bindings', 'international'),
    ('zentra_us_tax_provider_binding_changes', 'international'),
    ('zentra_us_tax_operations', 'international'),
    ('zentra_us_tax_invoice_links', 'international'),
    ('zentra_us_bank_reconciliations', 'international'),
    ('zentra_us_bank_receipts', 'international'),
    ('zentra_us_bank_audit', 'international'),
    ('zentra_us_bank_entry_claims', 'international'),
    ('zentra_us_supplier_proposals', 'international'),
    ('zentra_us_supplier_audit', 'international'),
    ('zentra_us_automation_settings', 'international'),
    ('zentra_us_automation_settings_changes', 'international'),
    ('zentra_us_analysis_periods', 'international'),
    ('zentra_us_analysis_jobs', 'international'),
    ('zentra_us_analysis_audit', 'international'),
    ('zentra_us_workspace_change_heads', 'international'),
    ('zentra_us_tax_merchant_admissions', 'international'),
    ('zentra_us_tax_invoice_preparations', 'international'),
    ('zentra_us_tax_prepared_operation_links', 'international')
), table_inventory as (
  select e.name, e.scope, c.oid,
    jsonb_build_object(
      'name', e.name, 'scope', e.scope, 'exists', c.oid is not null,
      'rls', c.relrowsecurity, 'forceRls', c.relforcerowsecurity,
      'owner', pg_get_userbyid(c.relowner), 'acl', c.relacl::text,
      'columns', (select jsonb_agg(jsonb_build_object(
        'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
        'notNull', a.attnotnull, 'default', pg_get_expr(d.adbin, d.adrelid)
      ) order by a.attnum)
        from pg_attribute a left join pg_attrdef d
          on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped),
      'constraints', (select jsonb_agg(jsonb_build_object(
        'name', k.conname, 'type', k.contype, 'validated', k.convalidated,
        'definition', pg_get_constraintdef(k.oid)
      ) order by k.conname) from pg_constraint k where k.conrelid = c.oid),
      'policies', (select jsonb_agg(jsonb_build_object(
        'name', p.polname, 'command', p.polcmd, 'roles', p.polroles,
        'using', pg_get_expr(p.polqual, p.polrelid),
        'withCheck', pg_get_expr(p.polwithcheck, p.polrelid)
      ) order by p.polname) from pg_policy p where p.polrelid = c.oid),
      'triggers', (select jsonb_agg(jsonb_build_object(
        'name', t.tgname, 'enabled', t.tgenabled,
        'definition', pg_get_triggerdef(t.oid)
      ) order by t.tgname) from pg_trigger t
        where t.tgrelid = c.oid and not t.tgisinternal)
    ) as metadata
  from expected e
  left join pg_namespace n on n.nspname = 'public'
  left join pg_class c on c.relnamespace = n.oid and c.relname = e.name and c.relkind = 'r'
), function_inventory as (
  select jsonb_build_object(
    'schema', n.nspname, 'name', p.proname,
    'identityArguments', pg_get_function_identity_arguments(p.oid),
    'result', pg_get_function_result(p.oid),
    'owner', pg_get_userbyid(p.proowner), 'securityDefiner', p.prosecdef,
    'config', p.proconfig, 'acl', p.proacl::text,
    'definitionMd5', md5(pg_get_functiondef(p.oid)),
    'bodyMd5', md5(p.prosrc)
  ) as metadata
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'zentra_admission_private')
    and (p.proname = any(array[
      'zentra_commit_workspace', 'zentra_reserve_workspace_numbers',
      'zentra_prepare_content', 'zentra_reserve_content_blob',
      'zentra_claim_content_cleanup', 'rls_auto_enable',
      'zentra_admit_new_us_workspace_v1', 'admit_new_us_workspace_v1'
    ]) or p.proname like 'zentra_%')
    and p.prokind in ('f', 'p')
)
select jsonb_build_object(
  'serverVersion', current_setting('server_version'),
  'tables', (select jsonb_agg(metadata order by scope, name) from table_inventory),
  'functions', (select jsonb_agg(metadata order by metadata->>'schema', metadata->>'name') from function_inventory),
  'privateAdmissionSchemaExists', exists(select 1 from pg_namespace where nspname = 'zentra_admission_private'),
  'schemas', (select jsonb_agg(jsonb_build_object(
    'name', n.nspname, 'owner', pg_get_userbyid(n.nspowner), 'acl', n.nspacl::text
  ) order by n.nspname) from pg_namespace n
    where n.nspname in ('public', 'zentra_admission_private')),
  'privateAdmissionRole', (select jsonb_build_object(
    'name', rolname, 'login', rolcanlogin, 'superuser', rolsuper, 'bypassRls', rolbypassrls,
    'inherit', rolinherit, 'createRole', rolcreaterole, 'createDb', rolcreatedb, 'replication', rolreplication,
    'members', (select jsonb_agg(pg_get_userbyid(m.member) order by m.member)
      from pg_auth_members m where m.roleid = r.oid),
    'memberOf', (select jsonb_agg(pg_get_userbyid(m.roleid) order by m.roleid)
      from pg_auth_members m where m.member = r.oid)
  ) from pg_roles r where rolname = 'zentra_us_admission_owner'),
  'eventTriggers', (select jsonb_agg(jsonb_build_object(
    'name', e.evtname, 'event', e.evtevent, 'enabled', e.evtenabled,
    'function', e.evtfoid::regprocedure::text
  ) order by e.evtname) from pg_event_trigger e),
  'publications', (select jsonb_agg(jsonb_build_object(
    'publication', p.pubname, 'allTables', p.puballtables
  ) order by p.pubname) from pg_publication p),
  'publishedExpectedTables', (select jsonb_agg(jsonb_build_object(
    'publication', p.pubname, 'schema', p.schemaname, 'table', p.tablename
  ) order by p.pubname, p.tablename) from pg_publication_tables p
    where p.schemaname = 'public' and p.tablename in (select name from expected)),
  'migrationHistoryTableExists', to_regclass('supabase_migrations.schema_migrations') is not null
) as metadata;

rollback;
