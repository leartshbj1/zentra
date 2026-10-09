-- Private TEST merchant admission only. No hosted apply, provider calls, legal
-- classification, ERP mutation, credential secrets or changes to CH records.
begin;

create function public.zentra_us_tax_merchant_payload_valid(p jsonb,org text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare c jsonb;k jsonb;o jsonb;v_until timestamptz;v_observed timestamptz;
begin
  if not public.zentra_us_tax_object(p,array['context','credential','configurationFingerprint','observation','validUntil'])
    or jsonb_typeof(p->'configurationFingerprint') is distinct from 'string' or p->>'configurationFingerprint' !~ '^[0-9a-f]{64}$' then return false;end if;
  c:=p->'context';k:=p->'credential';o:=p->'observation';
  if not public.zentra_us_tax_object(c,array['organizationId','countryRevision','configuration','sellerRevision','seller','taxFactsRevision','taxFacts','bindingRevision'])
    or c->>'organizationId' is distinct from org
    or not public.zentra_us_tax_revision(c->'countryRevision') or not public.zentra_us_tax_revision(c->'sellerRevision') or not public.zentra_us_tax_revision(c->'taxFactsRevision')
    or not public.zentra_us_tax_revision(c->'bindingRevision',0) or (c->>'bindingRevision')::numeric>=9007199254740990
    or not public.zentra_country_config_valid(c->'configuration',org) or c->'configuration'->>'country' is distinct from 'US' or c->'configuration'->>'currency' is distinct from 'USD'
    or not public.zentra_us_seller_profile_valid(c->'seller') or not public.zentra_us_tax_facts_valid(c->'taxFacts')
    or c->'taxFacts'->>'timeZone' is distinct from c->'configuration'->>'timeZone'
    or not public.zentra_us_tax_object(k,array['reference','revision','accountId']) or not public.zentra_us_tax_strings(k,array['reference','accountId'])
    or not public.zentra_us_tax_text_valid(k->>'reference',256,true) or k->>'accountId' !~ '^acct_[A-Za-z0-9]{1,95}$'
    or not public.zentra_us_tax_safe_integer(k->'revision',1)
    or not public.zentra_us_tax_object(o,array['organizationId','accountId','mode','apiVersion','settingsSha256','registrationsSha256','observedAt','taxOrigin'])
    or not public.zentra_us_tax_strings(o,array['organizationId','accountId','mode','apiVersion','settingsSha256','registrationsSha256','observedAt'])
    or o->>'organizationId' is distinct from org or o->>'accountId' is distinct from k->>'accountId' or o->>'mode' is distinct from 'test'
    or o->>'apiVersion' is distinct from '2026-08-26.dahlia' or o->>'settingsSha256' !~ '^[0-9a-f]{64}$' or o->>'registrationsSha256' !~ '^[0-9a-f]{64}$'
    or o->'taxOrigin' is distinct from c->'taxFacts'->'taxOrigin'
    or not public.zentra_us_tax_instant(o->>'observedAt') or jsonb_typeof(p->'validUntil') is distinct from 'string' or not public.zentra_us_tax_instant(p->>'validUntil') then return false;end if;
  v_observed:=(o->>'observedAt')::timestamptz;v_until:=(p->>'validUntil')::timestamptz;
  return v_until>v_observed and v_until<=v_observed+interval '120 seconds';
exception when others then return false;end $$;

create function public.zentra_us_tax_merchant_result(p jsonb,org text,request_id uuid,actor_id text) returns jsonb
language sql immutable security invoker set search_path='' as $$
  select jsonb_build_object('schemaVersion',1,'organizationId',org,'requestId',request_id,'actorUserId',actor_id,
    'countryRevision',(p->'context'->>'countryRevision')::bigint+case when p->'context'->'configuration'->'taxConfiguration'->>'status'='unconfigured' then 1 else 0 end,
    'configurationChanged',p->'context'->'configuration'->'taxConfiguration'->>'status'='unconfigured',
    'credential',p->'credential','configurationFingerprint',p->>'configurationFingerprint',
    'binding',jsonb_build_object('organizationId',org,'accountId',p->'credential'->>'accountId','mode','test','apiVersion','2026-08-26.dahlia',
      'revision',(p->'context'->>'bindingRevision')::bigint+1,'settingsSha256',p->'observation'->>'settingsSha256',
      'registrationsSha256',p->'observation'->>'registrationsSha256','observedAt',p->'observation'->>'observedAt','validUntil',p->>'validUntil',
      'evidenceKind','provider_observation','scope','erp_invoice_tax'));
$$;

create table public.zentra_us_tax_merchant_admissions(
  organization_id text not null references public.zentra_workspace_country_configs(organization_id) on delete restrict,
  request_id uuid not null check(request_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  actor_id text not null check(public.zentra_us_tax_text_valid(actor_id,256,true)),
  binding_revision bigint not null check(binding_revision between 1 and 9007199254740990),
  payload jsonb not null check(public.zentra_us_tax_merchant_payload_valid(payload,organization_id)),
  result jsonb not null,
  admitted_at timestamptz not null check(isfinite(admitted_at)),
  primary key(organization_id,request_id),unique(organization_id,binding_revision),
  foreign key(organization_id,binding_revision) references public.zentra_us_tax_provider_binding_changes(organization_id,revision) on delete restrict,
  check(result=public.zentra_us_tax_merchant_result(payload,organization_id,request_id,actor_id)),
  check(binding_revision=(result->'binding'->>'revision')::bigint)
);

create function public.zentra_guard_us_tax_merchant_admission() returns trigger
language plpgsql security invoker set search_path='' as $$
declare c public.zentra_workspace_country_configs%rowtype;s public.zentra_us_seller_profiles%rowtype;f public.zentra_us_tax_profiles%rowtype;b public.zentra_us_tax_provider_binding_changes%rowtype;expected_config jsonb;
begin
  if tg_op<>'INSERT' then raise exception using errcode='PM009',message='TEST merchant admission is immutable';end if;
  perform public.zentra_lock_us_tax_context(new.organization_id);
  if not coalesce(public.zentra_us_tax_merchant_payload_valid(new.payload,new.organization_id),false) then raise exception using errcode='PM004',message='Invalid TEST merchant admission';end if;
  new.admitted_at:=clock_timestamp();
  if (new.payload->'observation'->>'observedAt')::timestamptz>new.admitted_at
    or (new.payload->'observation'->>'observedAt')::timestamptz<new.admitted_at-interval '120 seconds'
    or (new.payload->>'validUntil')::timestamptz<=new.admitted_at then raise exception using errcode='PM006',message='TEST observation expired';end if;
  select * into c from public.zentra_workspace_country_configs where organization_id=new.organization_id;
  select * into s from public.zentra_us_seller_profiles where organization_id=new.organization_id;
  select * into f from public.zentra_us_tax_profiles where organization_id=new.organization_id;
  select * into b from public.zentra_us_tax_provider_binding_changes where organization_id=new.organization_id and request_id=new.request_id;
  expected_config:=jsonb_set(new.payload->'context'->'configuration','{taxConfiguration,status}','"configured"'::jsonb);
  if c.country is distinct from 'US' or c.currency is distinct from 'USD' or c.config is distinct from expected_config
    or c.revision is distinct from (new.result->>'countryRevision')::bigint
    or s.revision is distinct from (new.payload->'context'->>'sellerRevision')::bigint or s.profile is distinct from new.payload->'context'->'seller'
    or f.revision is distinct from (new.payload->'context'->>'taxFactsRevision')::bigint or f.facts is distinct from new.payload->'context'->'taxFacts'
    or b.revision is distinct from new.binding_revision or b.previous_revision is distinct from (new.payload->'context'->>'bindingRevision')::bigint
    or b.snapshot is distinct from new.result->'binding' or b.changed_by is distinct from new.actor_id
    or not exists(select 1 from public.zentra_us_tax_provider_bindings h where h.organization_id=new.organization_id and h.revision=new.binding_revision and h.snapshot=new.result->'binding') then
    raise exception using errcode='PM001',message='TEST merchant snapshot changed';end if;
  if new.payload->'context'->'configuration'->'taxConfiguration'->>'status'='unconfigured' and not exists(
    select 1 from public.zentra_workspace_country_config_changes h where h.organization_id=new.organization_id and h.request_id=new.request_id
      and h.previous_revision=(new.payload->'context'->>'countryRevision')::bigint and h.previous_config=new.payload->'context'->'configuration'
      and h.revision=c.revision and h.config=c.config and h.changed_by=new.actor_id) then raise exception using errcode='PM001',message='TEST country admission history missing';end if;
  return new;
end $$;
create trigger zentra_us_tax_merchant_immutable before insert or update or delete on public.zentra_us_tax_merchant_admissions for each row execute function public.zentra_guard_us_tax_merchant_admission();
create trigger zentra_us_tax_merchant_no_truncate before truncate on public.zentra_us_tax_merchant_admissions for each statement execute function public.zentra_guard_us_tax_merchant_admission();

create function public.zentra_read_us_tax_merchant_context(p_organization text,p_actor jsonb) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare c public.zentra_workspace_country_configs%rowtype;s public.zentra_us_seller_profiles%rowtype;f public.zentra_us_tax_profiles%rowtype;b bigint;
begin
  if not coalesce(public.zentra_us_tax_actor_valid(p_actor,p_organization),false) or p_actor->>'role' is distinct from 'owner' then raise exception using errcode='PM005',message='Owner authority required';end if;
  select * into c from public.zentra_workspace_country_configs where organization_id=p_organization;
  if c.country is distinct from 'US' or c.currency is distinct from 'USD' then raise exception using errcode='PM003',message='US workspace required';end if;
  select * into s from public.zentra_us_seller_profiles where organization_id=p_organization;
  if not found then raise exception using errcode='PM007',message='Seller required';end if;
  select * into f from public.zentra_us_tax_profiles where organization_id=p_organization;
  if not found then raise exception using errcode='PM008',message='Tax declaration required';end if;
  if f.facts->>'timeZone' is distinct from c.config->>'timeZone' then raise exception using errcode='PM001',message='Tax declaration time zone changed';end if;
  select revision into b from public.zentra_us_tax_provider_bindings where organization_id=p_organization;
  return jsonb_build_object('organizationId',p_organization,'countryRevision',c.revision,'configuration',c.config,'sellerRevision',s.revision,'seller',s.profile,'taxFactsRevision',f.revision,'taxFacts',f.facts,'bindingRevision',coalesce(b,0));
end $$;

create function public.zentra_read_us_tax_merchant_receipt(p_organization text,p_actor jsonb,p_request_id uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare r public.zentra_us_tax_merchant_admissions%rowtype;
begin
  if not coalesce(public.zentra_us_tax_actor_valid(p_actor,p_organization),false) or p_actor->>'role' is distinct from 'owner' then raise exception using errcode='PM005',message='Owner authority required';end if;
  if not exists(select 1 from public.zentra_workspace_country_configs where organization_id=p_organization and country='US' and currency='USD') then raise exception using errcode='PM003',message='US workspace required';end if;
  if p_request_id is null then raise exception using errcode='PM004',message='Request required';end if;
  select * into r from public.zentra_us_tax_merchant_admissions where organization_id=p_organization and request_id=p_request_id;
  if not found then return null;end if;
  if r.actor_id is distinct from p_actor->>'userId' then raise exception using errcode='PM002',message='TEST merchant request conflict';end if;
  return r.result;
end $$;

create function public.zentra_read_us_tax_merchant_credential(p_organization text,p_actor jsonb,p_binding_revision bigint) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
  if not coalesce(public.zentra_us_tax_actor_valid(p_actor,p_organization),false) then raise exception using errcode='PX007',message='Financial authority required';end if;
  if p_binding_revision is null or p_binding_revision not between 1 and 9007199254740990 then raise exception using errcode='PM004',message='Binding revision required';end if;
  if not exists(select 1 from public.zentra_workspace_country_configs where organization_id=p_organization and country='US' and currency='USD') then raise exception using errcode='PM003',message='US workspace required';end if;
  select jsonb_build_object('credential',a.result->'credential','configurationFingerprint',a.result->>'configurationFingerprint') into result from public.zentra_us_tax_provider_bindings b
    join public.zentra_us_tax_merchant_admissions a on a.organization_id=b.organization_id and a.binding_revision=b.revision and a.result->'binding'=b.snapshot
    join public.zentra_workspace_country_configs c on c.organization_id=a.organization_id and c.revision=(a.result->>'countryRevision')::bigint
      and c.config=jsonb_set(a.payload->'context'->'configuration','{taxConfiguration,status}','"configured"'::jsonb)
    join public.zentra_us_seller_profiles s on s.organization_id=a.organization_id and s.revision=(a.payload->'context'->>'sellerRevision')::bigint and s.profile=a.payload->'context'->'seller'
    join public.zentra_us_tax_profiles f on f.organization_id=a.organization_id and f.revision=(a.payload->'context'->>'taxFactsRevision')::bigint and f.facts=a.payload->'context'->'taxFacts'
    where b.organization_id=p_organization and b.revision=p_binding_revision and b.snapshot->>'evidenceKind'='provider_observation';
  return result;
end $$;

create function public.zentra_activate_us_tax_test_merchant(p_organization text,p_actor jsonb,p_request_id uuid,p_context jsonb,p_credential jsonb,p_configuration_fingerprint text,p_observation jsonb,p_valid_until text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare p jsonb;r public.zentra_us_tax_merchant_admissions%rowtype;c public.zentra_workspace_country_configs%rowtype;s public.zentra_us_seller_profiles%rowtype;f public.zentra_us_tax_profiles%rowtype;b public.zentra_us_tax_provider_bindings%rowtype;v_result jsonb;t timestamptz;
begin
  if not coalesce(public.zentra_us_tax_actor_valid(p_actor,p_organization),false) or p_actor->>'role' is distinct from 'owner' then raise exception using errcode='PM005',message='Owner authority required';end if;
  p:=jsonb_build_object('context',p_context,'credential',p_credential,'configurationFingerprint',p_configuration_fingerprint,'observation',p_observation,'validUntil',p_valid_until);
  if p_request_id is null or p_request_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or not coalesce(public.zentra_us_tax_merchant_payload_valid(p,p_organization),false) then raise exception using errcode='PM004',message='Invalid TEST merchant activation';end if;
  perform public.zentra_lock_us_tax_context(p_organization);
  select * into r from public.zentra_us_tax_merchant_admissions where organization_id=p_organization and request_id=p_request_id;
  if found then
    if r.actor_id is distinct from p_actor->>'userId' or r.payload is distinct from p then raise exception using errcode='PM002',message='TEST merchant request conflict';end if;
    return r.result;
  end if;
  select * into c from public.zentra_workspace_country_configs where organization_id=p_organization;
  select * into s from public.zentra_us_seller_profiles where organization_id=p_organization;
  select * into f from public.zentra_us_tax_profiles where organization_id=p_organization;
  select * into b from public.zentra_us_tax_provider_bindings where organization_id=p_organization;
  if c.revision is distinct from (p_context->>'countryRevision')::bigint or c.config is distinct from p_context->'configuration'
    or s.revision is distinct from (p_context->>'sellerRevision')::bigint or s.profile is distinct from p_context->'seller'
    or f.revision is distinct from (p_context->>'taxFactsRevision')::bigint or f.facts is distinct from p_context->'taxFacts'
    or coalesce(b.revision,0) is distinct from (p_context->>'bindingRevision')::bigint then raise exception using errcode='PM001',message='TEST merchant snapshot changed';end if;
  t:=clock_timestamp();
  if (p_observation->>'observedAt')::timestamptz>t or (p_observation->>'observedAt')::timestamptz<t-interval '120 seconds' or p_valid_until::timestamptz<=t then raise exception using errcode='PM006',message='TEST observation expired';end if;
  v_result:=public.zentra_us_tax_merchant_result(p,p_organization,p_request_id,p_actor->>'userId');
  perform public.zentra_put_us_tax_provider_binding(p_organization,p_actor->>'userId',(p_context->>'bindingRevision')::bigint,p_request_id,v_result->'binding');
  if c.config->'taxConfiguration'->>'status'='unconfigured' then
    perform public.zentra_put_workspace_country_config(p_organization,p_actor->>'userId',c.revision,p_request_id,jsonb_set(c.config,'{taxConfiguration,status}','"configured"'::jsonb));
  end if;
  insert into public.zentra_us_tax_merchant_admissions values(p_organization,p_request_id,p_actor->>'userId',(v_result->'binding'->>'revision')::bigint,p,v_result,t);
  return v_result;
end $$;

alter table public.zentra_us_tax_merchant_admissions enable row level security;
revoke all on public.zentra_us_tax_merchant_admissions from public,anon,authenticated;
grant select,insert on public.zentra_us_tax_merchant_admissions to service_role;
create policy zentra_us_tax_merchant_service_only on public.zentra_us_tax_merchant_admissions for all to service_role using(true) with check(true);
revoke all on function public.zentra_us_tax_merchant_payload_valid(jsonb,text),public.zentra_us_tax_merchant_result(jsonb,text,uuid,text),public.zentra_guard_us_tax_merchant_admission(),public.zentra_read_us_tax_merchant_context(text,jsonb),public.zentra_read_us_tax_merchant_receipt(text,jsonb,uuid),public.zentra_read_us_tax_merchant_credential(text,jsonb,bigint),public.zentra_activate_us_tax_test_merchant(text,jsonb,uuid,jsonb,jsonb,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.zentra_us_tax_merchant_payload_valid(jsonb,text),public.zentra_us_tax_merchant_result(jsonb,text,uuid,text),public.zentra_read_us_tax_merchant_context(text,jsonb),public.zentra_read_us_tax_merchant_receipt(text,jsonb,uuid),public.zentra_read_us_tax_merchant_credential(text,jsonb,bigint),public.zentra_activate_us_tax_test_merchant(text,jsonb,uuid,jsonb,jsonb,text,jsonb,text) to service_role;
comment on table public.zentra_us_tax_merchant_admissions is 'Private immutable technical TEST merchant observations; no key, legal registration attestation or issuance grant.';
commit;
