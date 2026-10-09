-- Additive private US change hints. Generated with local Supabase CLI.
-- These heads confer no authority, contain no facts/documents/grants, and keep
-- the three-second read independent of list size and historical job count.
begin;
create table public.zentra_us_workspace_change_heads (
  organization_id text not null references public.zentra_us_erp_heads on delete restrict,
  channel text not null check(channel in('supplierProposals','bankReconciliations','supplierAnalysis')),
  scope text not null check(scope='global' or scope='settings' or scope ~ '^(TEST|PRODUCTION):[1-9][0-9]{3}-(0[1-9]|1[0-2])$'),
  revision bigint not null check(revision between 1 and 9007199254740990),
  change_hash text not null check(change_hash ~ '^[a-f0-9]{64}$'),
  primary key(organization_id,channel,scope)
);
alter table public.zentra_us_workspace_change_heads enable row level security;
revoke all on public.zentra_us_workspace_change_heads from public,anon,authenticated,service_role;
grant select,insert,update on public.zentra_us_workspace_change_heads to service_role;
create policy zentra_us_workspace_change_heads_service on public.zentra_us_workspace_change_heads to service_role using(true) with check(true);

-- One-time compact seed. Existing sources and their immutable histories are
-- untouched. Later writes advance the head within their original transaction.
insert into public.zentra_us_workspace_change_heads
select organization_id,'supplierProposals','global',1,encode(sha256(convert_to(jsonb_build_array('seed-supplier',organization_id,count(*),max(id::text),sum(revision))::text,'UTF8')),'hex') from public.zentra_us_supplier_proposals group by organization_id;
insert into public.zentra_us_workspace_change_heads
select organization_id,'bankReconciliations','global',1,encode(sha256(convert_to(jsonb_build_array('seed-bank',organization_id,count(*),max(id::text),sum(revision))::text,'UTF8')),'hex') from public.zentra_us_bank_reconciliations group by organization_id;
insert into public.zentra_us_workspace_change_heads
select organization_id,'supplierAnalysis','settings',1,encode(sha256(convert_to(jsonb_build_array('seed-settings',organization_id,revision)::text,'UTF8')),'hex') from public.zentra_us_automation_settings;
insert into public.zentra_us_workspace_change_heads
select organization_id,'supplierAnalysis',environment||':'||(payload->'grant'->>'periodId'),1,
  encode(sha256(convert_to(jsonb_build_array('seed-usage',organization_id,environment,payload->'grant'->>'periodId',count(*),max(id::text))::text,'UTF8')),'hex')
from public.zentra_us_analysis_jobs group by organization_id,environment,payload->'grant'->>'periodId';

create function public.zentra_track_us_workspace_change() returns trigger
language plpgsql security invoker set search_path='' as $$
declare channel_name text;scope_name text:='global';identity jsonb;digest text;
begin
  if tg_op='UPDATE' and new is not distinct from old then return new;end if;
  if tg_table_name='zentra_us_supplier_proposals' then channel_name:='supplierProposals';identity:=jsonb_build_array(new.id,new.revision);
  elsif tg_table_name='zentra_us_bank_reconciliations' then channel_name:='bankReconciliations';identity:=jsonb_build_array(new.id,new.revision);
  elsif tg_table_name='zentra_us_automation_settings' then channel_name:='supplierAnalysis';scope_name:='settings';identity:=jsonb_build_array(new.revision);
  elsif tg_table_name='zentra_us_analysis_jobs' then
    channel_name:='supplierAnalysis';scope_name:=new.environment||':'||(new.payload->'grant'->>'periodId');
    identity:=jsonb_build_array(new.id,new.payload->'state',new.payload->'leaseGeneration');
  else raise exception using errcode='PW009',message='Unexpected US change source';end if;
  digest:=encode(sha256(convert_to(jsonb_build_array(new.organization_id,channel_name,scope_name,identity)::text,'UTF8')),'hex');
  insert into public.zentra_us_workspace_change_heads(organization_id,channel,scope,revision,change_hash) values(new.organization_id,channel_name,scope_name,1,digest)
  on conflict(organization_id,channel,scope) do update set revision=public.zentra_us_workspace_change_heads.revision+1,
    change_hash=encode(sha256(convert_to(jsonb_build_array(public.zentra_us_workspace_change_heads.change_hash,excluded.change_hash,public.zentra_us_workspace_change_heads.revision+1)::text,'UTF8')),'hex');
  return new;
end $$;
create trigger zentra_us_supplier_change_head after insert or update on public.zentra_us_supplier_proposals for each row execute function public.zentra_track_us_workspace_change();
create trigger zentra_us_bank_change_head after insert or update on public.zentra_us_bank_reconciliations for each row execute function public.zentra_track_us_workspace_change();
create trigger zentra_us_settings_change_head after insert or update on public.zentra_us_automation_settings for each row execute function public.zentra_track_us_workspace_change();
create trigger zentra_us_analysis_change_head after insert or update on public.zentra_us_analysis_jobs for each row execute function public.zentra_track_us_workspace_change();
revoke all on function public.zentra_track_us_workspace_change() from public,anon,authenticated,service_role;
grant execute on function public.zentra_track_us_workspace_change() to service_role;

-- Fixed service RPC, one MVCC snapshot for the grouped PG heads. No SELECT
-- list/read RPC and no write lock on a financial book during polling.
create function public.zentra_us_workspace_sync_heads(p_organization text,p_actor jsonb,p_supported_schema_version integer,p_supplier boolean,p_bank boolean,p_analysis boolean,p_analysis_configuration_hash text,p_grant jsonb) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
  if not public.zentra_us_supplier_uuid(p_organization) or not public.zentra_us_tax_object(p_actor,array['organizationId','userId','role','managementEntitled','timestamp'])
    or not public.zentra_us_tax_strings(p_actor,array['organizationId','userId','role','timestamp'])
    or p_actor->>'organizationId' is distinct from p_organization or p_actor->'managementEntitled' is distinct from 'true'::jsonb
    or p_actor->>'role' not in('owner','admin','accountant','member','read_only') or not public.zentra_us_supplier_text(p_actor->>'userId',256)
    or not public.zentra_us_purchase_timestamp(p_actor->>'timestamp') then raise exception using errcode='PW005',message='US workspace actor required';end if;
  if p_supported_schema_version is null or p_supported_schema_version not in(1,2,3,4) or p_supplier is null or p_bank is null or p_analysis is null
    or p_analysis_configuration_hash is not null and p_analysis_configuration_hash !~ '^[a-f0-9]{64}$'
    or p_analysis and p_analysis_configuration_hash is null or not p_analysis and p_grant is not null then raise exception using errcode='PW009',message='Invalid compact head selection';end if;
  if p_grant is not null and not public.zentra_us_analysis_grant_valid(p_grant,p_organization,false) then raise exception using errcode='PW009',message='Invalid scoped budget evidence';end if;
  if not exists(select 1 from public.zentra_workspace_country_configs where organization_id=p_organization and country='US' and currency='USD') then raise exception using errcode='PW009',message='Configured US workspace required';end if;
  if exists(select 1 from public.zentra_us_erp_heads where organization_id=p_organization and (header->>'schemaVersion')::integer>p_supported_schema_version) then raise exception using errcode='PW008',message='Captured client capability required';end if;
  with scope as (
    select c.organization_id,c.config,h.revision,h.header,
      h.header->'schemaVersion'='4'::jsonb and h.header->'configuration'=c.config and p_supported_schema_version=4 and p_actor->>'role' in('owner','admin','accountant') as accounting
    from public.zentra_workspace_country_configs c left join public.zentra_us_erp_heads h using(organization_id) where c.organization_id=p_organization and c.country='US' and c.currency='USD'
  ), heads as (
    select s.*,
      (select jsonb_build_array(revision,change_hash) from public.zentra_us_workspace_change_heads where organization_id=s.organization_id and channel='supplierProposals' and scope='global') supplier,
      (select jsonb_build_array(revision,change_hash) from public.zentra_us_workspace_change_heads where organization_id=s.organization_id and channel='bankReconciliations' and scope='global') bank,
      (select jsonb_build_array(revision,change_hash) from public.zentra_us_workspace_change_heads where organization_id=s.organization_id and channel='supplierAnalysis' and scope='settings') settings,
      (select jsonb_build_array(revision,change_hash) from public.zentra_us_workspace_change_heads where organization_id=s.organization_id and channel='supplierAnalysis' and scope=(p_grant->>'environment')||':'||(p_grant->>'periodId')) usage,
      case when p_actor->>'role'='owner' then coalesce((select revision from public.zentra_us_seller_profiles where organization_id=s.organization_id),0) else null end seller,
      case when p_actor->>'role'='owner' then coalesce((select revision from public.zentra_us_tax_profiles where organization_id=s.organization_id),0) else null end tax
    from scope s
  ) select jsonb_build_object('schemaVersion',1,'organizationId',organization_id,'role',p_actor->'role',
    'erp',case when revision is null then null else jsonb_build_object('schemaVersion',header->'schemaVersion','organizationId',organization_id,'revision',revision) end,
    'channels',jsonb_build_object(
      'supplierProposals',case when accounting and p_supplier then encode(sha256(convert_to(jsonb_build_array('supplier-v1',organization_id,config,supplier)::text,'UTF8')),'hex') else null end,
      'bankReconciliations',case when accounting and p_bank then encode(sha256(convert_to(jsonb_build_array('bank-v1',organization_id,config,bank)::text,'UTF8')),'hex') else null end,
      'sellerProfile',case when seller is not null then encode(sha256(convert_to(jsonb_build_array('seller-v1',organization_id,config,seller)::text,'UTF8')),'hex') else null end,
      'taxProfile',case when tax is not null then encode(sha256(convert_to(jsonb_build_array('tax-v1',organization_id,config,tax)::text,'UTF8')),'hex') else null end,
      'team',null,
      'supplierAnalysis',case when accounting and p_supplier and p_analysis then encode(sha256(convert_to(jsonb_build_array('analysis-v1',organization_id,config,settings,usage,p_analysis_configuration_hash,p_grant-'checkedAt')::text,'UTF8')),'hex') else null end
    )) into result from heads;
  return result;
end $$;
revoke all on function public.zentra_us_workspace_sync_heads(text,jsonb,integer,boolean,boolean,boolean,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.zentra_us_workspace_sync_heads(text,jsonb,integer,boolean,boolean,boolean,text,jsonb) to service_role;
commit;
