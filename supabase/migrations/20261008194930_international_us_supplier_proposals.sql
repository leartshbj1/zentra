-- Additive US invoice proposals. Literal extraction never grants financial
-- permission or computes a tax rate. Only an explicit human review reaches the
-- existing guarded manual vendor-bill command, in the same PostgreSQL transaction.
begin;

create function public.zentra_us_supplier_uuid(v text) returns boolean
language sql immutable security invoker set search_path='' as $$
  select coalesce(v ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',false);
$$;
create function public.zentra_us_supplier_utf16(v text) returns integer
language sql immutable security invoker set search_path='' as $$
  select length(v)+length(regexp_replace(v COLLATE pg_catalog."C",'[^'||chr(65536)||'-'||chr(1114111)||']','','g'));
$$;
create function public.zentra_us_supplier_trim(v text) returns text
language sql immutable security invoker set search_path='' as $$
  select btrim(v,E' \t\n\r\f'||chr(11)||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279));
$$;
create function public.zentra_us_supplier_text(v text,n integer,multiline boolean default false) returns boolean
language sql immutable security invoker set search_path='' as $$
  select coalesce(length(public.zentra_us_supplier_trim(v))>0 and public.zentra_us_supplier_utf16(v)<=n
    and not(v COLLATE pg_catalog."C" ~ case when multiline then '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' else '[\x01-\x1f\x7f]' end),false);
$$;
create function public.zentra_us_supplier_review_valid(v jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
begin
  return coalesce(public.zentra_us_tax_object(v,array['vendorId','reference','date','accountingDate','dueDate','periodId','netMinor','printedTaxMinor'])
    and public.zentra_us_tax_strings(v,array['vendorId','reference','date','accountingDate','dueDate','periodId','netMinor','printedTaxMinor'])
    and public.zentra_us_supplier_text(v->>'vendorId',160) and public.zentra_us_supplier_text(v->>'reference',500) and public.zentra_us_supplier_text(v->>'periodId',160)
    and public.zentra_us_purchase_date(v->>'date') and public.zentra_us_purchase_date(v->>'accountingDate') and public.zentra_us_purchase_date(v->>'dueDate')
    and v->>'dueDate'>=v->>'date' and public.zentra_us_erp_v4_amount(v->'netMinor') and public.zentra_us_erp_v4_amount(v->'printedTaxMinor')
    and (v->>'netMinor')::numeric+(v->>'printedTaxMinor')::numeric between 1 and 999999999999999999999999999999999999::numeric,false);
exception when others then return false;end $$;
create function public.zentra_us_supplier_request_valid(v jsonb) returns boolean
language sql immutable security invoker set search_path='' as $$
  select coalesce(public.zentra_us_tax_object(v,array['schemaVersion','idempotencyKey','proposalId','expectedProposalRevision','expectedErpRevision','confirmed','taxReviewed','review'])
    and v->'schemaVersion'='1'::jsonb and public.zentra_us_tax_strings(v,array['idempotencyKey','proposalId'])
    and public.zentra_us_supplier_uuid(v->>'idempotencyKey') and public.zentra_us_supplier_uuid(v->>'proposalId')
    and v->'expectedProposalRevision'='0'::jsonb and public.zentra_us_tax_revision(v->'expectedErpRevision',1)
    and v->'confirmed'='true'::jsonb and v->'taxReviewed'='true'::jsonb and public.zentra_us_supplier_review_valid(v->'review'),false);
$$;
create function public.zentra_us_supplier_extraction_valid(v jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare fields text[]:=array['supplierName','reference','invoiceDate','dueDate','currency','netMinor','printedTaxMinor','totalMinor'];
  missing text[]:=array['missing_supplier_name','missing_reference','missing_invoice_date','missing_due_date','missing_currency','missing_net_amount','missing_printed_tax','missing_total_amount'];
  allowed text[]:=array['human_approval_required','document_kind_unconfirmed','document_not_vendor_invoice','unreadable_source','unsupported_currency','due_date_before_invoice','amounts_inconsistent','non_positive_amount','low_confidence','missing_evidence']||missing;
  issues text[];derived text[]:=array['human_approval_required'];k text;i integer;f jsonb;e jsonb;c jsonb;conf numeric;budget integer:=0;sorted jsonb;
begin
  if not public.zentra_us_tax_object(v,array['schemaVersion','kind','confidence','fields','evidence','fieldConfidence','issues']) or v->'schemaVersion'<>'1'::jsonb
    or jsonb_typeof(v->'kind')<>'string' or v->>'kind' not in ('vendor_invoice','other','unknown')
    or jsonb_typeof(v->'confidence')<>'number' or (v->>'confidence')::numeric not between 0 and 1
    or not public.zentra_us_tax_object(v->'fields',fields) or not public.zentra_us_tax_object(v->'evidence',array[]::text[],fields)
    or not public.zentra_us_tax_object(v->'fieldConfidence',array[]::text[],fields) or jsonb_typeof(v->'issues')<>'array' then return false;end if;
  f:=v->'fields';e:=v->'evidence';c:=v->'fieldConfidence';conf:=(v->>'confidence')::numeric;
  for i in 1..cardinality(fields) loop
    k:=fields[i];
    if f->k='null'::jsonb then
      derived:=array_append(derived,missing[i]);conf:=0;
    elsif jsonb_typeof(f->k)<>'string' or not public.zentra_us_supplier_text(f->>k,500) or f->>k<>public.zentra_us_supplier_trim(f->>k) then return false;
    else
      if k in ('netMinor','printedTaxMinor','totalMinor') and not public.zentra_us_erp_v4_amount(f->k) then return false;end if;
      if k in ('invoiceDate','dueDate') and not public.zentra_us_purchase_date(f->>k) then return false;end if;
      if k='currency' and f->>k !~ '^[A-Z]{3}$' then return false;end if;
      if not(e?k) then derived:=array_append(derived,'missing_evidence');end if;
      conf:=least(conf,coalesce((c->>k)::numeric,0));
    end if;
    if e?k then
      if f->k='null'::jsonb or jsonb_typeof(e->k)<>'string' or not public.zentra_us_supplier_text(e->>k,3000,true) then return false;end if;
      budget:=budget+public.zentra_us_supplier_utf16(e->>k);if budget>16000 then return false;end if;
    end if;
    if c?k and (jsonb_typeof(c->k)<>'number' or (c->>k)::numeric not between 0 and 1 or (f->k='null'::jsonb and c->k<>'0'::jsonb)) then return false;end if;
  end loop;
  if (v->>'confidence')::numeric<>conf then return false;end if;
  if v->>'kind'='unknown' then derived:=array_append(derived,'document_kind_unconfirmed');end if;
  if v->>'kind'='other' then derived:=array_append(derived,'document_not_vendor_invoice');end if;
  if f->'currency'<>'null'::jsonb and f->>'currency'<>'USD' then derived:=array_append(derived,'unsupported_currency');end if;
  if f->'invoiceDate'<>'null'::jsonb and f->'dueDate'<>'null'::jsonb and f->>'dueDate'<f->>'invoiceDate' then derived:=array_append(derived,'due_date_before_invoice');end if;
  if f->'netMinor'<>'null'::jsonb and f->'printedTaxMinor'<>'null'::jsonb and f->'totalMinor'<>'null'::jsonb then
    if (f->>'netMinor')::numeric+(f->>'printedTaxMinor')::numeric<>(f->>'totalMinor')::numeric then derived:=array_append(derived,'amounts_inconsistent');end if;
    if (f->>'netMinor')::numeric<=0 or (f->>'totalMinor')::numeric<=0 then derived:=array_append(derived,'non_positive_amount');end if;
  end if;
  if conf<0.95 then derived:=array_append(derived,'low_confidence');end if;
  if jsonb_array_length(v->'issues')>cardinality(allowed) or exists(select 1 from jsonb_array_elements(v->'issues')x where jsonb_typeof(x)<>'string') then return false;end if;
  select array_agg(x) into issues from jsonb_array_elements_text(v->'issues')x;
  if not coalesce(issues,array[]::text[])<@allowed or not derived<@coalesce(issues,array[]::text[]) then return false;end if;
  select coalesce(jsonb_agg(x order by x COLLATE pg_catalog."C"),'[]'::jsonb) into sorted from(select distinct unnest(issues)x)s;
  return sorted=v->'issues';
exception when others then return false;end $$;
create function public.zentra_us_supplier_proposal_valid(v jsonb,org text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare s jsonb;r jsonb;
begin
  if not public.zentra_us_tax_object(v,array['schemaVersion','organizationId','id','revision','source','extraction','createdBy','createdAt','state'],array['recording'])
    or v->'schemaVersion'<>'1'::jsonb or not public.zentra_us_tax_strings(v,array['organizationId','id','createdBy','createdAt','state'])
    or v->>'organizationId' is distinct from org or not public.zentra_us_supplier_uuid(v->>'id')
    or not public.zentra_us_supplier_text(v->>'createdBy',256) or not public.zentra_us_purchase_timestamp(v->>'createdAt')
    or v->>'state' not in ('review','recorded') or v->'revision' is distinct from to_jsonb(case when v->>'state'='review' then 0 else 1 end)
    or (v?'recording') is distinct from (v->>'state'='recorded') or not public.zentra_us_supplier_extraction_valid(v->'extraction') then return false;end if;
  s:=v->'source';
  if not public.zentra_us_tax_object(s,array['kind','sha256','fileName','mediaType','workspaceId','connectionId','messageId','receivedAt','documentText'])
    or not public.zentra_us_tax_strings(s,array['kind','sha256','fileName','mediaType','receivedAt','documentText'])
    or s->>'kind' not in ('document_import','support_mail') or s->>'sha256' !~ '^[a-f0-9]{64}$'
    or not public.zentra_us_supplier_text(s->>'fileName',160) or s->>'mediaType' not in ('text/plain','application/pdf')
    or not public.zentra_us_purchase_timestamp(s->>'receivedAt') or length(public.zentra_us_supplier_trim(s->>'documentText'))=0 or octet_length(s->>'documentText')>16384 then return false;end if;
  if s->>'mediaType'='text/plain' and s->>'sha256' is distinct from encode(sha256(convert_to(s->>'documentText','UTF8')),'hex') then return false;end if;
  if s->>'kind'='document_import' then
    if s->'workspaceId'<>'null'::jsonb or s->'connectionId'<>'null'::jsonb or s->'messageId'<>'null'::jsonb then return false;end if;
  else
    if not public.zentra_us_tax_strings(s,array['workspaceId','connectionId','messageId']) or not public.zentra_us_supplier_text(s->>'workspaceId',256)
      or not public.zentra_us_supplier_text(s->>'connectionId',256) or not public.zentra_us_supplier_text(s->>'messageId',256) then return false;end if;
  end if;
  if v?'recording' then
    r:=v->'recording';
    if not public.zentra_us_tax_object(r,array['idempotencyKey','requestHash','by','at','review','erpReceipt'])
      or not public.zentra_us_tax_strings(r,array['idempotencyKey','requestHash','by','at']) or not public.zentra_us_supplier_uuid(r->>'idempotencyKey')
      or r->>'requestHash' !~ '^[a-f0-9]{64}$' or not public.zentra_us_supplier_text(r->>'by',256) or not public.zentra_us_purchase_timestamp(r->>'at')
      or (r->>'at')::timestamptz<(v->>'createdAt')::timestamptz or not public.zentra_us_supplier_review_valid(r->'review')
      or not public.zentra_us_tax_object(r->'erpReceipt',array['idempotencyKey','commandHash','revision','entityId','action'])
      or not public.zentra_us_tax_strings(r->'erpReceipt',array['idempotencyKey','commandHash','entityId','action'])
      or r->'erpReceipt'->>'idempotencyKey' is distinct from 'us-mail-approve:'||(r->>'idempotencyKey')
      or r->'erpReceipt'->>'entityId' is distinct from 'us-mail-bill:'||(v->>'id') or r->'erpReceipt'->>'action'<>'record_vendor_bill'
      or r->'erpReceipt'->>'commandHash' !~ '^[a-f0-9]{64}$' or not public.zentra_us_tax_revision(r->'erpReceipt'->'revision') then return false;end if;
  end if;
  return true;
exception when others then return false;end $$;
-- Conservative aggregate limits also bound own-data JSON snapshots. No accepted
-- write may produce a list that the private transport cannot read afterward.
create function public.zentra_us_supplier_capacity(v jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare valid boolean;
begin
  if jsonb_typeof(v) is distinct from 'array' or jsonb_array_length(v)>50 or octet_length(v::text)>2000000 then return false;end if;
  with recursive nodes(value,key_name,depth) as (
    select v,null::text,0 union all
    select child.value,child.key_name,n.depth+1 from nodes n cross join lateral (
      select e.value,e.key key_name from jsonb_each(case when jsonb_typeof(n.value)='object' then n.value else '{}'::jsonb end)e
      union all select a.value,null::text from jsonb_array_elements(case when jsonb_typeof(n.value)='array' then n.value else '[]'::jsonb end)a
    )child where n.depth<21
  )select count(*)<=49000 and sum(coalesce(octet_length(key_name),0)+case when jsonb_typeof(value)='string' then octet_length(value#>>'{}') else 0 end)<=2000000
    and bool_and(depth<=20 and coalesce(octet_length(key_name),0)<=500000 and case when jsonb_typeof(value)='string' then octet_length(value#>>'{}')<=500000 else true end
      and case when jsonb_typeof(value)='array' then jsonb_array_length(value)<=1000 else true end) into valid from nodes;
  return coalesce(valid,false);
end $$;

create table public.zentra_us_supplier_proposals (
  organization_id text not null references public.zentra_us_erp_heads on delete restrict,id uuid not null,
  source_sha256 text not null check(source_sha256 ~ '^[a-f0-9]{64}$'),revision integer not null check(revision in(0,1)),payload jsonb not null,
  primary key(organization_id,id),unique(organization_id,source_sha256),
  check(public.zentra_us_supplier_proposal_valid(payload,organization_id) and payload->>'id'=id::text and payload->>'revision'=revision::text and payload->'source'->>'sha256'=source_sha256)
);
create table public.zentra_us_supplier_audit (
  organization_id text not null,proposal_id uuid not null,revision integer not null check(revision in(0,1)),
  action text not null check(action in('proposed','recorded')),actor_id text not null,occurred_at timestamptz not null,
  proposal jsonb not null,request jsonb,request_hash text,erp_commit jsonb,
  primary key(organization_id,proposal_id,revision),foreign key(organization_id,proposal_id) references public.zentra_us_supplier_proposals on delete restrict
);
create unique index zentra_us_supplier_approval_key on public.zentra_us_supplier_audit(organization_id,(request->>'idempotencyKey')) where revision=1;
alter table public.zentra_us_supplier_proposals enable row level security;
alter table public.zentra_us_supplier_audit enable row level security;
revoke all on public.zentra_us_supplier_proposals,public.zentra_us_supplier_audit from public,anon,authenticated,service_role;
grant select,insert,update on public.zentra_us_supplier_proposals to service_role;
grant select,insert on public.zentra_us_supplier_audit to service_role;
create function public.zentra_us_supplier_immutable() returns trigger language plpgsql security invoker set search_path='' as $$
begin raise exception using errcode='PS008',message='Supplier source and history are immutable';end $$;
create trigger zentra_us_supplier_no_delete before delete or truncate on public.zentra_us_supplier_proposals for each statement execute function public.zentra_us_supplier_immutable();
create trigger zentra_us_supplier_audit_immutable before update or delete or truncate on public.zentra_us_supplier_audit for each statement execute function public.zentra_us_supplier_immutable();
create function public.zentra_us_supplier_transition() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.organization_id is distinct from old.organization_id or new.id is distinct from old.id or new.source_sha256 is distinct from old.source_sha256
    or old.revision<>0 or new.revision<>1 or old.payload->>'state'<>'review' or new.payload->>'state'<>'recorded'
    or (new.payload-array['revision','state','recording']) is distinct from (old.payload-array['revision','state']) then raise exception using errcode='PS008',message='Supplier proposal facts are immutable';end if;
  return new;
end $$;
create trigger zentra_us_supplier_transition before update on public.zentra_us_supplier_proposals for each row execute function public.zentra_us_supplier_transition();

create function public.zentra_us_supplier_erp_request(p jsonb,r jsonb) returns jsonb
language sql immutable security invoker set search_path='' as $$
  select jsonb_build_object('idempotencyKey','us-mail-approve:'||(r->>'idempotencyKey'),'expectedRevision',r->'expectedErpRevision',
    'command',jsonb_build_object('type','record_vendor_bill','id','us-mail-bill:'||(p->>'id'),'vendorId',r->'review'->>'vendorId','reference',r->'review'->>'reference',
      'date',r->'review'->>'date','accountingDate',r->'review'->>'accountingDate','dueDate',r->'review'->>'dueDate','periodId',r->'review'->>'periodId',
      'netMinor',r->'review'->>'netMinor','purchaseTaxMinor',r->'review'->>'printedTaxMinor','expenseAccountId','purchases','sourceReference','mail:'||(p->>'id')||':'||(p->'source'->>'sha256')));
$$;
-- ERP commit builds groups in domain order; its immutable event captures the
-- same keyed changes in SQL kind/id order. Compare the exact keyed records,
-- without changing either stored array or the original replay envelope.
create function public.zentra_us_supplier_ordered_changes(v jsonb) returns jsonb
language sql immutable security invoker set search_path='' as $$
  select coalesce(jsonb_agg(x order by x->>'kind',x->>'id'),'[]'::jsonb) from jsonb_array_elements(v)x;
$$;
-- Workspace->country->ERP head follows the existing financial lock order. The
-- proposal is locked afterward; approvals across an organization serialize on
-- the same ERP head, including duplicate bills and unrelated ERP commands.
create function public.zentra_us_supplier_scope(org text,actor jsonb,cap integer) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare c public.zentra_workspace_country_configs%rowtype;h public.zentra_us_erp_heads%rowtype;
begin
  if not public.zentra_us_supplier_uuid(org) or not coalesce(public.zentra_us_tax_actor_valid(actor,org),false) or not public.zentra_us_purchase_timestamp(actor->>'timestamp') then raise exception using errcode='PS005',message='Supplier financial authority required';end if;
  if cap is distinct from 4 then raise exception using errcode='PS006',message='Supplier accounting capability required';end if;
  perform 1 from public.zentra_workspaces where organization_id=org for update;
  if not found then raise exception using errcode='PS006',message='US workspace required';end if;
  select * into c from public.zentra_workspace_country_configs where organization_id=org for update;
  if not found or c.country<>'US' or c.currency<>'USD' then raise exception using errcode='PS006',message='Explicit US workspace required';end if;
  select * into h from public.zentra_us_erp_heads where organization_id=org for update;
  if not found or h.header->'schemaVersion' is distinct from '4'::jsonb or h.header->'configuration' is distinct from c.config then raise exception using errcode='PS006',message='Current US accounting book required';end if;
  return h.header;
end $$;
create function public.zentra_us_supplier_history_consistent() returns trigger
language plpgsql security invoker set search_path='' as $$
declare org text:=new.organization_id;pid uuid;stored public.zentra_us_supplier_proposals%rowtype;a public.zentra_us_supplier_audit%rowtype;
  original public.zentra_us_supplier_audit%rowtype;r jsonb;erp_request jsonb;hash text;event jsonb;bill jsonb;v_receipt jsonb;journal jsonb;
begin
  if tg_table_name='zentra_us_supplier_proposals' then pid:=new.id;else pid:=new.proposal_id;end if;
  select * into stored from public.zentra_us_supplier_proposals where organization_id=org and id=pid;
  if not found then raise exception using errcode='PS008',message='Supplier history has no proposal';end if;
  if not exists(select 1 from public.zentra_us_erp_heads h join public.zentra_workspace_country_configs c using(organization_id)
    where h.organization_id=org and c.country='US' and c.currency='USD' and h.header->'schemaVersion'='4'::jsonb and h.header->'configuration'=c.config) then raise exception using errcode='PS008',message='Supplier proposal requires current US accounting';end if;
  if not(select public.zentra_us_supplier_capacity(coalesce(jsonb_agg(payload),'[]'::jsonb))from public.zentra_us_supplier_proposals where organization_id=org) then raise exception using errcode='PS007',message='Supplier review capacity reached';end if;
  if (select count(*)from public.zentra_us_supplier_audit where organization_id=org and proposal_id=pid)<>stored.revision+1 then raise exception using errcode='PS008',message='Supplier history incomplete';end if;
  select * into original from public.zentra_us_supplier_audit where organization_id=org and proposal_id=pid and revision=0;
  if not found or original.action<>'proposed' or original.proposal->>'state'<>'review' or original.proposal->'revision'<>'0'::jsonb
    or not public.zentra_us_supplier_proposal_valid(original.proposal,org) or original.proposal->>'id'<>pid::text
    or original.actor_id is distinct from stored.payload->>'createdBy' or original.occurred_at is distinct from (stored.payload->>'createdAt')::timestamptz
    or original.request is not null or original.request_hash is not null or original.erp_commit is not null
    or (original.proposal-array['revision','state']) is distinct from (stored.payload-array['revision','state','recording']) then raise exception using errcode='PS008',message='Supplier source history differs';end if;
  if stored.revision=0 then return new;end if;
  -- Known foreign currency cannot be silently relabelled USD, even through a
  -- privileged direct sidecar/event transaction. Review-only sources stay valid.
  if stored.payload->'extraction'->'fields'->'currency' is distinct from 'null'::jsonb
    and stored.payload->'extraction'->'fields'->>'currency' is distinct from 'USD' then raise exception using errcode='PS008',message='Known non-USD supplier source cannot be recorded';end if;
  select * into a from public.zentra_us_supplier_audit where organization_id=org and proposal_id=pid and revision=1;
  r:=stored.payload->'recording';v_receipt:=r->'erpReceipt';
  if not found or a.action<>'recorded' or a.proposal is distinct from stored.payload or not public.zentra_us_supplier_request_valid(a.request)
    or a.request->>'proposalId'<>pid::text or a.request->'review' is distinct from r->'review'
    or a.actor_id is distinct from r->>'by' or a.occurred_at is distinct from (r->>'at')::timestamptz
    or a.request->>'idempotencyKey' is distinct from r->>'idempotencyKey' or a.request_hash is distinct from r->>'requestHash'
    or not public.zentra_us_tax_object(a.erp_commit,array['organizationId','expectedRevision','header','changes','ledgerAudit','receipt','actor'])
    or a.erp_commit->'receipt' is distinct from v_receipt or a.erp_commit->>'organizationId' is distinct from org
    or a.erp_commit->'expectedRevision' is distinct from a.request->'expectedErpRevision'
    or not public.zentra_us_tax_actor_valid(a.erp_commit->'actor',org) or a.erp_commit->'actor'->>'userId' is distinct from a.actor_id
    or a.erp_commit->'actor'->>'timestamp' is distinct from r->>'at' then raise exception using errcode='PS008',message='Supplier approval audit differs';end if;
  hash:=encode(sha256(convert_to(public.zentra_us_erp_v4_canonical(jsonb_build_array(org,a.actor_id,a.request)),'UTF8')),'hex');
  erp_request:=public.zentra_us_supplier_erp_request(stored.payload,a.request);
  if a.request_hash is distinct from hash or v_receipt->>'commandHash' is distinct from encode(sha256(convert_to(public.zentra_us_erp_v4_canonical(jsonb_build_array(org,a.actor_id,erp_request)),'UTF8')),'hex')
    or v_receipt->>'revision' is distinct from ((a.request->>'expectedErpRevision')::bigint+1)::text then raise exception using errcode='PS008',message='Supplier command fingerprint differs';end if;
  select e.event into event from public.zentra_us_erp_events e join public.zentra_us_erp_receipts z on z.organization_id=e.organization_id and z.revision=e.revision
    where e.organization_id=org and e.revision=(v_receipt->>'revision')::bigint and z.receipt=v_receipt and z.actor_id=a.actor_id;
  if not found or event->'schemaVersion'<>'4'::jsonb or event->'header' is distinct from a.erp_commit->'header' or event->'changes' is distinct from public.zentra_us_supplier_ordered_changes(a.erp_commit->'changes')
    or event->'ledgerAudit' is distinct from a.erp_commit->'ledgerAudit' or event->'receipt' is distinct from v_receipt or event->>'actorId' is distinct from a.actor_id
    or (event->>'occurredAt')::timestamptz is distinct from a.occurred_at then raise exception using errcode='PS008',message='Supplier approval requires its immutable ERP event';end if;
  select x->'payload' into bill from jsonb_array_elements(event->'changes')x where x->>'kind'='vendor_bill' and x->>'id'='us-mail-bill:'||pid::text;
  if not found or bill->>'id' is distinct from erp_request->'command'->>'id' or bill->>'sourceReference' is distinct from erp_request->'command'->>'sourceReference'
    or bill->>'approvalSource'<>'manual_entry' or bill->>'validatedBy' is distinct from a.actor_id or (bill->>'approvedAt')::timestamptz is distinct from a.occurred_at
    or (bill-array['id','organizationId','vendorId','vendorSnapshot','currency','net','tax','total','expenseAccountId','validatedBy','approvedAt','approvalSource','sourceReference','recordedRevision','date','accountingDate','dueDate','periodId','reference'])<>'{}'::jsonb
    or jsonb_build_object('vendorId',bill->'vendorId','reference',bill->'reference','date',bill->'date','accountingDate',bill->'accountingDate','dueDate',bill->'dueDate','periodId',bill->'periodId','netMinor',bill->'net'->'minorUnits','printedTaxMinor',bill->'tax'->'minorUnits') is distinct from a.request->'review' then raise exception using errcode='PS008',message='Supplier bill differs from human review';end if;
  for journal in select x->'payload' from jsonb_array_elements(event->'changes')x where x->>'kind'='journal' loop
    if journal->>'fingerprint' is distinct from public.zentra_us_erp_v4_canonical((journal->>'fingerprint')::jsonb) then raise exception using errcode='PS008',message='Supplier journal fingerprint is not canonical';end if;
  end loop;
  return new;
end $$;
create constraint trigger zentra_us_supplier_record_complete after insert or update on public.zentra_us_supplier_proposals deferrable initially deferred for each row execute function public.zentra_us_supplier_history_consistent();
create constraint trigger zentra_us_supplier_audit_complete after insert on public.zentra_us_supplier_audit deferrable initially deferred for each row execute function public.zentra_us_supplier_history_consistent();
create function public.zentra_us_supplier_erp_complete() returns trigger
language plpgsql security invoker set search_path='' as $$
declare a public.zentra_us_supplier_audit%rowtype;
begin
  if new.event->'receipt'->>'action'<>'record_vendor_bill' or left(new.event->'receipt'->>'entityId',13)<>'us-mail-bill:' then return new;end if;
  select * into a from public.zentra_us_supplier_audit where organization_id=new.organization_id and revision=1
    and proposal->'recording'->'erpReceipt'=new.event->'receipt';
  if not found or a.erp_commit->'header' is distinct from new.event->'header' or public.zentra_us_supplier_ordered_changes(a.erp_commit->'changes') is distinct from new.event->'changes'
    or a.erp_commit->'ledgerAudit' is distinct from new.event->'ledgerAudit' or a.actor_id is distinct from new.event->>'actorId'
    or a.occurred_at is distinct from (new.event->>'occurredAt')::timestamptz then raise exception using errcode='PS008',message='US mail bill requires its human supplier approval';end if;
  return new;
end $$;
create constraint trigger zentra_us_supplier_erp_complete after insert on public.zentra_us_erp_events deferrable initially deferred for each row execute function public.zentra_us_supplier_erp_complete();

create function public.zentra_list_us_supplier_proposals(p_organization text,p_actor jsonb,p_supported_schema_version integer) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
  perform public.zentra_us_supplier_scope(p_organization,p_actor,p_supported_schema_version);
  select coalesce(jsonb_agg(payload order by payload->>'createdAt' desc,id),'[]'::jsonb) into result from public.zentra_us_supplier_proposals where organization_id=p_organization;
  if not public.zentra_us_supplier_capacity(result) then raise exception using errcode='PS007',message='Supplier review limit';end if;return result;
end $$;
create function public.zentra_read_us_supplier_proposal(p_organization text,p_actor jsonb,p_supported_schema_version integer,p_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin perform public.zentra_us_supplier_scope(p_organization,p_actor,p_supported_schema_version);select payload into result from public.zentra_us_supplier_proposals where organization_id=p_organization and id=p_id;return result;end $$;
create function public.zentra_find_us_supplier_source(p_organization text,p_actor jsonb,p_supported_schema_version integer,p_sha256 text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
  perform public.zentra_us_supplier_scope(p_organization,p_actor,p_supported_schema_version);
  if p_sha256 is null or p_sha256 !~ '^[a-f0-9]{64}$' then raise exception using errcode='PS004',message='Invalid supplier source';end if;
  select payload into result from public.zentra_us_supplier_proposals where organization_id=p_organization and source_sha256=p_sha256;return result;
end $$;
create function public.zentra_create_us_supplier_proposal(p_organization text,p_actor jsonb,p_supported_schema_version integer,p_proposal jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare old public.zentra_us_supplier_proposals%rowtype;combined jsonb;
begin
  perform public.zentra_us_supplier_scope(p_organization,p_actor,p_supported_schema_version);
  if not public.zentra_us_supplier_proposal_valid(p_proposal,p_organization) or p_proposal->>'state'<>'review' or p_proposal->'revision'<>'0'::jsonb
    or p_proposal->>'createdBy' is distinct from p_actor->>'userId' or p_proposal->>'createdAt' is distinct from p_actor->>'timestamp' then raise exception using errcode='PS004',message='Invalid supplier proposal';end if;
  select * into old from public.zentra_us_supplier_proposals where organization_id=p_organization and source_sha256=p_proposal->'source'->>'sha256';
  if found then
    if old.payload->'source'->'documentText' is distinct from p_proposal->'source'->'documentText' or old.payload->'source'->'mediaType' is distinct from p_proposal->'source'->'mediaType' then raise exception using errcode='PS002',message='Supplier source identity differs';end if;return old.payload;
  end if;
  if exists(select 1 from public.zentra_us_supplier_proposals where organization_id=p_organization and id=(p_proposal->>'id')::uuid) then raise exception using errcode='PS002',message='Supplier proposal identity differs';end if;
  select coalesce(jsonb_agg(payload),'[]'::jsonb)||jsonb_build_array(p_proposal) into combined from public.zentra_us_supplier_proposals where organization_id=p_organization;
  if not public.zentra_us_supplier_capacity(combined) then raise exception using errcode='PS007',message='Supplier review limit';end if;
  insert into public.zentra_us_supplier_proposals values(p_organization,(p_proposal->>'id')::uuid,p_proposal->'source'->>'sha256',0,p_proposal);
  insert into public.zentra_us_supplier_audit values(p_organization,(p_proposal->>'id')::uuid,0,'proposed',p_actor->>'userId',(p_actor->>'timestamp')::timestamptz,p_proposal,null,null,null);
  return p_proposal;
end $$;
create function public.zentra_approve_us_supplier_proposal(p_organization text,p_actor jsonb,p_supported_schema_version integer,p_request jsonb,p_request_hash text,p_erp jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare h jsonb;stored public.zentra_us_supplier_proposals%rowtype;prior public.zentra_us_supplier_audit%rowtype;erp_request jsonb;expected_hash text;v_receipt jsonb;recording jsonb;candidate jsonb;combined jsonb;
begin
  h:=public.zentra_us_supplier_scope(p_organization,p_actor,p_supported_schema_version);
  if not public.zentra_us_supplier_request_valid(p_request) or not public.zentra_us_tax_object(p_erp,array['organizationId','expectedRevision','header','changes','ledgerAudit','receipt','actor'])
    or p_erp->>'organizationId' is distinct from p_organization or p_erp->'expectedRevision' is distinct from p_request->'expectedErpRevision'
    or p_erp->'header'->'schemaVersion' is distinct from '4'::jsonb or not coalesce(public.zentra_us_tax_actor_valid(p_erp->'actor',p_organization),false)
    or p_erp->'actor'->>'userId' is distinct from p_actor->>'userId' or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$' then raise exception using errcode='PS004',message='Invalid human supplier approval';end if;
  expected_hash:=encode(sha256(convert_to(public.zentra_us_erp_v4_canonical(jsonb_build_array(p_organization,p_actor->>'userId',p_request)),'UTF8')),'hex');
  if p_request_hash is distinct from expected_hash then raise exception using errcode='PS002',message='Supplier request fingerprint differs';end if;
  select * into stored from public.zentra_us_supplier_proposals where organization_id=p_organization and id=(p_request->>'proposalId')::uuid for update;
  if not found then raise exception using errcode='PS001',message='Supplier proposal unavailable';end if;
  if stored.payload->'extraction'->'fields'->'currency' is distinct from 'null'::jsonb
    and stored.payload->'extraction'->'fields'->>'currency' is distinct from 'USD' then raise exception using errcode='PS004',message='Known non-USD supplier source cannot be approved';end if;
  erp_request:=public.zentra_us_supplier_erp_request(stored.payload,p_request);v_receipt:=p_erp->'receipt';
  if not public.zentra_us_tax_object(v_receipt,array['idempotencyKey','commandHash','revision','entityId','action'])
    or v_receipt->>'idempotencyKey' is distinct from erp_request->>'idempotencyKey' or v_receipt->>'entityId' is distinct from erp_request->'command'->>'id'
    or v_receipt->>'action'<>'record_vendor_bill' or v_receipt->>'revision' is distinct from ((p_request->>'expectedErpRevision')::bigint+1)::text
    or v_receipt->>'commandHash' is distinct from encode(sha256(convert_to(public.zentra_us_erp_v4_canonical(jsonb_build_array(p_organization,p_actor->>'userId',erp_request)),'UTF8')),'hex') then raise exception using errcode='PS002',message='Supplier ERP receipt identity differs';end if;
  select * into prior from public.zentra_us_supplier_audit where organization_id=p_organization and revision=1 and request->>'idempotencyKey'=p_request->>'idempotencyKey';
  if found then
    if prior.proposal_id<>stored.id or prior.actor_id is distinct from p_actor->>'userId' or prior.request is distinct from p_request or prior.request_hash is distinct from p_request_hash or prior.erp_commit is distinct from p_erp then raise exception using errcode='PS002',message='Supplier approval replay differs';end if;
    return prior.proposal->'recording';
  end if;
  if stored.revision<>0 then raise exception using errcode='PS001',message='Supplier proposal already recorded';end if;
  if h->'revision' is distinct from p_request->'expectedErpRevision' then raise exception using errcode='PS003',message='ERP changed during supplier review';end if;
  if p_erp->'actor' is distinct from p_actor or (p_actor->>'timestamp')::timestamptz<(stored.payload->>'createdAt')::timestamptz then raise exception using errcode='PS004',message='Fresh human approval stamp required';end if;
  recording:=jsonb_build_object('idempotencyKey',p_request->>'idempotencyKey','requestHash',p_request_hash,'by',p_actor->>'userId','at',p_actor->>'timestamp','review',p_request->'review','erpReceipt',v_receipt);
  candidate:=stored.payload||jsonb_build_object('revision',1,'state','recorded','recording',recording);
  select coalesce(jsonb_agg(case when id=stored.id then candidate else payload end),'[]'::jsonb) into combined from public.zentra_us_supplier_proposals where organization_id=p_organization;
  if not public.zentra_us_supplier_capacity(combined) then raise exception using errcode='PS007',message='Supplier review capacity reached';end if;
  -- An orphan ERP receipt cannot be adopted as a new human approval. The exact
  -- historical event and sidecar audit are a single commit, not two authorities.
  if exists(select 1 from public.zentra_us_erp_receipts where organization_id=p_organization and idempotency_key=v_receipt->>'idempotencyKey') then raise exception using errcode='PS002',message='ERP receipt has no supplier approval';end if;
  if public.zentra_commit_us_erp(p_organization,(p_request->>'expectedErpRevision')::bigint,p_erp->'header',p_erp->'changes',p_erp->'ledgerAudit',v_receipt,p_actor) is distinct from v_receipt then raise exception using errcode='PS008',message='ERP receipt changed during approval';end if;
  update public.zentra_us_supplier_proposals set revision=1,payload=candidate where organization_id=p_organization and id=stored.id;
  insert into public.zentra_us_supplier_audit values(p_organization,stored.id,1,'recorded',p_actor->>'userId',(p_actor->>'timestamp')::timestamptz,candidate,p_request,p_request_hash,p_erp);
  return recording;
end $$;

-- Every helper/RPC is private. Public/authenticated roles cannot invoke a
-- privileged service adapter, supply an actor, or query source documents.
do $$ declare f record;begin
  for f in select p.oid::regprocedure signature from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'zentra\_us\_supplier\_%' escape '\'
    or n.nspname='public' and p.proname in('zentra_list_us_supplier_proposals','zentra_read_us_supplier_proposal','zentra_find_us_supplier_source','zentra_create_us_supplier_proposal','zentra_approve_us_supplier_proposal') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
commit;
