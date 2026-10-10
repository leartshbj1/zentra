-- Private US supplier originals. Metadata is immutable; only a trusted server
-- can attest an R2 re-read. SQL never claims to verify remote object bytes.
-- No legacy tables/RPCs, retention policy, cleanup, lease or object deletion.
begin;

create function public.zentra_us_supplier_document_descriptor_valid(v jsonb,org text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
begin
  if not public.zentra_us_tax_object(v,array['schemaVersion','organizationId','id','contentSha256','sizeBytes','mediaType','fileName','documentText','textSha256','createdBy','createdAt'])
    or v->'schemaVersion' is distinct from '1'::jsonb or v->>'organizationId' is distinct from org
    or not public.zentra_us_supplier_uuid(org) or not public.zentra_us_supplier_uuid(v->>'id')
    or not public.zentra_us_tax_strings(v,array['organizationId','id','contentSha256','mediaType','fileName','createdBy','createdAt'])
    or v->>'contentSha256' !~ '^[a-f0-9]{64}$' or v->>'mediaType' not in('application/pdf','image/png','image/jpeg','text/plain')
    or jsonb_typeof(v->'sizeBytes') is distinct from 'number' or v->>'sizeBytes' !~ '^[1-9][0-9]*$' or (v->>'sizeBytes')::bigint not between 1 and 6291456
    or not public.zentra_us_supplier_text(v->>'fileName',160) or not public.zentra_us_supplier_text(v->>'createdBy',256)
    or not public.zentra_us_purchase_timestamp(v->>'createdAt') then return false;end if;
  if v->'documentText'='null'::jsonb then return v->'textSha256'='null'::jsonb;end if;
  return coalesce(public.zentra_us_tax_strings(v,array['documentText','textSha256']) and length(public.zentra_us_supplier_trim(v->>'documentText'))>0
    and octet_length(v->>'documentText')<=16384 and (v->>'documentText') !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]'
    and v->>'textSha256'=encode(sha256(convert_to(v->>'documentText','UTF8')),'hex'),false);
exception when others then return false;end $$;

create table public.zentra_us_supplier_documents(
  organization_id text not null references public.zentra_workspace_country_configs(organization_id),
  id uuid not null,content_sha256 text not null,size_bytes bigint not null,payload jsonb not null,
  primary key(organization_id,id),unique(organization_id,content_sha256),unique(organization_id,id,content_sha256,size_bytes),
  check(public.zentra_us_supplier_document_descriptor_valid(payload,organization_id) is true
    and payload->>'id'=id::text and payload->>'contentSha256'=content_sha256 and (payload->>'sizeBytes')::bigint=size_bytes)
);
create table public.zentra_us_supplier_document_receipts(
  organization_id text not null,document_id uuid not null,content_sha256 text not null,size_bytes bigint not null,
  completed_by text not null check(public.zentra_us_supplier_text(completed_by,256)),completed_at timestamptz not null,
  primary key(organization_id,document_id),
  foreign key(organization_id,document_id,content_sha256,size_bytes) references public.zentra_us_supplier_documents(organization_id,id,content_sha256,size_bytes)
);
create table public.zentra_us_supplier_document_links(
  organization_id text not null,document_id uuid not null,proposal_id uuid not null,text_sha256 text not null check(text_sha256 ~ '^[a-f0-9]{64}$'),
  linked_by text not null check(public.zentra_us_supplier_text(linked_by,256)),linked_at timestamptz not null,
  primary key(organization_id,document_id),unique(organization_id,proposal_id),
  foreign key(organization_id,document_id) references public.zentra_us_supplier_document_receipts(organization_id,document_id),
  foreign key(organization_id,proposal_id) references public.zentra_us_supplier_proposals(organization_id,id)
);

-- Same lock order as financial commands, including direct privileged writes.
-- The service actor/role is validated by zentra_us_supplier_scope in every RPC;
-- this structural trigger does not fabricate an owner or replace fresh Auth/D1.
create function public.zentra_us_supplier_document_workspace(org text) returns void
language plpgsql security invoker set search_path='' as $$
declare c public.zentra_workspace_country_configs%rowtype;h public.zentra_us_erp_heads%rowtype;
begin
  perform 1 from public.zentra_workspaces where organization_id=org for update;
  if not found then raise exception using errcode='PD001',message='Current US workspace required';end if;
  select * into c from public.zentra_workspace_country_configs where organization_id=org for update;
  select * into h from public.zentra_us_erp_heads where organization_id=org for update;
  if c.country is distinct from 'US' or c.currency is distinct from 'USD' or h.header->'schemaVersion' is distinct from '4'::jsonb or h.header->'configuration' is distinct from c.config
    then raise exception using errcode='PD001',message='Current US workspace required';end if;
end $$;
create function public.zentra_us_supplier_document_immutable() returns trigger
language plpgsql security invoker set search_path='' as $$
begin raise exception using errcode='PD002',message='Supplier original history is immutable';end $$;
create function public.zentra_us_supplier_document_insert() returns trigger
language plpgsql security invoker set search_path='' as $$
declare d public.zentra_us_supplier_documents%rowtype;p public.zentra_us_supplier_proposals%rowtype;
begin
  perform public.zentra_us_supplier_document_workspace(new.organization_id);
  if tg_table_name='zentra_us_supplier_documents' then
    if (select count(*) from public.zentra_us_supplier_documents where organization_id=new.organization_id)>=50
      or (select coalesce(sum(size_bytes),0) from public.zentra_us_supplier_documents where organization_id=new.organization_id)+new.size_bytes>104857600
      then raise exception using errcode='PD004',message='Supplier original capacity reached';end if;
  else
    select * into d from public.zentra_us_supplier_documents where organization_id=new.organization_id and id=new.document_id;
    if not found then raise exception using errcode='PD001',message='Original descriptor required';end if;
    if tg_table_name='zentra_us_supplier_document_receipts' then
      if new.completed_at<(d.payload->>'createdAt')::timestamptz then raise exception using errcode='PD001',message='Invalid original receipt time';end if;
    else
      select * into p from public.zentra_us_supplier_proposals where organization_id=new.organization_id and id=new.proposal_id for update;
      if not found or p.revision<>0 or p.payload->>'state'<>'review' or d.payload->'documentText'='null'::jsonb
        or d.payload->>'textSha256' is distinct from new.text_sha256 or p.payload->'source'->>'sha256' is distinct from new.text_sha256
        or p.payload->'source'->>'documentText' is distinct from d.payload->>'documentText'
        or p.payload->'source'->>'mediaType' is distinct from 'text/plain' or p.payload->'source'->>'kind' is distinct from 'document_import'
        or new.linked_at<(d.payload->>'createdAt')::timestamptz then raise exception using errcode='PD002',message='Original source link differs';end if;
    end if;
  end if;
  return new;
end $$;
do $$ declare tab text;begin
  foreach tab in array array['zentra_us_supplier_documents','zentra_us_supplier_document_receipts','zentra_us_supplier_document_links'] loop
    execute format('alter table public.%I enable row level security',tab);
    execute format('revoke all on table public.%I from public,anon,authenticated,service_role',tab);
    execute format('grant select,insert on table public.%I to service_role',tab);
    execute format('create trigger %I before insert on public.%I for each row execute function public.zentra_us_supplier_document_insert()',tab||'_insert',tab);
    execute format('create trigger %I before update or delete or truncate on public.%I for each statement execute function public.zentra_us_supplier_document_immutable()',tab||'_immutable',tab);
  end loop;
end $$;

create function public.zentra_us_supplier_document_projection(org text,doc uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
  select d.payload||jsonb_build_object('stored',exists(select 1 from public.zentra_us_supplier_document_receipts r where r.organization_id=d.organization_id and r.document_id=d.id),
    'proposalId',(select l.proposal_id::text from public.zentra_us_supplier_document_links l where l.organization_id=d.organization_id and l.document_id=d.id))
  from public.zentra_us_supplier_documents d where d.organization_id=org and d.id=doc;
$$;
create function public.zentra_list_us_supplier_documents(p_organization text,p_actor jsonb,p_supported_schema_version integer) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare result jsonb;begin
  perform public.zentra_us_supplier_scope(p_organization,p_actor,p_supported_schema_version);
  select coalesce(jsonb_agg(public.zentra_us_supplier_document_projection(p_organization,id) order by payload->>'createdAt' desc,id),'[]'::jsonb)
    into result from public.zentra_us_supplier_documents where organization_id=p_organization;
  return result;
end $$;
create function public.zentra_read_us_supplier_document(p_organization text,p_actor jsonb,p_supported_schema_version integer,p_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
begin perform public.zentra_us_supplier_scope(p_organization,p_actor,p_supported_schema_version);return public.zentra_us_supplier_document_projection(p_organization,p_id);end $$;
create function public.zentra_reserve_us_supplier_document(p_organization text,p_actor jsonb,p_supported_schema_version integer,p_descriptor jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare d public.zentra_us_supplier_documents%rowtype;
begin
  perform public.zentra_us_supplier_scope(p_organization,p_actor,p_supported_schema_version);
  if not coalesce(public.zentra_us_supplier_document_descriptor_valid(p_descriptor,p_organization),false)
    or p_descriptor->>'createdBy' is distinct from p_actor->>'userId' or p_descriptor->>'createdAt' is distinct from p_actor->>'timestamp'
    then raise exception using errcode='PD001',message='Invalid original descriptor';end if;
  select * into d from public.zentra_us_supplier_documents where organization_id=p_organization and id=(p_descriptor->>'id')::uuid;
  if found then
    if d.payload-'createdAt' is distinct from p_descriptor-'createdAt' then raise exception using errcode='PD002',message='Original request differs';end if;
    return public.zentra_us_supplier_document_projection(p_organization,d.id);
  end if;
  select * into d from public.zentra_us_supplier_documents where organization_id=p_organization and content_sha256=p_descriptor->>'contentSha256';
  if found then
    if d.size_bytes<>(p_descriptor->>'sizeBytes')::bigint or d.payload->'mediaType' is distinct from p_descriptor->'mediaType'
      then raise exception using errcode='PD002',message='Original bytes descriptor differs';end if;
    return public.zentra_us_supplier_document_projection(p_organization,d.id);
  end if;
  insert into public.zentra_us_supplier_documents values(p_organization,(p_descriptor->>'id')::uuid,p_descriptor->>'contentSha256',(p_descriptor->>'sizeBytes')::bigint,p_descriptor);
  return public.zentra_us_supplier_document_projection(p_organization,(p_descriptor->>'id')::uuid);
end $$;
create function public.zentra_complete_us_supplier_document(p_organization text,p_actor jsonb,p_supported_schema_version integer,p_id uuid,p_content_sha256 text,p_size_bytes bigint) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare d public.zentra_us_supplier_documents%rowtype;
begin
  perform public.zentra_us_supplier_scope(p_organization,p_actor,p_supported_schema_version);
  select * into d from public.zentra_us_supplier_documents where organization_id=p_organization and id=p_id;
  if not found then raise exception using errcode='PD003',message='Original not found';end if;
  if d.content_sha256 is distinct from p_content_sha256 or d.size_bytes is distinct from p_size_bytes
    then raise exception using errcode='PD002',message='Verified original bytes differ';end if;
  if not exists(select 1 from public.zentra_us_supplier_document_receipts where organization_id=p_organization and document_id=p_id) then
    insert into public.zentra_us_supplier_document_receipts values(p_organization,p_id,p_content_sha256,p_size_bytes,p_actor->>'userId',(p_actor->>'timestamp')::timestamptz);
  end if;
  return public.zentra_us_supplier_document_projection(p_organization,p_id);
end $$;
create function public.zentra_link_us_supplier_document(p_organization text,p_actor jsonb,p_supported_schema_version integer,p_id uuid,p_proposal jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare d public.zentra_us_supplier_documents%rowtype;p public.zentra_us_supplier_proposals%rowtype;l public.zentra_us_supplier_document_links%rowtype;
begin
  perform public.zentra_us_supplier_scope(p_organization,p_actor,p_supported_schema_version);
  if not coalesce(public.zentra_us_supplier_proposal_valid(p_proposal,p_organization),false) then raise exception using errcode='PD001',message='Invalid proposal snapshot';end if;
  select * into d from public.zentra_us_supplier_documents where organization_id=p_organization and id=p_id;
  if not found then raise exception using errcode='PD003',message='Original not found';end if;
  if not exists(select 1 from public.zentra_us_supplier_document_receipts where organization_id=p_organization and document_id=p_id)
    or d.payload->'documentText'='null'::jsonb or p_proposal->'source'->>'documentText' is distinct from d.payload->>'documentText'
    or p_proposal->'source'->>'sha256' is distinct from d.payload->>'textSha256'
    then raise exception using errcode='PD002',message='Stored original and exact text required';end if;
  select * into p from public.zentra_us_supplier_proposals where organization_id=p_organization and id=(p_proposal->>'id')::uuid for update;
  if not found or (p.payload-array['revision','state','recording']) is distinct from (p_proposal-array['revision','state','recording'])
    then raise exception using errcode='PD002',message='Original proposal snapshot differs';end if;
  select * into l from public.zentra_us_supplier_document_links where organization_id=p_organization and document_id=p_id;
  if found then
    if l.proposal_id::text is distinct from p_proposal->>'id' then raise exception using errcode='PD002',message='Original already linked';end if;
    return public.zentra_us_supplier_document_projection(p_organization,p_id);
  end if;
  if exists(select 1 from public.zentra_us_supplier_document_links where organization_id=p_organization and proposal_id=(p_proposal->>'id')::uuid)
    then raise exception using errcode='PD002',message='Proposal already has an original';end if;
  if p.revision<>0 or p.payload is distinct from p_proposal then raise exception using errcode='PD002',message='Current review proposal required';end if;
  insert into public.zentra_us_supplier_document_links values(p_organization,p_id,p.id,d.payload->>'textSha256',p_actor->>'userId',(p_actor->>'timestamp')::timestamptz);
  return public.zentra_us_supplier_document_projection(p_organization,p_id);
end $$;

do $$ declare f record;begin
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and (p.proname like 'zentra_us_supplier_document_%' or p.proname in('zentra_list_us_supplier_documents','zentra_read_us_supplier_document','zentra_reserve_us_supplier_document','zentra_complete_us_supplier_document','zentra_link_us_supplier_document')) loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
commit;
