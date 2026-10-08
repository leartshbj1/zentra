-- Private US supplier analysis admission only. D1 remains SaaS authority.
-- No provider/key, hosted activation, CH rewrite or accounting mutation.
begin;

create function public.zentra_us_analysis_text(v text,n integer) returns boolean language sql immutable security invoker set search_path='' as $$
  select coalesce(public.zentra_us_supplier_text(v,n) and v=public.zentra_us_supplier_trim(v),false);
$$;
create function public.zentra_us_analysis_settings_request_valid(v jsonb) returns boolean language plpgsql immutable security invoker set search_path='' as $$ begin
  return coalesce(public.zentra_us_tax_object(v,array['schemaVersion','requestId','expectedRevision','action','processingPolicyVersion','consent'])
    and v->'schemaVersion'='1'::jsonb and public.zentra_us_tax_strings(v,array['requestId','action']) and public.zentra_us_supplier_uuid(v->>'requestId') and public.zentra_us_tax_revision(v->'expectedRevision',0)
    and ((v->>'action'='activate' and v->'consent'='true'::jsonb and jsonb_typeof(v->'processingPolicyVersion')='string' and v->>'processingPolicyVersion' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
      or (v->>'action'='pause' and v->'consent'='false'::jsonb and (v->'processingPolicyVersion'='null'::jsonb or (jsonb_typeof(v->'processingPolicyVersion')='string' and v->>'processingPolicyVersion' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')))),false);
exception when others then return false;end $$;
create function public.zentra_us_analysis_grant_valid(v jsonb,org text,fresh boolean default true) returns boolean
language plpgsql volatile security invoker set search_path='' as $$
declare start_at timestamptz;end_at timestamptz;now_epoch bigint:=floor(extract(epoch from clock_timestamp()));
begin
  if not public.zentra_us_tax_object(v,array['schemaVersion','organizationId','environment','bucket','periodId','periodStart','periodEnd','limit','subscriptionId','authorityReference','catalogVersion','priceId','budgetPolicyVersion','processingPolicyVersion','checkedAt'])
    or v->'schemaVersion'<>'1'::jsonb or v->>'organizationId' is distinct from org or v->>'environment' not in('TEST','PRODUCTION') or v->>'bucket'<>'supplier_invoice_extract'
    or v->>'periodId' !~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])$' or not public.zentra_us_tax_safe_integer(v->'limit',1) or (v->>'limit')::bigint>1000000
    or not public.zentra_us_tax_strings(v,array['organizationId','environment','bucket','periodId','subscriptionId','authorityReference','catalogVersion','priceId','budgetPolicyVersion','processingPolicyVersion'])
    or not public.zentra_us_tax_safe_integer(v->'periodStart') or not public.zentra_us_tax_safe_integer(v->'periodEnd') or not public.zentra_us_tax_safe_integer(v->'checkedAt')
    or v->>'priceId' !~ '^price_[A-Za-z0-9_]{1,120}$' or exists(select 1 from unnest(array['subscriptionId','authorityReference','catalogVersion','budgetPolicyVersion','processingPolicyVersion']) k where v->>k !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') then return false;end if;
  start_at:=((v->>'periodId')||'-01T00:00:00Z')::timestamptz;end_at:=((start_at at time zone 'UTC')+interval '1 month') at time zone 'UTC';
  if (v->>'periodStart')::bigint<>extract(epoch from start_at)::bigint or (v->>'periodEnd')::bigint<>extract(epoch from end_at)::bigint
    or (v->>'checkedAt')::bigint<(v->>'periodStart')::bigint or (v->>'checkedAt')::bigint>=(v->>'periodEnd')::bigint then return false;end if;
  return not fresh or ((v->>'checkedAt')::bigint between now_epoch-30 and now_epoch+5 and now_epoch>=(v->>'periodStart')::bigint and now_epoch<(v->>'periodEnd')::bigint);
exception when others then return false;end $$;
create function public.zentra_us_analysis_settings_valid(v jsonb,org text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
begin
  return coalesce(public.zentra_us_tax_object(v,array['schemaVersion','organizationId','revision','enabled','consent']) and v->'schemaVersion'='1'::jsonb and v->>'organizationId'=org
    and public.zentra_us_tax_revision(v->'revision',0) and jsonb_typeof(v->'enabled')='boolean'
    and (v->'consent'='null'::jsonb or (public.zentra_us_tax_object(v->'consent',array['processingPolicyVersion','acceptedBy','acceptedAt'])
      and public.zentra_us_tax_strings(v->'consent',array['processingPolicyVersion','acceptedBy','acceptedAt'])
      and v->'consent'->>'processingPolicyVersion' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      and public.zentra_us_analysis_text(v->'consent'->>'acceptedBy',256) and public.zentra_us_purchase_timestamp(v->'consent'->>'acceptedAt')))
    and (v->'enabled'='false'::jsonb or v->'consent'<>'null'::jsonb)
    and (v->'revision'<>'0'::jsonb or (v->'enabled'='false'::jsonb and v->'consent'='null'::jsonb)),false);
exception when others then return false;end $$;
create function public.zentra_us_analysis_source_valid(v jsonb,org text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare extraction jsonb;
begin
  extraction:=jsonb_build_object('schemaVersion',1,'kind','unknown','confidence',0,'fields',jsonb_build_object('supplierName',null,'reference',null,'invoiceDate',null,'dueDate',null,'currency',null,'netMinor',null,'printedTaxMinor',null,'totalMinor',null),'evidence','{}'::jsonb,'fieldConfidence','{}'::jsonb,'issues',jsonb_build_array('document_kind_unconfirmed','human_approval_required','low_confidence','missing_currency','missing_due_date','missing_invoice_date','missing_net_amount','missing_printed_tax','missing_reference','missing_supplier_name','missing_total_amount'));
  return v->>'mediaType'='text/plain' and public.zentra_us_supplier_proposal_valid(jsonb_build_object('schemaVersion',1,'organizationId',org,'id','11111111-1111-4111-8111-111111111111','revision',0,'state','review','source',v,'extraction',extraction,'createdBy','validator','createdAt','2026-10-08T00:00:00Z'),org);
exception when others then return false;end $$;
create function public.zentra_us_analysis_job_valid(v jsonb,org text) returns boolean
language plpgsql stable security invoker set search_path='' as $$
declare dispatched boolean;done boolean;r jsonb;
begin
  if not public.zentra_us_tax_object(v,array['schemaVersion','organizationId','id','environment','bucket','source','recipeVersion','requestId','createdBy','createdAt','grant','consentRevision','state','leaseToken','leaseUntil','leaseGeneration','dispatchId','dispatchedAt','resultBody','resultSha256','proposalId'])
    or v->'schemaVersion'<>'1'::jsonb or v->>'organizationId' is distinct from org or not public.zentra_us_supplier_uuid(v->>'id') or not public.zentra_us_supplier_uuid(v->>'requestId')
    or not public.zentra_us_tax_strings(v,array['organizationId','id','environment','bucket','recipeVersion','requestId','createdBy','createdAt','state'])
    or not public.zentra_us_analysis_text(v->>'createdBy',256) or not public.zentra_us_purchase_timestamp(v->>'createdAt') or v->>'recipeVersion' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or not public.zentra_us_analysis_grant_valid(v->'grant',org,false) or v->'environment' is distinct from v->'grant'->'environment' or v->'bucket' is distinct from v->'grant'->'bucket'
    or not public.zentra_us_tax_revision(v->'consentRevision') or not public.zentra_us_tax_revision(v->'leaseGeneration') or not public.zentra_us_analysis_source_valid(v->'source',org)
    or v->>'state' not in('held','released','dispatched','uncertain','completed') then return false;end if;
  if v->>'state'='released' then if v->'leaseToken'<>'null'::jsonb or v->'leaseUntil'<>'null'::jsonb then return false;end if;
  elsif not public.zentra_us_tax_strings(v,array['leaseToken','leaseUntil']) or not public.zentra_us_supplier_uuid(v->>'leaseToken') or not public.zentra_us_purchase_timestamp(v->>'leaseUntil') or (v->>'leaseUntil')::timestamptz<=(v->>'createdAt')::timestamptz then return false;end if;
  dispatched:=v->>'state' in('dispatched','uncertain','completed');done:=v->>'state'='completed';
  if dispatched then if not public.zentra_us_tax_strings(v,array['dispatchId','dispatchedAt']) or not public.zentra_us_supplier_uuid(v->>'dispatchId') or not public.zentra_us_purchase_timestamp(v->>'dispatchedAt') or (v->>'dispatchedAt')::timestamptz<(v->>'createdAt')::timestamptz then return false;end if;
  elsif v->'dispatchId'<>'null'::jsonb or v->'dispatchedAt'<>'null'::jsonb then return false;end if;
  if done then
    if not public.zentra_us_tax_strings(v,array['resultBody','resultSha256','proposalId']) or octet_length(v->>'resultBody')>65536 or v->>'resultSha256' !~ '^[a-f0-9]{64}$'
      or v->>'resultSha256' is distinct from encode(sha256(convert_to(v->>'resultBody','UTF8')),'hex') or not public.zentra_us_supplier_uuid(v->>'proposalId') then return false;end if;
    r:=(v->>'resultBody')::jsonb;if not public.zentra_us_supplier_extraction_valid(r) then return false;end if;
  elsif v->'resultBody'<>'null'::jsonb or v->'resultSha256'<>'null'::jsonb or v->'proposalId'<>'null'::jsonb then return false;end if;
  return true;
exception when others then return false;end $$;

create table public.zentra_us_automation_settings(organization_id text primary key references public.zentra_us_erp_heads on delete restrict,revision bigint not null,payload jsonb not null,
  check(public.zentra_us_analysis_settings_valid(payload,organization_id) and payload->>'revision'=revision::text and revision>0));
create table public.zentra_us_automation_settings_changes(organization_id text not null references public.zentra_us_erp_heads on delete restrict,request_id uuid not null,revision bigint not null,
  actor_id text not null,actor_role text not null,occurred_at timestamptz not null,request jsonb not null,previous jsonb not null,snapshot jsonb not null,
  primary key(organization_id,request_id),unique(organization_id,revision),check(public.zentra_us_analysis_settings_valid(previous,organization_id) and public.zentra_us_analysis_settings_valid(snapshot,organization_id) and snapshot->>'revision'=revision::text));
alter table public.zentra_us_automation_settings add constraint zentra_us_automation_settings_history_fk foreign key(organization_id,revision) references public.zentra_us_automation_settings_changes(organization_id,revision) deferrable initially deferred;
create table public.zentra_us_analysis_periods(organization_id text not null references public.zentra_us_erp_heads on delete restrict,environment text not null,bucket text not null,period_id text not null,initial_grant jsonb not null,
  primary key(organization_id,environment,bucket,period_id),check(public.zentra_us_analysis_grant_valid(initial_grant,organization_id,false) and initial_grant->>'environment'=environment and initial_grant->>'bucket'=bucket and initial_grant->>'periodId'=period_id));
create table public.zentra_us_analysis_jobs(organization_id text not null references public.zentra_us_erp_heads on delete restrict,id uuid not null,environment text not null,bucket text not null,source_sha256 text not null,payload jsonb not null,
  primary key(organization_id,id),unique(organization_id,environment,bucket,source_sha256),check(public.zentra_us_analysis_job_valid(payload,organization_id) and payload->>'id'=id::text and payload->>'environment'=environment and payload->>'bucket'=bucket and payload->'source'->>'sha256'=source_sha256));
create unique index zentra_us_analysis_request_unique on public.zentra_us_analysis_jobs(organization_id,(payload->>'requestId'));
create table public.zentra_us_analysis_audit(organization_id text not null,job_id uuid not null,sequence bigint not null,action text not null check(action in('claimed','reclaimed','released','dispatched','uncertain','completed')),
  actor_id text not null,occurred_at timestamptz not null,previous_hash text,snapshot_hash text not null check(snapshot_hash ~ '^[a-f0-9]{64}$'),
  previous_state text,state text not null,lease_generation bigint not null,period_id text not null,primary key(organization_id,job_id,sequence),
  foreign key(organization_id,job_id) references public.zentra_us_analysis_jobs deferrable initially deferred);
create function public.zentra_us_analysis_immutable() returns trigger language plpgsql security invoker set search_path='' as $$ begin raise exception using errcode='PA008',message='US analysis history is immutable';end $$;
create trigger zentra_us_automation_settings_no_delete before delete or truncate on public.zentra_us_automation_settings for each statement execute function public.zentra_us_analysis_immutable();
create trigger zentra_us_automation_changes_immutable before update or delete or truncate on public.zentra_us_automation_settings_changes for each statement execute function public.zentra_us_analysis_immutable();
create trigger zentra_us_analysis_periods_immutable before update or delete or truncate on public.zentra_us_analysis_periods for each statement execute function public.zentra_us_analysis_immutable();
create trigger zentra_us_analysis_jobs_no_delete before delete or truncate on public.zentra_us_analysis_jobs for each statement execute function public.zentra_us_analysis_immutable();
create trigger zentra_us_analysis_audit_immutable before update or delete or truncate on public.zentra_us_analysis_audit for each statement execute function public.zentra_us_analysis_immutable();

create function public.zentra_us_analysis_scope(org text,actor jsonb,cap integer) returns void
language plpgsql security invoker set search_path='' as $$ begin
  if cap is distinct from 4 then raise exception using errcode='PA006',message='Captured US capability4 required';end if;
  if not public.zentra_us_supplier_uuid(org) or not coalesce(public.zentra_us_tax_actor_valid(actor,org),false) or not public.zentra_us_analysis_text(actor->>'userId',256) or not public.zentra_us_purchase_timestamp(actor->>'timestamp') then raise exception using errcode='PA005',message='US financial actor required';end if;
  perform public.zentra_us_supplier_scope(org,actor,cap);
end $$;
create function public.zentra_us_analysis_check_grant(org text,g jsonb) returns void language plpgsql security invoker set search_path='' as $$ begin
  if not public.zentra_us_analysis_grant_valid(g,org,false) then raise exception using errcode='PA004',message='Invalid private budget evidence';end if;
  if not public.zentra_us_analysis_grant_valid(g,org,true) then raise exception using errcode='PA011',message='Fresh private budget evidence required';end if;
end $$;
create function public.zentra_read_us_automation_settings(p_organization text,p_actor jsonb,p_supported_schema_version integer) returns jsonb
language plpgsql security invoker set search_path='' as $$ declare result jsonb;begin
  perform public.zentra_us_analysis_scope(p_organization,p_actor,p_supported_schema_version);
  select payload into result from public.zentra_us_automation_settings where organization_id=p_organization;
  return coalesce(result,jsonb_build_object('schemaVersion',1,'organizationId',p_organization,'revision',0,'enabled',false,'consent',null));
end $$;
create function public.zentra_save_us_automation_settings(p_organization text,p_actor jsonb,p_supported_schema_version integer,p_request jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$ declare before jsonb;after jsonb;prior public.zentra_us_automation_settings_changes%rowtype;activate boolean;
begin
  perform public.zentra_us_analysis_scope(p_organization,p_actor,p_supported_schema_version);activate:=p_request->>'action'='activate';
  if not public.zentra_us_analysis_settings_request_valid(p_request) then raise exception using errcode='PA004',message='Invalid processing consent request';end if;
  if (activate and p_actor->>'role'<>'owner') or (not activate and p_actor->>'role' not in('owner','admin')) then raise exception using errcode='PA005',message='Owner consent or administrative pause required';end if;
  select * into prior from public.zentra_us_automation_settings_changes where organization_id=p_organization and request_id=(p_request->>'requestId')::uuid;
  if found then if prior.actor_id is distinct from p_actor->>'userId' or prior.request is distinct from p_request then raise exception using errcode='PA002',message='Consent request reuse differs';end if;return jsonb_build_object('settings',prior.snapshot,'replayed',true);end if;
  before:=public.zentra_read_us_automation_settings(p_organization,p_actor,p_supported_schema_version);
  if before->'revision' is distinct from p_request->'expectedRevision' then raise exception using errcode='PA001',message='Processing settings changed';end if;
  after:=jsonb_build_object('schemaVersion',1,'organizationId',p_organization,'revision',(before->>'revision')::bigint+1,'enabled',activate,'consent',case when activate then jsonb_build_object('processingPolicyVersion',p_request->>'processingPolicyVersion','acceptedBy',p_actor->>'userId','acceptedAt',p_actor->>'timestamp') else before->'consent' end);
  insert into public.zentra_us_automation_settings_changes values(p_organization,(p_request->>'requestId')::uuid,(after->>'revision')::bigint,p_actor->>'userId',p_actor->>'role',(p_actor->>'timestamp')::timestamptz,p_request,before,after);
  insert into public.zentra_us_automation_settings values(p_organization,(after->>'revision')::bigint,after) on conflict(organization_id) do update set revision=excluded.revision,payload=excluded.payload;
  return jsonb_build_object('settings',after,'replayed',false);
end $$;
create function public.zentra_us_analysis_consent(org text,g jsonb) returns bigint language plpgsql security invoker set search_path='' as $$ declare s public.zentra_us_automation_settings%rowtype;begin
  select * into s from public.zentra_us_automation_settings where organization_id=org for update;
  if not found or s.payload->'enabled'<>'true'::jsonb or s.payload->'consent'->'processingPolicyVersion' is distinct from g->'processingPolicyVersion' then raise exception using errcode='PA003',message='Current owner processing consent required';end if;return s.revision;
end $$;
create function public.zentra_us_analysis_write(org text,j jsonb,action text,actor jsonb) returns void
language plpgsql security invoker set search_path='' as $$ declare prior jsonb;n bigint;begin
  select payload into prior from public.zentra_us_analysis_jobs where organization_id=org and id=(j->>'id')::uuid;
  select coalesce(max(sequence),0)+1 into n from public.zentra_us_analysis_audit where organization_id=org and job_id=(j->>'id')::uuid;
  insert into public.zentra_us_analysis_jobs values(org,(j->>'id')::uuid,j->>'environment',j->>'bucket',j->'source'->>'sha256',j) on conflict(organization_id,id) do update set payload=excluded.payload;
  insert into public.zentra_us_analysis_audit values(org,(j->>'id')::uuid,n,action,actor->>'userId',(actor->>'timestamp')::timestamptz,
    case when prior is null then null else encode(sha256(convert_to(public.zentra_us_erp_v4_canonical(prior),'UTF8')),'hex') end,encode(sha256(convert_to(public.zentra_us_erp_v4_canonical(j),'UTF8')),'hex'),
    prior->>'state',j->>'state',(j->>'leaseGeneration')::bigint,j->'grant'->>'periodId');
end $$;
create function public.zentra_us_analysis_transition() returns trigger language plpgsql security invoker set search_path='' as $$ begin
  if new.organization_id is distinct from old.organization_id or new.id is distinct from old.id or new.environment is distinct from old.environment or new.bucket is distinct from old.bucket or new.source_sha256 is distinct from old.source_sha256
    or (new.payload-array['state','grant','consentRevision','leaseToken','leaseUntil','leaseGeneration','dispatchId','dispatchedAt','resultBody','resultSha256','proposalId']) is distinct from (old.payload-array['state','grant','consentRevision','leaseToken','leaseUntil','leaseGeneration','dispatchId','dispatchedAt','resultBody','resultSha256','proposalId']) then raise exception using errcode='PA008',message='Analysis identity is immutable';end if;
  if old.payload->>'state' in('dispatched','uncertain','completed') and (new.payload-array['state','resultBody','resultSha256','proposalId']) is distinct from (old.payload-array['state','resultBody','resultSha256','proposalId']) then raise exception using errcode='PA008',message='Dispatch and consumed period are immutable';end if;
  if old.payload->>'state'='held' and new.payload->>'state' in('held','released') and (old.payload->>'leaseUntil')::timestamptz>clock_timestamp() and (old.payload->'grant'->>'periodEnd')::bigint>extract(epoch from clock_timestamp()) then raise exception using errcode='PA008',message='Unexpired analysis lease cannot be reclaimed or released';end if;
  if not ((old.payload->>'state' in('held','released') and new.payload->>'state'='held' and (new.payload->>'leaseGeneration')::bigint=(old.payload->>'leaseGeneration')::bigint+1)
    or (old.payload->>'state'='held' and new.payload->>'state' in('released','dispatched')) or (old.payload->>'state'='dispatched' and new.payload->>'state'='uncertain') or (old.payload->>'state' in('dispatched','uncertain') and new.payload->>'state'='completed')) then raise exception using errcode='PA008',message='Invalid analysis transition';end if;return new;
end $$;
create trigger zentra_us_analysis_transition before update on public.zentra_us_analysis_jobs for each row execute function public.zentra_us_analysis_transition();
create function public.zentra_us_analysis_history() returns trigger language plpgsql security invoker set search_path='' as $$ declare j jsonb;h text;n bigint;proposal jsonb;guarded_job_id uuid;latest public.zentra_us_analysis_audit%rowtype;begin
  if tg_table_name='zentra_us_analysis_jobs' then guarded_job_id:=new.id;else guarded_job_id:=new.job_id;end if;
  select payload into j from public.zentra_us_analysis_jobs r where r.organization_id=new.organization_id and r.id=guarded_job_id;
  select snapshot_hash into h from public.zentra_us_analysis_audit where organization_id=new.organization_id and job_id=(j->>'id')::uuid order by sequence desc limit 1;
  if h is distinct from encode(sha256(convert_to(public.zentra_us_erp_v4_canonical(j),'UTF8')),'hex') then raise exception using errcode='PA008',message='Analysis has no correlated audit';end if;
  select * into latest from public.zentra_us_analysis_audit a where a.organization_id=new.organization_id and a.job_id=(j->>'id')::uuid order by sequence desc limit 1;
  if latest.state is distinct from j->>'state' or latest.lease_generation is distinct from (j->>'leaseGeneration')::bigint or latest.period_id is distinct from j->'grant'->>'periodId'
    or (select count(*) from public.zentra_us_analysis_audit a where a.organization_id=new.organization_id and a.job_id=(j->>'id')::uuid)<>latest.sequence
    or exists(select 1 from public.zentra_us_analysis_audit a left join public.zentra_us_analysis_audit p on p.organization_id=a.organization_id and p.job_id=a.job_id and p.sequence=a.sequence-1
      where a.organization_id=new.organization_id and a.job_id=(j->>'id')::uuid and (not public.zentra_us_analysis_text(a.actor_id,256)
      or (a.sequence=1 and (a.action<>'claimed' or a.previous_hash is not null or a.previous_state is not null or a.state<>'held' or a.lease_generation<>1 or a.actor_id is distinct from j->>'createdBy' or a.occurred_at is distinct from (j->>'createdAt')::timestamptz))
      or (a.sequence>1 and (p.sequence is null or a.previous_hash is distinct from p.snapshot_hash or a.previous_state is distinct from p.state or a.occurred_at<p.occurred_at
        or not ((a.action='reclaimed' and p.state='released' and a.state='held' and a.lease_generation=p.lease_generation+1)
          or (a.action='released' and p.state='held' and a.state='released' and a.lease_generation=p.lease_generation and a.period_id=p.period_id)
          or (a.action='dispatched' and p.state='held' and a.state='dispatched' and a.lease_generation=p.lease_generation and a.period_id=p.period_id)
          or (a.action='uncertain' and p.state='dispatched' and a.state='uncertain' and a.lease_generation=p.lease_generation and a.period_id=p.period_id)
          or (a.action='completed' and p.state in('dispatched','uncertain') and a.state='completed' and a.lease_generation=p.lease_generation and a.period_id=p.period_id)))))) then raise exception using errcode='PA008',message='Analysis audit chain differs';end if;
  if (select count(*)>50 or octet_length(coalesce(jsonb_agg(payload),'[]'::jsonb)::text)>2000000 from public.zentra_us_analysis_jobs where organization_id=new.organization_id) then raise exception using errcode='PA012',message='Analysis source budget reached';end if;
  if j->>'state'='completed' then
    select payload into proposal from public.zentra_us_supplier_proposals where organization_id=new.organization_id and id=(j->>'proposalId')::uuid;
    if proposal is null or proposal->'source'->'sha256' is distinct from j->'source'->'sha256' or proposal->'source'->'documentText' is distinct from j->'source'->'documentText' or proposal->'extraction' is distinct from (j->>'resultBody')::jsonb then raise exception using errcode='PA008',message='Analysis result has no exact supplier proposal';end if;
  end if;return new;
end $$;
create constraint trigger zentra_us_analysis_job_history after insert or update on public.zentra_us_analysis_jobs deferrable initially deferred for each row execute function public.zentra_us_analysis_history();
create constraint trigger zentra_us_analysis_audit_history after insert on public.zentra_us_analysis_audit deferrable initially deferred for each row execute function public.zentra_us_analysis_history();
create function public.zentra_us_analysis_settings_history() returns trigger language plpgsql security invoker set search_path='' as $$ declare s public.zentra_us_automation_settings%rowtype;r public.zentra_us_automation_settings_changes%rowtype;begin
  select * into s from public.zentra_us_automation_settings where organization_id=new.organization_id;
  select * into r from public.zentra_us_automation_settings_changes where organization_id=new.organization_id and revision=s.revision;
  if not found or r.snapshot is distinct from s.payload or (select count(*)from public.zentra_us_automation_settings_changes where organization_id=new.organization_id)<>s.revision
    or exists(select 1 from public.zentra_us_automation_settings_changes c left join public.zentra_us_automation_settings_changes p on p.organization_id=c.organization_id and p.revision=c.revision-1 where c.organization_id=new.organization_id and (c.snapshot->'revision' is distinct from to_jsonb(c.revision) or c.previous->>'revision'<>(c.revision-1)::text
      or not public.zentra_us_analysis_text(c.actor_id,256) or c.actor_role not in('owner','admin')
      or not public.zentra_us_analysis_settings_request_valid(c.request) or c.request->>'requestId'<>c.request_id::text or c.request->'expectedRevision' is distinct from to_jsonb(c.revision-1)
      or (c.revision=1 and c.previous is distinct from jsonb_build_object('schemaVersion',1,'organizationId',c.organization_id,'revision',0,'enabled',false,'consent',null))
      or (c.revision>1 and (p.revision is null or c.previous is distinct from p.snapshot or c.occurred_at<p.occurred_at))
      or not ((c.request->>'action'='activate' and c.actor_role='owner' and c.request->'consent'='true'::jsonb and c.snapshot->'enabled'='true'::jsonb and c.snapshot->'consent'->'processingPolicyVersion'=c.request->'processingPolicyVersion' and c.snapshot->'consent'->>'acceptedBy'=c.actor_id and (c.snapshot->'consent'->>'acceptedAt')::timestamptz=c.occurred_at)
        or (c.request->>'action'='pause' and c.request->'consent'='false'::jsonb and c.snapshot->'enabled'='false'::jsonb and c.snapshot->'consent' is not distinct from c.previous->'consent')))) then raise exception using errcode='PA008',message='Processing consent history differs';end if;return new;
end $$;
create constraint trigger zentra_us_automation_settings_history after insert or update on public.zentra_us_automation_settings deferrable initially deferred for each row execute function public.zentra_us_analysis_settings_history();
create constraint trigger zentra_us_automation_changes_history after insert on public.zentra_us_automation_settings_changes deferrable initially deferred for each row execute function public.zentra_us_analysis_settings_history();

create function public.zentra_usage_us_automation_analysis(p_organization text,p_actor jsonb,p_supported_schema_version integer,p_grant jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$ declare held bigint;consumed bigint;begin
  perform public.zentra_us_analysis_scope(p_organization,p_actor,p_supported_schema_version);perform public.zentra_us_analysis_check_grant(p_organization,p_grant);
  select count(*)filter(where payload->>'state'='held'),count(*)filter(where payload->>'state' in('dispatched','uncertain','completed')) into held,consumed from public.zentra_us_analysis_jobs
    where organization_id=p_organization and environment=p_grant->>'environment' and bucket=p_grant->>'bucket' and payload->'grant'->'periodId'=p_grant->'periodId';
  return jsonb_build_object('schemaVersion',1,'organizationId',p_organization,'environment',p_grant->'environment','bucket',p_grant->'bucket','periodId',p_grant->'periodId','limit',p_grant->'limit','held',held,'consumed',consumed,'remaining',greatest(0,(p_grant->>'limit')::bigint-held-consumed));
end $$;
create function public.zentra_expire_us_automation_held(p_organization text,p_actor jsonb,p_supported_schema_version integer,p_grant jsonb) returns integer
language plpgsql security invoker set search_path='' as $$ declare r record;j jsonb;n integer:=0;begin
  perform public.zentra_us_analysis_scope(p_organization,p_actor,p_supported_schema_version);perform public.zentra_us_analysis_check_grant(p_organization,p_grant);
  for r in select payload from public.zentra_us_analysis_jobs where organization_id=p_organization and environment=p_grant->>'environment' and bucket=p_grant->>'bucket' and payload->>'state'='held'
    and ((payload->>'leaseUntil')::timestamptz<=clock_timestamp() or (payload->'grant'->>'periodEnd')::bigint<=extract(epoch from clock_timestamp())) for update loop
    j:=r.payload||jsonb_build_object('state','released','leaseToken',null,'leaseUntil',null);perform public.zentra_us_analysis_write(p_organization,j,'released',p_actor);n:=n+1;
  end loop;return n;
end $$;
create function public.zentra_claim_us_automation_analysis(p_organization text,p_actor jsonb,p_supported_schema_version integer,p_grant jsonb,p_source jsonb,p_recipe_version text,p_request_id uuid,p_lease_token uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$ declare j jsonb;s bigint;u jsonb;t text:=to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');begin
  perform public.zentra_us_analysis_scope(p_organization,p_actor,p_supported_schema_version);perform public.zentra_us_analysis_check_grant(p_organization,p_grant);s:=public.zentra_us_analysis_consent(p_organization,p_grant);
  if not public.zentra_us_analysis_source_valid(p_source,p_organization) or p_recipe_version is null or p_recipe_version !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' or p_request_id is null or p_lease_token is null then raise exception using errcode='PA004',message='Invalid analysis source';end if;
  if exists(select 1 from public.zentra_us_analysis_jobs where organization_id=p_organization and payload->>'requestId'=p_request_id::text and (source_sha256 is distinct from p_source->>'sha256' or environment is distinct from p_grant->>'environment')) then raise exception using errcode='PA002',message='Analysis request source reuse differs';end if;
  perform public.zentra_expire_us_automation_held(p_organization,p_actor,p_supported_schema_version,p_grant);
  select payload into j from public.zentra_us_analysis_jobs where organization_id=p_organization and environment=p_grant->>'environment' and bucket=p_grant->>'bucket' and source_sha256=p_source->>'sha256' for update;
  if found then
    if j->'source'->'documentText' is distinct from p_source->'documentText' or j->'source'->'mediaType' is distinct from p_source->'mediaType' then raise exception using errcode='PA002',message='Analysis source identity differs';end if;
    if j->>'state'<>'released' then return jsonb_build_object('job',j,'claimed',j->>'state'='held' and j->>'leaseToken'=p_lease_token::text);end if;
  end if;
  u:=public.zentra_usage_us_automation_analysis(p_organization,p_actor,p_supported_schema_version,p_grant);
  if (u->>'remaining')::bigint<1 then raise exception using errcode='PA007',message='US analysis quota exhausted';end if;
  insert into public.zentra_us_analysis_periods values(p_organization,p_grant->>'environment',p_grant->>'bucket',p_grant->>'periodId',p_grant) on conflict do nothing;
  if j is null then
    if (select count(*)>=50 from public.zentra_us_analysis_jobs where organization_id=p_organization) then raise exception using errcode='PA012',message='US analysis source limit';end if;
    j:=jsonb_build_object('schemaVersion',1,'organizationId',p_organization,'id',gen_random_uuid()::text,'environment',p_grant->'environment','bucket',p_grant->'bucket','source',p_source,'recipeVersion',p_recipe_version,'requestId',p_request_id::text,'createdBy',p_actor->>'userId','createdAt',p_actor->>'timestamp','grant',p_grant,'consentRevision',s,'state','held','leaseToken',p_lease_token::text,'leaseUntil',to_char((clock_timestamp()+interval '120 seconds') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'leaseGeneration',1,'dispatchId',null,'dispatchedAt',null,'resultBody',null,'resultSha256',null,'proposalId',null);
    perform public.zentra_us_analysis_write(p_organization,j,'claimed',p_actor);
  else
    j:=j||jsonb_build_object('grant',p_grant,'consentRevision',s,'state','held','leaseToken',p_lease_token::text,'leaseUntil',to_char((clock_timestamp()+interval '120 seconds') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'leaseGeneration',(j->>'leaseGeneration')::bigint+1);
    perform public.zentra_us_analysis_write(p_organization,j,'reclaimed',p_actor);
  end if;return jsonb_build_object('job',j,'claimed',true);
end $$;
create function public.zentra_dispatch_us_automation_analysis(p_organization text,p_actor jsonb,p_supported_schema_version integer,p_grant jsonb,p_job_id uuid,p_lease_token uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$ declare j jsonb;s bigint;u jsonb;begin
  perform public.zentra_us_analysis_scope(p_organization,p_actor,p_supported_schema_version);perform public.zentra_us_analysis_check_grant(p_organization,p_grant);s:=public.zentra_us_analysis_consent(p_organization,p_grant);
  select payload into j from public.zentra_us_analysis_jobs where organization_id=p_organization and id=p_job_id for update;
  if j is null or j->'environment' is distinct from p_grant->'environment' then raise exception using errcode='PA004',message='Analysis unavailable';end if;
  if j->>'state' in('dispatched','uncertain','completed') then return jsonb_build_object('job',j,'mayDispatch',false);end if;
  if j->>'state'<>'held' or j->>'leaseToken' is distinct from p_lease_token::text or (j->>'leaseUntil')::timestamptz<=clock_timestamp() or j->'grant'->'periodId' is distinct from p_grant->'periodId' or (j->>'consentRevision')::bigint<>s then raise exception using errcode='PA009',message='Analysis lease or consent changed';end if;
  u:=public.zentra_usage_us_automation_analysis(p_organization,p_actor,p_supported_schema_version,p_grant);
  if (u->>'held')::bigint+(u->>'consumed')::bigint>(p_grant->>'limit')::bigint then raise exception using errcode='PA007',message='Current US quota reduced';end if;
  j:=j||jsonb_build_object('state','dispatched','dispatchId',gen_random_uuid()::text,'dispatchedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  perform public.zentra_us_analysis_write(p_organization,j,'dispatched',p_actor);return jsonb_build_object('job',j,'mayDispatch',true);
end $$;
create function public.zentra_complete_us_automation_analysis(p_organization text,p_actor jsonb,p_supported_schema_version integer,p_grant jsonb,p_job_id uuid,p_dispatch_id uuid,p_result_body text,p_result_sha256 text) returns jsonb
language plpgsql security invoker set search_path='' as $$ declare j jsonb;r jsonb;proposal jsonb;begin
  perform public.zentra_us_analysis_scope(p_organization,p_actor,p_supported_schema_version);perform public.zentra_us_analysis_check_grant(p_organization,p_grant);
  select payload into j from public.zentra_us_analysis_jobs where organization_id=p_organization and id=p_job_id for update;
  if j is null or j->'environment' is distinct from p_grant->'environment' or j->>'dispatchId' is distinct from p_dispatch_id::text then raise exception using errcode='PA004',message='Original analysis dispatch required';end if;
  if p_result_body is null or octet_length(p_result_body)>65536 or p_result_sha256 is distinct from encode(sha256(convert_to(p_result_body,'UTF8')),'hex') then raise exception using errcode='PA004',message='Invalid analysis result bytes';end if;
  begin r:=p_result_body::jsonb;exception when others then raise exception using errcode='PA004',message='Invalid analysis result JSON';end;
  if not public.zentra_us_supplier_extraction_valid(r) then raise exception using errcode='PA004',message='Invalid extracted proposal';end if;
  if j->>'state'='completed' then
    if j->>'resultBody' is distinct from p_result_body or j->>'resultSha256' is distinct from p_result_sha256 then raise exception using errcode='PA002',message='Analysis completion reuse differs';end if;
    select payload into proposal from public.zentra_us_supplier_proposals where organization_id=p_organization and id=(j->>'proposalId')::uuid;return jsonb_build_object('job',j,'proposal',proposal);
  end if;
  if j->>'state' not in('dispatched','uncertain') then raise exception using errcode='PA010',message='Dispatched analysis required';end if;
  proposal:=jsonb_build_object('schemaVersion',1,'organizationId',p_organization,'id',j->>'id','revision',0,'state','review','source',j->'source','extraction',r,'createdBy',p_actor->>'userId','createdAt',p_actor->>'timestamp');
  proposal:=public.zentra_create_us_supplier_proposal(p_organization,p_actor,p_supported_schema_version,proposal);
  if proposal->'extraction' is distinct from r then raise exception using errcode='PA002',message='Existing source result differs';end if;
  j:=j||jsonb_build_object('state','completed','resultBody',p_result_body,'resultSha256',p_result_sha256,'proposalId',proposal->>'id');
  perform public.zentra_us_analysis_write(p_organization,j,'completed',p_actor);return jsonb_build_object('job',j,'proposal',proposal);
end $$;
create function public.zentra_uncertain_us_automation_analysis(p_organization text,p_actor jsonb,p_supported_schema_version integer,p_job_id uuid,p_dispatch_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$ declare j jsonb;begin
  perform public.zentra_us_analysis_scope(p_organization,p_actor,p_supported_schema_version);select payload into j from public.zentra_us_analysis_jobs where organization_id=p_organization and id=p_job_id for update;
  if j is null or j->>'dispatchId' is distinct from p_dispatch_id::text then raise exception using errcode='PA004',message='Original analysis dispatch required';end if;
  if j->>'state' in('uncertain','completed') then return j;end if;
  if j->>'state'<>'dispatched' then raise exception using errcode='PA010',message='Dispatched analysis required';end if;
  j:=j||jsonb_build_object('state','uncertain');perform public.zentra_us_analysis_write(p_organization,j,'uncertain',p_actor);return j;
end $$;
create function public.zentra_read_us_automation_analysis(p_organization text,p_actor jsonb,p_supported_schema_version integer,p_job_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$ declare j jsonb;begin perform public.zentra_us_analysis_scope(p_organization,p_actor,p_supported_schema_version);select payload into j from public.zentra_us_analysis_jobs where organization_id=p_organization and id=p_job_id;return j;end $$;
create function public.zentra_find_us_automation_source(p_organization text,p_actor jsonb,p_supported_schema_version integer,p_grant jsonb,p_source_sha256 text) returns jsonb
language plpgsql security invoker set search_path='' as $$ declare j jsonb;begin
  perform public.zentra_us_analysis_scope(p_organization,p_actor,p_supported_schema_version);perform public.zentra_us_analysis_check_grant(p_organization,p_grant);
  if p_source_sha256 is null or p_source_sha256 !~ '^[a-f0-9]{64}$' then raise exception using errcode='PA004',message='Invalid analysis source hash';end if;
  select payload into j from public.zentra_us_analysis_jobs where organization_id=p_organization and environment=p_grant->>'environment' and bucket=p_grant->>'bucket' and source_sha256=p_source_sha256;return j;
end $$;
do $$ declare tab text;f record;begin
  foreach tab in array array['zentra_us_automation_settings','zentra_us_automation_settings_changes','zentra_us_analysis_periods','zentra_us_analysis_jobs','zentra_us_analysis_audit'] loop
    execute format('alter table public.%I enable row level security',tab);execute format('revoke all on table public.%I from public,anon,authenticated,service_role',tab);execute format('grant select,insert on table public.%I to service_role',tab);
    if tab in('zentra_us_automation_settings','zentra_us_analysis_jobs') then execute format('grant update on table public.%I to service_role',tab);end if;
  end loop;
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'zentra_us_analysis_%' or p.proname in('zentra_read_us_automation_settings','zentra_save_us_automation_settings','zentra_claim_us_automation_analysis','zentra_dispatch_us_automation_analysis','zentra_complete_us_automation_analysis','zentra_uncertain_us_automation_analysis','zentra_read_us_automation_analysis','zentra_find_us_automation_source','zentra_usage_us_automation_analysis','zentra_expire_us_automation_held')) loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
comment on table public.zentra_us_analysis_jobs is 'Private US supplier analysis; dispatched quota never expires or refunds. No provider, hosted activation or distributed D1/PG transaction established.';
commit;
