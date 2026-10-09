-- Immutable reviewed inputs for the private US TEST issuer. No hosted apply,
-- secret, provider call, inferred classification, CH rewrite or legacy rewrite.
begin;

create function public.zentra_us_tax_preparation_valid(p jsonb,org text,actor_id text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare r jsonb;c jsonb;m jsonb;e jsonb;b jsonb;line jsonb;k jsonb;i integer:=0;hash text;destination jsonb;instant timestamptz;net numeric;total numeric:=0;
begin
  if not public.zentra_us_tax_object(p,array['schemaVersion','organizationId','actorUserId','request','commandHash','context','merchant','estimate','estimateSha256','classifications','taxDateInstant','addressSource'])
    or p->'schemaVersion' is distinct from '1'::jsonb or p->>'organizationId' is distinct from org or p->>'actorUserId' is distinct from actor_id then return false;end if;
  r:=p->'request';c:=p->'context';m:=p->'merchant';e:=p->'estimate';b:=c->'binding';
  if not public.zentra_us_tax_object(r,array['idempotencyKey','expectedRevision','command']) or not public.zentra_us_tax_revision(r->'expectedRevision',0)
    or jsonb_typeof(r->'idempotencyKey') is distinct from 'string' or r->>'idempotencyKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,231}$'
    or not public.zentra_us_tax_object(r->'command',array['type','id','estimateId','expectedEstimateRevision','date','accountingDate','dueDate','periodId'])
    or not public.zentra_us_tax_strings(r->'command',array['type','id','estimateId','date','accountingDate','dueDate','periodId'])
    or r->'command'->>'type' is distinct from 'issue_invoice' or not public.zentra_us_tax_revision(r->'command'->'expectedEstimateRevision') then return false;end if;
  foreach hash in array array['id','estimateId','periodId'] loop
    if not public.zentra_us_tax_text_valid(r->'command'->>hash,160,false) then return false;end if;
  end loop;
  foreach hash in array array['date','accountingDate','dueDate'] loop
    if r->'command'->>hash !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or to_char((r->'command'->>hash)::date,'YYYY-MM-DD') is distinct from r->'command'->>hash then return false;end if;
  end loop;
  if (r->'command'->>'dueDate')::date<(r->'command'->>'date')::date then return false;end if;
  hash:=encode(sha256(convert_to(public.zentra_us_erp_v4_canonical(jsonb_build_array(org,actor_id,r)),'UTF8')),'hex');
  if p->>'commandHash' is distinct from hash
    or not public.zentra_us_tax_object(c,array['organizationId','countryRevision','configuration','sellerRevision','seller','taxFactsRevision','taxFacts','binding'])
    or c->>'organizationId' is distinct from org or not public.zentra_us_tax_revision(c->'countryRevision') or not public.zentra_us_tax_revision(c->'sellerRevision') or not public.zentra_us_tax_revision(c->'taxFactsRevision')
    or not public.zentra_country_config_valid(c->'configuration',org) or c->'configuration'->>'country' is distinct from 'US' or c->'configuration'->>'currency' is distinct from 'USD'
    or c->'configuration'->'taxConfiguration'->>'status' is distinct from 'configured' or not public.zentra_us_seller_profile_valid(c->'seller') or not public.zentra_us_tax_facts_valid(c->'taxFacts')
    or c->'configuration'->>'timeZone' is distinct from c->'taxFacts'->>'timeZone'
    or not coalesce(public.zentra_us_tax_binding_valid(b,org,(b->>'revision')::bigint),false) or b->>'evidenceKind' is distinct from 'provider_observation'
    or not public.zentra_us_tax_object(m,array['credential','configurationFingerprint']) or jsonb_typeof(m->'configurationFingerprint') is distinct from 'string' or m->>'configurationFingerprint' !~ '^[0-9a-f]{64}$'
    or not public.zentra_us_tax_object(m->'credential',array['reference','revision','accountId']) or not public.zentra_us_tax_strings(m->'credential',array['reference','accountId'])
    or not public.zentra_us_tax_text_valid(m->'credential'->>'reference',256,true) or not public.zentra_us_tax_safe_integer(m->'credential'->'revision',1) or m->'credential'->>'accountId' is distinct from b->>'accountId'
    or e->>'organizationId' is distinct from org or e->>'currency' is distinct from 'USD' or e->>'status' is distinct from 'accepted'
    or e->>'id' is distinct from r->'command'->>'estimateId' or e->'revision' is distinct from r->'command'->'expectedEstimateRevision'
    or p->>'estimateSha256' is distinct from encode(sha256(convert_to(public.zentra_us_erp_v4_canonical(e),'UTF8')),'hex')
    or jsonb_typeof(e->'lines') is distinct from 'array' or jsonb_array_length(e->'lines') not between 1 and 100
    or jsonb_typeof(p->'classifications') is distinct from 'array' or jsonb_array_length(p->'classifications')<>jsonb_array_length(e->'lines')
    or not public.zentra_us_tax_strings(p,array['taxDateInstant','addressSource']) or p->>'addressSource' not in ('billing','shipping') or not public.zentra_us_tax_instant(p->>'taxDateInstant') then return false;end if;
  instant:=(p->>'taxDateInstant')::timestamptz;
  if extract(epoch from instant)<0 or extract(epoch from instant)%1<>0 or to_char(instant at time zone (c->'taxFacts'->>'timeZone'),'YYYY-MM-DD') is distinct from r->'command'->>'date' then return false;end if;
  destination:=e->'customer'->(case when p->>'addressSource'='billing' then 'billingAddress' else 'shippingAddress' end);
  if destination->>'country' is distinct from 'US' then return false;end if;
  for line in select value from jsonb_array_elements(e->'lines') loop
    k:=p->'classifications'->i;i:=i+1;
    if not public.zentra_us_tax_object(k,array['lineId','taxCode','kind','taxBehavior','revision','evidenceReference']) or not public.zentra_us_tax_strings(k,array['lineId','taxCode','kind','taxBehavior','evidenceReference'])
      or k->>'lineId' is distinct from line->>'id' or k->>'taxCode' !~ '^txcd_[0-9]{8}$' or k->>'kind' is distinct from 'service' or k->>'taxBehavior' is distinct from 'exclusive' or k->'revision' is distinct from '1'::jsonb
      or k->>'evidenceReference' is distinct from 'ztaxprep_'||encode(sha256(convert_to(public.zentra_us_erp_v4_canonical(jsonb_build_array('zentra:us:tax:preparation:classification:v1',org,actor_id,hash,k->>'lineId',k->>'taxCode')),'UTF8')),'hex')
      or line->>'taxTreatment' is distinct from 'taxable' or line->'unitPrice'->>'currency' is distinct from 'USD'
      or line->>'quantityUnits' !~ '^[1-9][0-9]{0,35}$' or not public.zentra_us_tax_safe_integer(line->'quantityScale') or (line->>'quantityScale')::integer>6
      or (line->>'quantityUnits')::numeric%power(10::numeric,(line->>'quantityScale')::integer)<>0
      or (line->>'quantityUnits')::numeric/power(10::numeric,(line->>'quantityScale')::integer)>9007199254740991
      or not public.zentra_us_tax_amount(line->'unitPrice'->'minorUnits') or (line->'unitPrice'->>'minorUnits')::numeric<=0
      or not public.zentra_us_tax_safe_integer(line->'discountBasisPoints') or (line->>'discountBasisPoints')::integer>=10000 then return false;end if;
    net:=(public.zentra_us_erp_line_totals(line)->>'netMinor')::numeric;total:=total+net;
    if net not between 1 and 9007199254740991 or total>9007199254740991 then return false;end if;
  end loop;
  return not exists(select 1 from jsonb_array_elements(p->'classifications') a group by a->>'lineId' having count(*)>1);
exception when others then return false;end $$;

create table public.zentra_us_tax_invoice_preparations(
  organization_id text not null references public.zentra_workspace_country_configs(organization_id) on delete restrict,
  erp_idempotency_key text not null,actor_id text not null,command_hash text not null,
  preparation_body text not null check(public.zentra_us_tax_body_valid(preparation_body)),preparation_sha256 text not null,
  preparation jsonb not null,prepared_at timestamptz not null check(isfinite(prepared_at)),
  primary key(organization_id,erp_idempotency_key),
  check(public.zentra_us_tax_preparation_valid(preparation,organization_id,actor_id)),
  check(preparation_body=public.zentra_us_erp_v4_canonical(preparation)),
  check(preparation_sha256=encode(sha256(convert_to(preparation_body,'UTF8')),'hex')),
  check(erp_idempotency_key=preparation->'request'->>'idempotencyKey' and command_hash=preparation->>'commandHash')
);
create function public.zentra_us_tax_preparation_result(p public.zentra_us_tax_invoice_preparations) returns jsonb
language sql immutable security invoker set search_path='' as $$
  select p.preparation||jsonb_build_object('preparationSha256',p.preparation_sha256,'preparedAt',to_char(date_trunc('milliseconds',p.prepared_at) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
$$;

create function public.zentra_us_tax_preparation_capability(org text,cap integer) returns void
language plpgsql stable security invoker set search_path='' as $$
declare h jsonb;
begin
  if not coalesce(cap in (1,2,3,4),false) then raise exception using errcode='PU008',message='Trusted ERP capability required';end if;
  select header into h from public.zentra_us_erp_heads where organization_id=org;
  if h is null then raise exception using errcode='PF003',message='US TEST preparation book required';end if;
  if not coalesce(h->'schemaVersion' in ('1'::jsonb,'2'::jsonb,'3'::jsonb,'4'::jsonb),false) or (h->>'schemaVersion')::integer>cap then raise exception using errcode='PU008',message='ERP capability required before preparation replay';end if;
end $$;
create function public.zentra_assert_us_tax_preparation_current(p public.zentra_us_tax_invoice_preparations,after_commit boolean default false) returns void
language plpgsql security invoker set search_path='' as $$
declare c public.zentra_workspace_country_configs%rowtype;s public.zentra_us_seller_profiles%rowtype;f public.zentra_us_tax_profiles%rowtype;b public.zentra_us_tax_provider_bindings%rowtype;h public.zentra_us_erp_heads%rowtype;e jsonb;ctx jsonb;merchant jsonb;t timestamptz:=clock_timestamp();
begin
  perform public.zentra_lock_us_tax_context(p.organization_id);
  select * into h from public.zentra_us_erp_heads where organization_id=p.organization_id for update;
  ctx:=p.preparation->'context';
  select * into c from public.zentra_workspace_country_configs where organization_id=p.organization_id;
  select * into s from public.zentra_us_seller_profiles where organization_id=p.organization_id;
  select * into f from public.zentra_us_tax_profiles where organization_id=p.organization_id;
  select * into b from public.zentra_us_tax_provider_bindings where organization_id=p.organization_id;
  select payload into e from public.zentra_us_erp_records where organization_id=p.organization_id and kind='estimate' and id=p.preparation->'request'->'command'->>'estimateId';
  if c.country is distinct from 'US' or c.currency is distinct from 'USD' or c.revision is distinct from (ctx->>'countryRevision')::bigint or c.config is distinct from ctx->'configuration'
    or s.revision is distinct from (ctx->>'sellerRevision')::bigint or s.profile is distinct from ctx->'seller'
    or f.revision is distinct from (ctx->>'taxFactsRevision')::bigint or f.facts is distinct from ctx->'taxFacts'
    or b.snapshot is distinct from ctx->'binding' or e is distinct from p.preparation->'estimate'
    or encode(sha256(convert_to(public.zentra_us_erp_v4_canonical(e),'UTF8')),'hex') is distinct from p.preparation->>'estimateSha256'
    or h.revision is distinct from (p.preparation->'request'->>'expectedRevision')::bigint+(case when after_commit then 1 else 0 end)
    or h.header->'configuration' is distinct from ctx->'configuration' then raise exception using errcode='PF001',message='Reviewed TEST invoice snapshot changed';end if;
  if (b.snapshot->>'observedAt')::timestamptz>t or (b.snapshot->>'validUntil')::timestamptz<=t then raise exception using errcode='PF006',message='Reviewed TEST invoice binding expired';end if;
  if abs(extract(epoch from (p.preparation->>'taxDateInstant')::timestamptz-t))>31*86400 then raise exception using errcode='PF006',message='Reviewed invoice tax date expired';end if;
  -- Compare durable private provenance directly; never manufacture an actor.
  select jsonb_build_object('credential',a.result->'credential','configurationFingerprint',a.result->>'configurationFingerprint') into merchant
    from public.zentra_us_tax_merchant_admissions a where a.organization_id=p.organization_id and a.binding_revision=b.revision and a.result->'binding'=b.snapshot
      and (a.result->>'countryRevision')::bigint=c.revision
      and jsonb_set(a.payload->'context'->'configuration','{taxConfiguration,status}','"configured"'::jsonb)=c.config
      and a.payload->'context'->'seller'=s.profile and (a.payload->'context'->>'sellerRevision')::bigint=s.revision
      and a.payload->'context'->'taxFacts'=f.facts and (a.payload->'context'->>'taxFactsRevision')::bigint=f.revision;
  if merchant is distinct from p.preparation->'merchant' then raise exception using errcode='PF001',message='Reviewed merchant provenance changed';end if;
end $$;

create function public.zentra_guard_us_tax_invoice_preparation() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if tg_op<>'INSERT' then raise exception using errcode='PF007',message='Invoice preparation is immutable';end if;
  if not coalesce(public.zentra_us_tax_preparation_valid(new.preparation,new.organization_id,new.actor_id),false) then raise exception using errcode='PF004',message='Invalid reviewed TEST inputs';end if;
  new.prepared_at:=clock_timestamp();
  perform public.zentra_assert_us_tax_preparation_current(new);
  return new;
end $$;
create trigger zentra_us_tax_invoice_preparation_immutable before insert or update or delete on public.zentra_us_tax_invoice_preparations for each row execute function public.zentra_guard_us_tax_invoice_preparation();
create trigger zentra_us_tax_invoice_preparation_no_truncate before truncate on public.zentra_us_tax_invoice_preparations for each statement execute function public.zentra_guard_us_tax_invoice_preparation();

create function public.zentra_read_us_tax_invoice_preparation(p_organization text,p_actor jsonb,p_erp_idempotency_key text,p_command_hash text,p_supported_schema_version integer) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare p public.zentra_us_tax_invoice_preparations%rowtype;
begin
  if not coalesce(public.zentra_us_tax_actor_valid(p_actor,p_organization),false) then raise exception using errcode='PF005',message='Financial authority required';end if;
  if not exists(select 1 from public.zentra_workspace_country_configs where organization_id=p_organization and country='US' and currency='USD') then raise exception using errcode='PF003',message='US TEST preparation required';end if;
  perform public.zentra_us_tax_preparation_capability(p_organization,p_supported_schema_version);
  select * into p from public.zentra_us_tax_invoice_preparations where organization_id=p_organization and erp_idempotency_key=p_erp_idempotency_key;
  if not found then return null;end if;
  if p.actor_id is distinct from p_actor->>'userId' or p.command_hash is distinct from p_command_hash then raise exception using errcode='PF002',message='Invoice preparation request conflict';end if;
  return public.zentra_us_tax_preparation_result(p);
end $$;
create function public.zentra_create_us_tax_invoice_preparation(p_organization text,p_actor jsonb,p_preparation_body text,p_preparation_sha256 text,p_supported_schema_version integer) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare p public.zentra_us_tax_invoice_preparations%rowtype;v jsonb;
begin
  if not coalesce(public.zentra_us_tax_actor_valid(p_actor,p_organization),false) then raise exception using errcode='PF005',message='Financial authority required';end if;
  begin v:=p_preparation_body::jsonb;exception when others then raise exception using errcode='PF004',message='Invalid reviewed TEST inputs';end;
  if not coalesce(public.zentra_us_tax_preparation_valid(v,p_organization,p_actor->>'userId'),false) or p_preparation_body is distinct from public.zentra_us_erp_v4_canonical(v) or p_preparation_sha256 is distinct from encode(sha256(convert_to(p_preparation_body,'UTF8')),'hex') then raise exception using errcode='PF004',message='Invalid reviewed TEST inputs';end if;
  perform public.zentra_lock_us_tax_context(p_organization);
  perform 1 from public.zentra_us_erp_heads where organization_id=p_organization for update;
  perform public.zentra_us_tax_preparation_capability(p_organization,p_supported_schema_version);
  select * into p from public.zentra_us_tax_invoice_preparations where organization_id=p_organization and erp_idempotency_key=v->'request'->>'idempotencyKey';
  if found then
    if p.actor_id is distinct from p_actor->>'userId' or p.preparation_body is distinct from p_preparation_body or p.preparation_sha256 is distinct from p_preparation_sha256 then raise exception using errcode='PF002',message='Invoice preparation request conflict';end if;
    return public.zentra_us_tax_preparation_result(p);
  end if;
  insert into public.zentra_us_tax_invoice_preparations values(p_organization,v->'request'->>'idempotencyKey',p_actor->>'userId',v->>'commandHash',p_preparation_body,p_preparation_sha256,v,clock_timestamp()) returning * into p;
  return public.zentra_us_tax_preparation_result(p);
end $$;

create table public.zentra_us_tax_prepared_operation_links(
  organization_id text not null,operation_id uuid not null,erp_idempotency_key text not null,preparation_sha256 text not null,
  primary key(organization_id,operation_id),unique(organization_id,erp_idempotency_key),
  foreign key(organization_id,operation_id) references public.zentra_us_tax_operations(organization_id,operation_id) on delete restrict,
  foreign key(organization_id,erp_idempotency_key) references public.zentra_us_tax_invoice_preparations(organization_id,erp_idempotency_key) on delete restrict
);
create function public.zentra_assert_us_tax_prepared_operation(org text,op uuid,current_inputs boolean default true,after_commit boolean default false) returns void
language plpgsql security invoker set search_path='' as $$
declare o public.zentra_us_tax_operations%rowtype;l public.zentra_us_tax_prepared_operation_links%rowtype;p public.zentra_us_tax_invoice_preparations%rowtype;v jsonb;command jsonb;invoice jsonb;journal jsonb;head jsonb;
begin
  select * into o from public.zentra_us_tax_operations where organization_id=org and operation_id=op;
  select * into l from public.zentra_us_tax_prepared_operation_links where organization_id=org and operation_id=op;
  if o.organization_id is null or l.organization_id is null then raise exception using errcode='PF003',message='Durable reviewed TEST inputs required';end if;
  select * into p from public.zentra_us_tax_invoice_preparations where organization_id=org and erp_idempotency_key=l.erp_idempotency_key;
  v:=p.preparation;
  if l.preparation_sha256 is distinct from p.preparation_sha256 or o.actor_id is distinct from p.actor_id or o.command_hash is distinct from p.command_hash
    or o.erp_idempotency_key is distinct from p.erp_idempotency_key or o.expected_erp_revision is distinct from (v->'request'->>'expectedRevision')::bigint
    or o.invoice_id is distinct from v->'request'->'command'->>'id' or o.resolved->'snapshots'->'estimate' is distinct from v->'estimate'
    or o.resolved->'snapshots'->'configuration' is distinct from v->'context'->'configuration' or o.resolved->'snapshots'->'taxFacts' is distinct from v->'context'->'taxFacts'
    or o.resolved->'countryRevision' is distinct from v->'context'->'countryRevision' or o.resolved->'sellerRevision' is distinct from v->'context'->'sellerRevision'
    or o.resolved->'taxFactsRevision' is distinct from v->'context'->'taxFactsRevision' or o.resolved->'binding' is distinct from v->'context'->'binding'
    or o.resolved->'classifications' is distinct from v->'classifications' or o.resolved->>'taxDateInstant' is distinct from v->>'taxDateInstant'
    or o.resolved->>'invoiceDate' is distinct from v->'request'->'command'->>'date' or o.resolved->'params'->'customer_details'->>'address_source' is distinct from v->>'addressSource' then raise exception using errcode='PF001',message='Reserved inputs differ from reviewed TEST preparation';end if;
  if current_inputs then perform public.zentra_assert_us_tax_preparation_current(p,after_commit);end if;
  -- A declared command hash is not proof that the committed document/journal
  -- used its dates and period. This assertion also runs from the operation
  -- transition/completion triggers, so historical mutation RPCs cannot bypass it.
  if after_commit or o.status='committed' then
    command:=v->'request'->'command';
    select payload into invoice from public.zentra_us_erp_records where organization_id=org and kind='invoice' and id=o.invoice_id;
    if invoice is null or invoice->>'id' is distinct from command->>'id'
      or invoice->>'sourceEstimateId' is distinct from command->>'estimateId' or invoice->'sourceEstimateRevision' is distinct from command->'expectedEstimateRevision'
      or invoice->>'issuedBy' is distinct from p.actor_id or invoice->>'date' is distinct from command->>'date'
      or invoice->>'accountingDate' is distinct from command->>'accountingDate' or invoice->>'dueDate' is distinct from command->>'dueDate' then
      raise exception using errcode='PF001',message='Invoice effect differs from reviewed TEST command';end if;
    if v->'context'->'configuration'->>'accountingBasis'='accrual' then
      select payload into journal from public.zentra_us_erp_records where organization_id=org and kind='journal' and id='entry:invoice:'||o.invoice_id;
      if journal is null or journal->>'transactionDate' is distinct from command->>'date'
        or journal->>'accountingDate' is distinct from command->>'accountingDate' or journal->>'periodId' is distinct from command->>'periodId' then
        raise exception using errcode='PF001',message='Invoice journal differs from reviewed TEST command';end if;
    end if;
    -- Cash issuance has no invoice journal, but must still use the reviewed
    -- open period. Historical replay does not re-open or re-admit old periods.
    if after_commit then
      select header into head from public.zentra_us_erp_heads where organization_id=org;
      if not exists(select 1 from jsonb_array_elements(head->'ledger'->'periods') period where period->>'id'=command->>'periodId'
        and period->>'status'='open' and command->>'accountingDate' between period->>'start' and period->>'end') then
        raise exception using errcode='PF001',message='Reviewed invoice period is not open';end if;
    end if;
  end if;
end $$;
create function public.zentra_guard_us_tax_prepared_link() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if tg_op<>'INSERT' then raise exception using errcode='PF007',message='Reviewed operation link is immutable';end if;
  return new;
end $$;
create trigger zentra_us_tax_prepared_link_immutable before update or delete on public.zentra_us_tax_prepared_operation_links for each row execute function public.zentra_guard_us_tax_prepared_link();
create trigger zentra_us_tax_prepared_link_no_truncate before truncate on public.zentra_us_tax_prepared_operation_links for each statement execute function public.zentra_guard_us_tax_prepared_link();
create function public.zentra_guard_us_tax_prepared_operation() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if new.resolved->'binding'->>'evidenceKind'='provider_observation' then
    perform public.zentra_lock_us_tax_context(new.organization_id);
    perform public.zentra_assert_us_tax_prepared_operation(new.organization_id,new.operation_id,true,new.status='committed');
  end if;
  return new;
end $$;
create trigger zentra_us_tax_prepared_transition before update on public.zentra_us_tax_operations for each row execute function public.zentra_guard_us_tax_prepared_operation();
create function public.zentra_guard_us_tax_prepared_complete() returns trigger
language plpgsql security invoker set search_path='' as $$
declare o public.zentra_us_tax_operations%rowtype;org text;op uuid;
begin
  org:=new.organization_id;op:=new.operation_id;
  select * into o from public.zentra_us_tax_operations where organization_id=org and operation_id=op;
  if o.resolved->'binding'->>'evidenceKind'='provider_observation' then perform public.zentra_assert_us_tax_prepared_operation(org,op,o.status<>'committed');end if;
  return null;
end $$;
create constraint trigger zentra_us_tax_prepared_operation_complete after insert or update on public.zentra_us_tax_operations deferrable initially deferred for each row execute function public.zentra_guard_us_tax_prepared_complete();
create constraint trigger zentra_us_tax_prepared_link_complete after insert on public.zentra_us_tax_prepared_operation_links deferrable initially deferred for each row execute function public.zentra_guard_us_tax_prepared_complete();

create function public.zentra_reserve_us_tax_prepared_operation(p_organization text,p_actor jsonb,p_operation_id uuid,p_resolved_body text,p_resolved_sha256 text,p_params_body text,p_params_sha256 text,p_provider_idempotency_key text,p_supported_schema_version integer) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare p public.zentra_us_tax_invoice_preparations%rowtype;v jsonb;r jsonb;o public.zentra_us_tax_operations%rowtype;
begin
  if not coalesce(public.zentra_us_tax_actor_valid(p_actor,p_organization),false) then raise exception using errcode='PF005',message='Financial authority required';end if;
  begin v:=p_resolved_body::jsonb;exception when others then raise exception using errcode='PF004',message='Invalid resolved TEST operation';end;
  perform public.zentra_lock_us_tax_context(p_organization);
  perform 1 from public.zentra_us_erp_heads where organization_id=p_organization for update;
  perform public.zentra_us_tax_preparation_capability(p_organization,p_supported_schema_version);
  select * into p from public.zentra_us_tax_invoice_preparations where organization_id=p_organization and erp_idempotency_key=v->>'erpIdempotencyKey';
  if p.organization_id is null then raise exception using errcode='PF003',message='Reviewed TEST preparation required';end if;
  r:=public.zentra_reserve_us_tax_operation(p_organization,p_actor,p_operation_id,p_resolved_body,p_resolved_sha256,p_params_body,p_params_sha256,p_provider_idempotency_key);
  select * into o from public.zentra_us_tax_operations where organization_id=p_organization and operation_id=p_operation_id;
  if not exists(select 1 from public.zentra_us_tax_prepared_operation_links where organization_id=p_organization and operation_id=p_operation_id) then
    insert into public.zentra_us_tax_prepared_operation_links values(p_organization,p_operation_id,p.erp_idempotency_key,p.preparation_sha256);
  end if;
  perform public.zentra_assert_us_tax_prepared_operation(p_organization,p_operation_id,o.status<>'committed');
  return r;
end $$;
create function public.zentra_record_us_tax_prepared_calculation(p_organization text,p_operation_id uuid,p_actor jsonb,p_proof_body text,p_proof_sha256 text,p_assessment jsonb,p_supported_schema_version integer) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare o public.zentra_us_tax_operations%rowtype;
begin
  if not coalesce(public.zentra_us_tax_actor_valid(p_actor,p_organization),false) then raise exception using errcode='PF005',message='Financial authority required';end if;
  perform public.zentra_lock_us_tax_context(p_organization);perform 1 from public.zentra_us_erp_heads where organization_id=p_organization for update;
  perform public.zentra_us_tax_preparation_capability(p_organization,p_supported_schema_version);
  select * into o from public.zentra_us_tax_operations where organization_id=p_organization and operation_id=p_operation_id for update;
  if o.actor_id is distinct from p_actor->>'userId' then raise exception using errcode='PF002',message='Operation actor conflict';end if;
  perform public.zentra_assert_us_tax_prepared_operation(p_organization,p_operation_id,o.status<>'committed');
  return public.zentra_record_us_tax_calculation(p_organization,p_operation_id,p_actor,p_proof_body,p_proof_sha256,p_assessment);
end $$;
create function public.zentra_commit_us_tax_prepared_invoice_test(p_organization text,p_operation_id uuid,p_expected_revision bigint,p_header jsonb,p_changes jsonb,p_ledger_audit jsonb,p_receipt jsonb,p_actor jsonb,p_supported_schema_version integer) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare o public.zentra_us_tax_operations%rowtype;
begin
  if not coalesce(public.zentra_us_tax_actor_valid(p_actor,p_organization),false) then raise exception using errcode='PF005',message='Financial authority required';end if;
  perform public.zentra_lock_us_tax_context(p_organization);perform 1 from public.zentra_us_erp_heads where organization_id=p_organization for update;
  perform public.zentra_us_tax_preparation_capability(p_organization,p_supported_schema_version);
  select * into o from public.zentra_us_tax_operations where organization_id=p_organization and operation_id=p_operation_id for update;
  if o.actor_id is distinct from p_actor->>'userId' then raise exception using errcode='PF002',message='Operation actor conflict';end if;
  perform public.zentra_assert_us_tax_prepared_operation(p_organization,p_operation_id,o.status<>'committed');
  return public.zentra_commit_us_tax_invoice_test_v2(p_organization,p_operation_id,p_expected_revision,p_header,p_changes,p_ledger_audit,p_receipt,p_actor,p_supported_schema_version);
end $$;

do $$ declare tab text;f record;begin
  foreach tab in array array['zentra_us_tax_invoice_preparations','zentra_us_tax_prepared_operation_links'] loop
    execute format('alter table public.%I enable row level security',tab);
    execute format('revoke all on public.%I from public,anon,authenticated',tab);
    execute format('grant select,insert on public.%I to service_role',tab);
    execute format('create policy %I on public.%I for all to service_role using(true) with check(true)',tab||'_service_only',tab);
  end loop;
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in(
    'zentra_us_tax_preparation_valid','zentra_us_tax_preparation_result','zentra_us_tax_preparation_capability','zentra_assert_us_tax_preparation_current','zentra_guard_us_tax_invoice_preparation',
    'zentra_read_us_tax_invoice_preparation','zentra_create_us_tax_invoice_preparation','zentra_assert_us_tax_prepared_operation','zentra_guard_us_tax_prepared_link','zentra_guard_us_tax_prepared_operation','zentra_guard_us_tax_prepared_complete',
    'zentra_reserve_us_tax_prepared_operation','zentra_record_us_tax_prepared_calculation','zentra_commit_us_tax_prepared_invoice_test') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
comment on table public.zentra_us_tax_invoice_preparations is 'Immutable exact ERP-request US TEST review; catalogue existence is not legal classification authority and this row is never an issuance grant.';
commit;
