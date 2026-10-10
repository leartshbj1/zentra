-- Additive commercial register. No change to ERP schemas1..4 or CH books.
-- Fresh Auth/D1 entitlement remains a server admission, never a client JSON grant.
begin;
create table public.zentra_us_sales_order_heads(
 organization_id text primary key references public.zentra_us_erp_heads on delete restrict,
 revision bigint not null check(revision between 0 and 9007199254740989),
 sequence bigint not null check(sequence between 0 and 9007199254740989)
);
create table public.zentra_us_sales_orders(
 organization_id text not null references public.zentra_us_sales_order_heads on delete restrict,
 id uuid not null, sequence bigint not null check(sequence between 1 and 9007199254740989),
 revision bigint not null check(revision between 1 and 3), state text not null check(state in('draft','confirmed','cancelled')),
 estimate_id text not null, head_revision bigint not null check(head_revision between 1 and 9007199254740989),
 payload jsonb not null check(octet_length(payload::text)<=600000),
 primary key(organization_id,id),unique(organization_id,sequence),
 check(coalesce(payload->>'organizationId'=organization_id and payload->>'id'=id::text and payload->>'sequence'=sequence::text and payload->>'revision'=revision::text and payload->>'state'=state and payload->'sourceEstimate'->>'id'=estimate_id,false))
);
create unique index zentra_us_sales_order_active_estimate on public.zentra_us_sales_orders(organization_id,estimate_id) where state<>'cancelled';
create table public.zentra_us_sales_order_receipts(
 organization_id text not null references public.zentra_us_sales_order_heads on delete restrict,
 idempotency_key text not null, head_revision bigint not null,
 actor jsonb not null, request jsonb not null, receipt jsonb not null,
 primary key(organization_id,idempotency_key),unique(organization_id,head_revision)
);
create table public.zentra_us_sales_order_audit(
 organization_id text not null, head_revision bigint not null, order_id uuid not null,
 previous_payload jsonb, payload jsonb not null,
 primary key(organization_id,head_revision),
 foreign key(organization_id,head_revision) references public.zentra_us_sales_order_receipts(organization_id,head_revision) on delete restrict
);
alter table public.zentra_us_sales_orders add constraint zentra_us_sales_order_audit_fk foreign key(organization_id,head_revision) references public.zentra_us_sales_order_audit(organization_id,head_revision) deferrable initially deferred;
alter table public.zentra_us_sales_order_heads enable row level security;
alter table public.zentra_us_sales_orders enable row level security;
alter table public.zentra_us_sales_order_receipts enable row level security;
alter table public.zentra_us_sales_order_audit enable row level security;
revoke all on public.zentra_us_sales_order_heads,public.zentra_us_sales_orders,public.zentra_us_sales_order_receipts,public.zentra_us_sales_order_audit from public,anon,authenticated,service_role;
grant select,insert,update on public.zentra_us_sales_order_heads,public.zentra_us_sales_orders to service_role;
grant select,insert on public.zentra_us_sales_order_receipts,public.zentra_us_sales_order_audit to service_role;
create policy zentra_us_sales_order_head_service on public.zentra_us_sales_order_heads to service_role using(true) with check(true);
create policy zentra_us_sales_order_service on public.zentra_us_sales_orders to service_role using(true) with check(true);
create policy zentra_us_sales_order_receipt_service on public.zentra_us_sales_order_receipts to service_role using(true) with check(true);
create policy zentra_us_sales_order_audit_service on public.zentra_us_sales_order_audit to service_role using(true) with check(true);

create function public.zentra_us_sales_order_admit(org text,actor jsonb,cap integer,writing boolean default false) returns void
language plpgsql stable security invoker set search_path='' as $$
begin
 if not public.zentra_us_tax_object(actor,array['organizationId','userId','role','managementEntitled','timestamp']) or not public.zentra_us_tax_strings(actor,array['organizationId','userId','role','timestamp'])
  or actor->>'organizationId' is distinct from org or not public.zentra_us_tax_text_valid(actor->>'userId',256,false) or actor->'managementEntitled' is distinct from 'true'::jsonb or not public.zentra_us_tax_instant(actor->>'timestamp') or actor->>'role' not in('owner','admin','accountant','member','read_only')
  or writing and actor->>'role'='read_only' then raise exception using errcode='PO006',message='Commercial workspace permission required';end if;
 if cap is distinct from 4 or not exists(select 1 from public.zentra_workspace_country_configs c join public.zentra_us_erp_heads h using(organization_id)
   where c.organization_id=org and c.country='US' and c.currency='USD' and h.header->'schemaVersion'='4'::jsonb and h.header->'configuration'=c.config) then
  raise exception using errcode='PO005',message='Current US schema4 configuration required';end if;
end $$;
create function public.zentra_us_sales_order_request_valid(r jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare c jsonb:=r->'command';a text:=c->>'type';
begin
 if not public.zentra_us_tax_object(r,array['schemaVersion','idempotencyKey','orderId','expectedErpRevision','expectedHeadRevision','expectedOrderRevision','command'])
  or r->'schemaVersion' is distinct from '1'::jsonb or not public.zentra_us_tax_strings(r,array['idempotencyKey','orderId'])
  or r->>'idempotencyKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$' or r->>'orderId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  or not public.zentra_us_tax_revision(r->'expectedErpRevision') or not public.zentra_us_tax_revision(r->'expectedHeadRevision',0)
  or (r->>'expectedErpRevision')::numeric>=9007199254740990 or (r->>'expectedHeadRevision')::numeric>=9007199254740990 then return false;end if;
 if a='create_from_estimate' then return coalesce(public.zentra_us_tax_object(c,array['type','estimateId','expectedEstimateRevision','orderDate','customerReference'])
  and public.zentra_us_tax_strings(c,array['type','estimateId','orderDate']) and public.zentra_us_tax_text_valid(c->>'estimateId',160,true)
  and public.zentra_us_tax_revision(c->'expectedEstimateRevision') and public.zentra_us_purchase_date(c->>'orderDate')
  and r->'expectedOrderRevision'='null'::jsonb and (c->'customerReference'='null'::jsonb or jsonb_typeof(c->'customerReference')='string' and public.zentra_us_tax_text_valid(c->>'customerReference',500,true)),false);
 elsif a='confirm' then return coalesce(public.zentra_us_tax_object(c,array['type','reference']) and public.zentra_us_tax_strings(c,array['type','reference']) and public.zentra_us_tax_text_valid(c->>'reference',500,true) and public.zentra_us_tax_revision(r->'expectedOrderRevision'),false);
 elsif a='cancel' then return coalesce(public.zentra_us_tax_object(c,array['type','reason']) and public.zentra_us_tax_strings(c,array['type','reason']) and public.zentra_us_tax_text_valid(c->>'reason',500,true) and public.zentra_us_tax_revision(r->'expectedOrderRevision'),false);end if;
 return false;
exception when others then return false;end $$;

create function public.zentra_prepare_us_sales_order(org text,actor jsonb,r jsonb,previous jsonb,seq bigint) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare c jsonb:=r->'command';action text:=c->>'type';estimate jsonb;configuration jsonb;seller jsonb;result jsonb;prior_time timestamptz;
begin
 if not coalesce(public.zentra_us_sales_order_request_valid(r),false) then raise exception using errcode='PO004',message='Exact commercial command required';end if;
 if action='create_from_estimate' then
  if previous is not null then raise exception using errcode='PO009',message='Order identity already exists';end if;
  select payload into estimate from public.zentra_us_erp_records where organization_id=org and kind='estimate' and id=c->>'estimateId';
  if estimate is null or estimate->>'status'<>'accepted' or estimate->'revision' is distinct from c->'expectedEstimateRevision'
   or octet_length(public.zentra_us_erp_v4_canonical(estimate))>524288 then raise exception using errcode='PO007',message='Current accepted estimate required';end if;
  if exists(select 1 from public.zentra_us_erp_records where organization_id=org and kind='invoice' and payload->>'sourceEstimateId'=estimate->>'id') then raise exception using errcode='PO012',message='Estimate already invoiced';end if;
  if exists(select 1 from public.zentra_us_sales_orders where organization_id=org and estimate_id=estimate->>'id' and state<>'cancelled') then raise exception using errcode='PO009',message='Active order already references estimate';end if;
  select config-'ein' into configuration from public.zentra_workspace_country_configs where organization_id=org;
  select profile||jsonb_build_object('organizationId',org) into seller from public.zentra_us_seller_profiles where organization_id=org;
  if seller is null then raise exception using errcode='PO013',message='Public seller identity required';end if;
  result:=jsonb_build_object('schemaVersion',1,'organizationId',org,'id',r->>'orderId','sequence',seq,'number','SO-'||lpad(seq::text,greatest(6,length(seq::text)),'0'),'revision',1,'state','draft',
   'sourceErpRevision',r->'expectedErpRevision','sourceEstimate',estimate,'companyConfiguration',configuration,'sellerSnapshot',seller,
   'orderDate',c->>'orderDate','customerReference',c->'customerReference','createdBy',actor->>'userId','createdAt',actor->>'timestamp','confirmation',null,'cancellation',null);
 else
  if previous is null then raise exception using errcode='PO010',message='Order not found';end if;
  if previous->'revision' is distinct from r->'expectedOrderRevision' then raise exception using errcode='PO001',message='Order revision changed';end if;
  prior_time:=coalesce(previous->'confirmation'->>'confirmedAt',previous->>'createdAt')::timestamptz;
  if (actor->>'timestamp')::timestamptz<prior_time then raise exception using errcode='PO004',message='Audit time cannot run backwards';end if;
  if exists(select 1 from public.zentra_us_erp_records where organization_id=org and kind='invoice' and payload->>'sourceEstimateId'=previous->'sourceEstimate'->>'id') then raise exception using errcode='PO012',message='Issued invoice prevents order transition';end if;
  if action='confirm' then
   if previous->>'state'<>'draft' then raise exception using errcode='PO011',message='Only draft orders can be internally confirmed';end if;
   result:=previous||jsonb_build_object('revision',(previous->>'revision')::bigint+1,'state','confirmed','confirmation',jsonb_build_object('reference',c->>'reference','confirmedBy',actor->>'userId','confirmedAt',actor->>'timestamp'));
  elsif action='cancel' then
   if previous->>'state' not in('draft','confirmed') then raise exception using errcode='PO011',message='Order is already cancelled';end if;
   result:=previous||jsonb_build_object('revision',(previous->>'revision')::bigint+1,'state','cancelled','cancellation',jsonb_build_object('reason',c->>'reason','cancelledBy',actor->>'userId','cancelledAt',actor->>'timestamp'));
  end if;
 end if;
 return result;
end $$;

create function public.zentra_guard_us_sales_order_history() returns trigger
language plpgsql security invoker set search_path='' as $$
declare r public.zentra_us_sales_order_receipts%rowtype;head public.zentra_us_sales_order_heads%rowtype;prior jsonb;expected jsonb;seq bigint;erp bigint;
begin
 if tg_op<>'INSERT' then raise exception using errcode='PO014',message='Commercial audit and receipts are append-only';end if;
 if tg_table_name='zentra_us_sales_order_receipts' then
  perform 1 from public.zentra_workspaces where organization_id=new.organization_id for update;
  perform 1 from public.zentra_workspace_country_configs where organization_id=new.organization_id for update;
  perform public.zentra_us_sales_order_admit(new.organization_id,new.actor,4,true);
  if not coalesce(public.zentra_us_sales_order_request_valid(new.request),false) or not public.zentra_us_tax_object(new.receipt,array['schemaVersion','organizationId','idempotencyKey','commandHash','actorId','orderId','action','revision','headRevision','erpRevision','sequence']) then raise exception using errcode='PO004',message='Exact receipt required';end if;
  select revision into erp from public.zentra_us_erp_heads where organization_id=new.organization_id for update;
  select * into head from public.zentra_us_sales_order_heads where organization_id=new.organization_id for update;
  if erp<>(new.request->>'expectedErpRevision')::bigint then raise exception using errcode='PO003',message='ERP revision changed';end if;
  if head.revision<>(new.request->>'expectedHeadRevision')::bigint or new.head_revision<>head.revision+1 then raise exception using errcode='PO001',message='Order head revision changed';end if;
  select payload into prior from public.zentra_us_sales_orders where organization_id=new.organization_id and id=(new.request->>'orderId')::uuid;
  seq:=case when new.request->'command'->>'type'='create_from_estimate' then head.sequence+1 else (prior->>'sequence')::bigint end;
  expected:=jsonb_build_object('schemaVersion',1,'organizationId',new.organization_id,'idempotencyKey',new.request->>'idempotencyKey',
   'commandHash',encode(sha256(convert_to(public.zentra_us_erp_v4_canonical(jsonb_build_array(new.organization_id,new.actor->>'userId',new.request)),'UTF8')),'hex'),
   'actorId',new.actor->>'userId','orderId',new.request->>'orderId','action',new.request->'command'->>'type','revision',coalesce((prior->>'revision')::bigint,0)+1,'headRevision',head.revision+1,'erpRevision',erp,'sequence',seq);
  if new.idempotency_key is distinct from new.request->>'idempotencyKey' or new.receipt is distinct from expected then raise exception using errcode='PO004',message='Receipt identity mismatch';end if;
  perform public.zentra_prepare_us_sales_order(new.organization_id,new.actor,new.request,prior,seq);
 else
  select * into r from public.zentra_us_sales_order_receipts where organization_id=new.organization_id and head_revision=new.head_revision;
  select payload into prior from public.zentra_us_sales_orders where organization_id=new.organization_id and id=new.order_id;
  if r.organization_id is null or r.request->>'orderId' is distinct from new.order_id::text or new.previous_payload is distinct from prior
   or new.payload is distinct from public.zentra_prepare_us_sales_order(new.organization_id,r.actor,r.request,prior,(r.receipt->>'sequence')::bigint) then raise exception using errcode='PO014',message='Exact source-backed audited transition required';end if;
 end if;
 return new;
end $$;
create trigger zentra_us_sales_order_receipt_guard before insert or update or delete on public.zentra_us_sales_order_receipts for each row execute function public.zentra_guard_us_sales_order_history();
create trigger zentra_us_sales_order_audit_guard before insert or update or delete on public.zentra_us_sales_order_audit for each row execute function public.zentra_guard_us_sales_order_history();

create function public.zentra_guard_us_sales_order_current() returns trigger
language plpgsql security invoker set search_path='' as $$
declare audit public.zentra_us_sales_order_audit%rowtype;receipt jsonb;seq bigint;
begin
 if tg_op='DELETE' then raise exception using errcode='PO014',message='Orders cannot be silently removed';end if;
 if tg_table_name='zentra_us_sales_order_heads' then
  if tg_op='INSERT' then
   if new.revision<>0 or new.sequence<>0 then raise exception using errcode='PO014',message='Empty register must start at zero';end if;
  else
   select r.receipt into receipt from public.zentra_us_sales_order_receipts r where r.organization_id=new.organization_id and r.head_revision=new.revision;
   if new.organization_id is distinct from old.organization_id or new.revision<>old.revision+1 or receipt is null or new.sequence<>old.sequence+(case when receipt->>'action'='create_from_estimate' then 1 else 0 end) then raise exception using errcode='PO014',message='Register head requires exact receipt';end if;
  end if;
 else
  select * into audit from public.zentra_us_sales_order_audit a where a.organization_id=new.organization_id and a.head_revision=new.head_revision;
  if audit.organization_id is null or audit.order_id<>new.id or audit.payload is distinct from new.payload
   or (tg_op='INSERT' and (audit.previous_payload is not null or new.revision<>1))
   or (tg_op='UPDATE' and (audit.previous_payload is distinct from old.payload or new.organization_id is distinct from old.organization_id or new.id<>old.id or new.sequence<>old.sequence or new.revision<>old.revision+1)) then raise exception using errcode='PO014',message='Order requires its exact audited transition';end if;
 end if;
 return new;
end $$;
create trigger zentra_us_sales_order_head_guard before insert or update or delete on public.zentra_us_sales_order_heads for each row execute function public.zentra_guard_us_sales_order_current();
create trigger zentra_us_sales_order_current_guard before insert or update or delete on public.zentra_us_sales_orders for each row execute function public.zentra_guard_us_sales_order_current();
create function public.zentra_guard_us_sales_order_complete() returns trigger
language plpgsql security invoker set search_path='' as $$
declare audit public.zentra_us_sales_order_audit%rowtype;receipt jsonb;current_order public.zentra_us_sales_orders%rowtype;head public.zentra_us_sales_order_heads%rowtype;
begin
 select * into audit from public.zentra_us_sales_order_audit where organization_id=new.organization_id and head_revision=new.head_revision;
 select r.receipt into receipt from public.zentra_us_sales_order_receipts r where r.organization_id=new.organization_id and r.head_revision=new.head_revision;
 select * into current_order from public.zentra_us_sales_orders where organization_id=new.organization_id and id=audit.order_id;
 select * into head from public.zentra_us_sales_order_heads where organization_id=new.organization_id;
 if audit.organization_id is null or receipt is null or current_order.organization_id is null or current_order.revision<(receipt->>'revision')::bigint or head.revision<new.head_revision
  or (current_order.head_revision=new.head_revision and current_order.payload is distinct from audit.payload) then raise exception using errcode='PO014',message='Incomplete order transaction';end if;
 return new;
end $$;
create constraint trigger zentra_us_sales_order_receipt_complete after insert on public.zentra_us_sales_order_receipts deferrable initially deferred for each row execute function public.zentra_guard_us_sales_order_complete();
create constraint trigger zentra_us_sales_order_audit_complete after insert on public.zentra_us_sales_order_audit deferrable initially deferred for each row execute function public.zentra_guard_us_sales_order_complete();
create function public.zentra_guard_us_sales_order_truncate() returns trigger language plpgsql security invoker set search_path='' as $$begin raise exception using errcode='PO014',message='Commercial history cannot be truncated';end $$;
create trigger zentra_us_sales_order_head_truncate before truncate on public.zentra_us_sales_order_heads for each statement execute function public.zentra_guard_us_sales_order_truncate();
create trigger zentra_us_sales_order_truncate before truncate on public.zentra_us_sales_orders for each statement execute function public.zentra_guard_us_sales_order_truncate();
create trigger zentra_us_sales_order_receipt_truncate before truncate on public.zentra_us_sales_order_receipts for each statement execute function public.zentra_guard_us_sales_order_truncate();
create trigger zentra_us_sales_order_audit_truncate before truncate on public.zentra_us_sales_order_audit for each statement execute function public.zentra_guard_us_sales_order_truncate();

create function public.zentra_guard_us_sales_order_source() returns trigger
language plpgsql security invoker set search_path='' as $$
declare order_row public.zentra_us_sales_orders%rowtype;
begin
 if new.kind='estimate' then
  if tg_op='UPDATE' and new.payload is distinct from old.payload and exists(select 1 from public.zentra_us_sales_orders where organization_id=new.organization_id and estimate_id=new.id and state<>'cancelled') then
   raise exception using errcode='PO008',message='Cancel the active order before changing its accepted source';end if;
 elsif new.kind='invoice' and tg_op='INSERT' then
  select * into order_row from public.zentra_us_sales_orders where organization_id=new.organization_id and estimate_id=new.payload->>'sourceEstimateId' and state<>'cancelled';
  if found and (order_row.state<>'confirmed' or order_row.payload->'sourceEstimate'->'revision' is distinct from new.payload->'sourceEstimateRevision'
   or order_row.payload->'sourceEstimate'->'lines' is distinct from new.payload->'lines' or order_row.payload->'sourceEstimate'->'customer' is distinct from new.payload->'customer'
   or order_row.payload->'sourceEstimate'->'projectId' is distinct from new.payload->'projectId' or order_row.payload->'sourceEstimate'->'notes' is distinct from new.payload->'notes'
   or (new.payload->>'issuedAt')::timestamptz<(order_row.payload->'confirmation'->>'confirmedAt')::timestamptz) then
   raise exception using errcode='PO011',message='Internally confirmed exact order source required before invoicing';end if;
 end if;
 return new;
end $$;
create trigger zentra_us_sales_order_source_guard before insert or update on public.zentra_us_erp_records for each row execute function public.zentra_guard_us_sales_order_source();

create function public.zentra_execute_us_sales_order(p_organization text,p_actor jsonb,p_supported_schema_version integer,p_request jsonb,p_command_hash text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare erp bigint;head public.zentra_us_sales_order_heads%rowtype;saved public.zentra_us_sales_order_receipts%rowtype;prior jsonb;next_order jsonb;receipt jsonb;seq bigint;
begin
 perform public.zentra_us_sales_order_admit(p_organization,p_actor,p_supported_schema_version,true);
 if not coalesce(public.zentra_us_sales_order_request_valid(p_request),false) or p_command_hash is null or p_command_hash !~ '^[a-f0-9]{64}$' or p_command_hash is distinct from encode(sha256(convert_to(public.zentra_us_erp_v4_canonical(jsonb_build_array(p_organization,p_actor->>'userId',p_request)),'UTF8')),'hex') then raise exception using errcode='PO004',message='Exact canonical request identity required';end if;
 perform 1 from public.zentra_workspaces where organization_id=p_organization for update;
 perform 1 from public.zentra_workspace_country_configs where organization_id=p_organization for update;
 select revision into erp from public.zentra_us_erp_heads where organization_id=p_organization for update;
 perform public.zentra_us_sales_order_admit(p_organization,p_actor,p_supported_schema_version,true);
 select * into saved from public.zentra_us_sales_order_receipts where organization_id=p_organization and idempotency_key=p_request->>'idempotencyKey';
 if found then
  if saved.request is distinct from p_request or saved.actor->>'userId' is distinct from p_actor->>'userId' or saved.receipt->>'commandHash' is distinct from p_command_hash then raise exception using errcode='PO002',message='Idempotency identity changed';end if;
  return jsonb_build_object('receipt',saved.receipt,'replayed',true);
 end if;
 if erp<>(p_request->>'expectedErpRevision')::bigint then raise exception using errcode='PO003',message='ERP revision changed';end if;
 insert into public.zentra_us_sales_order_heads values(p_organization,0,0) on conflict do nothing;
 select * into head from public.zentra_us_sales_order_heads where organization_id=p_organization for update;
 if head.revision<>(p_request->>'expectedHeadRevision')::bigint then raise exception using errcode='PO001',message='Commercial register revision changed';end if;
 if head.revision>=9007199254740988 or head.sequence>=9007199254740988 then raise exception using errcode='PO015',message='Sequence exhausted';end if;
 select payload into prior from public.zentra_us_sales_orders where organization_id=p_organization and id=(p_request->>'orderId')::uuid;
 seq:=case when p_request->'command'->>'type'='create_from_estimate' then head.sequence+1 else (prior->>'sequence')::bigint end;
 next_order:=public.zentra_prepare_us_sales_order(p_organization,p_actor,p_request,prior,seq);
 receipt:=jsonb_build_object('schemaVersion',1,'organizationId',p_organization,'idempotencyKey',p_request->>'idempotencyKey','commandHash',p_command_hash,'actorId',p_actor->>'userId',
  'orderId',p_request->>'orderId','action',p_request->'command'->>'type','revision',next_order->'revision','headRevision',head.revision+1,'erpRevision',erp,'sequence',seq);
 insert into public.zentra_us_sales_order_receipts values(p_organization,p_request->>'idempotencyKey',head.revision+1,p_actor,p_request,receipt);
 insert into public.zentra_us_sales_order_audit values(p_organization,head.revision+1,(p_request->>'orderId')::uuid,prior,next_order);
 update public.zentra_us_sales_order_heads set revision=head.revision+1,sequence=case when p_request->'command'->>'type'='create_from_estimate' then seq else head.sequence end where organization_id=p_organization;
 if prior is null then
  insert into public.zentra_us_sales_orders values(p_organization,(p_request->>'orderId')::uuid,seq,(next_order->>'revision')::bigint,next_order->>'state',next_order->'sourceEstimate'->>'id',head.revision+1,next_order);
 else
  update public.zentra_us_sales_orders set revision=(next_order->>'revision')::bigint,state=next_order->>'state',head_revision=head.revision+1,payload=next_order where organization_id=p_organization and id=(p_request->>'orderId')::uuid;
 end if;
 return jsonb_build_object('receipt',receipt,'replayed',false);
end $$;
create function public.zentra_us_sales_order_invoice(org text,order_payload jsonb) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('id',id,'number',payload->>'number','sourceEstimateRevision',payload->'sourceEstimateRevision','issuedAt',payload->>'issuedAt') from public.zentra_us_erp_records
 where organization_id=org and kind='invoice' and payload->>'sourceEstimateId'=order_payload->'sourceEstimate'->>'id'
 and payload->'sourceEstimateRevision'=order_payload->'sourceEstimate'->'revision'
 and payload->'lines'=order_payload->'sourceEstimate'->'lines' and payload->'customer'=order_payload->'sourceEstimate'->'customer'
 and payload->'notes'=order_payload->'sourceEstimate'->'notes' and payload->'projectId' is not distinct from order_payload->'sourceEstimate'->'projectId'
 and order_payload->>'state'='confirmed';
$$;
create function public.zentra_read_us_sales_order(p_organization text,p_actor jsonb,p_supported_schema_version integer,p_order_id uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$declare result jsonb;begin
 perform public.zentra_us_sales_order_admit(p_organization,p_actor,p_supported_schema_version);
 select jsonb_build_object('order',payload,'invoice',public.zentra_us_sales_order_invoice(p_organization,payload)) into result from public.zentra_us_sales_orders where organization_id=p_organization and id=p_order_id;
 return result;end $$;
create function public.zentra_us_sales_order_head(p_organization text,p_actor jsonb,p_supported_schema_version integer) returns jsonb
language plpgsql stable security invoker set search_path='' as $$declare result jsonb;begin
 perform public.zentra_us_sales_order_admit(p_organization,p_actor,p_supported_schema_version);
 select jsonb_build_object('schemaVersion',1,'organizationId',p_organization,'headRevision',coalesce((select revision from public.zentra_us_sales_order_heads where organization_id=p_organization),0),'erpRevision',revision) into result from public.zentra_us_erp_heads where organization_id=p_organization;
 return result;end $$;
create function public.zentra_us_sales_order_receipt(p_organization text,p_actor jsonb,p_supported_schema_version integer,p_idempotency_key text) returns jsonb
language plpgsql stable security invoker set search_path='' as $$declare result jsonb;begin
 perform public.zentra_us_sales_order_admit(p_organization,p_actor,p_supported_schema_version,true);
 select receipt into result from public.zentra_us_sales_order_receipts where organization_id=p_organization and idempotency_key=p_idempotency_key;
 if result is not null and result->>'actorId' is distinct from p_actor->>'userId' then raise exception using errcode='PO002',message='Actor identity changed';end if;
 return result;end $$;
-- One accepted source lookup, independent of the visible 25-row register page.
create function public.zentra_us_sales_order_source(p_organization text,p_actor jsonb,p_supported_schema_version integer,p_estimate_id text) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare estimate jsonb;erp bigint;active uuid;invoice text;
begin
 perform public.zentra_us_sales_order_admit(p_organization,p_actor,p_supported_schema_version);
 if not public.zentra_us_tax_text_valid(p_estimate_id,160,true) then raise exception using errcode='PO004',message='Exact source identity required';end if;
 select revision into erp from public.zentra_us_erp_heads where organization_id=p_organization;
 select payload into estimate from public.zentra_us_erp_records where organization_id=p_organization and kind='estimate' and id=p_estimate_id;
 if estimate is not null then
  select id into active from public.zentra_us_sales_orders where organization_id=p_organization and estimate_id=p_estimate_id and state<>'cancelled';
  select id into invoice from public.zentra_us_erp_records where organization_id=p_organization and kind='invoice' and payload->>'sourceEstimateId'=p_estimate_id;
 end if;
 return jsonb_build_object('schemaVersion',1,'organizationId',p_organization,'erpRevision',erp,'estimateId',p_estimate_id,'estimateRevision',estimate->'revision','activeOrderId',active,'invoiceId',invoice,'status',coalesce(estimate->>'status','missing'));
end $$;
create function public.zentra_list_us_sales_orders(p_organization text,p_actor jsonb,p_supported_schema_version integer,p_before_sequence bigint default null) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;orders jsonb;last_sequence bigint;more boolean;erp bigint;head bigint;total bigint;
begin
 perform public.zentra_us_sales_order_admit(p_organization,p_actor,p_supported_schema_version);
 if p_before_sequence is not null and p_before_sequence not between 1 and 9007199254740989 then raise exception using errcode='PO004',message='Invalid pagination cursor';end if;
 select revision into erp from public.zentra_us_erp_heads where organization_id=p_organization;
 select coalesce(max(revision),0),coalesce(max(sequence),0) into head,total from public.zentra_us_sales_order_heads where organization_id=p_organization;
 with page as(select * from public.zentra_us_sales_orders where organization_id=p_organization and (p_before_sequence is null or sequence<p_before_sequence) order by sequence desc limit 25), amount as(
  select p.*, (select coalesce(sum((public.zentra_us_erp_line_totals(l)->>'netMinor')::numeric),0)::text from jsonb_array_elements(p.payload->'sourceEstimate'->'lines')l) net from page p
 ) select coalesce(jsonb_agg(jsonb_build_object('id',id,'sequence',sequence,'number',payload->>'number','revision',revision,'state',state,
  'sourceEstimateId',estimate_id,'sourceEstimateRevision',payload->'sourceEstimate'->'revision','sourceEstimateNumber',payload->'sourceEstimate'->>'number','orderDate',payload->>'orderDate',
  'customerName',payload->'sourceEstimate'->'customer'->>'name','customerReference',payload->'customerReference','net',jsonb_build_object('currency','USD','minorUnits',net),
  'confirmationReference',payload->'confirmation'->>'reference','invoice',public.zentra_us_sales_order_invoice(p_organization,payload)) order by sequence desc),'[]'::jsonb),min(sequence) into orders,last_sequence from amount;
 select exists(select 1 from public.zentra_us_sales_orders where organization_id=p_organization and sequence<last_sequence) into more;
 return jsonb_build_object('schemaVersion',1,'organizationId',p_organization,'headRevision',head,'erpRevision',erp,'total',total,'orders',orders,'nextBeforeSequence',case when more then last_sequence else null end);
end $$;

-- No implicit PUBLIC execute grant on any new private helper or API.
do $$declare f record;begin
 for f in select oid::regprocedure signature from pg_catalog.pg_proc where pronamespace='public'::regnamespace and proname in(
  'zentra_us_sales_order_admit','zentra_us_sales_order_request_valid','zentra_prepare_us_sales_order','zentra_guard_us_sales_order_history','zentra_guard_us_sales_order_current','zentra_guard_us_sales_order_complete','zentra_guard_us_sales_order_truncate','zentra_guard_us_sales_order_source','zentra_execute_us_sales_order','zentra_us_sales_order_invoice','zentra_read_us_sales_order','zentra_us_sales_order_receipt','zentra_list_us_sales_orders','zentra_us_sales_order_head','zentra_us_sales_order_source') loop
  execute 'revoke all on function '||f.signature||' from public,anon,authenticated,service_role';
  execute 'grant execute on function '||f.signature||' to service_role';
 end loop;
end $$;
commit;
