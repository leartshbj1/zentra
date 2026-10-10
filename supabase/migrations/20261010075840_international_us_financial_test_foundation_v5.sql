-- PRIVATE LOCAL TEST FOUNDATION ONLY. No public/native ERP schema5, D1 grant,
-- provider write, or financial append is enabled by installing this migration.
-- The DB owner must deliberately provision TEST grants. Append remains closed
-- until a later additive migration supplies independent financial guards.
begin;

create table public.zentra_us_financial_test_grants (
 organization_id text not null references public.zentra_us_erp_heads on delete restrict,
 user_id text not null check(length(user_id) between 1 and 256),
 role text not null check(role in('owner','admin','accountant')),
 version bigint not null check(version between 1 and 9007199254740990),
 enabled boolean not null default false,
 policy jsonb not null,
 primary key(organization_id,user_id)
);
create table public.zentra_us_financial_test_heads (
 organization_id text primary key references public.zentra_us_erp_heads on delete restrict,
 revision bigint not null check(revision between 2 and 9007199254740990),
 baseline jsonb not null,
 baseline_sha256 text not null check(baseline_sha256 ~ '^[a-f0-9]{64}$'),
 policy jsonb not null,
 promotion jsonb not null,
 book_sha256 text not null check(book_sha256 ~ '^[a-f0-9]{64}$'),
 promotion_key text not null check(promotion_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
 promotion_hash text not null check(promotion_hash ~ '^[a-f0-9]{64}$'),
 promotion_receipt jsonb not null,
 grant_version bigint not null check(grant_version between 1 and 9007199254740990)
);
create table public.zentra_us_financial_test_events (
 organization_id text not null references public.zentra_us_financial_test_heads on delete restrict,
 revision bigint not null check(revision between 2 and 9007199254740990),
 payload jsonb not null,
 primary key(organization_id,revision)
);
create table public.zentra_us_financial_test_receipts (
 organization_id text not null references public.zentra_us_financial_test_heads on delete restrict,
 idempotency_key text not null check(length(idempotency_key) between 1 and 240),
 origin text not null check(origin in('legacy_erp4','promotion','financial_v5')),
 actor_id text not null check(length(actor_id) between 1 and 256),
 receipt jsonb not null,
 primary key(organization_id,idempotency_key)
);

create function public.zentra_us_financial_test_hash(v jsonb) returns text
language sql immutable security invoker set search_path='' as $$
 select encode(sha256(convert_to(public.zentra_us_erp_v4_canonical(v),'UTF8')),'hex');
$$;
create function public.zentra_us_financial_test_policy_valid(v jsonb) returns boolean
language sql immutable security invoker set search_path='' as $$
 select coalesce(public.zentra_us_tax_object(v,array['version','environment','approval'])
 and v->>'version'='us-accrual-receivable-credit-v1' and v->>'environment'='test'
 and public.zentra_us_tax_object(v->'approval',array['reference','reviewedBy','reviewedAt'])
 and public.zentra_us_tax_strings(v->'approval',array['reference','reviewedBy','reviewedAt'])
 and public.zentra_us_tax_text_valid(v->'approval'->>'reference',500,true)
 and public.zentra_us_tax_text_valid(v->'approval'->>'reviewedBy',256,true)
 and public.zentra_us_purchase_timestamp(v->'approval'->>'reviewedAt'),false);
$$;
alter table public.zentra_us_financial_test_grants add constraint zentra_financial_test_policy_valid check(public.zentra_us_financial_test_policy_valid(policy));

-- JSONB removes executable prototypes/getters before SQL. These independent
-- conservative transport/node/depth/array bounds do not claim throughput.
create function public.zentra_us_financial_test_budget(v jsonb) returns void
language plpgsql immutable security invoker set search_path='' as $$
declare nodes bigint; deepest integer; widest integer;scalar_bytes bigint;key_bytes bigint;scalar_max integer;key_max integer;
begin
 if v is null or octet_length(v::text)>4194304 then raise exception using errcode='PF012',message='Financial TEST book budget exceeded';end if;
 with recursive walk(value,depth) as (
  select v,0 union all
  select child.value,w.depth+1 from walk w cross join lateral (
   select e.value from jsonb_each(case when jsonb_typeof(w.value)='object' then w.value else '{}'::jsonb end) e
   union all select a.value from jsonb_array_elements(case when jsonb_typeof(w.value)='array' then w.value else '[]'::jsonb end) a
  ) child where w.depth<=20
 ), keys as (select k from walk w cross join lateral jsonb_object_keys(case when jsonb_typeof(w.value)='object' then w.value else '{}'::jsonb end) k)
 select count(*),max(depth),max(case when jsonb_typeof(value)='array' then jsonb_array_length(value) else 0 end),
 coalesce(sum(case when jsonb_typeof(value)='string' then octet_length(value#>>'{}') else 0 end),0),
 coalesce(max(case when jsonb_typeof(value)='string' then octet_length(value#>>'{}') else 0 end),0),
 (select coalesce(sum(octet_length(k)),0) from keys),(select coalesce(max(octet_length(k)),0) from keys)
 into nodes,deepest,widest,scalar_bytes,scalar_max,key_bytes,key_max from walk;
 -- UTF8 bytes >= UTF16 units for valid Unicode. Deliberately stricter than
 -- TS for non-ASCII text, never a claim of exact transport-budget parity.
 if nodes>50000 or deepest>20 or widest>1000 or scalar_max>524288 or key_max>524288 or scalar_bytes+key_bytes>2097152 then raise exception using errcode='PF012',message='Financial TEST book budget exceeded';end if;
end $$;

-- The grant is an authoritative, local TEST row; never an assertion that Auth,
-- D1 membership/subscription revocation is atomic with this transaction.
create function public.zentra_us_financial_test_admit(org text,actor jsonb,grant_version bigint,cap text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare g public.zentra_us_financial_test_grants%rowtype;c public.zentra_workspace_country_configs%rowtype;
begin
 if cap is distinct from 'postgres-test-foundation-v5' or current_setting('transaction_isolation') is distinct from 'read committed' then
  raise exception using errcode='PF009',message='Private READ COMMITTED TEST capability required';end if;
 if org is null or org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
 or not public.zentra_us_tax_object(actor,array['organizationId','userId','role','managementEntitled','timestamp'])
 or not public.zentra_us_tax_strings(actor,array['organizationId','userId','role','timestamp'])
 or actor->>'organizationId' is distinct from org or actor->'managementEntitled' is distinct from 'true'::jsonb
 or actor->>'role' not in('owner','admin','accountant') or not public.zentra_us_tax_text_valid(actor->>'userId',256,true)
 or not public.zentra_us_purchase_timestamp(actor->>'timestamp') then raise exception using errcode='PF005',message='Living financial TEST grant required';end if;
 perform 1 from public.zentra_workspaces where organization_id=org for update;
 if not found then raise exception using errcode='PF005',message='Living financial TEST grant required';end if;
 select * into c from public.zentra_workspace_country_configs where organization_id=org for update;
 if not found or c.country<>'US' or c.currency<>'USD' or c.config->>'accountingBasis'<>'accrual' then
  raise exception using errcode='PF011',message='US accrual TEST policy required';end if;
 perform 1 from public.zentra_us_erp_heads where organization_id=org for update;
 if not found then raise exception using errcode='PF005',message='Living financial TEST grant required';end if;
 select * into g from public.zentra_us_financial_test_grants where organization_id=org and user_id=actor->>'userId' for update;
 if not found or not g.enabled or g.role is distinct from actor->>'role' then raise exception using errcode='PF005',message='Living financial TEST grant required';end if;
 if grant_version is null or g.version<>grant_version then raise exception using errcode='PF006',message='Financial TEST grant version changed';end if;
 if exists(select 1 from public.zentra_us_financial_test_heads h where h.organization_id=org and (h.baseline->'configuration' is distinct from c.config or h.policy is distinct from g.policy)) then
  raise exception using errcode='PF007',message='Financial TEST configuration changed';end if;
 return g.policy;
end $$;

-- No hidden renamed read RPC remains available. Every legacy admission is
-- guarded in place below. A shared workspace lock excludes a promotion while
-- a read completes; writers take the existing exclusive tenant lock first.
create function public.zentra_us_financial_test_require_legacy(org text,writing boolean default false,upgrade_code text default 'PF008') returns void
language plpgsql volatile security invoker set search_path='' as $$
begin
 if writing then perform 1 from public.zentra_workspaces where organization_id=org for update;
 else perform 1 from public.zentra_workspaces where organization_id=org for key share;end if;
 if upgrade_code is null or upgrade_code not in('PF008','PU008','PW008','PS006','PB008','PO005') then raise exception using errcode='PF004',message='Invalid private upgrade guard';end if;
 -- Confirmed CH jurisdiction cannot become US: the existing country row and
 -- append-only change log independently forbid jurisdiction/currency changes.
 -- Keep CH transactions under their existing isolation; unknown/US contexts
 -- still require RC so a lock wait observes the fresh promotion marker.
 if exists(select 1 from public.zentra_workspace_country_configs where organization_id=org and country='CH' and currency='CHF' and config->>'country'='CH' and config->>'currency'='CHF') then return;end if;
 if current_setting('transaction_isolation') is distinct from 'read committed' then raise exception using errcode='PF009',message='Legacy financial admission requires READ COMMITTED';end if;
 if exists(select 1 from public.zentra_us_financial_test_heads where organization_id=org) then raise exception using errcode=upgrade_code,message='Current financial capability required';end if;
end $$;
create function public.zentra_us_financial_test_freeze_legacy() returns trigger
language plpgsql volatile security invoker set search_path='' as $$
begin
 if tg_op='TRUNCATE' then
  -- Whole-table destructive maintenance has no confirmed-CH row to exempt.
  -- Refuse independently of marker visibility: even RC's EXISTS could race a
  -- promotion on a sidecar not otherwise read by the promotion transaction.
  raise exception using errcode='PF003',message='Financial history cannot be truncated';
 end if;
 if tg_op in('UPDATE','DELETE') then perform public.zentra_us_financial_test_require_legacy(old.organization_id,true);end if;
 if tg_op in('INSERT','UPDATE') then perform public.zentra_us_financial_test_require_legacy(new.organization_id,true);end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
create function public.zentra_us_financial_test_grant_guard() returns trigger
language plpgsql volatile security invoker set search_path='' as $$
begin
 -- service_role needs UPDATE privilege for SELECT FOR UPDATE, not authority to
 -- provision itself. Only a database owner/superuser local fixture may mutate.
 if current_user='service_role' or tg_op in('DELETE','TRUNCATE') then raise exception using errcode='PF003',message='TEST grant administration is private';end if;
 if tg_op='UPDATE' and (new.organization_id is distinct from old.organization_id or new.user_id is distinct from old.user_id or new.version<>old.version+1) then
  raise exception using errcode='PF006',message='TEST grant version must advance';end if;
 return new;
end $$;
create trigger zentra_financial_test_grant_guard before insert or update or delete on public.zentra_us_financial_test_grants for each row execute function public.zentra_us_financial_test_grant_guard();
create trigger zentra_financial_test_grant_truncate before truncate on public.zentra_us_financial_test_grants for each statement execute function public.zentra_us_financial_test_grant_guard();

create function public.zentra_us_financial_test_book(h public.zentra_us_financial_test_heads) returns jsonb
language sql immutable security invoker set search_path='' as $$
 select jsonb_build_object('schemaVersion',5,'revision',h.revision,'baseline',h.baseline,'policy',h.policy,'promotion',h.promotion,'events','[]'::jsonb);
$$;
create function public.zentra_us_financial_test_promotion_hash(org text,actor jsonb,book jsonb,key text) returns text
language sql immutable security invoker set search_path='' as $$
 select public.zentra_us_financial_test_hash(jsonb_build_array(org,actor->>'userId',jsonb_build_object('type','promote_financial_book','idempotencyKey',key,'baselineRevision',book->'baseline'->'revision','baselineSha256',book->'promotion'->'baselineSha256','policy',book->'policy')));
$$;

create function public.zentra_us_financial_test_head_guard() returns trigger
language plpgsql volatile security invoker set search_path='' as $$
declare actual jsonb;approved jsonb;book jsonb;expected_receipt jsonb;actor jsonb;
begin
 if tg_op<>'INSERT' then raise exception using errcode='PF003',message='Financial TEST promotion is immutable';end if;
 actor:=new.promotion->'actor';approved:=public.zentra_us_financial_test_admit(new.organization_id,actor,new.grant_version,'postgres-test-foundation-v5');
 if actor->>'role'<>'owner' then raise exception using errcode='PF005',message='Owner TEST grant required for promotion';end if;
 actual:=public.zentra_read_us_erp_v4(new.organization_id);
 if actual is null or actual->'schemaVersion' is distinct from '4'::jsonb or actual->'configuration'->>'accountingBasis'<>'accrual'
 or actual->'ledger'->>'basis'<>'accrual' or actual is distinct from new.baseline
 or (actual->>'revision')::bigint+1<>new.revision then raise exception using errcode='PF001',message='Exact ERP4 baseline revision required';end if;
 if new.policy is distinct from approved or not public.zentra_us_financial_test_policy_valid(new.policy) then raise exception using errcode='PF011',message='Approved TEST policy required';end if;
 if not public.zentra_us_tax_object(new.promotion,array['actor','baselineSha256'])
 or new.promotion->>'baselineSha256' is distinct from new.baseline_sha256 or new.baseline_sha256<>public.zentra_us_financial_test_hash(actual)
 or (actor->>'timestamp')::timestamptz<(new.policy->'approval'->>'reviewedAt')::timestamptz then raise exception using errcode='PF004',message='Invalid TEST promotion provenance';end if;
 if exists(select 1 from jsonb_array_elements(actual->'ledger'->'audit') e where (e->>'timestamp')::timestamptz>(actor->>'timestamp')::timestamptz)
 or exists(select 1 from jsonb_array_elements(actual->'invoices') e where (e->>'issuedAt')::timestamptz>(actor->>'timestamp')::timestamptz) then raise exception using errcode='PF004',message='Invalid TEST promotion chronology';end if;
 book:=public.zentra_us_financial_test_book(new);perform public.zentra_us_financial_test_budget(book);
 if new.book_sha256<>public.zentra_us_financial_test_hash(book) or new.promotion_hash<>public.zentra_us_financial_test_promotion_hash(new.organization_id,actor,book,new.promotion_key) then
  raise exception using errcode='PF004',message='Invalid TEST promotion identity';end if;
 if exists(select 1 from public.zentra_us_erp_receipts r where r.organization_id=new.organization_id and r.idempotency_key=new.promotion_key) then raise exception using errcode='PF002',message='Reserved historical idempotency key';end if;
 expected_receipt:=jsonb_build_object('schemaVersion',1,'organizationId',new.organization_id,'idempotencyKey',new.promotion_key,'commandHash',new.promotion_hash,'revision',new.revision,'baselineRevision',actual->'revision','baselineSha256',new.baseline_sha256,'actorId',actor->>'userId','action','promote_financial_book');
 if new.promotion_receipt is distinct from expected_receipt then raise exception using errcode='PF004',message='Invalid TEST promotion receipt';end if;
 return new;
end $$;
create trigger zentra_financial_test_head_guard before insert or update or delete on public.zentra_us_financial_test_heads for each row execute function public.zentra_us_financial_test_head_guard();

create function public.zentra_us_financial_test_history_guard() returns trigger
language plpgsql volatile security invoker set search_path='' as $$
declare h public.zentra_us_financial_test_heads%rowtype;r public.zentra_us_erp_receipts%rowtype;
begin
 if tg_op<>'INSERT' then raise exception using errcode='PF003',message='Financial TEST history is append-only';end if;
 if tg_table_name='zentra_us_financial_test_events' then raise exception using errcode='PF010',message='Independent financial append guards not installed';end if;
 if new.origin='financial_v5' then raise exception using errcode='PF010',message='Independent financial append guards not installed';end if;
 select * into h from public.zentra_us_financial_test_heads where organization_id=new.organization_id;
 if not found then raise exception using errcode='PF004',message='Financial TEST promotion missing';end if;
 if new.origin='promotion' then
  if new.idempotency_key is distinct from h.promotion_key or new.actor_id is distinct from h.promotion->'actor'->>'userId' or new.receipt is distinct from h.promotion_receipt then raise exception using errcode='PF004',message='Invalid promotion index';end if;
 else
  select * into r from public.zentra_us_erp_receipts where organization_id=new.organization_id and idempotency_key=new.idempotency_key;
  if not found or new.actor_id is distinct from r.actor_id or new.receipt is distinct from r.receipt then raise exception using errcode='PF004',message='Invalid historical receipt index';end if;
 end if;
 return new;
end $$;
create trigger zentra_financial_test_event_guard before insert or update or delete on public.zentra_us_financial_test_events for each row execute function public.zentra_us_financial_test_history_guard();
create trigger zentra_financial_test_receipt_guard before insert or update or delete on public.zentra_us_financial_test_receipts for each row execute function public.zentra_us_financial_test_history_guard();
create trigger zentra_financial_test_head_truncate before truncate on public.zentra_us_financial_test_heads for each statement execute function public.zentra_us_financial_test_history_guard();
create trigger zentra_financial_test_event_truncate before truncate on public.zentra_us_financial_test_events for each statement execute function public.zentra_us_financial_test_history_guard();
create trigger zentra_financial_test_receipt_truncate before truncate on public.zentra_us_financial_test_receipts for each statement execute function public.zentra_us_financial_test_history_guard();

create function public.zentra_us_financial_test_complete() returns trigger
language plpgsql volatile security invoker set search_path='' as $$
declare h public.zentra_us_financial_test_heads%rowtype;org text;
begin
 org:=new.organization_id;select * into h from public.zentra_us_financial_test_heads where organization_id=org;
 if exists(select 1 from public.zentra_us_financial_test_events where organization_id=org)
 or not exists(select 1 from public.zentra_us_financial_test_receipts r where r.organization_id=org and r.idempotency_key=h.promotion_key and r.origin='promotion' and r.receipt=h.promotion_receipt and r.actor_id=h.promotion->'actor'->>'userId')
 or exists(select 1 from public.zentra_us_erp_receipts e where e.organization_id=org and not exists(select 1 from public.zentra_us_financial_test_receipts r where r.organization_id=org and r.idempotency_key=e.idempotency_key and r.origin='legacy_erp4' and r.actor_id=e.actor_id and r.receipt=e.receipt)) then
  raise exception using errcode='PF004',message='Complete immutable promotion receipt index required';end if;
 return null;
end $$;
create constraint trigger zentra_financial_test_complete after insert on public.zentra_us_financial_test_heads deferrable initially deferred for each row execute function public.zentra_us_financial_test_complete();

create function public.zentra_read_us_financial_test_v5(p_organization text,p_actor jsonb,p_grant_version bigint,p_capability text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare h public.zentra_us_financial_test_heads%rowtype;book jsonb;
begin
 perform public.zentra_us_financial_test_admit(p_organization,p_actor,p_grant_version,p_capability);
 select * into h from public.zentra_us_financial_test_heads where organization_id=p_organization for update;
 if not found then return null;end if;book:=public.zentra_us_financial_test_book(h);
 if h.book_sha256<>public.zentra_us_financial_test_hash(book) or exists(select 1 from public.zentra_us_financial_test_events where organization_id=p_organization) then raise exception using errcode='PF004',message='Invalid financial TEST book';end if;
 return book;
end $$;
create function public.zentra_us_financial_test_receipt_v5(p_organization text,p_actor jsonb,p_grant_version bigint,p_capability text,p_idempotency_key text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare r public.zentra_us_financial_test_receipts%rowtype;
begin
 perform public.zentra_us_financial_test_admit(p_organization,p_actor,p_grant_version,p_capability);
 if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 240 then raise exception using errcode='PF004',message='Invalid financial TEST receipt key';end if;
 select * into r from public.zentra_us_financial_test_receipts where organization_id=p_organization and idempotency_key=p_idempotency_key;
 if not found then return null;end if;
 return jsonb_build_object('origin',r.origin,'actorId',r.actor_id,'receipt',r.receipt);
end $$;
create function public.zentra_promote_us_financial_test_v5(p_organization text,p_actor jsonb,p_grant_version bigint,p_capability text,p_book jsonb,p_idempotency_key text,p_command_hash text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare h public.zentra_us_financial_test_heads%rowtype;approved jsonb;receipt jsonb;fingerprint text;baseline_hash text;
begin
 approved:=public.zentra_us_financial_test_admit(p_organization,p_actor,p_grant_version,p_capability);
 if p_actor->>'role'<>'owner' then raise exception using errcode='PF005',message='Owner TEST grant required for promotion';end if;
 perform public.zentra_us_financial_test_budget(p_book);
 if not public.zentra_us_tax_object(p_book,array['schemaVersion','revision','baseline','policy','promotion','events'])
 or p_book->'schemaVersion' is distinct from '5'::jsonb or p_book->'events' is distinct from '[]'::jsonb
 or p_book->'policy' is distinct from approved or p_book->'promotion'->'actor' is distinct from p_actor
 or p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
 or p_command_hash is null or p_command_hash !~ '^[a-f0-9]{64}$'
 or p_command_hash<>public.zentra_us_financial_test_promotion_hash(p_organization,p_actor,p_book,p_idempotency_key) then raise exception using errcode='PF004',message='Invalid exact TEST promotion';end if;
 fingerprint:=public.zentra_us_financial_test_hash(p_book);
 select * into h from public.zentra_us_financial_test_heads where organization_id=p_organization for update;
 if found then
  if h.promotion_key is distinct from p_idempotency_key or h.promotion_hash is distinct from p_command_hash or h.book_sha256 is distinct from fingerprint or public.zentra_us_financial_test_book(h) is distinct from p_book then raise exception using errcode='PF002',message='Financial TEST promotion conflict';end if;
  return jsonb_build_object('book',p_book,'receipt',h.promotion_receipt,'replayed',true);
 end if;
 if not public.zentra_us_tax_revision(p_book->'revision') or not public.zentra_us_tax_revision(p_book->'baseline'->'revision') then raise exception using errcode='PF004',message='Invalid financial TEST revision';end if;
 baseline_hash:=p_book->'promotion'->>'baselineSha256';
 receipt:=jsonb_build_object('schemaVersion',1,'organizationId',p_organization,'idempotencyKey',p_idempotency_key,'commandHash',p_command_hash,'revision',p_book->'revision','baselineRevision',p_book->'baseline'->'revision','baselineSha256',baseline_hash,'actorId',p_actor->>'userId','action','promote_financial_book');
 insert into public.zentra_us_financial_test_heads values(p_organization,(p_book->>'revision')::bigint,p_book->'baseline',baseline_hash,p_book->'policy',p_book->'promotion',fingerprint,p_idempotency_key,p_command_hash,receipt,p_grant_version);
 insert into public.zentra_us_financial_test_receipts select p_organization,idempotency_key,'legacy_erp4',actor_id,r.receipt from public.zentra_us_erp_receipts r where r.organization_id=p_organization;
 insert into public.zentra_us_financial_test_receipts values(p_organization,p_idempotency_key,'promotion',p_actor->>'userId',receipt);
 return jsonb_build_object('book',p_book,'receipt',receipt,'replayed',false);
end $$;
create function public.zentra_append_us_financial_test_v5(p_organization text,p_actor jsonb,p_grant_version bigint,p_capability text,p_expected_revision bigint,p_previous_fingerprint text,p_book jsonb,p_receipt jsonb) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
begin
 perform public.zentra_us_financial_test_admit(p_organization,p_actor,p_grant_version,p_capability);
 raise exception using errcode='PF010',message='Independent financial append guards not installed';
end $$;

-- Guard real existing functions in place, preserving their signatures/defaults
-- and body, rather than leaving an unguarded renamed RPC. All names below are
-- explicit and validated; unsupported language/shape aborts the migration.
do $$ declare f record;body text;guard text;names text[]:=array[
 'zentra_read_us_erp','zentra_read_us_erp_v2','zentra_read_us_erp_v3','zentra_read_us_erp_v4',
 'zentra_us_erp_receipt','zentra_us_erp_receipt_v2','zentra_us_erp_receipt_v3','zentra_us_erp_receipt_v4',
 'zentra_us_erp_revision','zentra_us_erp_revision_v2','zentra_us_erp_revision_v3','zentra_us_erp_revision_v4',
 'zentra_us_erp_delta','zentra_us_erp_delta_v2','zentra_us_erp_delta_v3','zentra_us_erp_delta_v4',
 'zentra_commit_us_erp','zentra_us_supplier_scope','zentra_us_supplier_document_workspace','zentra_us_bank_scope','zentra_us_sales_order_admit',
 'zentra_lock_us_tax_context','zentra_us_tax_preparation_capability','zentra_read_us_tax_operation','zentra_us_workspace_sync_heads',
 'zentra_us_sales_order_invoice','zentra_us_supplier_document_projection','zentra_read_us_tax_merchant_context','zentra_activate_us_tax_test_merchant',
 'zentra_read_us_seller_profile','zentra_put_us_seller_profile','zentra_read_us_tax_profile','zentra_put_us_tax_profile'];
begin
 if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any(names))<>cardinality(names) then raise exception 'Exact financial foundation prerequisites required';end if;
 for f in select p.*,l.lanname from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang where n.nspname='public' and p.proname=any(names) loop
  if f.proargnames[1] not in('org','p_organization') then raise exception 'Unsupported financial admission argument';end if;
  guard:=format('perform public.zentra_us_financial_test_require_legacy(%I,%s,%L);',f.proargnames[1],case when f.proname in('zentra_commit_us_erp','zentra_us_supplier_scope','zentra_us_supplier_document_workspace','zentra_us_bank_scope','zentra_us_sales_order_admit','zentra_lock_us_tax_context','zentra_us_tax_preparation_capability','zentra_activate_us_tax_test_merchant','zentra_put_us_seller_profile','zentra_put_us_tax_profile') then 'true' else 'false' end,
   case when f.proname='zentra_us_workspace_sync_heads' then 'PW008' when f.proname in('zentra_us_supplier_scope','zentra_us_supplier_document_workspace') then 'PS006' when f.proname='zentra_us_bank_scope' then 'PB008' when f.proname='zentra_us_sales_order_admit' then 'PO005' else 'PU008' end);
  if f.lanname='plpgsql' and f.prosrc ~* '\mbegin\M' then body:=regexp_replace(f.prosrc,'\mbegin\M','begin '||guard,'i');
  elsif f.lanname='sql' and f.prorettype='jsonb'::regtype then body:='begin '||guard||' return ('||regexp_replace(btrim(f.prosrc),';\s*$','')||'); end;';
  else raise exception 'Unsupported financial admission body';end if;
  execute format('create or replace function public.%I(%s) returns %s language plpgsql volatile security invoker set search_path='''' as %L',f.proname,pg_get_function_arguments(f.oid),pg_get_function_result(f.oid),body);
 end loop;
end $$;

-- One marker freezes legacy core/config and the source-dependent sidecars.
-- History is preserved in place; no frozen legacy projection is called current.
do $$ declare name text;names text[]:=array[
 'zentra_us_erp_heads','zentra_us_erp_records','zentra_us_erp_receipts','zentra_us_erp_ledger_audit','zentra_us_erp_streams','zentra_us_erp_events','zentra_us_erp_wakeups',
 'zentra_workspaces','zentra_workspace_country_configs','zentra_workspace_country_config_changes',
 'zentra_us_seller_profiles','zentra_us_seller_profile_changes','zentra_us_tax_profiles','zentra_us_tax_profile_changes',
 'zentra_us_supplier_proposals','zentra_us_supplier_audit','zentra_us_supplier_documents','zentra_us_supplier_document_receipts','zentra_us_supplier_document_links',
 'zentra_us_bank_reconciliations','zentra_us_bank_receipts','zentra_us_bank_audit','zentra_us_bank_entry_claims',
 'zentra_us_sales_order_heads','zentra_us_sales_orders','zentra_us_sales_order_receipts','zentra_us_sales_order_audit',
 'zentra_us_tax_provider_bindings','zentra_us_tax_provider_binding_changes','zentra_us_tax_operations','zentra_us_tax_invoice_links','zentra_us_tax_invoice_preparations','zentra_us_tax_prepared_operation_links','zentra_us_tax_merchant_admissions',
 'zentra_us_automation_settings','zentra_us_automation_settings_changes','zentra_us_analysis_periods','zentra_us_analysis_jobs','zentra_us_analysis_audit','zentra_us_workspace_change_heads'];
begin
 foreach name in array names loop
  if to_regclass('public.'||name) is null then raise exception 'Financial source table prerequisite missing: %',name;end if;
  execute format('create trigger aa_financial_test_freeze before insert or update or delete on public.%I for each row execute function public.zentra_us_financial_test_freeze_legacy()',name);
  execute format('create trigger aa_financial_test_no_truncate before truncate on public.%I for each statement execute function public.zentra_us_financial_test_freeze_legacy()',name);
 end loop;
end $$;

do $$ declare name text;f record;
begin
 foreach name in array array['zentra_us_financial_test_grants','zentra_us_financial_test_heads','zentra_us_financial_test_events','zentra_us_financial_test_receipts'] loop
  execute format('alter table public.%I enable row level security',name);
  execute format('revoke all on table public.%I from public,anon,authenticated,service_role',name);
  execute format('grant select,insert,update on table public.%I to service_role',name);
  execute format('create policy zentra_financial_test_server on public.%I for all to service_role using(true) with check(true)',name);
 end loop;
 -- No INSERT privilege to grant administration. UPDATE permits row locks only;
 -- the trigger denies actual service_role mutations independently.
 revoke insert on public.zentra_us_financial_test_grants from service_role;
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'zentra_us_financial_test_%' or p.proname in('zentra_read_us_financial_test_v5','zentra_promote_us_financial_test_v5','zentra_append_us_financial_test_v5')) loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
-- The pre-existing NOLOGIN admission owner runs the new row triggers while it
-- creates a fresh workspace. It may inspect the marker's organization column,
-- never its private book, grant or receipts. Its existing workspace lock grant
-- remains sufficient; no membership or new SECURITY DEFINER path is added.
grant select(organization_id) on public.zentra_us_financial_test_heads to zentra_us_admission_owner;
create policy zentra_financial_test_admission_marker on public.zentra_us_financial_test_heads for select to zentra_us_admission_owner using(true);
grant execute on function public.zentra_us_financial_test_require_legacy(text,boolean,text),public.zentra_us_financial_test_freeze_legacy() to zentra_us_admission_owner;
commit;
