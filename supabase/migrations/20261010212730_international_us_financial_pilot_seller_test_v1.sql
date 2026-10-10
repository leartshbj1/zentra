-- Private local TEST seller presentation. Fiscal identity and financial events
-- are unchanged; current admission is distinct from historical corroboration.
begin;

create table public.zentra_us_financial_seller_test_changes (
 organization_id text not null references public.zentra_us_financial_test_heads on delete restrict,
 request_id uuid not null, seller_revision bigint not null check(seller_revision between 2 and 9007199254740990),
 change_index integer not null check(change_index between 1 and 1000), change_sha256 text not null check(change_sha256 ~ '^[a-f0-9]{64}$'),
 proof jsonb not null, grant_version bigint not null, opt_in_version bigint not null,
 primary key(organization_id,request_id),unique(organization_id,seller_revision),unique(organization_id,change_index),unique(organization_id,change_sha256)
);
create table public.zentra_us_financial_seller_test_heads (
 organization_id text primary key references public.zentra_us_financial_test_heads on delete restrict,
 seller_revision bigint not null, change_index integer not null, change_sha256 text not null, presentation jsonb not null,
 foreign key(organization_id,change_sha256) references public.zentra_us_financial_seller_test_changes(organization_id,change_sha256) deferrable initially deferred
);

create function public.zentra_us_pilot_seller_budget(v jsonb,maximum integer default 65536) returns void
language plpgsql immutable security invoker set search_path='' as $$
begin
 perform public.zentra_us_financial_test_budget(v);
 if octet_length(public.zentra_us_erp_v4_canonical(v))>maximum then raise exception using errcode='SQ004',message='Seller data budget exceeded';end if;
end $$;
create function public.zentra_us_pilot_seller_request(q jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare c jsonb;p jsonb;
begin
 if not public.zentra_us_tax_object(q,array['consumer','schemaVersion','requestId','expectedRevision','expectedSellerRevision','command'])
 or q->>'consumer' is distinct from 'financial-pilot' or q->'schemaVersion' is distinct from '1'::jsonb
 or not public.zentra_us_bank_uuid(q->>'requestId') or not public.zentra_us_tax_revision(q->'expectedRevision') or not public.zentra_us_tax_revision(q->'expectedSellerRevision') then return false;end if;
 c:=q->'command';if not public.zentra_us_tax_object(c,array['type','displayName','contactEmail','contactPhone']) or c->>'type' is distinct from 'update_seller_presentation' then return false;end if;
 p:=jsonb_strip_nulls(c-'type');if not public.zentra_us_seller_profile_valid(p) then return false;end if;
 perform public.zentra_us_pilot_seller_budget(q,4096);return true;
exception when others then return false;end $$;
create function public.zentra_us_pilot_seller_legacy(org text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare s public.zentra_us_seller_profiles%rowtype;
begin
 select * into s from public.zentra_us_seller_profiles where organization_id=org for update;
 if not found then raise exception using errcode='SQ006',message='Configured seller required';end if;
 return jsonb_build_object('origin','legacy-frozen','baseSellerRevision',s.revision,'sellerRevision',s.revision,'changeCount',0,'profile',s.profile,'updatedBy',s.updated_by,'updatedAt',to_char(s.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'changeSha256',null);
end $$;
create function public.zentra_us_pilot_seller_expected(org text,b jsonb,previous jsonb,q jsonb,a jsonb) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare p jsonb;prefix jsonb;f bigint;
begin
 if not public.zentra_us_pilot_seller_request(q) or not public.zentra_us_tax_actor_valid(a,org) or a->>'role' is distinct from 'owner'
 or not public.zentra_us_invoicing_instant(a->>'timestamp') or cardinality(public.zentra_us_bank_utf16_key(a->>'userId'))>256 then raise exception using errcode='SQ004',message='Exact structural seller identity required';end if;
 if q->'expectedSellerRevision' is distinct from previous->'sellerRevision' then raise exception using errcode='SQ001',message='Seller revision changed';end if;
 if (previous->>'changeCount')::integer>=1000 or (previous->>'sellerRevision')::bigint>=9007199254740990 then raise exception using errcode='SQ005',message='Seller capacity reached';end if;
 f:=(q->>'expectedRevision')::bigint;prefix:=public.zentra_us_pilot_bank_prefix(b,f);
 if (a->>'timestamp')::timestamptz<(previous->>'updatedAt')::timestamptz or (a->>'timestamp')::timestamptz<coalesce(prefix->'events'->-1#>>'{actor,timestamp}',prefix#>>'{promotion,actor,timestamp}')::timestamptz then raise exception using errcode='SQ003',message='Seller clock precedes immutable source';end if;
 p:=jsonb_build_object('schemaVersion',1,'organizationId',org,'request',q,'actor',a,'commandHash',public.zentra_us_financial_test_hash(jsonb_build_array('zentra:us:financial-pilot:seller:v1',org,a->>'userId',q)),
 'before',previous,'after',jsonb_strip_nulls((q->'command')-'type'),'sellerRevision',(previous->>'sellerRevision')::bigint+1,'changeIndex',(previous->>'changeCount')::integer+1,'changedAt',a->>'timestamp');
 return p||jsonb_build_object('changeSha256',public.zentra_us_financial_test_hash(p));
end $$;
create function public.zentra_us_pilot_seller_after(p jsonb) returns jsonb
language sql immutable security invoker set search_path='' as $$
 select jsonb_build_object('origin','financial-v5','baseSellerRevision',p#>'{before,baseSellerRevision}','sellerRevision',p->'sellerRevision','changeCount',p->'changeIndex','profile',p->'after','updatedBy',p#>>'{actor,userId}','updatedAt',p->>'changedAt','changeSha256',p->>'changeSha256');
$$;
-- Bounded reconstruction against each real financial prefix. An old actor is
-- historical evidence, not a currently admitted user or current head.
create function public.zentra_us_pilot_seller_history_reconstruct(org text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare b jsonb;p jsonb;expected jsonb;item record;h public.zentra_us_financial_seller_test_heads%rowtype;n integer:=0;last_f bigint:=0;
begin
 b:=public.zentra_us_settlement_book(org);
 if b is null then raise exception using errcode='SQ004',message='Corroborated financial source required';end if;
 p:=public.zentra_us_pilot_seller_legacy(org);
 for item in select * from public.zentra_us_financial_seller_test_changes where organization_id=org order by change_index loop
  n:=n+1;if n>1000 or item.change_index<>n or (item.proof#>>'{request,expectedRevision}')::bigint<last_f then raise exception using errcode='SQ004',message='Seller history sequence differs';end if;
  expected:=public.zentra_us_pilot_seller_expected(org,b,p,item.proof->'request',item.proof->'actor');
  perform public.zentra_us_pilot_seller_budget(item.proof);
  if expected is distinct from item.proof or item.request_id::text is distinct from item.proof#>>'{request,requestId}' or item.seller_revision is distinct from (item.proof->>'sellerRevision')::bigint or item.change_sha256 is distinct from item.proof->>'changeSha256' then raise exception using errcode='SQ004',message='Seller history differs from immutable source';end if;
  last_f:=(item.proof#>>'{request,expectedRevision}')::bigint;p:=public.zentra_us_pilot_seller_after(item.proof);
 end loop;
 select * into h from public.zentra_us_financial_seller_test_heads where organization_id=org for update;
 if (n=0 and found) or (n>0 and (not found or h.seller_revision is distinct from (p->>'sellerRevision')::bigint or h.change_index<>n or h.change_sha256 is distinct from p->>'changeSha256' or h.presentation is distinct from p)) then raise exception using errcode='SQ004',message='Seller head differs from immutable history';end if;
 return p;
end $$;
-- Public reads/new seller writes require the stable cursor. Historical invoice
-- provenance is also checked inside the financial cursor's BEFORE UPDATE guard,
-- where the validated event is present and its cursor has not advanced yet.
-- Both paths reconstruct from the real SQL book; no supplied book/bypass flag.
create function public.zentra_us_pilot_seller_history(org text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare b jsonb;c public.zentra_us_financial_test_cursors%rowtype;
begin
 b:=public.zentra_us_settlement_book(org);select * into c from public.zentra_us_financial_test_cursors where organization_id=org for update;
 if b is null or c.revision is distinct from (b->>'revision')::bigint or c.book_sha256 is distinct from public.zentra_us_financial_test_hash(b) then raise exception using errcode='SQ004',message='Corroborated financial source required';end if;
 return public.zentra_us_pilot_seller_history_reconstruct(org);
end $$;
create function public.zentra_us_pilot_seller_guard() returns trigger
language plpgsql volatile security invoker set search_path='' as $$
declare p jsonb;expected jsonb;previous jsonb;b jsonb;g bigint;o bigint;c public.zentra_us_financial_test_cursors%rowtype;
begin
 if tg_op not in('INSERT','UPDATE') or (tg_table_name='zentra_us_financial_seller_test_changes' and tg_op<>'INSERT') then raise exception using errcode='SQ004',message='Seller audit must be retained';end if;
 if tg_table_name='zentra_us_financial_seller_test_changes' then p:=new.proof;g:=new.grant_version;o:=new.opt_in_version;
 else
  select proof,grant_version,opt_in_version into p,g,o from public.zentra_us_financial_seller_test_changes where organization_id=new.organization_id and change_sha256=new.change_sha256;
  if p is null then raise exception using errcode='SQ004',message='Seller head requires its immutable change';end if;
 end if;
 perform public.zentra_us_financial_pilot_test_admit(new.organization_id,p->'actor',g,o,'postgres-test-financial-pilot-dto1');
 if p#>>'{actor,role}' is distinct from 'owner' then raise exception using errcode='PF005',message='Current owner required';end if;
 select * into c from public.zentra_us_financial_test_cursors where organization_id=new.organization_id for update;
 if p#>'{request,expectedRevision}' is distinct from to_jsonb(c.revision) then raise exception using errcode='SQ007',message='Financial revision changed';end if;
 if tg_table_name='zentra_us_financial_seller_test_changes' then
  previous:=public.zentra_us_pilot_seller_history(new.organization_id);b:=public.zentra_us_settlement_book(new.organization_id);
  expected:=public.zentra_us_pilot_seller_expected(new.organization_id,b,previous,p->'request',p->'actor');
  if p is distinct from expected or new.request_id::text is distinct from p#>>'{request,requestId}' or new.seller_revision is distinct from (p->>'sellerRevision')::bigint or new.change_index is distinct from (p->>'changeIndex')::integer or new.change_sha256 is distinct from p->>'changeSha256' then raise exception using errcode='SQ004',message='Independently reconstructed seller change required';end if;
 else
  if new.presentation is distinct from public.zentra_us_pilot_seller_after(p) or new.seller_revision is distinct from (p->>'sellerRevision')::bigint or new.change_index is distinct from (p->>'changeIndex')::integer then raise exception using errcode='SQ004',message='Exact seller head required';end if;
  if tg_op='UPDATE' and (new.organization_id is distinct from old.organization_id or new.seller_revision<>old.seller_revision+1 or new.change_index<>old.change_index+1 or p->'before' is distinct from old.presentation) then raise exception using errcode='SQ004',message='Monotone seller head required';end if;
  if tg_op='INSERT' and (new.change_index<>1 or p->'before' is distinct from public.zentra_us_pilot_seller_legacy(new.organization_id)) then raise exception using errcode='SQ004',message='Exact frozen seller source required';end if;
 end if;
 return new;
end $$;
create function public.zentra_us_pilot_seller_complete() returns trigger
language plpgsql volatile security invoker set search_path='' as $$
begin perform public.zentra_us_pilot_seller_history(new.organization_id);return null;end $$;
do $$declare t text;begin
 foreach t in array array['zentra_us_financial_seller_test_heads','zentra_us_financial_seller_test_changes'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select,insert,update on public.%I to service_role',t);
  execute format('create trigger seller_test_guard before insert or update or delete on public.%I for each row execute function public.zentra_us_pilot_seller_guard()',t);
  execute format('create trigger seller_test_no_truncate before truncate on public.%I for each statement execute function public.zentra_us_pilot_seller_guard()',t);
  execute format('create constraint trigger seller_test_atomic after insert or update on public.%I deferrable initially deferred for each row execute function public.zentra_us_pilot_seller_complete()',t);
 end loop;
end $$;

create function public.zentra_us_financial_pilot_seller_test_head_v1(p_organization text,p_actor jsonb,p_grant_version bigint,p_opt_in_version bigint,p_capability text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare h jsonb;p jsonb;
begin
 h:=public.zentra_us_financial_pilot_bank_test_head_v1(p_organization,p_actor,p_grant_version,p_opt_in_version,p_capability);
 p:=public.zentra_us_pilot_seller_history(p_organization);
 return jsonb_build_object('consumer','financial-pilot','schemaVersion',1,'organizationId',p_organization,'revision',h->'revision','bankRevision',h->'bankRevision','sellerRevision',p->'sellerRevision');
end $$;
create function public.zentra_read_us_financial_pilot_seller_test_v1(p_organization text,p_actor jsonb,p_grant_version bigint,p_opt_in_version bigint,p_capability text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare h jsonb;p jsonb;r jsonb;
begin
 h:=public.zentra_us_financial_pilot_seller_test_head_v1(p_organization,p_actor,p_grant_version,p_opt_in_version,p_capability);
 p:=public.zentra_us_pilot_seller_history(p_organization);r:=jsonb_build_object('head',h,'presentation',p);perform public.zentra_us_pilot_seller_budget(r);return r;
end $$;
create function public.zentra_us_financial_pilot_seller_test_receipt_v1(p_organization text,p_actor jsonb,p_grant_version bigint,p_opt_in_version bigint,p_capability text,p_request_id uuid) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare p jsonb;
begin
 perform public.zentra_us_financial_pilot_test_admit(p_organization,p_actor,p_grant_version,p_opt_in_version,p_capability);
 if p_request_id is null then raise exception using errcode='SQ004',message='Exact seller request ID required';end if;
 select proof into p from public.zentra_us_financial_seller_test_changes where organization_id=p_organization and request_id=p_request_id;
 if p is null then return null;end if;
 if p#>>'{actor,userId}' is distinct from p_actor->>'userId' then raise exception using errcode='SQ002',message='Seller receipt actor differs';end if;
 perform public.zentra_us_pilot_seller_history(p_organization);return p;
end $$;
create function public.zentra_append_us_financial_pilot_seller_test_v1(p_organization text,p_actor jsonb,p_grant_version bigint,p_opt_in_version bigint,p_capability text,p_request jsonb,p_proof jsonb) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare prior jsonb;h jsonb;p jsonb;expected jsonb;b jsonb;
begin
 perform public.zentra_us_financial_pilot_test_admit(p_organization,p_actor,p_grant_version,p_opt_in_version,p_capability);
 if p_actor->>'role' is distinct from 'owner' then raise exception using errcode='PF005',message='Current owner required';end if;
 if not public.zentra_us_pilot_seller_request(p_request) then raise exception using errcode='SQ004',message='Exact seller request required';end if;
 select proof into prior from public.zentra_us_financial_seller_test_changes where organization_id=p_organization and request_id=(p_request->>'requestId')::uuid;
 if prior is not null then
  if prior->'request' is distinct from p_request or prior#>>'{actor,userId}' is distinct from p_actor->>'userId' or prior->>'commandHash' is distinct from public.zentra_us_financial_test_hash(jsonb_build_array('zentra:us:financial-pilot:seller:v1',p_organization,p_actor->>'userId',p_request)) then raise exception using errcode='SQ002',message='Seller replay identity differs';end if;
  perform public.zentra_us_pilot_seller_history(p_organization);return prior;
 end if;
 h:=public.zentra_us_financial_pilot_seller_test_head_v1(p_organization,p_actor,p_grant_version,p_opt_in_version,p_capability);
 if h->'revision' is distinct from p_request->'expectedRevision' then raise exception using errcode='SQ007',message='Financial revision changed';end if;
 if h->'sellerRevision' is distinct from p_request->'expectedSellerRevision' then raise exception using errcode='SQ001',message='Seller revision changed';end if;
 p:=public.zentra_us_pilot_seller_history(p_organization);b:=public.zentra_us_settlement_book(p_organization);
 expected:=public.zentra_us_pilot_seller_expected(p_organization,b,p,p_request,p_actor);perform public.zentra_us_pilot_seller_budget(p_proof);
 if p_proof is distinct from expected then raise exception using errcode='SQ004',message='Seller proposal differs from independent reconstruction';end if;
 insert into public.zentra_us_financial_seller_test_changes values(p_organization,(p_request->>'requestId')::uuid,(expected->>'sellerRevision')::bigint,(expected->>'changeIndex')::integer,expected->>'changeSha256',expected,p_grant_version,p_opt_in_version);
 if exists(select 1 from public.zentra_us_financial_seller_test_heads where organization_id=p_organization) then
  update public.zentra_us_financial_seller_test_heads set seller_revision=(expected->>'sellerRevision')::bigint,change_index=(expected->>'changeIndex')::integer,change_sha256=expected->>'changeSha256',presentation=public.zentra_us_pilot_seller_after(expected) where organization_id=p_organization;
 else
  insert into public.zentra_us_financial_seller_test_heads values(p_organization,(expected->>'sellerRevision')::bigint,(expected->>'changeIndex')::integer,expected->>'changeSha256',public.zentra_us_pilot_seller_after(expected));
 end if;
 perform public.zentra_us_pilot_seller_history(p_organization);return expected;
end $$;

-- Compatible presentation contexts. The original fiscal payload and every
-- legacy hash remain immutable and independently corroborated.
create function public.zentra_us_pilot_seller_legacy_context_valid(c jsonb,org text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
begin
 return coalesce(public.zentra_us_tax_object(c,array['schemaVersion','organizationId','revision','countryRevision','configuration','sellerRevision','seller','taxFactsRevision','taxFacts','binding','merchant','admittedBy','admittedAt','contextSha256']) and c->'schemaVersion'='1'::jsonb and c->>'organizationId'=org
 and public.zentra_us_tax_strings(c,array['organizationId','admittedBy','admittedAt','contextSha256']) and public.zentra_us_tax_text_valid(c->>'admittedBy',256,true) and public.zentra_us_purchase_timestamp(c->>'admittedAt')
 and public.zentra_us_tax_revision(c->'revision') and public.zentra_us_tax_revision(c->'countryRevision') and public.zentra_us_tax_revision(c->'sellerRevision') and public.zentra_us_tax_revision(c->'taxFactsRevision')
 and public.zentra_country_config_valid(c->'configuration',org) and c->'configuration'->>'country'='US' and c->'configuration'->>'currency'='USD' and c->'configuration'->>'accountingBasis'='accrual' and c->'configuration'->'taxConfiguration'->>'status'='configured'
 and public.zentra_us_seller_profile_valid(c->'seller') and public.zentra_us_tax_facts_valid(c->'taxFacts') and c->'configuration'->>'timeZone'=c->'taxFacts'->>'timeZone'
 and public.zentra_us_tax_binding_valid(c->'binding',org,(c->'binding'->>'revision')::bigint)
 and public.zentra_us_tax_object(c->'merchant',array['credential','configurationFingerprint']) and public.zentra_us_tax_strings(c->'merchant',array['configurationFingerprint']) and c->'merchant'->>'configurationFingerprint' ~ '^[0-9a-f]{64}$'
 and public.zentra_us_tax_object(c->'merchant'->'credential',array['reference','revision','accountId']) and public.zentra_us_tax_strings(c->'merchant'->'credential',array['reference','accountId']) and public.zentra_us_tax_text_valid(c->'merchant'->'credential'->>'reference',256,true) and public.zentra_us_tax_revision(c->'merchant'->'credential'->'revision') and c->'merchant'->'credential'->>'accountId'=c->'binding'->>'accountId'
 and public.zentra_us_invoicing_instant(c->>'admittedAt') and public.zentra_us_invoicing_instant(c->'binding'->>'observedAt') and public.zentra_us_invoicing_instant(c->'binding'->>'validUntil') and (c->'binding'->>'observedAt')::timestamptz<=(c->>'admittedAt')::timestamptz and (c->>'admittedAt')::timestamptz<(c->'binding'->>'validUntil')::timestamptz and (c->'binding'->>'validUntil')::timestamptz-(c->'binding'->>'observedAt')::timestamptz<=interval '120 seconds'
 and c->>'contextSha256'=public.zentra_us_financial_test_hash(c-'contextSha256'),false);
exception when others then return false;end $$;

create function public.zentra_us_pilot_seller_invoice_base(c jsonb) returns jsonb
language sql immutable security invoker set search_path='' as $$
 select case when c->'schemaVersion'='2'::jsonb then (c-'presentation')||jsonb_build_object('schemaVersion',1,'contextSha256',c->'presentation'->>'baseContextSha256') else c end
$$;
create function public.zentra_us_pilot_seller_invoice_profile(c jsonb) returns jsonb
language sql immutable security invoker set search_path='' as $$
 select case when c->'schemaVersion'='2'::jsonb then c->'presentation'->'profile' else c->'seller' end
$$;
create or replace function public.zentra_us_invoicing_context_valid(c jsonb,org text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare p jsonb;
begin
 if c->'schemaVersion'='1'::jsonb then return public.zentra_us_pilot_seller_legacy_context_valid(c,org);end if;
 p:=c->'presentation';
 return coalesce(public.zentra_us_tax_object(c,array['schemaVersion','organizationId','revision','countryRevision','configuration','sellerRevision','seller','taxFactsRevision','taxFacts','binding','merchant','admittedBy','admittedAt','contextSha256','presentation']) and c->'schemaVersion'='2'::jsonb
 and public.zentra_us_pilot_seller_legacy_context_valid(public.zentra_us_pilot_seller_invoice_base(c),org)
 and public.zentra_us_tax_object(p,array['schemaVersion','baseContextRevision','baseContextSha256','origin','sellerRevision','sellerChangeSha256','profile']) and p->'schemaVersion'='1'::jsonb
 and p->'baseContextRevision'=c->'revision' and public.zentra_us_tax_revision(p->'sellerRevision') and public.zentra_us_tax_strings(p,array['baseContextSha256','origin']) and p->>'baseContextSha256' ~ '^[a-f0-9]{64}$'
 and public.zentra_us_seller_profile_valid(p->'profile') and ((p->>'origin'='legacy-frozen' and p->'sellerChangeSha256'='null'::jsonb) or (p->>'origin'='financial-v5' and jsonb_typeof(p->'sellerChangeSha256')='string' and p->>'sellerChangeSha256' ~ '^[a-f0-9]{64}$'))
 and jsonb_typeof(c->'contextSha256')='string' and c->>'contextSha256'=public.zentra_us_financial_test_hash(c-'contextSha256'),false);
exception when others then return false;end $$;
create function public.zentra_us_pilot_seller_legacy_preparation_valid(p jsonb,org text,actor_id text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare legacy jsonb;c jsonb;request jsonb;
begin
 if not public.zentra_us_tax_object(p,array['schemaVersion','organizationId','actorId','request','financialCommandHash','erpRequest','erpCommandHash','previousBookFingerprint','context','estimate','estimateSha256','classifications','taxDateInstant','addressSource','preparedAt','preparationSha256']) or p->'schemaVersion' is distinct from '1'::jsonb or p->>'organizationId' is distinct from org or p->>'actorId' is distinct from actor_id or not public.zentra_us_tax_strings(p,array['organizationId','actorId','financialCommandHash','erpCommandHash','previousBookFingerprint','estimateSha256','taxDateInstant','addressSource','preparedAt','preparationSha256']) or p->>'previousBookFingerprint' !~ '^[0-9a-f]{64}$' or not public.zentra_us_purchase_timestamp(p->>'preparedAt') then return false;end if;
 request:=p->'request';c:=p->'context';
 if not public.zentra_us_tax_object(request,array['idempotencyKey','expectedRevision','command']) or not public.zentra_us_tax_object(request->'command',array['type','request']) or request->'command'->>'type' is distinct from 'erp_command' or p->'erpRequest' is distinct from jsonb_build_object('idempotencyKey',request->>'idempotencyKey','expectedRevision',request->'expectedRevision','command',request->'command'->'request') or request->>'idempotencyKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' or p->>'financialCommandHash' is distinct from public.zentra_us_financial_test_hash(jsonb_build_array(org,actor_id,request)) or not public.zentra_us_invoicing_context_valid(c,org) or p->>'preparationSha256' is distinct from public.zentra_us_financial_test_hash(p-'preparationSha256') then return false;end if;
 if (p->'estimate' ? 'projectId' and not public.zentra_us_tax_text_valid(p->'estimate'->>'projectId',160,true)) or not public.zentra_us_invoicing_instant(p->>'preparedAt') or (p->>'preparedAt')::timestamptz<(c->>'admittedAt')::timestamptz or (p->>'preparedAt')::timestamptz>=(c->'binding'->>'validUntil')::timestamptz or abs(extract(epoch from (p->>'taxDateInstant')::timestamptz-(p->>'preparedAt')::timestamptz))>31*86400 then return false;end if;
 legacy:=jsonb_build_object('schemaVersion',1,'organizationId',org,'actorUserId',actor_id,'request',p->'erpRequest','commandHash',p->>'erpCommandHash','context',c-array['schemaVersion','revision','merchant','admittedBy','admittedAt','contextSha256'],'merchant',c->'merchant','estimate',p->'estimate','estimateSha256',p->>'estimateSha256','classifications',p->'classifications','taxDateInstant',p->>'taxDateInstant','addressSource',p->>'addressSource');
 return public.zentra_us_invoicing_review_valid(legacy,org,actor_id,p->>'financialCommandHash');
exception when others then return false;end $$;

create or replace function public.zentra_us_invoicing_preparation_valid(p jsonb,org text,actor_id text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare transformed jsonb;
begin
 if p->'context'->'schemaVersion'='1'::jsonb then return public.zentra_us_pilot_seller_legacy_preparation_valid(p,org,actor_id);end if;
 if not public.zentra_us_invoicing_context_valid(p->'context',org) or p->>'preparationSha256' is distinct from public.zentra_us_financial_test_hash(p-'preparationSha256') then return false;end if;
 transformed:=jsonb_set(p,'{context}',public.zentra_us_pilot_seller_invoice_base(p->'context'))-'preparationSha256';
 transformed:=transformed||jsonb_build_object('preparationSha256',public.zentra_us_financial_test_hash(transformed));
 return public.zentra_us_pilot_seller_legacy_preparation_valid(transformed,org,actor_id);
exception when others then return false;end $$;
create function public.zentra_us_pilot_seller_invoice_context(org text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare c jsonb;s jsonb;p jsonb;
begin
 c:=public.zentra_us_invoicing_context(org);s:=public.zentra_us_pilot_seller_history(org);
 p:=jsonb_build_object('schemaVersion',1,'baseContextRevision',c->'revision','baseContextSha256',c->>'contextSha256','origin',s->>'origin','sellerRevision',s->'sellerRevision','sellerChangeSha256',s->'changeSha256','profile',s->'profile');
 c:=(c-'contextSha256')||jsonb_build_object('schemaVersion',2,'presentation',p);c:=c||jsonb_build_object('contextSha256',public.zentra_us_financial_test_hash(c));
 if not public.zentra_us_invoicing_context_valid(c,org) then raise exception using errcode='PF004',message='Corroborated presentation context required';end if;
 return c;
end $$;
-- History corroborates the immutable original base and the recorded S. It does
-- not require that S remain current, that an old actor remain admitted, or that
-- an old observation remain unexpired. Freshness belongs to new-action guards.
create function public.zentra_us_pilot_seller_invoice_provenance(org text,c jsonb) returns boolean
language plpgsql volatile security invoker set search_path='' as $$
declare base jsonb;s jsonb;p jsonb;proof jsonb;
begin
 if not public.zentra_us_invoicing_context_valid(c,org) then return false;end if;
 base:=public.zentra_us_pilot_seller_invoice_base(c);
 if not exists(select 1 from public.zentra_us_financial_invoice_test_contexts q where q.organization_id=org and q.revision=(base->>'revision')::bigint and q.payload=base) then return false;end if;
 if c->'schemaVersion'='1'::jsonb then return true;end if;
 perform public.zentra_us_pilot_seller_history_reconstruct(org);p:=c->'presentation';
 if p->>'origin'='legacy-frozen' then
  s:=public.zentra_us_pilot_seller_legacy(org);
  return p->'sellerRevision'=s->'sellerRevision' and p->'profile'=s->'profile' and p->'sellerChangeSha256'='null'::jsonb;
 end if;
 select x.proof into proof from public.zentra_us_financial_seller_test_changes x where x.organization_id=org and x.change_sha256=p->>'sellerChangeSha256' and x.seller_revision=(p->>'sellerRevision')::bigint;
 return coalesce(proof is not null and public.zentra_us_pilot_seller_after(proof)->'profile'=p->'profile',false);
exception when others then return false;end $$;
create or replace function public.zentra_us_invoicing_preparation_current(org text,p jsonb,a jsonb) returns void
language plpgsql volatile security invoker set search_path='' as $$
declare b jsonb;c jsonb;e jsonb;durable boolean;head public.zentra_us_financial_test_cursors%rowtype;
begin
 select * into head from public.zentra_us_financial_test_cursors where organization_id=org for update;
 b:=public.zentra_us_settlement_book(org);
 if head.revision is distinct from (b->>'revision')::bigint or head.book_sha256 is distinct from public.zentra_us_financial_test_hash(b) then raise exception using errcode='PF004',message='Exact invoice cursor required';end if;
 -- These locks are acquired on both branches. S append and first reservation
 -- therefore share the same F cursor and seller-history serialization point.
 c:=public.zentra_us_invoicing_context(org);perform public.zentra_us_pilot_seller_history(org);
 e:=public.zentra_us_invoicing_command(b,p->'erpRequest'->'command',p->'erpRequest'->'command'->>'id');
 select exists(select 1 from public.zentra_us_financial_invoice_test_operations o where o.organization_id=org and o.idempotency_key=p->'request'->>'idempotencyKey' and o.payload->'preparation'=p) into durable;
 if b->'revision' is distinct from p->'request'->'expectedRevision' or public.zentra_us_financial_test_hash(b) is distinct from p->>'previousBookFingerprint' or e is distinct from p->'estimate' or not public.zentra_us_pilot_seller_invoice_provenance(org,p->'context')
 or (p->'context'->'binding'->>'observedAt')::timestamptz>clock_timestamp() or (p->'context'->'binding'->>'validUntil')::timestamptz<=clock_timestamp()
 then raise exception using errcode='PF001',message='Reviewed financial invoice source changed';end if;
 if not durable then
  if p->'context'->'schemaVersion'='2'::jsonb then c:=public.zentra_us_pilot_seller_invoice_context(org);
  elsif exists(select 1 from public.zentra_us_financial_seller_test_heads where organization_id=org) then raise exception using errcode='PF001',message='New reservation requires current seller presentation';end if;
  if c is distinct from p->'context' then raise exception using errcode='PF001',message='Reviewed seller presentation changed';end if;
 end if;
 if (p->>'preparedAt')::timestamptz>clock_timestamp()+interval '30 seconds' or abs(extract(epoch from (p->>'taxDateInstant')::timestamptz-clock_timestamp()))>31*86400 then raise exception using errcode='PF016',message='Original invoice review clock unavailable';end if;
 perform public.zentra_us_invoicing_source(org,e,a->>'timestamp');
end $$;
create or replace function public.zentra_us_invoicing_operation_guard() returns trigger
language plpgsql volatile security invoker set search_path='' as $$
declare p jsonb;e jsonb;b jsonb;expected_receipt jsonb;proof jsonb;
begin
 if tg_op not in('INSERT','UPDATE') then raise exception using errcode='PF003',message='Invoice operations must be retained';end if;
 perform public.zentra_us_invoicing_admit(new.organization_id,new.authority,new.grant_version,'postgres-test-invoicing-v5');perform public.zentra_us_financial_test_budget(new.payload);
 select payload into p from public.zentra_us_financial_invoice_test_preparations where organization_id=new.organization_id and idempotency_key=new.idempotency_key for update;
 if p is null or p is distinct from new.payload->'preparation' or p->>'actorId' is distinct from new.authority->>'userId' or new.operation_id::text is distinct from new.payload->>'operationId' or not public.zentra_us_invoicing_operation_valid(new.payload,new.organization_id) then raise exception using errcode='PF004',message='Corroborated private invoice operation required';end if;
 if tg_op='INSERT' then
  if exists(select 1 from public.zentra_us_financial_invoice_test_operations where organization_id=new.organization_id and (operation_id=new.operation_id or payload->>'providerKey'=new.payload->>'providerKey' or payload->'preparation'->'erpRequest'->'command'->>'id'=p->'erpRequest'->'command'->>'id')) then raise exception using errcode='PF002',message='Fiscal operation identity remains reserved';end if;
  if exists(select 1 from public.zentra_us_tax_operations where organization_id=new.organization_id and (operation_id=new.operation_id or invoice_id=p->'erpRequest'->'command'->>'id' or provider_idempotency_key=new.payload->>'providerKey')) then raise exception using errcode='PF002',message='Legacy fiscal identifiers remain reserved';end if;
  if new.payload->>'status'<>'reserved' or (new.payload->>'reservedAt')::timestamptz>clock_timestamp()+interval '30 seconds' or (new.payload->>'reservedAt')::timestamptz<(p->>'preparedAt')::timestamptz then raise exception using errcode='PF016',message='Original invoice reservation clock required';end if;perform public.zentra_us_invoicing_preparation_current(new.organization_id,p,new.authority);
 else
  if new.organization_id is distinct from old.organization_id or new.operation_id is distinct from old.operation_id or new.idempotency_key is distinct from old.idempotency_key or new.authority is distinct from old.authority or new.grant_version is distinct from old.grant_version or new.payload-array['status','proofBody','proofSha256','assessment','receipt'] is distinct from old.payload-array['status','proofBody','proofSha256','assessment','receipt'] then raise exception using errcode='PF003',message='Invoice operation identity is immutable';end if;
  if old.payload->>'status'='reserved' and new.payload->>'status'='calculated' then
   if (old.payload->>'retryUntil')::timestamptz<=clock_timestamp() then raise exception using errcode='PF014',message='Original invoice retry window expired';end if;perform public.zentra_us_invoicing_preparation_current(new.organization_id,p,new.authority);proof:=(new.payload->>'proofBody')::jsonb;
   if (proof->>'calculatedAt')::timestamptz>clock_timestamp() or (new.payload->'assessment'->>'validUntil')::timestamptz<=clock_timestamp() then raise exception using errcode='PF014',message='Fresh original invoice proof required';end if;
  elsif old.payload->>'status'='calculated' and new.payload->>'status'='committed' then
   if new.payload-array['status','receipt'] is distinct from old.payload-array['status','receipt'] then raise exception using errcode='PF003',message='Invoice proof is immutable';end if;
   b:=public.zentra_us_settlement_book(new.organization_id);select payload into e from public.zentra_us_financial_test_events where organization_id=new.organization_id and payload->'operation'->>'idempotencyKey'=new.idempotency_key;
   expected_receipt:=public.zentra_us_settlement_receipt(b,e);
   if e is null or e->'operation'->'command' is distinct from p->'erpRequest'->'command' or e->'actor'->>'userId' is distinct from p->>'actorId' or e->'operation'->'facts'->'taxAssessment' is distinct from new.payload->'assessment' or e->'operation'->'facts'->'sellerSnapshot' is distinct from (jsonb_build_object('organizationId',new.organization_id)||public.zentra_us_pilot_seller_invoice_profile(p->'context')) or new.payload->'receipt' is distinct from expected_receipt or expected_receipt->>'commandHash' is distinct from p->>'financialCommandHash' or not exists(select 1 from public.zentra_us_financial_test_receipts r where r.organization_id=new.organization_id and r.idempotency_key=new.idempotency_key and r.receipt=expected_receipt) then raise exception using errcode='PF004',message='Exact atomic invoice event and receipt required';end if;
  else raise exception using errcode='PF003',message='Invoice operation transition is immutable';end if;
 end if;return new;
end $$;
create or replace function public.zentra_us_invoicing_plans(b jsonb,completed boolean default true) returns void
language plpgsql volatile security invoker set search_path='' as $$
declare e jsonb;plan public.zentra_us_financial_test_tax_plans%rowtype;o public.zentra_us_financial_invoice_test_operations%rowtype;p jsonb;prefix jsonb;org text:=b->'baseline'->'configuration'->>'organizationId';
begin
 for e in select value from jsonb_array_elements(b->'events') loop
  if e->'operation'->>'type'='customer_credit' then
   select * into plan from public.zentra_us_financial_test_tax_plans where organization_id=org and idempotency_key=e->'operation'->>'idempotencyKey';
   if not found or plan.invoice_id is distinct from e->'operation'->>'invoiceId' or plan.proof is distinct from e->'operation'->'taxProof' then raise exception using errcode='PF014',message='Private TEST tax plan required';end if;
  elsif e->'operation'->'command'->>'type'='issue_invoice' then
   select * into o from public.zentra_us_financial_invoice_test_operations where organization_id=org and idempotency_key=e->'operation'->>'idempotencyKey';p:=o.payload->'preparation';
   prefix:=b||jsonb_build_object('revision',(e->>'revision')::bigint-1,'events',(select coalesce(jsonb_agg(x order by n),'[]'::jsonb) from jsonb_array_elements(b->'events') with ordinality t(x,n) where (x->>'revision')::bigint<(e->>'revision')::bigint));
   if o.payload is null or not public.zentra_us_invoicing_operation_valid(o.payload,org) or o.payload->>'status' not in('calculated','committed') or (completed and o.payload->>'status'<>'committed')
    or public.zentra_us_invoicing_command(prefix,p->'erpRequest'->'command',p->'erpRequest'->'command'->>'id') is distinct from p->'estimate' or p->'context'->'configuration' is distinct from b->'baseline'->'configuration' or p->'request'->'expectedRevision' is distinct from prefix->'revision' or p->>'previousBookFingerprint' is distinct from public.zentra_us_financial_test_hash(prefix)
    or e->'actor'->>'userId' is distinct from p->>'actorId' or e->'operation'->'command' is distinct from p->'erpRequest'->'command'
    or e->'operation'->'facts'->'taxAssessment' is distinct from o.payload->'assessment' or e->'operation'->'facts'->'sellerSnapshot' is distinct from (jsonb_build_object('organizationId',org)||public.zentra_us_pilot_seller_invoice_profile(p->'context'))
    or not exists(select 1 from public.zentra_us_financial_invoice_test_preparations q where q.organization_id=org and q.idempotency_key=o.idempotency_key and q.payload=p)
    or not public.zentra_us_pilot_seller_invoice_provenance(org,p->'context')
    or (completed and (o.payload->'receipt' is distinct from public.zentra_us_settlement_receipt(b,e) or not exists(select 1 from public.zentra_us_financial_test_receipts q where q.organization_id=org and q.idempotency_key=o.idempotency_key and q.receipt=o.payload->'receipt')))
   then raise exception using errcode='PF014',message='Corroborated original invoice operation required';end if;
  end if;
 end loop;
end $$;
create function public.zentra_us_pilot_seller_invoice_preflight(p_organization text,p_actor jsonb,p_grant_version bigint,p_capability text,p_request jsonb,p_financial_command_hash text,p_erp_command_hash text,p_previous_fingerprint text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare b jsonb;c jsonb;e jsonb;inner_request jsonb;prior jsonb;
begin
 b:=public.zentra_read_us_financial_invoicing_test_v5(p_organization,p_actor,p_grant_version,p_capability);
 perform public.zentra_us_financial_test_budget(p_request);
 if not public.zentra_us_tax_object(p_request,array['idempotencyKey','expectedRevision','command']) or not public.zentra_us_tax_object(p_request->'command',array['type','request']) or p_request->'command'->>'type' is distinct from 'erp_command' or p_request->>'idempotencyKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' then raise exception using errcode='PF004',message='Exact invoice financial request required';end if;
 inner_request:=jsonb_build_object('idempotencyKey',p_request->>'idempotencyKey','expectedRevision',p_request->'expectedRevision','command',p_request->'command'->'request');
 if p_financial_command_hash is distinct from public.zentra_us_financial_test_hash(jsonb_build_array(p_organization,p_actor->>'userId',p_request)) or p_erp_command_hash is distinct from public.zentra_us_financial_test_hash(jsonb_build_array(p_organization,p_actor->>'userId',inner_request)) then raise exception using errcode='PF002',message='Distinct exact financial and ERP request hashes required';end if;
 if b is null or b->'revision' is distinct from p_request->'expectedRevision' or public.zentra_us_financial_test_hash(b) is distinct from p_previous_fingerprint then raise exception using errcode='PF001',message='Financial invoice source changed';end if;
 if exists(select 1 from public.zentra_us_financial_test_receipts where organization_id=p_organization and idempotency_key=p_request->>'idempotencyKey') or exists(select 1 from public.zentra_us_tax_operations where organization_id=p_organization and erp_idempotency_key=p_request->>'idempotencyKey') or exists(select 1 from public.zentra_us_tax_invoice_preparations where organization_id=p_organization and erp_idempotency_key=p_request->>'idempotencyKey') then raise exception using errcode='PF002',message='Fiscal request key remains reserved';end if;
 select payload into prior from public.zentra_us_financial_invoice_test_preparations where organization_id=p_organization and idempotency_key=p_request->>'idempotencyKey' for update;
 if prior is not null and (prior->'request' is distinct from p_request or prior->>'actorId' is distinct from p_actor->>'userId' or prior->>'financialCommandHash' is distinct from p_financial_command_hash or prior->>'erpCommandHash' is distinct from p_erp_command_hash) then raise exception using errcode='PF002',message='Prepared fiscal identity differs';end if;
 if exists(select 1 from public.zentra_us_financial_invoice_test_operations where organization_id=p_organization and idempotency_key<>p_request->>'idempotencyKey' and payload->'preparation'->'erpRequest'->'command'->>'id'=p_request->'command'->'request'->>'id') then raise exception using errcode='PF002',message='Prepared invoice identity remains reserved';end if;
 if exists(select 1 from public.zentra_us_tax_operations where organization_id=p_organization and invoice_id=p_request->'command'->'request'->>'id') or exists(select 1 from public.zentra_us_tax_invoice_preparations where organization_id=p_organization and preparation->'request'->'command'->>'id'=p_request->'command'->'request'->>'id') then raise exception using errcode='PF002',message='Legacy invoice identity remains reserved';end if;
 e:=public.zentra_us_invoicing_command(b,p_request->'command'->'request',p_request->'command'->'request'->>'id');perform public.zentra_us_invoicing_source(p_organization,e,p_actor->>'timestamp');if prior is not null and exists(select 1 from public.zentra_us_financial_invoice_test_operations o where o.organization_id=p_organization and o.idempotency_key=p_request->>'idempotencyKey' and o.payload->'preparation'=prior) then perform public.zentra_us_invoicing_preparation_current(p_organization,prior,p_actor);c:=prior->'context';else c:=public.zentra_us_pilot_seller_invoice_context(p_organization);end if;
 if c->'configuration' is distinct from b->'baseline'->'configuration' then raise exception using errcode='PF007',message='Exact financial configuration required';end if;
 return jsonb_build_object('context',c,'estimate',e,'bookRevision',b->'revision','bookFingerprint',public.zentra_us_financial_test_hash(b));
end $$;
create function public.zentra_us_financial_pilot_invoice_test_context_seller_v1(p_organization text,p_actor jsonb,p_grant_version bigint,p_opt_in_version bigint,p_capability text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
begin
 perform public.zentra_us_financial_pilot_test_admit(p_organization,p_actor,p_grant_version,p_opt_in_version,p_capability);
 return public.zentra_us_pilot_seller_invoice_context(p_organization);
end $$;
create function public.zentra_read_us_financial_pilot_invoice_test_operation_seller_v1(p_organization text,p_actor jsonb,p_grant_version bigint,p_opt_in_version bigint,p_capability text,p_idempotency_key text,p_financial_command_hash text,p_erp_command_hash text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
begin
 perform public.zentra_us_financial_pilot_test_admit(p_organization,p_actor,p_grant_version,p_opt_in_version,p_capability);
 return public.zentra_read_us_financial_invoice_test_operation_v5(p_organization,p_actor,p_grant_version,'postgres-test-invoicing-v5',p_idempotency_key,p_financial_command_hash,p_erp_command_hash);
end $$;
create function public.zentra_preflight_us_financial_pilot_invoice_test_seller_v1(p_organization text,p_actor jsonb,p_grant_version bigint,p_opt_in_version bigint,p_capability text,p_request jsonb,p_financial_command_hash text,p_erp_command_hash text,p_previous_fingerprint text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
begin
 perform public.zentra_us_financial_pilot_test_admit(p_organization,p_actor,p_grant_version,p_opt_in_version,p_capability);
 return public.zentra_us_pilot_seller_invoice_preflight(p_organization,p_actor,p_grant_version,'postgres-test-invoicing-v5',p_request,p_financial_command_hash,p_erp_command_hash,p_previous_fingerprint);
end $$;
create function public.zentra_reserve_us_financial_pilot_invoice_test_seller_v1(p_organization text,p_actor jsonb,p_grant_version bigint,p_opt_in_version bigint,p_capability text,p_preparation jsonb,p_resolved_body text,p_resolved_sha256 text,p_params_body text,p_params_sha256 text,p_provider_idempotency_key text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
begin
 perform public.zentra_us_financial_pilot_test_admit(p_organization,p_actor,p_grant_version,p_opt_in_version,p_capability);
 return public.zentra_reserve_us_financial_invoice_test_v5(p_organization,p_actor,p_grant_version,'postgres-test-invoicing-v5',p_preparation,p_resolved_body,p_resolved_sha256,p_params_body,p_params_sha256,p_provider_idempotency_key);
end $$;
create function public.zentra_record_us_financial_pilot_invoice_test_calculation_seller_v1(p_organization text,p_actor jsonb,p_grant_version bigint,p_opt_in_version bigint,p_capability text,p_operation_id uuid,p_proof_body text,p_proof_sha256 text,p_assessment jsonb) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
begin
 perform public.zentra_us_financial_pilot_test_admit(p_organization,p_actor,p_grant_version,p_opt_in_version,p_capability);
 return public.zentra_record_us_financial_invoice_test_calculation_v5(p_organization,p_actor,p_grant_version,'postgres-test-invoicing-v5',p_operation_id,p_proof_body,p_proof_sha256,p_assessment);
end $$;

do $$declare f record;begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'zentra_us_pilot_seller_%' or p.proname in('zentra_read_us_financial_pilot_seller_test_v1','zentra_us_financial_pilot_seller_test_head_v1','zentra_us_financial_pilot_seller_test_receipt_v1','zentra_append_us_financial_pilot_seller_test_v1','zentra_us_financial_pilot_invoice_test_context_seller_v1','zentra_read_us_financial_pilot_invoice_test_operation_seller_v1','zentra_preflight_us_financial_pilot_invoice_test_seller_v1','zentra_reserve_us_financial_pilot_invoice_test_seller_v1','zentra_record_us_financial_pilot_invoice_test_calculation_seller_v1')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
commit;
