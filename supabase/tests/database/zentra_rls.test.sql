begin;

create extension if not exists pgtap with schema extensions;
select plan(44);

select ok(to_regclass('public.organizations') is not null, 'organizations exists');
select ok(to_regclass('public.organization_members') is not null, 'memberships exist');
select ok(to_regclass('public.invoice_archives') is not null, 'invoice archives exist');
select ok(to_regclass('public.organization_domains') is not null, 'custom domains exist');

select is(
  (select relrowsecurity from pg_class where oid = 'public.organizations'::regclass),
  true,
  'organizations has RLS enabled'
);
select is(
  (select relrowsecurity from pg_class where oid = 'public.organization_members'::regclass),
  true,
  'memberships has RLS enabled'
);
select is(
  (select relrowsecurity from pg_class where oid = 'public.invoice_archives'::regclass),
  true,
  'invoice archives has RLS enabled'
);
select is(
  (select relrowsecurity from pg_class where oid = 'storage.objects'::regclass),
  true,
  'storage objects has RLS enabled'
);
select is(
  (select public from storage.buckets where id = 'zentra-invoice-archives'),
  false,
  'invoice archive bucket is private'
);
select is(
  (
    select count(*)::integer
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'zentra_invoice_archives_read_member'
      and cmd = 'SELECT'
  ),
  1,
  'storage archive read policy exists exactly once'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'owner@zentra.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'reader@zentra.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'outsider@zentra.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'accountant@zentra.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'member@zentra.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000006', 'authenticated', 'authenticated', 'other-owner@zentra.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.subscriptions (
  subscription_id, customer_id, price_id, status, current_period_end,
  entitlement_valid_until
) values
  (
    'sub_rls_contract', 'cus_rls_contract', 'price_rls_contract', 'active',
    now() + interval '30 days', now() + interval '30 days'
  ),
  (
    'sub_rls_contract_other', 'cus_rls_contract_other', 'price_rls_contract', 'active',
    now() + interval '30 days', now() + interval '30 days'
  );

insert into public.organizations (
  organization_id, name, subscription_id, created_by_user_id
) values
  (
    'org_20000000-0000-4000-8000-000000000001',
    'Entreprise de test transactionnel',
    'sub_rls_contract',
    '10000000-0000-4000-8000-000000000001'
  ),
  (
    'org_20000000-0000-4000-8000-000000000002',
    'Entreprise étrangère au tenant',
    'sub_rls_contract_other',
    '10000000-0000-4000-8000-000000000006'
  );

insert into public.organization_members (
  membership_id, organization_id, user_id, email, role
) values
  ('mem_30000000-0000-4000-8000-000000000001', 'org_20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'owner@zentra.test', 'owner'),
  ('mem_30000000-0000-4000-8000-000000000002', 'org_20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'reader@zentra.test', 'read_only'),
  ('mem_30000000-0000-4000-8000-000000000003', 'org_20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000004', 'accountant@zentra.test', 'accountant'),
  ('mem_30000000-0000-4000-8000-000000000004', 'org_20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000005', 'member@zentra.test', 'member'),
  ('mem_30000000-0000-4000-8000-000000000005', 'org_20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000006', 'other-owner@zentra.test', 'owner');

insert into public.license_activations (
  license_id, subscription_id, installation_id
) values (
  'lic_rls_contract', 'sub_rls_contract', '40000000-0000-4000-8000-000000000001'
);

insert into public.device_sessions (
  session_id, token_hash, organization_id, user_id, installation_id, expires_at
) values
  (
    'dss_50000000-0000-4000-8000-000000000001',
    decode(repeat('11', 32), 'hex'),
    'org_20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    now() + interval '30 days'
  ),
  (
    'dss_50000000-0000-4000-8000-000000000002',
    decode(repeat('22', 32), 'hex'),
    'org_20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000006',
    '40000000-0000-4000-8000-000000000002',
    now() + interval '30 days'
  );

insert into public.invoice_archives (
  archive_id, organization_id, source_invoice_id, revision, invoice_number,
  issue_date, fiscal_year_end, correction_kind, object_key, content_sha256, size_bytes,
  previous_chain_sha256, chain_sha256, retention_until,
  stored_by_session_id, storage_status
) values
  (
    'arc_60000000-0000-4000-8000-000000000001',
    'org_20000000-0000-4000-8000-000000000001',
    'invoice-local-1', 1, 'F-2026-001', date '2026-09-02', date '2026-12-31', 'initial',
    'organizations/org_20000000-0000-4000-8000-000000000001/invoices/source/revision-0001-hash.pdf',
    repeat('a', 64), 128, null, repeat('b', 64), date '2036-12-31',
    'dss_50000000-0000-4000-8000-000000000001', 'pending'
  ),
  (
    'arc_60000000-0000-4000-8000-000000000002',
    'org_20000000-0000-4000-8000-000000000002',
    'invoice-foreign-1', 1, 'F-EXT-2026-001', date '2026-09-02', date '2027-03-31', 'initial',
    'organizations/org_20000000-0000-4000-8000-000000000002/invoices/source/revision-0001-hash.pdf',
    repeat('c', 64), 256, null, repeat('d', 64), date '2037-03-31',
    'dss_50000000-0000-4000-8000-000000000002', 'stored'
  );

insert into storage.objects (bucket_id, name, metadata) values
  (
    'zentra-invoice-archives',
    'organizations/org_20000000-0000-4000-8000-000000000001/invoices/source/revision-0001-hash.pdf',
    '{}'::jsonb
  ),
  (
    'zentra-invoice-archives',
    'organizations/org_20000000-0000-4000-8000-000000000002/invoices/source/revision-0001-hash.pdf',
    '{}'::jsonb
  ),
  (
    'zentra-invoice-archives',
    'misc/org_20000000-0000-4000-8000-000000000001/invoices/not-visible.pdf',
    '{}'::jsonb
  );

select lives_ok(
  $$update public.invoice_archives set storage_status = 'stored'
    where archive_id = 'arc_60000000-0000-4000-8000-000000000001'$$,
  'pending archive can be finalized exactly once'
);

select throws_ok(
  $$update public.invoice_archives set invoice_number = 'ALTERED'
    where archive_id = 'arc_60000000-0000-4000-8000-000000000001'$$,
  '55000',
  'stored invoice archive metadata is immutable',
  'stored archive metadata cannot be changed'
);

select throws_ok(
  $$delete from public.invoice_archives
    where archive_id = 'arc_60000000-0000-4000-8000-000000000001'$$,
  '55000',
  'stored invoice archives cannot be deleted',
  'stored archive cannot be deleted'
);

select throws_ok(
  $$update public.organization_members set role = 'admin'
    where membership_id = 'mem_30000000-0000-4000-8000-000000000001'$$,
  '23514',
  'an organization must keep an active owner',
  'last owner cannot be demoted'
);

select throws_ok(
  $$insert into public.invoice_archives (
      archive_id, organization_id, source_invoice_id, revision, invoice_number,
      issue_date, fiscal_year_end, correction_kind, object_key, content_sha256,
      size_bytes, previous_chain_sha256, chain_sha256, retention_until,
      stored_by_session_id, storage_status
    ) values (
      'arc_60000000-0000-4000-8000-000000000003',
      'org_20000000-0000-4000-8000-000000000001',
      'invoice-retention-too-short', 1, 'F-2026-RET',
      date '2026-09-02', date '2026-12-31', 'initial',
      'organizations/org_20000000-0000-4000-8000-000000000001/invoices/retention/too-short.pdf',
      repeat('e', 64), 128, null, repeat('f', 64), date '2036-09-02',
      'dss_50000000-0000-4000-8000-000000000001', 'pending'
    )$$,
  '23514',
  null,
  'retention cannot end ten years after issue date instead of fiscal year end'
);

select throws_ok(
  $$insert into public.invoice_archives (
      archive_id, organization_id, source_invoice_id, revision, invoice_number,
      issue_date, fiscal_year_end, correction_kind, object_key, content_sha256,
      size_bytes, previous_chain_sha256, chain_sha256, retention_until,
      stored_by_session_id, storage_status
    ) values (
      'arc_60000000-0000-4000-8000-000000000004',
      'org_20000000-0000-4000-8000-000000000001',
      'invoice-fiscal-end-too-far', 1, 'F-2026-LATE',
      date '2026-01-01', date '2027-08-01', 'initial',
      'organizations/org_20000000-0000-4000-8000-000000000001/invoices/retention/too-far.pdf',
      repeat('1', 64), 128, null, repeat('2', 64), date '2037-08-01',
      'dss_50000000-0000-4000-8000-000000000001', 'pending'
    )$$,
  '23514',
  null,
  'fiscal year end cannot be more than eighteen months after issue date'
);

select is(
  (
    select retention_until
    from public.invoice_archives
    where archive_id = 'arc_60000000-0000-4000-8000-000000000002'
  ),
  date '2037-03-31',
  'custom fiscal year keeps the archive until exactly ten years after its end'
);

select lives_ok(
  $$insert into public.invoice_archives (
      archive_id, organization_id, source_invoice_id, revision, invoice_number,
      issue_date, fiscal_year_end, correction_kind, object_key, content_sha256,
      size_bytes, previous_chain_sha256, chain_sha256, retention_until,
      stored_by_session_id, storage_status
    ) values (
      'arc_60000000-0000-4000-8000-000000000005',
      'org_20000000-0000-4000-8000-000000000001',
      'invoice-leap-fiscal-end', 1, 'F-2024-LEAP',
      date '2024-01-01', date '2024-02-29', 'initial',
      'organizations/org_20000000-0000-4000-8000-000000000001/invoices/retention/leap.pdf',
      repeat('3', 64), 128, null, repeat('4', 64), date '2034-02-28',
      'dss_50000000-0000-4000-8000-000000000001', 'pending'
    )$$,
  'leap-day fiscal year end uses the same clamped calendar rule as the server'
);

delete from public.invoice_archives
where archive_id = 'arc_60000000-0000-4000-8000-000000000005';

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);

select is(
  (select count(*)::integer from public.organizations),
  1,
  'owner sees own organization'
);
select is(
  (select count(*)::integer from public.organization_members),
  4,
  'owner sees organization member directory'
);
select is(
  (select count(*)::integer from public.invoice_archives),
  1,
  'owner sees own archive metadata'
);
select is(
  (select count(*)::integer from storage.objects where bucket_id = 'zentra-invoice-archives'),
  1,
  'owner sees only archive objects under own organization path'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000004', true);

select is(
  (select count(*)::integer from public.organizations),
  1,
  'accountant sees only own organization'
);
select is(
  (select count(*)::integer from public.organization_members),
  4,
  'accountant sees only own organization member directory'
);
select is(
  (select count(*)::integer from public.invoice_archives),
  1,
  'accountant sees only own archive metadata'
);
select is(
  (select count(*)::integer from storage.objects where bucket_id = 'zentra-invoice-archives'),
  1,
  'accountant sees only own archive objects'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000005', true);

select is(
  (select count(*)::integer from public.organizations),
  1,
  'member sees only own organization'
);
select is(
  (select count(*)::integer from public.organization_members),
  4,
  'member sees only own organization member directory'
);
select is(
  (select count(*)::integer from public.invoice_archives),
  1,
  'member sees only own archive metadata'
);
select is(
  (select count(*)::integer from storage.objects where bucket_id = 'zentra-invoice-archives'),
  1,
  'member sees only own archive objects'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values (
      'zentra-invoice-archives',
      'organizations/org_20000000-0000-4000-8000-000000000001/invoices/forbidden.pdf'
    )$$,
  '42501',
  null,
  'member cannot write directly to archive storage'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);

select is(
  (select count(*)::integer from public.organizations),
  1,
  'read-only collaborator can read own organization'
);
select is(
  (select count(*)::integer from public.invoice_archives),
  1,
  'read-only collaborator sees only own archive metadata'
);
select is(
  (select count(*)::integer from storage.objects where bucket_id = 'zentra-invoice-archives'),
  1,
  'read-only collaborator sees only own archive objects'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000006', true);

select is(
  (select count(*)::integer from public.organizations),
  1,
  'second organization owner sees only the second organization'
);
select is(
  (select count(*)::integer from public.organization_members),
  1,
  'second organization owner sees only its member directory'
);
select is(
  (select count(*)::integer from public.invoice_archives),
  1,
  'second organization owner sees only its archive metadata'
);
select is(
  (select count(*)::integer from storage.objects where bucket_id = 'zentra-invoice-archives'),
  1,
  'second organization owner sees only its archive objects'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000003', true);

select is(
  (select count(*)::integer from public.organizations),
  0,
  'non-member sees no organization'
);
select is(
  (select count(*)::integer from public.organization_members),
  0,
  'non-member sees no memberships'
);
select is(
  (select count(*)::integer from public.invoice_archives),
  0,
  'non-member sees no archives'
);
select is(
  (select count(*)::integer from storage.objects where bucket_id = 'zentra-invoice-archives'),
  0,
  'non-member sees no archive objects'
);

reset role;
set local role anon;

select throws_ok(
  $$select * from public.organizations$$,
  '42501',
  null,
  'anonymous visitors cannot read organizations'
);
select is(
  (select count(*)::integer from storage.objects where bucket_id = 'zentra-invoice-archives'),
  0,
  'anonymous visitors see no archive objects'
);

reset role;
select * from finish();
rollback;
