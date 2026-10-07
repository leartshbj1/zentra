-- Additive, disabled-by-default US ERP store. Apply only on a reconciled staging
-- workspace schema until explicit production approval. Does not alter CH data.
begin;

do $$ begin
  if pg_catalog.to_regclass('public.zentra_workspaces') is null
    or pg_catalog.to_regclass('public.zentra_workspace_country_configs') is null then
    raise exception 'Reconciled workspace and explicit country schema required';
  end if;
end $$;

create table public.zentra_us_erp_heads (
  organization_id text primary key references public.zentra_workspace_country_configs(organization_id) on delete restrict,
  revision bigint not null check (revision between 1 and 9007199254740991),
  header jsonb not null check (jsonb_typeof(header)='object'),
  updated_by text not null,
  updated_at timestamptz not null default now(),
  check (header->>'schemaVersion'='1' and header->>'revision'=revision::text)
);
create table public.zentra_us_erp_records (
  organization_id text not null references public.zentra_us_erp_heads on delete restrict,
  kind text not null check (kind in ('customer','estimate','invoice','journal')),
  id text not null check (length(id) between 1 and 512),
  payload jsonb not null check (jsonb_typeof(payload)='object' and payload->>'id'=id and payload->>'organizationId'=organization_id),
  state_revision bigint not null check (state_revision between 1 and 9007199254740991),
  primary key (organization_id,kind,id)
);
create unique index zentra_us_erp_document_number on public.zentra_us_erp_records(organization_id,kind,(payload->>'number')) where kind in ('estimate','invoice');
create unique index zentra_us_erp_estimate_conversion on public.zentra_us_erp_records(organization_id,(payload->>'sourceEstimateId'),(payload->>'sourceEstimateRevision')) where kind='invoice';
create unique index zentra_us_erp_journal_key on public.zentra_us_erp_records(organization_id,(payload->>'idempotencyKey')) where kind='journal';

create table public.zentra_us_erp_receipts (
  organization_id text not null references public.zentra_us_erp_heads on delete restrict,
  idempotency_key text not null check (length(idempotency_key) between 1 and 240),
  command_hash text not null check (command_hash ~ '^[0-9a-f]{64}$'),
  revision bigint not null check (revision between 1 and 9007199254740991),
  receipt jsonb not null,
  actor_id text not null,
  created_at timestamptz not null default now(),
  primary key (organization_id,idempotency_key),
  unique (organization_id,revision),
  check (jsonb_typeof(receipt)='object' and receipt->>'idempotencyKey'=idempotency_key and receipt->>'commandHash'=command_hash and receipt->>'revision'=revision::text)
);
create table public.zentra_us_erp_ledger_audit (
  organization_id text not null references public.zentra_us_erp_heads on delete restrict,
  revision bigint not null check (revision between 1 and 9007199254740991),
  payload jsonb not null,
  state_revision bigint not null,
  primary key (organization_id,revision),
  check (jsonb_typeof(payload)='object' and payload->>'revision'=revision::text and payload->>'action' in ('posted','period_closed'))
);

-- Exact JSON minor units; never use real/double precision or coerce decimals.
create function public.zentra_us_erp_minor(p_value jsonb) returns numeric
language plpgsql immutable security invoker set search_path='' as $$
begin
  if jsonb_typeof(p_value) is distinct from 'string' or p_value#>>'{}' !~ '^(0|[1-9][0-9]{0,35})$' then
    raise exception using errcode='PU004',message='Invalid exact minor amount';
  end if;
  return (p_value#>>'{}')::numeric;
end $$;

create function public.zentra_us_erp_journal_balanced(p_payload jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare v_line jsonb; v_dr numeric; v_cr numeric; v_debit numeric:=0; v_credit numeric:=0;
begin
  if jsonb_typeof(p_payload->'lines') is distinct from 'array' or jsonb_array_length(p_payload->'lines') not between 2 and 1000
    or p_payload->>'currency' is distinct from 'USD' then return false; end if;
  for v_line in select value from jsonb_array_elements(p_payload->'lines') loop
    v_dr:=public.zentra_us_erp_minor(v_line->'debitMinor'); v_cr:=public.zentra_us_erp_minor(v_line->'creditMinor');
    if (v_dr>0 and v_cr>0) or (v_dr=0 and v_cr=0) then return false; end if;
    v_debit:=v_debit+v_dr; v_credit:=v_credit+v_cr;
  end loop;
  return v_debit=v_credit and v_debit>0;
exception when others then return false;
end $$;
alter table public.zentra_us_erp_records add constraint zentra_us_erp_journal_balanced_check
  check (kind<>'journal' or public.zentra_us_erp_journal_balanced(payload));
create function public.zentra_us_erp_round_ratio(p_numerator numeric,p_denominator numeric) returns numeric
language sql immutable security invoker set search_path='' as $$
  select div(p_numerator,p_denominator)+case when mod(p_numerator,p_denominator)*2>=p_denominator then 1 else 0 end;
$$;
-- Mirrors lineTotals: quantity and discount are applied separately, with exact
-- integer half-up rounding. Financial amounts keep ledger.ts's 36 digit limit.
create function public.zentra_us_erp_line_totals(p_line jsonb) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare v_quantity numeric; v_price numeric; v_scale integer; v_discount integer; v_gross numeric; v_reduction numeric;
begin
  if jsonb_typeof(p_line) is distinct from 'object' or coalesce(length(p_line->>'id'),0) not between 1 and 160
    or coalesce(length(p_line->>'description'),0) not between 1 and 4000 or btrim(p_line->>'description')=''
    or p_line->'unitPrice'->>'currency' is distinct from 'USD'
    or jsonb_typeof(p_line->'quantityScale') is distinct from 'number' or p_line->>'quantityScale' !~ '^[0-6]$'
    or jsonb_typeof(p_line->'discountBasisPoints') is distinct from 'number' or p_line->>'discountBasisPoints' !~ '^[0-9]{1,5}$'
    or p_line->>'taxTreatment' is null or p_line->>'taxTreatment' not in ('taxable','non_taxable','exempt') then
    raise exception using errcode='PU004',message='Invalid exact sales line';
  end if;
  v_quantity:=public.zentra_us_erp_minor(p_line->'quantityUnits'); v_price:=public.zentra_us_erp_minor(p_line->'unitPrice'->'minorUnits');
  v_scale:=(p_line->>'quantityScale')::integer; v_discount:=(p_line->>'discountBasisPoints')::integer;
  if v_quantity<=0 or v_discount>10000 then raise exception using errcode='PU004',message='Invalid quantity or discount'; end if;
  v_gross:=public.zentra_us_erp_round_ratio(v_price*v_quantity,power(10::numeric,v_scale));
  v_reduction:=public.zentra_us_erp_round_ratio(v_gross*v_discount,10000);
  perform public.zentra_us_erp_minor(to_jsonb(v_gross::text));
  return jsonb_build_object('grossMinor',v_gross::text,'discountMinor',v_reduction::text,'netMinor',(v_gross-v_reduction)::text);
end $$;

create function public.zentra_us_erp_guard_history() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  raise exception using errcode='PU003',message='US ERP history is append-only';
end $$;
create trigger zentra_us_erp_receipt_immutable before update or delete on public.zentra_us_erp_receipts for each row execute function public.zentra_us_erp_guard_history();
create trigger zentra_us_erp_audit_immutable before update or delete on public.zentra_us_erp_ledger_audit for each row execute function public.zentra_us_erp_guard_history();

create function public.zentra_us_erp_guard_record() returns trigger
language plpgsql security invoker set search_path='' as $$
declare v_old_count integer; v_new_count integer; v_i integer;
begin
  if tg_op='DELETE' then raise exception using errcode='PU003',message='US ERP records cannot be silently deleted'; end if;
  if tg_op='UPDATE' then
    if new.organization_id is distinct from old.organization_id or new.kind is distinct from old.kind or new.id is distinct from old.id
      or new.state_revision<=old.state_revision or old.kind='journal' then
      raise exception using errcode='PU003',message='US ERP identity and posted journals are immutable';
    end if;
    if old.kind='invoice' then
      if new.payload-'payments' is distinct from old.payload-'payments' or jsonb_typeof(new.payload->'payments') is distinct from 'array' then
        raise exception using errcode='PU003',message='Issued invoice content is immutable';
      end if;
      v_old_count:=jsonb_array_length(old.payload->'payments'); v_new_count:=jsonb_array_length(new.payload->'payments');
      if v_new_count<>v_old_count+1 then raise exception using errcode='PU003',message='Invoice payments must append exactly one item'; end if;
      for v_i in 0..v_old_count-1 loop
        if old.payload->'payments'->v_i is distinct from new.payload->'payments'->v_i then
          raise exception using errcode='PU003',message='Recorded payment history is immutable';
        end if;
      end loop;
    end if;
  end if;
  return new;
end $$;
create trigger zentra_us_erp_record_immutable before update or delete on public.zentra_us_erp_records for each row execute function public.zentra_us_erp_guard_record();

create function public.zentra_us_erp_guard_head() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception using errcode='PU003',message='US ERP history must be retained'; end if;
  if tg_op='UPDATE' and (new.organization_id is distinct from old.organization_id or new.revision<>old.revision+1
    or (new.header->'configuration') - array['language','timeZone','address','ein','invoiceNumberPrefix','taxConfiguration'] is distinct from (old.header->'configuration') - array['language','timeZone','address','ein','invoiceNumberPrefix','taxConfiguration']
    or new.header->'ledger'->'accounts' is distinct from old.header->'ledger'->'accounts') then
    raise exception using errcode='PU003',message='US ERP configuration and chart cannot be silently replaced';
  end if;
  return new;
end $$;
create trigger zentra_us_erp_head_guard before update or delete on public.zentra_us_erp_heads for each row execute function public.zentra_us_erp_guard_head();

create function public.zentra_read_us_erp(p_organization text) returns jsonb
language sql stable security invoker set search_path='' as $$
  select h.header || jsonb_build_object(
    'customers',coalesce((select jsonb_agg(r.payload order by r.id) from public.zentra_us_erp_records r where r.organization_id=h.organization_id and r.kind='customer'),'[]'::jsonb),
    'estimates',coalesce((select jsonb_agg(r.payload order by r.id) from public.zentra_us_erp_records r where r.organization_id=h.organization_id and r.kind='estimate'),'[]'::jsonb),
    'invoices',coalesce((select jsonb_agg(r.payload order by r.id) from public.zentra_us_erp_records r where r.organization_id=h.organization_id and r.kind='invoice'),'[]'::jsonb),
    'ledger',(h.header->'ledger') || jsonb_build_object(
      'entries',coalesce((select jsonb_agg(r.payload order by (r.payload->>'revision')::bigint) from public.zentra_us_erp_records r where r.organization_id=h.organization_id and r.kind='journal'),'[]'::jsonb),
      'audit',coalesce((select jsonb_agg(a.payload order by a.revision) from public.zentra_us_erp_ledger_audit a where a.organization_id=h.organization_id),'[]'::jsonb)))
  from public.zentra_us_erp_heads h where h.organization_id=p_organization;
$$;
create function public.zentra_us_erp_receipt(p_organization text,p_idempotency_key text) returns jsonb
language sql stable security invoker set search_path='' as $$
  select receipt from public.zentra_us_erp_receipts where organization_id=p_organization and idempotency_key=p_idempotency_key;
$$;

create function public.zentra_commit_us_erp(p_organization text,p_expected_revision bigint,p_header jsonb,p_changes jsonb,p_ledger_audit jsonb,p_receipt jsonb,p_actor jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare
  v_head public.zentra_us_erp_heads%rowtype; v_config public.zentra_workspace_country_configs%rowtype;
  v_saved public.zentra_us_erp_receipts%rowtype; v_change jsonb; v_payload jsonb; v_previous jsonb;
  v_line jsonb; v_payment jsonb; v_audit jsonb; v_period jsonb; v_old_period jsonb;
  v_invoice jsonb; v_journal jsonb; v_estimate jsonb; v_assessment jsonb; v_tax_line jsonb; v_line_amounts jsonb; v_request_lines jsonb; v_fingerprint jsonb;
  v_expected_lines jsonb; v_net numeric; v_prior_paid numeric; v_amount numeric; v_recognized numeric; v_subtotal numeric; v_discount numeric; v_tax numeric;
  v_kind text; v_id text; v_action text; v_actor text; v_new_revision bigint; v_ledger_before bigint; v_ledger_after bigint;
  v_debit numeric; v_credit numeric; v_dr numeric; v_cr numeric; v_total numeric; v_paid numeric;
  v_new_estimates bigint:=0; v_new_invoices bigint:=0; v_new_journals bigint:=0; v_audit_revision bigint;
begin
  if p_organization is null or p_organization !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_expected_revision is null or p_expected_revision not between 0 and 9007199254740990
    or jsonb_typeof(p_actor) is distinct from 'object' or p_actor->>'organizationId' is distinct from p_organization
    or p_actor->>'role' is null or p_actor->>'role' not in ('owner','admin','accountant','member') or p_actor->'managementEntitled' is distinct from 'true'::jsonb
    or coalesce(length(p_actor->>'userId'),0) not between 1 and 256 or p_actor->>'timestamp' is null then
    raise exception using errcode='PU004',message='US ERP financial authority required';
  end if;
  v_actor:=p_actor->>'userId'; perform (p_actor->>'timestamp')::timestamptz;
  if jsonb_typeof(p_receipt) is distinct from 'object' or coalesce(length(p_receipt->>'idempotencyKey'),0) not between 1 and 240
    or p_receipt->>'commandHash' is null or p_receipt->>'commandHash' !~ '^[0-9a-f]{64}$'
    or coalesce(length(p_receipt->>'entityId'),0) not between 1 and 512
    or p_receipt->>'action' is null or p_receipt->>'action' not in ('initialize','refresh_configuration','save_customer','save_estimate','accept_estimate','issue_invoice','record_payment','close_period') then
    raise exception using errcode='PU004',message='Invalid US ERP receipt';
  end if;
  v_action:=p_receipt->>'action';
  -- Recheck the operation permission even when returning an earlier receipt.
  if (v_action in ('initialize','refresh_configuration') and p_actor->>'role'<>'owner') or (v_action in ('issue_invoice','record_payment','close_period') and p_actor->>'role' not in ('owner','admin','accountant')) then
    raise exception using errcode='PU004',message='US ERP operation permission required';
  end if;
  -- Existing snapshot head only supplies a tenant lock. Its revision is never changed.
  perform 1 from public.zentra_workspaces where organization_id=p_organization for update;
  if not found then raise exception using errcode='PU005',message='Workspace not available'; end if;
  select * into v_config from public.zentra_workspace_country_configs where organization_id=p_organization for update;
  if not found or v_config.country<>'US' or v_config.currency<>'USD' then
    raise exception using errcode='PU005',message='Explicit US country configuration required';
  end if;
  select * into v_saved from public.zentra_us_erp_receipts where organization_id=p_organization and idempotency_key=p_receipt->>'idempotencyKey';
  if found then
    if v_saved.command_hash is distinct from p_receipt->>'commandHash' or v_saved.actor_id is distinct from v_actor
      or v_saved.receipt->>'entityId' is distinct from p_receipt->>'entityId' or v_saved.receipt->>'action' is distinct from p_receipt->>'action' then
      raise exception using errcode='PU002',message='US ERP idempotency conflict';
    end if;
    return v_saved.receipt;
  end if;
  select * into v_head from public.zentra_us_erp_heads where organization_id=p_organization for update;
  if coalesce(v_head.revision,0)<>p_expected_revision then raise exception using errcode='PU001',message='US ERP revision conflict'; end if;
  v_new_revision:=p_expected_revision+1;
  if (v_head.organization_id is null) <> (v_action='initialize') then raise exception using errcode='PU004',message='US ERP initialization state conflict'; end if;
  if p_header->'configuration' is distinct from v_config.config
    or (v_head.organization_id is not null and v_action<>'refresh_configuration' and p_header->'configuration' is distinct from v_head.header->'configuration') then
    raise exception using errcode='PU006',message='US ERP configuration changed';
  end if;
  if jsonb_typeof(p_header) is distinct from 'object' or p_header->>'schemaVersion' is distinct from '1'
    or p_header->>'revision' is distinct from v_new_revision::text or p_receipt->>'revision' is distinct from v_new_revision::text
    or jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes)>20
    or jsonb_typeof(p_ledger_audit) is distinct from 'array' or jsonb_array_length(p_ledger_audit)>2
    or jsonb_typeof(p_header->'ledger') is distinct from 'object'
    or p_header->'ledger' ?| array['entries','audit'] or p_header ?| array['customers','estimates','invoices']
    or p_header->'ledger'->>'organizationId' is distinct from p_organization
    or p_header->'ledger'->>'currency' is distinct from 'USD'
    or p_header->'ledger'->>'basis' is distinct from v_config.config->>'accountingBasis'
    or jsonb_typeof(p_header->'ledger'->'accounts') is distinct from 'array'
    or jsonb_typeof(p_header->'ledger'->'periods') is distinct from 'array' then
    raise exception using errcode='PU004',message='Invalid US ERP header';
  end if;
  v_ledger_before:=coalesce((v_head.header->'ledger'->>'revision')::bigint,0);
  v_ledger_after:=(p_header->'ledger'->>'revision')::bigint;
  if v_ledger_after is null or v_ledger_after<>v_ledger_before+jsonb_array_length(p_ledger_audit) then
    raise exception using errcode='PU004',message='Invalid ledger revision chain';
  end if;
  if p_header->'counters'->>'estimate' is null or (p_header->'counters'->>'estimate')::numeric not between 0 and 9007199254740991
    or p_header->'counters'->>'invoice' is null or (p_header->'counters'->>'invoice')::numeric not between 0 and 9007199254740991 then
    raise exception using errcode='PU004',message='Invalid document counter';
  end if;
  if jsonb_array_length(p_header->'ledger'->'accounts')<2 or jsonb_array_length(p_header->'ledger'->'accounts')>1000 then
    raise exception using errcode='PU004',message='Invalid chart of accounts';
  end if;
  if exists(select 1 from jsonb_array_elements(p_header->'ledger'->'accounts') a where a->>'id' is null or a->>'code' is null or a->>'type' is null or a->>'type' not in ('asset','liability','equity','income','expense') or (a->>'cash'='true' and a->>'type'<>'asset'))
    or (select count(*)<>count(distinct a->>'id') or count(*)<>count(distinct a->>'code') from jsonb_array_elements(p_header->'ledger'->'accounts') a) then
    raise exception using errcode='PU004',message='Invalid chart of accounts';
  end if;
  if not exists(select 1 from jsonb_array_elements(p_header->'ledger'->'accounts') a where a->>'id'='receivables' and a->>'type'='asset')
    or not exists(select 1 from jsonb_array_elements(p_header->'ledger'->'accounts') a where a->>'id'='cash' and a->>'type'='asset' and a->'cash'='true'::jsonb)
    or not exists(select 1 from jsonb_array_elements(p_header->'ledger'->'accounts') a where a->>'id'='sales' and a->>'type'='income')
    or not exists(select 1 from jsonb_array_elements(p_header->'ledger'->'accounts') a where a->>'id'='tax-payable' and a->>'type'='liability') then
    raise exception using errcode='PU004',message='US sales posting chart mappings required';
  end if;
  if (select count(*)<>count(distinct a->>'id') from jsonb_array_elements(p_header->'ledger'->'periods') a)
    or exists(select 1 from jsonb_array_elements(p_header->'ledger'->'periods') a,jsonb_array_elements(p_header->'ledger'->'periods') b where a->>'id'<b->>'id' and (a->>'start')::date<=(b->>'end')::date and (b->>'start')::date<=(a->>'end')::date) then
    raise exception using errcode='PU004',message='Overlapping accounting periods';
  end if;
  for v_period in select value from jsonb_array_elements(p_header->'ledger'->'periods') loop
    if v_period->>'id' is null or v_period->>'status' is null or v_period->>'status' not in ('open','closed')
      or v_period->>'start' is null or v_period->>'end' is null or (v_period->>'start')::date>(v_period->>'end')::date then
      raise exception using errcode='PU004',message='Invalid accounting period';
    end if;
    if v_head.organization_id is not null then
      select value into v_old_period from jsonb_array_elements(v_head.header->'ledger'->'periods') where value->>'id'=v_period->>'id';
      if not found or v_period-'status' is distinct from v_old_period-'status'
        or (v_period->>'status' is distinct from v_old_period->>'status' and not (v_action='close_period' and v_old_period->>'status'='open' and v_period->>'status'='closed' and p_receipt->>'entityId'=v_period->>'id')) then
        raise exception using errcode='PU003',message='Accounting periods cannot be replaced or reopened';
      end if;
    end if;
  end loop;
  if v_head.organization_id is not null and jsonb_array_length(p_header->'ledger'->'periods')<>jsonb_array_length(v_head.header->'ledger'->'periods') then
    raise exception using errcode='PU003',message='Accounting periods cannot be removed';
  end if;
  insert into public.zentra_us_erp_heads values(p_organization,v_new_revision,p_header,v_actor,now())
    on conflict(organization_id) do update set revision=excluded.revision,header=excluded.header,updated_by=excluded.updated_by,updated_at=excluded.updated_at;
  if (select count(*)<>count(distinct (value->>'kind',value->>'id')) from jsonb_array_elements(p_changes)) then
    raise exception using errcode='PU004',message='Duplicate record changes';
  end if;
  for v_change in select value from jsonb_array_elements(p_changes) loop
    v_kind:=v_change->>'kind'; v_id:=v_change->>'id'; v_payload:=v_change->'payload';
    if v_kind is null or v_kind not in ('customer','estimate','invoice','journal') or coalesce(length(v_id),0) not between 1 and 512
      or jsonb_typeof(v_payload) is distinct from 'object' or v_payload->>'organizationId' is distinct from p_organization or v_payload->>'id' is distinct from v_id then
      raise exception using errcode='PU004',message='Invalid scoped record change';
    end if;
    select payload into v_previous from public.zentra_us_erp_records where organization_id=p_organization and kind=v_kind and id=v_id;
    if v_kind='customer' then
      if v_action<>'save_customer' or v_id<>p_receipt->>'entityId' or coalesce(length(v_payload->>'name'),0) not between 1 and 256
        or v_payload->>'kind' is null or v_payload->>'kind' not in ('individual','business') then
        raise exception using errcode='PU004',message='Invalid customer operation';
      end if;
    elsif v_kind='estimate' then
      if v_action not in ('save_estimate','accept_estimate') or v_id<>p_receipt->>'entityId' or v_payload->>'currency' is distinct from 'USD'
        or coalesce(length(v_payload->>'number'),0)=0 or v_payload->>'revision' is null or (v_payload->>'revision')::bigint<>coalesce((v_previous->>'revision')::bigint,0)+1
        or (v_previous is not null and (v_previous->>'status' not in ('draft','accepted') or v_payload->>'number' is distinct from v_previous->>'number'))
        or exists(select 1 from public.zentra_us_erp_records i where i.organization_id=p_organization and i.kind='invoice' and i.payload->>'sourceEstimateId'=v_id)
        or (v_action='accept_estimate' and (v_previous is null or v_payload->>'status' is distinct from 'accepted' or v_payload-array['revision','status'] is distinct from v_previous-array['revision','status']))
        or (v_action='save_estimate' and v_payload->>'status' is distinct from 'draft')
        or not exists(select 1 from public.zentra_us_erp_records c where c.organization_id=p_organization and c.kind='customer' and c.id=v_payload->'customer'->>'id') then
        raise exception using errcode='PU004',message='Invalid estimate transition or customer scope';
      end if;
      if jsonb_typeof(v_payload->'lines') is distinct from 'array' or jsonb_array_length(v_payload->'lines') not between 1 and 1000
        or (select count(*)<>count(distinct value->>'id') from jsonb_array_elements(v_payload->'lines'))
        or (v_action='save_estimate' and not exists(select 1 from public.zentra_us_erp_records c where c.organization_id=p_organization and c.kind='customer' and c.payload=v_payload->'customer')) then
        raise exception using errcode='PU004',message='Invalid estimate lines or customer snapshot';
      end if;
      for v_line in select value from jsonb_array_elements(v_payload->'lines') loop perform public.zentra_us_erp_line_totals(v_line); end loop;
      if v_previous is null then
        v_new_estimates:=v_new_estimates+1;
        v_amount:=coalesce((v_head.header->'counters'->>'estimate')::numeric,0)+v_new_estimates;
        if v_payload->>'number' is distinct from 'EST-'||lpad(v_amount::text,greatest(6,length(v_amount::text)),'0') then
          raise exception using errcode='PU004',message='Estimate number must match its atomic counter';
        end if;
      end if;
    elsif v_kind='invoice' then
      if v_payload->>'currency' is distinct from 'USD' or (v_previous is null and v_payload->'companyConfiguration' is distinct from v_config.config)
        or coalesce(length(v_payload->>'number'),0)=0 or jsonb_typeof(v_payload->'payments') is distinct from 'array'
        or (v_previous is null and (v_action<>'issue_invoice' or v_id<>p_receipt->>'entityId' or jsonb_array_length(v_payload->'payments')<>0))
        or (v_previous is not null and v_action<>'record_payment') then
        raise exception using errcode='PU004',message='Invalid invoice operation';
      end if;
      if v_previous is null then
        select payload into v_estimate from public.zentra_us_erp_records e where e.organization_id=p_organization and e.kind='estimate' and e.id=v_payload->>'sourceEstimateId' and e.payload->>'revision'=v_payload->>'sourceEstimateRevision' and e.payload->>'status'='accepted';
        if not found or v_payload->>'issuedBy' is distinct from v_actor then
          raise exception using errcode='PU004',message='Accepted estimate required for invoice';
        end if;
        if v_payload->'lines' is distinct from v_estimate->'lines' or v_payload->'customer' is distinct from v_estimate->'customer'
          or v_payload->'projectId' is distinct from v_estimate->'projectId' or v_payload->'notes' is distinct from v_estimate->'notes'
          or v_config.config->'taxConfiguration'->>'status' is distinct from 'configured' then
          raise exception using errcode='PU004',message='Invoice must preserve the accepted estimate snapshot';
        end if;
        v_subtotal:=0; v_discount:=0; v_request_lines:='[]'::jsonb;
        for v_line in select value from jsonb_array_elements(v_estimate->'lines') loop
          v_line_amounts:=public.zentra_us_erp_line_totals(v_line);
          v_subtotal:=v_subtotal+public.zentra_us_erp_minor(v_line_amounts->'grossMinor'); v_discount:=v_discount+public.zentra_us_erp_minor(v_line_amounts->'discountMinor');
          v_request_lines:=v_request_lines||jsonb_build_array(jsonb_build_object('id',v_line->>'id','netMinor',v_line_amounts->>'netMinor','taxTreatment',v_line->>'taxTreatment'));
        end loop;
        if public.zentra_us_erp_minor(v_payload->'subtotal'->'minorUnits')<>v_subtotal or public.zentra_us_erp_minor(v_payload->'discount'->'minorUnits')<>v_discount then
          raise exception using errcode='PU004',message='Invoice totals must match the accepted estimate';
        end if;
        v_assessment:=v_payload->'taxAssessment';
        if jsonb_typeof(v_assessment) is distinct from 'object' or v_assessment->>'organizationId' is distinct from p_organization
          or v_assessment->>'country' is distinct from 'US' or v_assessment->>'currency' is distinct from 'USD'
          or v_assessment->>'documentId' is distinct from v_estimate->>'id' or v_assessment->'documentRevision' is distinct from v_estimate->'revision'
          or v_assessment->>'source' is null or v_assessment->>'source' not in ('external-provider','documented-exemption')
          or coalesce(length(v_assessment->>'providerReference'),0) not between 1 and 500
          or jsonb_typeof(v_assessment->'lines') is distinct from 'array' or jsonb_array_length(v_assessment->'lines')<>jsonb_array_length(v_request_lines)
          or (select count(*)<>count(distinct value->>'id') from jsonb_array_elements(v_assessment->'lines'))
          or v_assessment->>'determinedAt' is null or v_assessment->>'validUntil' is null or v_payload->>'issuedAt' is null
          or (v_assessment->>'determinedAt')::timestamptz>(v_payload->>'issuedAt')::timestamptz
          or (v_assessment->>'validUntil')::timestamptz<(v_payload->>'issuedAt')::timestamptz
          or (v_payload->>'issuedAt')::timestamptz>(p_actor->>'timestamp')::timestamptz then
          raise exception using errcode='PU004',message='Valid scoped US tax evidence required';
        end if;
        begin v_fingerprint:=(v_assessment->>'fingerprint')::jsonb;
        exception when invalid_text_representation then raise exception using errcode='PU004',message='Tax request fingerprint is invalid'; end;
        if v_fingerprint is distinct from jsonb_build_array(p_organization,'US','USD',v_config.config->'address',v_estimate->>'id',v_estimate->'revision',v_payload->>'date',v_estimate->'customer'->'billingAddress',coalesce(v_estimate->'customer'->'shippingAddress','null'::jsonb),v_request_lines) then
          raise exception using errcode='PU004',message='Tax request does not match the invoice inputs';
        end if;
        v_tax:=0;
        for v_tax_line in select value from jsonb_array_elements(v_assessment->'lines') loop
          select value into v_line from jsonb_array_elements(v_estimate->'lines') where value->>'id'=v_tax_line->>'id';
          if not found or coalesce(length(v_tax_line->>'jurisdiction'),0) not between 1 and 160 or coalesce(length(v_tax_line->>'evidenceReference'),0) not between 1 and 500
            or ((v_line->>'taxTreatment'<>'taxable' or v_assessment->>'source'='documented-exemption') and public.zentra_us_erp_minor(v_tax_line->'taxMinor')<>0) then
            raise exception using errcode='PU004',message='Invalid tax evidence line';
          end if;
          v_tax:=v_tax+public.zentra_us_erp_minor(v_tax_line->'taxMinor');
        end loop;
        if v_tax<>public.zentra_us_erp_minor(v_payload->'tax'->'minorUnits') then raise exception using errcode='PU004',message='Invoice tax does not match its evidence'; end if;
        v_new_invoices:=v_new_invoices+1;
        v_amount:=coalesce((v_head.header->'counters'->>'invoice')::numeric,0)+v_new_invoices;
        if v_payload->>'number' is distinct from (v_config.config->>'invoiceNumberPrefix')||'-'||lpad(v_amount::text,greatest(6,length(v_amount::text)),'0') then
          raise exception using errcode='PU004',message='Invoice number must match its atomic counter';
        end if;
      end if;
      if exists(select 1 from jsonb_each(v_payload) a where a.key in ('subtotal','discount','tax','total') and a.value->>'currency' is distinct from 'USD') then
        raise exception using errcode='PU004',message='Invoice currency mismatch';
      end if;
      v_total:=public.zentra_us_erp_minor(v_payload->'total'->'minorUnits');
      if public.zentra_us_erp_minor(v_payload->'subtotal'->'minorUnits')-public.zentra_us_erp_minor(v_payload->'discount'->'minorUnits')+public.zentra_us_erp_minor(v_payload->'tax'->'minorUnits')<>v_total then
        raise exception using errcode='PU004',message='Invoice total mismatch';
      end if;
      v_paid:=0;
      for v_payment in select value from jsonb_array_elements(v_payload->'payments') loop
        if v_payment->>'organizationId' is distinct from p_organization or v_payment->>'invoiceId' is distinct from v_id
          or v_payment->'amount'->>'currency' is distinct from 'USD' or public.zentra_us_erp_minor(v_payment->'amount'->'minorUnits')<=0 then
          raise exception using errcode='PU004',message='Invalid invoice payment';
        end if;
        v_paid:=v_paid+public.zentra_us_erp_minor(v_payment->'amount'->'minorUnits');
      end loop;
      if v_paid>v_total or (select count(*)<>count(distinct value->>'id') or count(*)<>count(distinct value->>'idempotencyKey') from jsonb_array_elements(v_payload->'payments')) then
        raise exception using errcode='PU004',message='Payment exceeds balance or duplicates history';
      end if;
    else
      if v_action not in ('issue_invoice','record_payment') or v_previous is not null or v_payload->>'currency' is distinct from 'USD'
        or coalesce(length(v_payload->>'idempotencyKey'),0) not between 1 and 240 or v_payload->>'postedAt' is null
        or v_payload->>'basis' is distinct from v_config.config->>'accountingBasis' or v_payload->>'postedBy' is distinct from v_actor
        or jsonb_typeof(v_payload->'lines') is distinct from 'array' or jsonb_array_length(v_payload->'lines') not between 2 and 1000
        or not exists(select 1 from jsonb_array_elements(p_header->'ledger'->'periods') p where p->>'id'=v_payload->>'periodId' and p->>'status'='open' and (v_payload->>'accountingDate')::date between (p->>'start')::date and (p->>'end')::date)
        or exists(select 1 from jsonb_array_elements(p_header->'ledger'->'periods') p where p->>'status'='closed' and (v_payload->>'accountingDate')::date<=(p->>'end')::date) then
        raise exception using errcode='PU004',message='Invalid journal or accounting period';
      end if;
      v_debit:=0; v_credit:=0;
      for v_line in select value from jsonb_array_elements(v_payload->'lines') loop
        if not exists(select 1 from jsonb_array_elements(p_header->'ledger'->'accounts') a where a->>'id'=v_line->>'accountId') then
          raise exception using errcode='PU004',message='Journal account missing';
        end if;
        v_dr:=public.zentra_us_erp_minor(v_line->'debitMinor'); v_cr:=public.zentra_us_erp_minor(v_line->'creditMinor');
        if (v_dr>0 and v_cr>0) or (v_dr=0 and v_cr=0) then raise exception using errcode='PU004',message='Invalid journal line'; end if;
        v_debit:=v_debit+v_dr; v_credit:=v_credit+v_cr;
      end loop;
      if v_debit<>v_credit or v_debit=0 then raise exception using errcode='PU004',message='Unbalanced journal'; end if;
      v_new_journals:=v_new_journals+1;
    end if;
    insert into public.zentra_us_erp_records values(p_organization,v_kind,v_id,v_payload,v_new_revision)
      on conflict(organization_id,kind,id) do update set payload=excluded.payload,state_revision=excluded.state_revision;
  end loop;
  -- A balanced journal is not sufficient: reconstruct the actual monetary
  -- effect of this invoice/payment using the same exact core rounding rule.
  if v_action in ('issue_invoice','record_payment') then
    select payload into v_invoice from public.zentra_us_erp_records where organization_id=p_organization and kind='invoice' and state_revision=v_new_revision;
    if not found then raise exception using errcode='PU004',message='Invoice effect missing'; end if;
    select payload into v_journal from public.zentra_us_erp_records where organization_id=p_organization and kind='journal' and state_revision=v_new_revision;
    v_total:=public.zentra_us_erp_minor(v_invoice->'total'->'minorUnits');
    v_net:=v_total-public.zentra_us_erp_minor(v_invoice->'tax'->'minorUnits');
    if v_action='issue_invoice' and v_config.config->>'accountingBasis'='accrual' and v_total>0 then
      select jsonb_agg(value order by ordinality) into v_expected_lines from jsonb_array_elements(jsonb_build_array(
        jsonb_build_object('accountId','receivables','debitMinor',v_total::text,'creditMinor','0'),
        jsonb_build_object('accountId','sales','debitMinor','0','creditMinor',v_net::text),
        jsonb_build_object('accountId','tax-payable','debitMinor','0','creditMinor',v_invoice->'tax'->>'minorUnits'))) with ordinality
      where public.zentra_us_erp_minor(value->'debitMinor')>0 or public.zentra_us_erp_minor(value->'creditMinor')>0;
      if v_journal is null or v_journal->'source' is distinct from jsonb_build_object('type','customer_invoice','id',v_invoice->>'id')
        or v_journal->>'id' is distinct from 'entry:invoice:'||(v_invoice->>'id')
        or v_journal->>'idempotencyKey' is distinct from 'invoice:'||(v_invoice->>'id')
        or v_journal->>'transactionDate' is distinct from v_invoice->>'date' or v_journal->>'accountingDate' is distinct from v_invoice->>'accountingDate'
        or v_journal->>'postedAt' is distinct from v_invoice->>'issuedAt'
        or v_journal->'lines' is distinct from v_expected_lines or v_journal ?| array['paymentDate','cashFlowCategory','reversesEntryId'] then
        raise exception using errcode='PU004',message='Invoice journal does not match its financial effect';
      end if;
    elsif v_action='record_payment' then
      v_payment:=v_invoice->'payments'->(jsonb_array_length(v_invoice->'payments')-1);
      if v_payment->>'id' is distinct from p_receipt->>'entityId' or v_payment->>'recordedBy' is distinct from v_actor or v_payment->>'idempotencyKey' is distinct from p_receipt->>'idempotencyKey'
        or coalesce(length(v_payment->>'reference'),0) not between 1 and 500 or btrim(v_payment->>'reference')='' then
        raise exception using errcode='PU004',message='Payment identity does not match its receipt';
      end if;
      v_amount:=public.zentra_us_erp_minor(v_payment->'amount'->'minorUnits');
      select coalesce(sum(public.zentra_us_erp_minor(value->'amount'->'minorUnits')),0) into v_prior_paid from jsonb_array_elements(v_invoice->'payments') with ordinality where ordinality<jsonb_array_length(v_invoice->'payments');
      if v_config.config->>'accountingBasis'='accrual' then
        v_expected_lines:=jsonb_build_array(jsonb_build_object('accountId','receivables','debitMinor','0','creditMinor',v_amount::text));
      else
        v_recognized:=public.zentra_us_erp_round_ratio(v_net*(v_prior_paid+v_amount),v_total)-public.zentra_us_erp_round_ratio(v_net*v_prior_paid,v_total);
        select jsonb_agg(value order by ordinality) into v_expected_lines from jsonb_array_elements(jsonb_build_array(
          jsonb_build_object('accountId','sales','debitMinor','0','creditMinor',v_recognized::text),
          jsonb_build_object('accountId','tax-payable','debitMinor','0','creditMinor',(v_amount-v_recognized)::text))) with ordinality
        where public.zentra_us_erp_minor(value->'creditMinor')>0;
      end if;
      v_expected_lines:=jsonb_build_array(jsonb_build_object('accountId','cash','debitMinor',v_amount::text,'creditMinor','0','description','['||to_json(v_payment->>'id')::text||','||to_json(v_payment->>'reference')::text||']'))||v_expected_lines;
      if v_journal is null or v_journal->'source' is distinct from jsonb_build_object('type','customer_payment','id',v_invoice->>'id')
        or v_journal->>'id' is distinct from 'entry:payment:'||(v_payment->>'idempotencyKey')
        or v_journal->>'idempotencyKey' is distinct from 'payment:'||(v_payment->>'idempotencyKey')
        or v_journal->>'transactionDate' is distinct from v_payment->>'paymentDate'
        or v_journal->>'accountingDate' is distinct from v_payment->>'accountingDate'
        or v_journal->>'paymentDate' is distinct from v_payment->>'paymentDate'
        or v_journal->>'cashFlowCategory' is distinct from 'operating' or v_journal ? 'reversesEntryId'
        or v_journal->'lines' is distinct from v_expected_lines then
        raise exception using errcode='PU004',message='Payment journal does not match its financial effect';
      end if;
    end if;
  end if;
  if (p_header->'counters'->>'estimate')::bigint is distinct from coalesce((v_head.header->'counters'->>'estimate')::bigint,0)+v_new_estimates
    or (p_header->'counters'->>'invoice')::bigint is distinct from coalesce((v_head.header->'counters'->>'invoice')::bigint,0)+v_new_invoices then
    raise exception using errcode='PU004',message='US ERP number counter mismatch';
  end if;
  v_audit_revision:=v_ledger_before;
  for v_audit in select value from jsonb_array_elements(p_ledger_audit) loop
    v_audit_revision:=v_audit_revision+1;
    perform (v_audit->>'timestamp')::timestamptz;
    if v_audit->>'revision' is distinct from v_audit_revision::text or v_audit->>'actorId' is distinct from v_actor or v_audit->>'timestamp' is null
      or not ((v_audit->>'action'='posted' and exists(select 1 from public.zentra_us_erp_records r where r.organization_id=p_organization and r.kind='journal' and r.id=v_audit->>'entityId' and r.payload->>'revision'=v_audit->>'revision' and r.payload->>'postedAt'=v_audit->>'timestamp' and r.state_revision=v_new_revision))
        or (v_audit->>'action'='period_closed' and v_action='close_period' and p_receipt->>'entityId'=v_audit->>'entityId')) then
      raise exception using errcode='PU004',message='Ledger audit chain mismatch';
    end if;
    insert into public.zentra_us_erp_ledger_audit values(p_organization,v_audit_revision,v_audit,v_new_revision);
  end loop;
  if v_new_journals<>(select count(*) from jsonb_array_elements(p_ledger_audit) a where a->>'action'='posted') then
    raise exception using errcode='PU004',message='Posted journal audit required';
  end if;
  if (v_action in ('initialize','refresh_configuration') and (jsonb_array_length(p_changes)<>0 or jsonb_array_length(p_ledger_audit)<>0 or p_receipt->>'entityId' is distinct from p_organization))
    or (v_action in ('save_customer','save_estimate','accept_estimate') and (jsonb_array_length(p_changes)>1 or v_ledger_after<>v_ledger_before))
    or (v_action='issue_invoice' and (v_new_invoices<>1 or v_new_journals<>(case when v_config.config->>'accountingBasis'='accrual' and v_total>0 then 1 else 0 end)))
    or (v_action='record_payment' and (v_new_journals<>1 or (select count(*) from jsonb_array_elements(p_changes) a where a->>'kind'='invoice')<>1))
    or (v_action='close_period' and (jsonb_array_length(p_changes)<>0 or jsonb_array_length(p_ledger_audit)>1 or not exists(select 1 from jsonb_array_elements(p_header->'ledger'->'periods') p where p->>'id'=p_receipt->>'entityId' and p->>'status'='closed'))) then
    raise exception using errcode='PU004',message='Incomplete US ERP atomic operation';
  end if;
  insert into public.zentra_us_erp_receipts values(p_organization,p_receipt->>'idempotencyKey',p_receipt->>'commandHash',v_new_revision,p_receipt,v_actor,now());
  return p_receipt;
end $$;

alter table public.zentra_us_erp_heads enable row level security;
alter table public.zentra_us_erp_records enable row level security;
alter table public.zentra_us_erp_receipts enable row level security;
alter table public.zentra_us_erp_ledger_audit enable row level security;
revoke all on public.zentra_us_erp_heads,public.zentra_us_erp_records,public.zentra_us_erp_receipts,public.zentra_us_erp_ledger_audit from public,anon,authenticated;
grant select,insert,update on public.zentra_us_erp_heads,public.zentra_us_erp_records to service_role;
grant select,insert on public.zentra_us_erp_receipts,public.zentra_us_erp_ledger_audit to service_role;
create policy zentra_us_erp_heads_server on public.zentra_us_erp_heads for all to service_role using(true) with check(true);
create policy zentra_us_erp_records_server on public.zentra_us_erp_records for all to service_role using(true) with check(true);
create policy zentra_us_erp_receipts_server on public.zentra_us_erp_receipts for all to service_role using(true) with check(true);
create policy zentra_us_erp_audit_server on public.zentra_us_erp_ledger_audit for all to service_role using(true) with check(true);
revoke all on function public.zentra_us_erp_minor(jsonb),public.zentra_us_erp_journal_balanced(jsonb),public.zentra_us_erp_round_ratio(numeric,numeric),public.zentra_us_erp_line_totals(jsonb),public.zentra_us_erp_guard_history(),public.zentra_us_erp_guard_record(),public.zentra_us_erp_guard_head(),public.zentra_read_us_erp(text),public.zentra_us_erp_receipt(text,text),public.zentra_commit_us_erp(text,bigint,jsonb,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.zentra_us_erp_minor(jsonb),public.zentra_us_erp_journal_balanced(jsonb),public.zentra_us_erp_round_ratio(numeric,numeric),public.zentra_us_erp_line_totals(jsonb),public.zentra_read_us_erp(text),public.zentra_us_erp_receipt(text,text),public.zentra_commit_us_erp(text,bigint,jsonb,jsonb,jsonb,jsonb,jsonb) to service_role;
comment on table public.zentra_us_erp_heads is 'Experimental US ERP authority; separate from CH snapshot revisions; no inferred legacy data.';
comment on function public.zentra_commit_us_erp(text,bigint,jsonb,jsonb,jsonb,jsonb,jsonb) is 'Server-only atomic US ERP commit. D1 admission and trusted tax proof are mandatory gateway responsibilities; no fiscal certification.';
commit;
