-- Additive TEST-only private calculation registry. Auth/D1 and fresh Stripe
-- observations remain trusted server responsibilities. Declared owner facts do
-- not install a provider, change taxConfiguration or confer any financial right.
begin;
do $$ begin
  if pg_catalog.to_regclass('public.zentra_us_tax_profiles') is null
    or pg_catalog.to_regclass('public.zentra_us_seller_profiles') is null
    or pg_catalog.to_regclass('public.zentra_us_erp_receipts') is null then
    raise exception 'US country, seller, facts and ERP dependencies required';
  end if;
end $$;

create function public.zentra_us_tax_object(p jsonb,required text[],optional text[] default array[]::text[]) returns boolean
language sql immutable security invoker set search_path='' as $$
  select coalesce(jsonb_typeof(p)='object' and p ?& required and p-(required||optional)='{}'::jsonb,false);
$$;
create function public.zentra_us_tax_safe_integer(p jsonb,minimum bigint default 0) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
begin return coalesce(jsonb_typeof(p)='number' and p::text ~ '^(0|[1-9][0-9]{0,15})$' and p::text::numeric between minimum and 9007199254740991,false);
exception when others then return false;end $$;
create function public.zentra_us_tax_revision(p jsonb,minimum bigint default 1) returns boolean
language sql immutable security invoker set search_path='' as $$
  select coalesce(public.zentra_us_tax_safe_integer(p,minimum) and p::text::numeric<9007199254740991,false);
$$;
create function public.zentra_us_tax_amount(p jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
begin return coalesce(jsonb_typeof(p)='string' and p#>>'{}' ~ '^(0|[1-9][0-9]{0,15})$' and (p#>>'{}')::numeric<=9007199254740991,false);
exception when others then return false;end $$;
create function public.zentra_us_tax_strings(p jsonb,keys text[]) returns boolean
language sql immutable security invoker set search_path='' as $$
  select not exists(select 1 from pg_catalog.unnest(keys) k where jsonb_typeof(p->k) is distinct from 'string');
$$;
-- Match the TypeScript UTF16 body bound; UTF8 bytes are a separate conservative
-- cap. A non-BMP scalar counts as two UTF16 units, never as one user character.
create function public.zentra_us_tax_body_valid(p text) returns boolean
language sql immutable security invoker set search_path='' as $$
  select coalesce(octet_length(p)<=2097152 and length(p)+length(regexp_replace(p COLLATE pg_catalog."C",'[^'||chr(65536)||'-'||chr(1114111)||']','','g'))<=524288,false);
$$;
create function public.zentra_us_tax_instant(p text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare v timestamptz;
begin
  if p is null or p !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' then return false;end if;
  v:=p::timestamptz;return isfinite(v) and v>=timestamptz '0001-01-01 00:00:00+00' and v<timestamptz '10000-01-01 00:00:00+00';
exception when others then return false;end $$;
create function public.zentra_us_tax_binding_valid(p jsonb,org text,rev bigint) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
begin
  return coalesce(public.zentra_us_tax_object(p,array['organizationId','accountId','mode','apiVersion','revision','settingsSha256','registrationsSha256','observedAt','validUntil','evidenceKind','scope'])
    and public.zentra_us_tax_strings(p,array['organizationId','accountId','mode','apiVersion','settingsSha256','registrationsSha256','observedAt','validUntil','evidenceKind','scope'])
    and p->>'organizationId'=org and p->>'mode'='test' and p->>'scope'='erp_invoice_tax' and p->>'apiVersion'='2026-08-26.dahlia'
    and jsonb_typeof(p->'accountId')='string' and p->>'accountId' ~ '^acct_[A-Za-z0-9]{1,95}$'
    and public.zentra_us_tax_revision(p->'revision') and (p->>'revision')::bigint=rev
    and p->>'settingsSha256' ~ '^[0-9a-f]{64}$' and p->>'registrationsSha256' ~ '^[0-9a-f]{64}$'
    and p->>'evidenceKind' in ('test_fixture','provider_observation')
    and public.zentra_us_tax_instant(p->>'observedAt') and public.zentra_us_tax_instant(p->>'validUntil')
    and (p->>'validUntil')::timestamptz>(p->>'observedAt')::timestamptz,false);
exception when others then return false;end $$;

create table public.zentra_us_tax_provider_bindings(
  organization_id text primary key references public.zentra_workspace_country_configs(organization_id) on delete restrict,
  revision bigint not null check(revision between 1 and 9007199254740990),
  snapshot jsonb not null check(public.zentra_us_tax_binding_valid(snapshot,organization_id,revision)),
  updated_by text not null check(public.zentra_us_tax_text_valid(updated_by,256,false)),
  updated_at timestamptz not null check(isfinite(updated_at) and updated_at>=timestamptz '0001-01-01+00' and updated_at<timestamptz '10000-01-01+00')
);
create table public.zentra_us_tax_provider_binding_changes(
  organization_id text not null references public.zentra_workspace_country_configs(organization_id) on delete restrict,
  request_id uuid not null, previous_revision bigint not null check(previous_revision between 0 and 9007199254740989),
  revision bigint not null check(revision=previous_revision+1),previous_snapshot jsonb,snapshot jsonb not null,
  changed_by text not null check(public.zentra_us_tax_text_valid(changed_by,256,false)),
  changed_at timestamptz not null check(isfinite(changed_at) and changed_at>=timestamptz '0001-01-01+00' and changed_at<timestamptz '10000-01-01+00'),
  primary key(organization_id,request_id),unique(organization_id,revision),
  check(public.zentra_us_tax_binding_valid(snapshot,organization_id,revision)),
  check((previous_revision=0 and previous_snapshot is null) or (previous_revision>0 and public.zentra_us_tax_binding_valid(previous_snapshot,organization_id,previous_revision)))
);
alter table public.zentra_us_tax_provider_bindings add constraint zentra_us_tax_binding_receipt_fk
  foreign key(organization_id,revision) references public.zentra_us_tax_provider_binding_changes(organization_id,revision) deferrable initially deferred;

-- All RPCs lock in this order, including the first binding/operation write.
create function public.zentra_lock_us_tax_context(org text) returns void
language plpgsql security invoker set search_path='' as $$
begin
  perform 1 from public.zentra_workspaces where organization_id=org for update;
  if not found then raise exception using errcode='PX003',message='US tax workspace unavailable';end if;
  perform 1 from public.zentra_workspace_country_configs where organization_id=org and country='US' and currency='USD' for update;
  if not found then raise exception using errcode='PX003',message='US tax workspace unavailable';end if;
  perform 1 from public.zentra_us_seller_profiles where organization_id=org for update;
  perform 1 from public.zentra_us_tax_profiles where organization_id=org for update;
  perform 1 from public.zentra_us_tax_provider_bindings where organization_id=org for update;
end $$;
create function public.zentra_guard_us_tax_binding_history() returns trigger
language plpgsql security invoker set search_path='' as $$
declare h public.zentra_us_tax_provider_bindings%rowtype;
begin
  if tg_op<>'INSERT' then raise exception using errcode='PX005',message='Tax binding history is append-only';end if;
  perform public.zentra_lock_us_tax_context(new.organization_id);
  select * into h from public.zentra_us_tax_provider_bindings where organization_id=new.organization_id for update;
  if new.previous_revision is distinct from coalesce(h.revision,0) or new.previous_snapshot is distinct from h.snapshot
    or (new.snapshot->>'observedAt')::timestamptz>new.changed_at then
    raise exception using errcode='PX005',message='Tax binding audit baseline mismatch';end if;
  return new;
end $$;
create trigger zentra_us_tax_binding_history_guard before insert or update or delete on public.zentra_us_tax_provider_binding_changes for each row execute function public.zentra_guard_us_tax_binding_history();
create trigger zentra_us_tax_binding_history_truncate before truncate on public.zentra_us_tax_provider_binding_changes for each statement execute function public.zentra_guard_us_tax_binding_history();
create function public.zentra_guard_us_tax_binding_head() returns trigger
language plpgsql security invoker set search_path='' as $$
declare r public.zentra_us_tax_provider_binding_changes%rowtype;
begin
  if tg_op in ('DELETE','TRUNCATE') then raise exception using errcode='PX005',message='Tax binding history must be retained';end if;
  if tg_op='UPDATE' and (new.organization_id is distinct from old.organization_id or new.revision<>old.revision+1) then raise exception using errcode='PX005',message='Tax binding revision is immutable';end if;
  select * into r from public.zentra_us_tax_provider_binding_changes where organization_id=new.organization_id and revision=new.revision;
  if not found or r.snapshot is distinct from new.snapshot or r.changed_by is distinct from new.updated_by or r.changed_at is distinct from new.updated_at
    or (tg_op='INSERT' and r.previous_revision<>0) or (tg_op='UPDATE' and (r.previous_revision is distinct from old.revision or r.previous_snapshot is distinct from old.snapshot)) then
    raise exception using errcode='PX005',message='Tax binding head requires its exact audit receipt';end if;
  return new;
end $$;
create trigger zentra_us_tax_binding_head_guard before insert or update or delete on public.zentra_us_tax_provider_bindings for each row execute function public.zentra_guard_us_tax_binding_head();
create trigger zentra_us_tax_binding_head_truncate before truncate on public.zentra_us_tax_provider_bindings for each statement execute function public.zentra_guard_us_tax_binding_head();
create function public.zentra_guard_us_tax_binding_complete() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if not exists(select 1 from public.zentra_us_tax_provider_bindings where organization_id=new.organization_id and revision>=new.revision) then raise exception using errcode='PX005',message='Incomplete tax binding head';end if;
  return null;
end $$;
create constraint trigger zentra_us_tax_binding_complete after insert on public.zentra_us_tax_provider_binding_changes deferrable initially deferred for each row execute function public.zentra_guard_us_tax_binding_complete();
create function public.zentra_read_us_tax_provider_binding(p_organization text) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
begin
  if not exists(select 1 from public.zentra_workspace_country_configs where organization_id=p_organization and country='US' and currency='USD') then raise exception using errcode='PX003',message='US tax workspace unavailable';end if;
  return(select snapshot from public.zentra_us_tax_provider_bindings where organization_id=p_organization);
end $$;
create function public.zentra_put_us_tax_provider_binding(p_organization text,p_actor text,p_expected_revision bigint,p_request_id uuid,p_binding jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare h public.zentra_us_tax_provider_bindings%rowtype;r public.zentra_us_tax_provider_binding_changes%rowtype;t timestamptz:=clock_timestamp();
begin
  if p_request_id is null or not public.zentra_us_tax_text_valid(p_actor,256,false) or p_expected_revision is null or p_expected_revision not between 0 and 9007199254740989
    or not coalesce(public.zentra_us_tax_binding_valid(p_binding,p_organization,p_expected_revision+1),false) then raise exception using errcode='PX004',message='Invalid TEST binding';end if;
  perform public.zentra_lock_us_tax_context(p_organization);
  select * into r from public.zentra_us_tax_provider_binding_changes where organization_id=p_organization and request_id=p_request_id;
  if found then
    if r.changed_by is distinct from p_actor or r.previous_revision is distinct from p_expected_revision or r.snapshot is distinct from p_binding then raise exception using errcode='PX002',message='Tax binding request conflict';end if;
    return r.snapshot;
  end if;
  select * into h from public.zentra_us_tax_provider_bindings where organization_id=p_organization for update;
  if coalesce(h.revision,0)<>p_expected_revision then raise exception using errcode='PX001',message='Tax binding revision conflict';end if;
  insert into public.zentra_us_tax_provider_binding_changes values(p_organization,p_request_id,p_expected_revision,p_expected_revision+1,h.snapshot,p_binding,p_actor,t);
  if h.organization_id is null then
    insert into public.zentra_us_tax_provider_bindings values(p_organization,1,p_binding,p_actor,t);
  else
    update public.zentra_us_tax_provider_bindings set revision=p_expected_revision+1,snapshot=p_binding,updated_by=p_actor,updated_at=t where organization_id=p_organization;
  end if;
  return p_binding;
end $$;

create table public.zentra_us_tax_operations(
  organization_id text not null references public.zentra_workspace_country_configs(organization_id) on delete restrict,
  operation_id uuid not null,erp_idempotency_key text not null,actor_id text not null,actor_role text not null check(actor_role in ('owner','admin','accountant')),
  invoice_id text not null,command_hash text not null check(command_hash ~ '^[0-9a-f]{64}$'),
  country_revision bigint not null,seller_revision bigint not null,tax_facts_revision bigint not null,binding_revision bigint not null,expected_erp_revision bigint not null,
  expected_invoice_counter bigint not null,expected_ledger_revision bigint not null,
  resolved_body text not null check(public.zentra_us_tax_body_valid(resolved_body)),resolved_sha256 text not null,
  params_body text not null check(public.zentra_us_tax_body_valid(params_body)),params_sha256 text not null,
  resolved jsonb not null,provider_idempotency_key text not null,
  status text not null check(status in ('reserved','calculated','committed')),
  proof_body text,proof_sha256 text,proof jsonb,assessment jsonb,receipt jsonb,created_at timestamptz not null,retry_until timestamptz not null,calculated_at timestamptz,expires_at timestamptz,committed_at timestamptz,
  primary key(organization_id,operation_id),unique(organization_id,erp_idempotency_key),unique(organization_id,invoice_id),
  check(resolved_sha256=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(resolved_body,'UTF8')),'hex')),
  check(params_sha256=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(params_body,'UTF8')),'hex')),
  check(resolved=resolved_body::jsonb and resolved->'params'=params_body::jsonb and resolved->>'paramsSha256'=params_sha256),
  check((proof is null and proof_body is null and proof_sha256 is null) or (proof is not null and proof_body is not null and proof_sha256 is not null and public.zentra_us_tax_body_valid(proof_body) and proof=proof_body::jsonb and proof_sha256=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(proof_body,'UTF8')),'hex'))),
  check(isfinite(created_at) and created_at>=timestamptz '0001-01-01+00' and created_at<timestamptz '10000-01-01+00'),
  check(retry_until=created_at+interval '23 hours' and retry_until<timestamptz '10000-01-01+00'),
  check(calculated_at is null or (isfinite(calculated_at) and calculated_at>=timestamptz '0001-01-01+00' and calculated_at<timestamptz '10000-01-01+00')),
  check(expires_at is null or (isfinite(expires_at) and expires_at>=timestamptz '0001-01-01+00' and expires_at<timestamptz '10000-01-01+00')),
  check(committed_at is null or (isfinite(committed_at) and committed_at>=timestamptz '0001-01-01+00' and committed_at<timestamptz '10000-01-01+00')),
  check((status='reserved' and proof is null and assessment is null and calculated_at is null and expires_at is null and receipt is null and committed_at is null)
    or (status='calculated' and proof is not null and assessment is not null and calculated_at is not null and expires_at is not null and receipt is null and committed_at is null)
    or (status='committed' and proof is not null and assessment is not null and calculated_at is not null and expires_at is not null and receipt is not null and committed_at is not null))
);
-- Expression uniqueness is an index so PostgreSQL accepts it independently of
-- table-level unique constraints. No cross-tenant reuse of a provider key.
create unique index zentra_us_tax_operation_provider_key on public.zentra_us_tax_operations((resolved->'binding'->>'accountId'),provider_idempotency_key);
create function public.zentra_us_tax_operation_result(o public.zentra_us_tax_operations) returns jsonb
language sql immutable security invoker set search_path='' as $$
  select jsonb_build_object('status',o.status,'organizationId',o.organization_id,'operationId',o.operation_id,'actorUserId',o.actor_id,'erpIdempotencyKey',o.erp_idempotency_key,'commandHash',o.command_hash,
    'reservedAt',pg_catalog.to_char(date_trunc('milliseconds',o.created_at) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'retryUntil',pg_catalog.to_char(date_trunc('milliseconds',o.retry_until) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'resolvedBody',o.resolved_body,'resolvedSha256',o.resolved_sha256,'paramsBody',o.params_body,'paramsSha256',o.params_sha256,'providerKey',o.provider_idempotency_key,'proofBody',o.proof_body,'proofSha256',o.proof_sha256,'assessment',o.assessment,'receipt',o.receipt);
$$;

create function public.zentra_us_tax_actor_valid(a jsonb,org text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
begin
  return public.zentra_us_tax_object(a,array['organizationId','userId','role','managementEntitled','timestamp'])
    and public.zentra_us_tax_strings(a,array['organizationId','userId','role','timestamp'])
    and a->>'organizationId'=org and public.zentra_us_tax_text_valid(a->>'userId',256,false)
    and a->>'role' in ('owner','admin','accountant') and a->'managementEntitled'='true'::jsonb and public.zentra_us_tax_instant(a->>'timestamp');
exception when others then return false;end $$;
create function public.zentra_assert_us_tax_operation_snapshot(o public.zentra_us_tax_operations,p_erp_before boolean default true) returns void
language plpgsql security invoker set search_path='' as $$
declare c public.zentra_workspace_country_configs%rowtype;s public.zentra_us_seller_profiles%rowtype;f public.zentra_us_tax_profiles%rowtype;b public.zentra_us_tax_provider_bindings%rowtype;e jsonb;rev bigint;
begin
  select * into c from public.zentra_workspace_country_configs where organization_id=o.organization_id;
  select * into s from public.zentra_us_seller_profiles where organization_id=o.organization_id;
  select * into f from public.zentra_us_tax_profiles where organization_id=o.organization_id;
  select * into b from public.zentra_us_tax_provider_bindings where organization_id=o.organization_id;
  select revision into rev from public.zentra_us_erp_heads where organization_id=o.organization_id for update;
  select payload into e from public.zentra_us_erp_records where organization_id=o.organization_id and kind='estimate' and id=o.resolved->>'sourceEstimateId';
  if c.country is distinct from 'US' or c.currency is distinct from 'USD' or c.revision is distinct from o.country_revision or c.config is distinct from o.resolved->'snapshots'->'configuration'
    or s.revision is distinct from o.seller_revision or f.revision is distinct from o.tax_facts_revision or f.facts is distinct from o.resolved->'snapshots'->'taxFacts'
    or b.revision is distinct from o.binding_revision or b.snapshot is distinct from o.resolved->'binding'
    or e is distinct from o.resolved->'snapshots'->'estimate' or e->>'status' is distinct from 'accepted'
    or (e->>'revision')::bigint is distinct from (o.resolved->>'sourceEstimateRevision')::bigint
    or rev is distinct from o.expected_erp_revision+(case when p_erp_before then 0 else 1 end) then raise exception using errcode='PX001',message='Tax operation snapshot changed';end if;
  if (b.snapshot->>'observedAt')::timestamptz>clock_timestamp() or (b.snapshot->>'validUntil')::timestamptz<=clock_timestamp() then raise exception using errcode='PX006',message='TEST binding expired';end if;
end $$;
create function public.zentra_guard_us_tax_operation() returns trigger
language plpgsql security invoker set search_path='' as $$
declare r jsonb;v jsonb;line jsonb;class jsonb;original jsonb;address jsonb;i integer:=0;total numeric:=0;providerkey text;
begin
  if tg_op in ('DELETE','TRUNCATE') then raise exception using errcode='PX005',message='Tax operations must be retained';end if;
  if tg_op='UPDATE' then
    if to_jsonb(new)-array['status','proof_body','proof_sha256','proof','assessment','receipt','calculated_at','expires_at','committed_at'] is distinct from to_jsonb(old)-array['status','proof_body','proof_sha256','proof','assessment','receipt','calculated_at','expires_at','committed_at']
      or not((old.status='reserved' and new.status='calculated') or (old.status='calculated' and new.status='committed'))
      or (old.status='calculated' and (new.proof_body is distinct from old.proof_body or new.proof_sha256 is distinct from old.proof_sha256 or new.proof is distinct from old.proof or new.assessment is distinct from old.assessment or new.calculated_at is distinct from old.calculated_at or new.expires_at is distinct from old.expires_at)) then
      raise exception using errcode='PX005',message='Tax operation identity, params and proof are immutable';end if;
    if old.status='reserved' and clock_timestamp()>=old.retry_until then raise exception using errcode='PX006',message='Unresolved TEST calculation retry window expired';end if;
    if not coalesce(public.zentra_us_tax_private_proof_valid(new,new.proof,new.assessment),false)
      or new.calculated_at is distinct from (new.proof->>'calculatedAt')::timestamptz or new.expires_at is distinct from (new.assessment->>'validUntil')::timestamptz
      or new.calculated_at>clock_timestamp() or new.expires_at<=clock_timestamp() then raise exception using errcode='PX006',message='Invalid or expired immutable tax proof';end if;
    if new.status='committed' then perform public.zentra_lock_us_tax_context(new.organization_id);perform public.zentra_assert_us_tax_operation_snapshot(new,false);end if;
    return new;
  end if;
  new.created_at:=clock_timestamp();new.retry_until:=new.created_at+interval '23 hours';
  perform public.zentra_lock_us_tax_context(new.organization_id);r:=new.resolved;
  if not public.zentra_us_tax_object(r,array['schemaVersion','organizationId','operationId','invoiceId','actorUserId','erpIdempotencyKey','commandHash','expectedErpRevision','sourceEstimateId','sourceEstimateRevision','countryRevision','sellerRevision','taxFactsRevision','binding','classifications','invoiceDate','taxDateInstant','taxDatePolicy','timeZone','snapshots','params','netTotalMinor','paramsSha256'])
    or not public.zentra_us_tax_strings(r,array['organizationId','operationId','invoiceId','actorUserId','erpIdempotencyKey','commandHash','sourceEstimateId','invoiceDate','taxDateInstant','taxDatePolicy','timeZone','netTotalMinor','paramsSha256'])
    or r->'schemaVersion' is distinct from '1'::jsonb or r->>'organizationId' is distinct from new.organization_id or r->>'operationId' is distinct from new.operation_id::text
    or r->>'invoiceId' is distinct from new.invoice_id or r->>'actorUserId' is distinct from new.actor_id or r->>'erpIdempotencyKey' is distinct from new.erp_idempotency_key or r->>'commandHash' is distinct from new.command_hash
    or not public.zentra_us_tax_text_valid(new.actor_id,256,false) or new.erp_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,231}$'
    or not public.zentra_us_tax_text_valid(new.invoice_id,160,false) or new.status<>'reserved'
    or not public.zentra_us_tax_revision(r->'expectedErpRevision',0) or (r->>'expectedErpRevision')::bigint<>new.expected_erp_revision
    or not public.zentra_us_tax_revision(r->'countryRevision') or (r->>'countryRevision')::bigint<>new.country_revision
    or not public.zentra_us_tax_revision(r->'sellerRevision') or (r->>'sellerRevision')::bigint<>new.seller_revision
    or not public.zentra_us_tax_revision(r->'taxFactsRevision') or (r->>'taxFactsRevision')::bigint<>new.tax_facts_revision
    or not public.zentra_us_tax_revision(r->'sourceEstimateRevision') or not public.zentra_us_tax_binding_valid(r->'binding',new.organization_id,new.binding_revision)
    or not public.zentra_us_tax_object(r->'snapshots',array['configuration','estimate','taxFacts']) or not public.zentra_us_tax_facts_valid(r->'snapshots'->'taxFacts')
    or r->>'timeZone' is distinct from r->'snapshots'->'taxFacts'->>'timeZone' or r->>'taxDatePolicy' is distinct from 'caller_supplied_invoice_instant'
    or not public.zentra_us_tax_instant(r->>'taxDateInstant') or extract(epoch from (r->>'taxDateInstant')::timestamptz)%1<>0 or r->>'invoiceDate' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or to_char((r->>'taxDateInstant')::timestamptz at time zone (r->>'timeZone'),'YYYY-MM-DD') is distinct from r->>'invoiceDate'
    or not public.zentra_us_tax_amount(r->'netTotalMinor') then raise exception using errcode='PX004',message='Invalid resolved TEST tax operation';end if;
  v:=r->'params';
  if not public.zentra_us_tax_object(v,array['currency','customer_details','tax_date','line_items','expand']) or v->>'currency' is distinct from 'usd' or v->'expand' is distinct from '["line_items.data.tax_breakdown"]'::jsonb
    or not public.zentra_us_tax_object(v->'customer_details',array['address','address_source']) or not public.zentra_us_tax_strings(v->'customer_details',array['address_source']) or v->'customer_details'->>'address_source' not in ('billing','shipping')
    or not public.zentra_us_tax_safe_integer(v->'tax_date') or (v->>'tax_date')::numeric<>floor(extract(epoch from (r->>'taxDateInstant')::timestamptz))
    or abs((v->>'tax_date')::numeric-extract(epoch from clock_timestamp()))>31*86400
    or jsonb_typeof(v->'line_items') is distinct from 'array' or jsonb_array_length(v->'line_items') not between 1 and 100
    or jsonb_typeof(r->'classifications') is distinct from 'array' or jsonb_array_length(r->'classifications')<>jsonb_array_length(v->'line_items') then raise exception using errcode='PX004',message='Unsupported TEST calculation params';end if;
  address:=r->'snapshots'->'estimate'->'customer'->(case when v->'customer_details'->>'address_source'='billing' then 'billingAddress' else 'shippingAddress' end);
  if v->'customer_details'->'address' is distinct from jsonb_strip_nulls(jsonb_build_object('country',address->'country','line1',address->'line1','line2',address->'line2','city',address->'city','state',address->'subdivision','postal_code',address->'postalCode')) then raise exception using errcode='PX004',message='Calculation address does not match the snapshot';end if;
  for line in select value from jsonb_array_elements(v->'line_items') loop
    class:=r->'classifications'->i;i:=i+1;
    select value into original from jsonb_array_elements(r->'snapshots'->'estimate'->'lines') where value->>'id'=line->>'reference';
    if not public.zentra_us_tax_object(line,array['amount','quantity','reference','tax_code','tax_behavior']) or not public.zentra_us_tax_safe_integer(line->'amount',1) or not public.zentra_us_tax_safe_integer(line->'quantity',1)
      or not public.zentra_us_tax_strings(line,array['reference','tax_code','tax_behavior']) or line->>'tax_behavior' is distinct from 'exclusive' or line->>'tax_code' !~ '^txcd_[0-9]{8}$' or not public.zentra_us_tax_text_valid(line->>'reference',160,false)
      or not public.zentra_us_tax_object(class,array['lineId','taxCode','kind','taxBehavior','revision','evidenceReference']) or class->>'kind' is distinct from 'service' or class->>'taxBehavior' is distinct from 'exclusive'
      or not public.zentra_us_tax_strings(class,array['lineId','taxCode','kind','taxBehavior','evidenceReference']) or class->>'lineId' is distinct from line->>'reference' or class->>'taxCode' is distinct from line->>'tax_code' or not public.zentra_us_tax_revision(class->'revision') or not public.zentra_us_tax_text_valid(class->>'evidenceReference',256,false)
      or original is null or original->>'taxTreatment' is distinct from 'taxable' or (line->>'amount')::numeric is distinct from (public.zentra_us_erp_line_totals(original)->>'netMinor')::numeric
      or (line->>'quantity')::numeric is distinct from (original->>'quantityUnits')::numeric/power(10::numeric,(original->>'quantityScale')::integer) then raise exception using errcode='PX004',message='Invalid explicit line classification or quantity';end if;
    total:=total+(line->>'amount')::numeric;
  end loop;
  if total<>(r->>'netTotalMinor')::numeric or (select count(*)<>count(distinct value->>'reference') from jsonb_array_elements(v->'line_items')) then raise exception using errcode='PX004',message='Calculation line identity or sum mismatch';end if;
  providerkey:='ztax_test_'||pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('["zentra:us:stripe-tax:calculation:v1",'||to_json(new.organization_id)::text||','||to_json(new.operation_id::text)::text||','||to_json(r->'binding'->>'accountId')::text||',"test",'||to_json(new.resolved_sha256)::text||']','UTF8')),'hex');
  if new.provider_idempotency_key is distinct from providerkey then raise exception using errcode='PX004',message='Provider operation key mismatch';end if;
  if jsonb_array_length(v->'line_items')<>jsonb_array_length(r->'snapshots'->'estimate'->'lines') then raise exception using errcode='PX004',message='Incomplete calculation line coverage';end if;
  perform public.zentra_assert_us_tax_operation_snapshot(new);
  select (header->'counters'->>'invoice')::bigint,(header->'ledger'->>'revision')::bigint into new.expected_invoice_counter,new.expected_ledger_revision from public.zentra_us_erp_heads where organization_id=new.organization_id;
  return new;
end $$;
create trigger zentra_us_tax_operation_guard before insert or update or delete on public.zentra_us_tax_operations for each row execute function public.zentra_guard_us_tax_operation();
create trigger zentra_us_tax_operation_truncate before truncate on public.zentra_us_tax_operations for each statement execute function public.zentra_guard_us_tax_operation();

create function public.zentra_us_tax_private_proof_valid(o public.zentra_us_tax_operations,p jsonb,a jsonb) returns boolean
language plpgsql stable security invoker set search_path='' as $$
declare l jsonb;b jsonb;j jsonb;param jsonb;pub jsonb;fingerprint jsonb;request_lines jsonb;summary text;n numeric:=0;t numeric:=0;line_tax numeric;
begin
  if not public.zentra_us_tax_object(p,array['schemaVersion','organizationId','operationId','provider','accountId','mode','apiVersion','bindingRevision','resolvedSha256','paramsSha256','settingsSha256','registrationsSha256','evidenceKind','calculationId','calculatedAt','expiresAt','taxDate','currency','netMinor','taxMinor','totalMinor','lines'])
    or not public.zentra_us_tax_strings(p,array['organizationId','operationId','provider','accountId','mode','apiVersion','resolvedSha256','paramsSha256','settingsSha256','registrationsSha256','evidenceKind','calculationId','calculatedAt','expiresAt','currency','netMinor','taxMinor','totalMinor'])
    or p->'schemaVersion' is distinct from '1'::jsonb or p->>'organizationId' is distinct from o.organization_id or p->>'operationId' is distinct from o.operation_id::text or p->>'provider' is distinct from 'stripe_tax'
    or p->>'mode' is distinct from 'test' or p->>'currency' is distinct from 'USD' or p->>'accountId' is distinct from o.resolved->'binding'->>'accountId' or p->>'apiVersion' is distinct from o.resolved->'binding'->>'apiVersion'
    or p->'bindingRevision' is distinct from o.resolved->'binding'->'revision' or p->>'evidenceKind' is distinct from o.resolved->'binding'->>'evidenceKind'
    or p->>'resolvedSha256' is distinct from o.resolved_sha256 or p->>'paramsSha256' is distinct from o.params_sha256 or p->>'settingsSha256' is distinct from o.resolved->'binding'->>'settingsSha256' or p->>'registrationsSha256' is distinct from o.resolved->'binding'->>'registrationsSha256'
    or p->'taxDate' is distinct from o.resolved->'params'->'tax_date' or p->>'calculationId' !~ '^taxcalc_[A-Za-z0-9]+$' or not public.zentra_us_tax_text_valid(p->>'calculationId',100,false)
    or not public.zentra_us_tax_instant(p->>'calculatedAt') or not public.zentra_us_tax_instant(p->>'expiresAt') or (p->>'expiresAt')::timestamptz<=(p->>'calculatedAt')::timestamptz or (p->>'calculatedAt')::timestamptz<(o.resolved->'binding'->>'observedAt')::timestamptz
    or not public.zentra_us_tax_amount(p->'netMinor') or not public.zentra_us_tax_amount(p->'taxMinor') or not public.zentra_us_tax_amount(p->'totalMinor')
    or jsonb_typeof(p->'lines') is distinct from 'array' or jsonb_array_length(p->'lines')<>jsonb_array_length(o.resolved->'params'->'line_items')
    or not public.zentra_us_erp_tax_proof_valid(a,o.organization_id) or a->>'source' is distinct from 'external-provider' or a->>'providerReference' is distinct from p->>'calculationId'
    or a->>'documentId' is distinct from o.resolved->>'sourceEstimateId' or a->'documentRevision' is distinct from o.resolved->'sourceEstimateRevision'
    or a->>'determinedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' or a->>'validUntil' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    or not public.zentra_us_tax_instant(a->>'determinedAt') or not public.zentra_us_tax_instant(a->>'validUntil') or (a->>'determinedAt')::timestamptz is distinct from date_trunc('milliseconds',(p->>'calculatedAt')::timestamptz)
    or (a->>'validUntil')::timestamptz is distinct from date_trunc('milliseconds',least((p->>'expiresAt')::timestamptz,(o.resolved->'binding'->>'validUntil')::timestamptz))
    or (a->>'validUntil')::timestamptz<=(a->>'determinedAt')::timestamptz then return false;end if;
  fingerprint:=(a->>'fingerprint')::jsonb;
  select jsonb_agg(jsonb_build_object('id',value->>'id','netMinor',public.zentra_us_erp_line_totals(value)->>'netMinor','taxTreatment',value->>'taxTreatment') order by ordinality)
    into request_lines from jsonb_array_elements(o.resolved->'snapshots'->'estimate'->'lines') with ordinality;
  if fingerprint is distinct from jsonb_build_array(o.organization_id,'US','USD',o.resolved->'snapshots'->'configuration'->'address',o.resolved->>'sourceEstimateId',o.resolved->'sourceEstimateRevision',o.resolved->>'invoiceDate',o.resolved->'snapshots'->'estimate'->'customer'->'billingAddress',coalesce(o.resolved->'snapshots'->'estimate'->'customer'->'shippingAddress','null'::jsonb),request_lines) then return false;end if;
  for l in select value from jsonb_array_elements(p->'lines') loop
    select value into param from jsonb_array_elements(o.resolved->'params'->'line_items') where value->>'reference'=l->>'lineId';
    select value into pub from jsonb_array_elements(a->'lines') where value->>'id'=l->>'lineId';
    if param is null or pub is null or not public.zentra_us_tax_object(l,array['lineId','providerLineId','netMinor','quantity','taxCode','taxMinor','breakdowns'])
      or not public.zentra_us_tax_strings(l,array['lineId','providerLineId','netMinor','quantity','taxCode','taxMinor'])
      or not public.zentra_us_tax_text_valid(l->>'providerLineId',100,false) or l->>'providerLineId' !~ '^tax_li_[A-Za-z0-9]+$' or not public.zentra_us_tax_amount(l->'netMinor') or not public.zentra_us_tax_amount(l->'taxMinor') or not public.zentra_us_tax_amount(l->'quantity') or (l->>'quantity')::numeric<1
      or l->>'netMinor' is distinct from param->>'amount' or l->>'quantity' is distinct from param->>'quantity' or l->>'taxCode' is distinct from param->>'tax_code'
      or pub->>'taxMinor' is distinct from l->>'taxMinor' or pub->>'evidenceReference' is distinct from ((p->>'calculationId')||':'||(l->>'providerLineId'))
      or jsonb_typeof(l->'breakdowns') is distinct from 'array' or jsonb_array_length(l->'breakdowns') not between 1 and 100 then return false;end if;
    line_tax:=0;
    for b in select value from jsonb_array_elements(l->'breakdowns') loop
      if not public.zentra_us_tax_object(b,array['amountMinor','taxableMinor','taxabilityReason','sourcing','jurisdiction']) or not public.zentra_us_tax_strings(b,array['amountMinor','taxableMinor','taxabilityReason','sourcing'])
        or not public.zentra_us_tax_amount(b->'amountMinor') or not public.zentra_us_tax_amount(b->'taxableMinor') or (b->>'taxableMinor')::numeric>(l->>'netMinor')::numeric
        or b->>'taxabilityReason' not in ('standard_rated','zero_rated','product_exempt','not_subject_to_tax') or (b->>'taxabilityReason'<>'standard_rated' and b->>'amountMinor'<>'0') or b->>'sourcing' not in ('origin','destination') then return false;end if;
      j:=b->'jurisdiction';
      if not public.zentra_us_tax_object(j,array['country','level','displayName'],array['state']) or not public.zentra_us_tax_strings(j,array['country','level','displayName']) or j->>'country' is distinct from 'US'
        or j->>'level' not in ('country','state','county','city','district') or (j->>'level'<>'country' and not(j ? 'state')) or not public.zentra_us_tax_text_valid(j->>'displayName',100,false)
        or (j ? 'state' and (jsonb_typeof(j->'state') is distinct from 'string' or j->>'state' !~ '^[A-Z]{2}$')) then return false;end if;
      line_tax:=line_tax+(b->>'amountMinor')::numeric;
    end loop;
    if (select count(*)<>count(distinct value->'jurisdiction') from jsonb_array_elements(l->'breakdowns')) then return false;end if;
    select string_agg(marker,'; ' order by first_position) into summary from
      (select 'US'||coalesce('-'||(value->'jurisdiction'->>'state'),'') marker,min(ordinality) first_position from jsonb_array_elements(l->'breakdowns') with ordinality group by 1) summaries;
    if pub->>'jurisdiction' is distinct from summary or not public.zentra_us_tax_text_valid(summary,160,false) then return false;end if;
    if line_tax<>(l->>'taxMinor')::numeric then return false;end if;
    n:=n+(l->>'netMinor')::numeric;t:=t+(l->>'taxMinor')::numeric;
  end loop;
  return n=(p->>'netMinor')::numeric and n=(o.resolved->>'netTotalMinor')::numeric and t=(p->>'taxMinor')::numeric and n+t=(p->>'totalMinor')::numeric
    and jsonb_array_length(a->'lines')=jsonb_array_length(p->'lines')
    and not(select count(*)<>count(distinct value->>'lineId') or count(*)<>count(distinct value->>'providerLineId') from jsonb_array_elements(p->'lines'));
exception when others then return false;end $$;

create function public.zentra_reserve_us_tax_operation(p_organization text,p_actor jsonb,p_operation_id uuid,p_resolved_body text,p_resolved_sha256 text,p_params_body text,p_params_sha256 text,p_provider_idempotency_key text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare o public.zentra_us_tax_operations%rowtype;r jsonb;
begin
  if not coalesce(public.zentra_us_tax_actor_valid(p_actor,p_organization),false) then raise exception using errcode='PX007',message='Trusted financial authority required';end if;
  begin r:=p_resolved_body::jsonb;exception when others then raise exception using errcode='PX004',message='Invalid resolved operation JSON';end;
  perform public.zentra_lock_us_tax_context(p_organization);
  select * into o from public.zentra_us_tax_operations where organization_id=p_organization and (operation_id=p_operation_id or erp_idempotency_key=r->>'erpIdempotencyKey') for update;
  if found then
    if o.operation_id is distinct from p_operation_id or o.actor_id is distinct from p_actor->>'userId' or o.resolved_body is distinct from p_resolved_body or o.resolved_sha256 is distinct from p_resolved_sha256 or o.params_body is distinct from p_params_body or o.params_sha256 is distinct from p_params_sha256 or o.provider_idempotency_key is distinct from p_provider_idempotency_key then raise exception using errcode='PX002',message='Tax operation identifier conflict';end if;
    return public.zentra_us_tax_operation_result(o);
  end if;
  insert into public.zentra_us_tax_operations(organization_id,operation_id,erp_idempotency_key,actor_id,actor_role,invoice_id,command_hash,country_revision,seller_revision,tax_facts_revision,binding_revision,expected_erp_revision,resolved_body,resolved_sha256,params_body,params_sha256,resolved,provider_idempotency_key,status,created_at)
    values(p_organization,p_operation_id,r->>'erpIdempotencyKey',p_actor->>'userId',p_actor->>'role',r->>'invoiceId',r->>'commandHash',(r->>'countryRevision')::bigint,(r->>'sellerRevision')::bigint,(r->>'taxFactsRevision')::bigint,(r->'binding'->>'revision')::bigint,(r->>'expectedErpRevision')::bigint,p_resolved_body,p_resolved_sha256,p_params_body,p_params_sha256,r,p_provider_idempotency_key,'reserved',clock_timestamp()) returning * into o;
  return public.zentra_us_tax_operation_result(o);
end $$;
create function public.zentra_read_us_tax_operation(p_organization text,p_erp_idempotency_key text,p_command_hash text,p_actor jsonb) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare o public.zentra_us_tax_operations%rowtype;
begin
  if not coalesce(public.zentra_us_tax_actor_valid(p_actor,p_organization),false) then raise exception using errcode='PX007',message='Trusted financial authority required';end if;
  select * into o from public.zentra_us_tax_operations where organization_id=p_organization and erp_idempotency_key=p_erp_idempotency_key;
  if not found then return null;end if;
  if o.actor_id is distinct from p_actor->>'userId' or o.command_hash is distinct from p_command_hash then raise exception using errcode='PX002',message='Tax operation identifier conflict';end if;
  return public.zentra_us_tax_operation_result(o);
end $$;
create function public.zentra_record_us_tax_calculation(p_organization text,p_operation_id uuid,p_actor jsonb,p_proof_body text,p_proof_sha256 text,p_assessment jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare o public.zentra_us_tax_operations%rowtype;p_proof jsonb;
begin
  if not coalesce(public.zentra_us_tax_actor_valid(p_actor,p_organization),false) then raise exception using errcode='PX007',message='Trusted financial authority required';end if;
  if p_proof_sha256 is distinct from pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_proof_body,'UTF8')),'hex') then raise exception using errcode='PX004',message='Proof body hash mismatch';end if;
  begin p_proof:=p_proof_body::jsonb;exception when others then raise exception using errcode='PX004',message='Invalid proof body';end;
  perform public.zentra_lock_us_tax_context(p_organization);
  select * into o from public.zentra_us_tax_operations where organization_id=p_organization and operation_id=p_operation_id for update;
  if not found then raise exception using errcode='PX003',message='Tax operation unavailable';end if;
  if o.actor_id is distinct from p_actor->>'userId' then raise exception using errcode='PX002',message='Tax operation actor conflict';end if;
  if o.status<>'reserved' then
    if o.proof_body is distinct from p_proof_body or o.proof_sha256 is distinct from p_proof_sha256 or o.proof is distinct from p_proof or o.assessment is distinct from p_assessment then raise exception using errcode='PX002',message='Tax calculation proof conflict';end if;return public.zentra_us_tax_operation_result(o);
  end if;
  if clock_timestamp()>=o.retry_until then raise exception using errcode='PX006',message='Unresolved TEST calculation retry window expired';end if;
  if not coalesce(public.zentra_us_tax_private_proof_valid(o,p_proof,p_assessment),false) then raise exception using errcode='PX004',message='Unsupported TEST calculation proof';end if;
  if (p_proof->>'calculatedAt')::timestamptz>clock_timestamp() or (p_assessment->>'validUntil')::timestamptz<=clock_timestamp() then raise exception using errcode='PX006',message='Tax calculation expired';end if;
  update public.zentra_us_tax_operations set status='calculated',proof_body=p_proof_body,proof_sha256=p_proof_sha256,proof=p_proof,assessment=p_assessment,calculated_at=(p_proof->>'calculatedAt')::timestamptz,expires_at=(p_assessment->>'validUntil')::timestamptz where organization_id=p_organization and operation_id=p_operation_id returning * into o;
  return public.zentra_us_tax_operation_result(o);
end $$;

create table public.zentra_us_tax_invoice_links(
  organization_id text not null,invoice_id text not null,operation_id uuid not null,record_kind text not null default 'invoice' check(record_kind='invoice'),
  erp_idempotency_key text not null,command_hash text not null,erp_revision bigint not null,
  primary key(organization_id,invoice_id),unique(organization_id,operation_id),
  foreign key(organization_id,operation_id) references public.zentra_us_tax_operations(organization_id,operation_id) on delete restrict,
  foreign key(organization_id,record_kind,invoice_id) references public.zentra_us_erp_records(organization_id,kind,id) deferrable initially deferred,
  foreign key(organization_id,erp_idempotency_key) references public.zentra_us_erp_receipts(organization_id,idempotency_key) deferrable initially deferred
);
create function public.zentra_guard_us_tax_link() returns trigger
language plpgsql security invoker set search_path='' as $$
declare o public.zentra_us_tax_operations%rowtype;
begin
  if tg_op<>'INSERT' then raise exception using errcode='PX005',message='Invoice proof links are append-only';end if;
  perform public.zentra_lock_us_tax_context(new.organization_id);
  select * into o from public.zentra_us_tax_operations where organization_id=new.organization_id and operation_id=new.operation_id for update;
  if not found or o.status<>'calculated' or new.invoice_id is distinct from o.invoice_id or new.erp_idempotency_key is distinct from o.erp_idempotency_key or new.command_hash is distinct from o.command_hash or new.erp_revision is distinct from o.expected_erp_revision+1 then raise exception using errcode='PX005',message='Invoice proof link mismatch';end if;
  perform public.zentra_assert_us_tax_operation_snapshot(o);
  if not coalesce(public.zentra_us_tax_private_proof_valid(o,o.proof,o.assessment),false) or o.expires_at<=clock_timestamp() then raise exception using errcode='PX006',message='Tax calculation expired';end if;
  return new;
end $$;
create trigger zentra_us_tax_link_guard before insert or update or delete on public.zentra_us_tax_invoice_links for each row execute function public.zentra_guard_us_tax_link();
create trigger zentra_us_tax_link_truncate before truncate on public.zentra_us_tax_invoice_links for each statement execute function public.zentra_guard_us_tax_link();
create function public.zentra_guard_us_tax_invoice_insert() returns trigger
language plpgsql security invoker set search_path='' as $$
declare o public.zentra_us_tax_operations%rowtype;l public.zentra_us_tax_invoice_links%rowtype;s jsonb;
begin
  if new.kind<>'invoice' then return new;end if;
  -- ON CONFLICT DO UPDATE runs BEFORE INSERT first. Existing immutable invoices
  -- can still append an authorized payment without recalculating old taxes.
  if exists(select 1 from public.zentra_us_erp_records where organization_id=new.organization_id and kind='invoice' and id=new.id) then return new;end if;
  perform public.zentra_lock_us_tax_context(new.organization_id);
  select * into l from public.zentra_us_tax_invoice_links where organization_id=new.organization_id and invoice_id=new.id;
  select * into o from public.zentra_us_tax_operations where organization_id=l.organization_id and operation_id=l.operation_id for update;
  if o.operation_id is null or o.status<>'calculated' or new.state_revision is distinct from l.erp_revision or new.payload->'taxAssessment' is distinct from o.assessment
    or new.payload->>'issuedBy' is distinct from o.actor_id or new.payload->>'sourceEstimateId' is distinct from o.resolved->>'sourceEstimateId' or new.payload->'sourceEstimateRevision' is distinct from o.resolved->'sourceEstimateRevision'
    or new.payload->>'date' is distinct from o.resolved->>'invoiceDate' or new.payload->'tax'->>'minorUnits' is distinct from o.proof->>'taxMinor' or new.payload->'total'->>'minorUnits' is distinct from o.proof->>'totalMinor'
    or new.payload->>'number' is distinct from (o.resolved->'snapshots'->'configuration'->>'invoiceNumberPrefix')||'-'||lpad((o.expected_invoice_counter+1)::text,greatest(6,length((o.expected_invoice_counter+1)::text)),'0')
    or not exists(select 1 from public.zentra_us_erp_heads where organization_id=new.organization_id and (header->'counters'->>'invoice')::bigint=o.expected_invoice_counter+1) then raise exception using errcode='PX005',message='New invoice requires its private TEST operation proof';end if;
  perform public.zentra_assert_us_tax_operation_snapshot(o,false);
  select jsonb_build_object('organizationId',new.organization_id)||profile into s from public.zentra_us_seller_profiles where organization_id=new.organization_id;
  if new.payload->'sellerSnapshot' is distinct from s or o.expires_at<=clock_timestamp() or not coalesce(public.zentra_us_tax_private_proof_valid(o,o.proof,o.assessment),false) then raise exception using errcode='PX006',message='Invoice tax or seller evidence expired';end if;
  return new;
end $$;
create trigger zentra_us_tax_invoice_proof before insert on public.zentra_us_erp_records for each row execute function public.zentra_guard_us_tax_invoice_insert();

create function public.zentra_assert_us_tax_completed(org text,op uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare o public.zentra_us_tax_operations%rowtype;l public.zentra_us_tax_invoice_links%rowtype;r public.zentra_us_erp_receipts%rowtype;i public.zentra_us_erp_records%rowtype;j jsonb;expected jsonb;net numeric;tax numeric;total numeric;
begin
  select * into o from public.zentra_us_tax_operations where organization_id=org and operation_id=op;
  select * into l from public.zentra_us_tax_invoice_links where organization_id=org and operation_id=op;
  select * into r from public.zentra_us_erp_receipts where organization_id=org and idempotency_key=o.erp_idempotency_key;
  select * into i from public.zentra_us_erp_records where organization_id=org and kind='invoice' and id=o.invoice_id;
  if o.status is distinct from 'committed' or l.operation_id is null or r.actor_id is distinct from o.actor_id or r.command_hash is distinct from o.command_hash or r.receipt is distinct from o.receipt
    or r.receipt->>'action' is distinct from 'issue_invoice' or r.receipt->>'entityId' is distinct from o.invoice_id or r.revision is distinct from l.erp_revision
    or i.payload->'taxAssessment' is distinct from o.assessment or i.payload->>'issuedBy' is distinct from o.actor_id or i.state_revision<l.erp_revision then raise exception using errcode='PX005',message='Incomplete atomic invoice proof commit';end if;
  total:=(o.proof->>'totalMinor')::numeric;net:=(o.proof->>'netMinor')::numeric;tax:=(o.proof->>'taxMinor')::numeric;
  if o.resolved->'snapshots'->'configuration'->>'accountingBasis'='accrual' and total>0 then
    select payload into j from public.zentra_us_erp_records where organization_id=org and kind='journal' and id='entry:invoice:'||o.invoice_id;
    select jsonb_agg(value order by ordinality) into expected from jsonb_array_elements(jsonb_build_array(
      jsonb_build_object('accountId','receivables','debitMinor',total::text,'creditMinor','0'),jsonb_build_object('accountId','sales','debitMinor','0','creditMinor',net::text),jsonb_build_object('accountId','tax-payable','debitMinor','0','creditMinor',tax::text))) with ordinality where (value->>'debitMinor')::numeric>0 or (value->>'creditMinor')::numeric>0;
    if j is null or j->'lines' is distinct from expected or j->'source' is distinct from jsonb_build_object('type','customer_invoice','id',o.invoice_id)
      or j->>'postedBy' is distinct from o.actor_id or j->>'postedAt' is distinct from i.payload->>'issuedAt' or (j->>'revision')::bigint is distinct from o.expected_ledger_revision+1
      or not exists(select 1 from public.zentra_us_erp_ledger_audit where organization_id=org and revision=o.expected_ledger_revision+1 and payload->>'entityId'=j->>'id' and payload->>'actorId'=o.actor_id and payload->>'action'='posted') then raise exception using errcode='PX005',message='Invoice proof commit requires its exact journal and audit';end if;
  end if;
end $$;
create function public.zentra_guard_us_tax_completion() returns trigger
language plpgsql security invoker set search_path='' as $$
declare op uuid;
begin
  if tg_table_name='zentra_us_tax_operations' then
    if new.status<>'committed' then return null;end if;op:=new.operation_id;
  elsif tg_table_name='zentra_us_tax_invoice_links' then op:=new.operation_id;
  else
    if new.receipt->>'action'<>'issue_invoice' then return null;end if;
    select operation_id into op from public.zentra_us_tax_invoice_links where organization_id=new.organization_id and erp_idempotency_key=new.idempotency_key;
    if op is null then raise exception using errcode='PX005',message='Invoice receipt requires private operation proof';end if;
  end if;
  perform public.zentra_assert_us_tax_completed(new.organization_id,op);return null;
end $$;
create constraint trigger zentra_us_tax_operation_complete after insert or update on public.zentra_us_tax_operations deferrable initially deferred for each row execute function public.zentra_guard_us_tax_completion();
create constraint trigger zentra_us_tax_link_complete after insert on public.zentra_us_tax_invoice_links deferrable initially deferred for each row execute function public.zentra_guard_us_tax_completion();
create constraint trigger zentra_us_tax_receipt_complete after insert on public.zentra_us_erp_receipts deferrable initially deferred for each row execute function public.zentra_guard_us_tax_completion();

create function public.zentra_commit_us_tax_invoice_test(p_organization text,p_operation_id uuid,p_expected_revision bigint,p_header jsonb,p_changes jsonb,p_ledger_audit jsonb,p_receipt jsonb,p_actor jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare o public.zentra_us_tax_operations%rowtype;r jsonb;
begin
  if not coalesce(public.zentra_us_tax_actor_valid(p_actor,p_organization),false) then raise exception using errcode='PX007',message='Trusted financial authority required';end if;
  perform public.zentra_lock_us_tax_context(p_organization);
  select * into o from public.zentra_us_tax_operations where organization_id=p_organization and operation_id=p_operation_id for update;
  if not found then raise exception using errcode='PX003',message='Tax operation unavailable';end if;
  if o.actor_id is distinct from p_actor->>'userId' or o.erp_idempotency_key is distinct from p_receipt->>'idempotencyKey' or o.command_hash is distinct from p_receipt->>'commandHash' or p_receipt->>'action' is distinct from 'issue_invoice' or p_receipt->>'entityId' is distinct from o.invoice_id or p_expected_revision is distinct from o.expected_erp_revision then raise exception using errcode='PX002',message='Invoice operation identifier conflict';end if;
  if o.status='committed' then perform public.zentra_assert_us_tax_completed(p_organization,p_operation_id);return o.receipt;end if;
  if o.status<>'calculated' then raise exception using errcode='PX003',message='Calculated TEST proof required';end if;
  perform public.zentra_assert_us_tax_operation_snapshot(o);
  insert into public.zentra_us_tax_invoice_links(organization_id,invoice_id,operation_id,erp_idempotency_key,command_hash,erp_revision) values(p_organization,o.invoice_id,p_operation_id,o.erp_idempotency_key,o.command_hash,o.expected_erp_revision+1);
  r:=public.zentra_commit_us_erp(p_organization,p_expected_revision,p_header,p_changes,p_ledger_audit,p_receipt,p_actor);
  update public.zentra_us_tax_operations set status='committed',receipt=r,committed_at=clock_timestamp() where organization_id=p_organization and operation_id=p_operation_id;
  return r;
end $$;

do $$ declare tab text;fn record;begin
  foreach tab in array array['zentra_us_tax_provider_bindings','zentra_us_tax_provider_binding_changes','zentra_us_tax_operations','zentra_us_tax_invoice_links'] loop
    execute format('alter table public.%I enable row level security',tab);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',tab);
    execute format('grant select,insert on public.%I to service_role',tab);
    if tab in ('zentra_us_tax_provider_bindings','zentra_us_tax_operations') then execute format('grant update on public.%I to service_role',tab);end if;
    execute format('create policy %I on public.%I for all to service_role using(true) with check(true)',tab||'_server',tab);
  end loop;
  for fn in select p.oid::regprocedure as signature from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'zentra_us_tax_%' or p.proname like 'zentra_guard_us_tax_%' or p.proname in ('zentra_lock_us_tax_context','zentra_assert_us_tax_operation_snapshot','zentra_assert_us_tax_completed','zentra_read_us_tax_provider_binding','zentra_put_us_tax_provider_binding','zentra_reserve_us_tax_operation','zentra_read_us_tax_operation','zentra_record_us_tax_calculation','zentra_commit_us_tax_invoice_test')) loop
    execute format('revoke all on function %s from public,anon,authenticated',fn.signature);
    execute format('grant execute on function %s to service_role',fn.signature);
  end loop;
end $$;
comment on table public.zentra_us_tax_operations is 'Private TEST operation identity, exact retry parameters and typed proof. test_fixture is never provider observation; no production activation or legal certification.';
comment on table public.zentra_us_tax_provider_bindings is 'Internal TEST-only versioned binding observation, not a grant from declared owner facts. Remote Stripe changes still require fresh server observation.';
comment on function public.zentra_commit_us_tax_invoice_test(text,uuid,bigint,jsonb,jsonb,jsonb,jsonb,jsonb) is 'Atomic TEST private proof link + existing invoice/number/journal/receipt/event transaction. Fresh real Auth/D1 admission remains mandatory at the server boundary.';
commit;
