-- Additive US journal/period capability4. No historical data or migration rewrite.
-- Service-only invoker RPCs, same organization/CAS/audit/event book. No tax/provider grant.
begin;

alter table public.zentra_us_erp_heads drop constraint zentra_us_erp_heads_check;
alter table public.zentra_us_erp_heads add constraint zentra_us_erp_heads_check
  check(coalesce(header->'schemaVersion' in ('1'::jsonb,'2'::jsonb,'3'::jsonb,'4'::jsonb) and header->>'revision'=revision::text,false));
alter table public.zentra_us_erp_events drop constraint zentra_us_erp_events_check;
alter table public.zentra_us_erp_events add constraint zentra_us_erp_events_check
  check(coalesce(jsonb_typeof(event)='object' and event->'schemaVersion' in ('1'::jsonb,'2'::jsonb,'3'::jsonb,'4'::jsonb)
    and event->'schemaVersion'=event->'header'->'schemaVersion' and event->>'organizationId'=organization_id
    and event->>'revision'=revision::text and event->'header'->>'revision'=revision::text
    and event->'header'->'configuration'->>'organizationId'=organization_id and event->'receipt'->>'revision'=revision::text
    and jsonb_typeof(event->'changes')='array' and jsonb_typeof(event->'ledgerAudit')='array',false));
alter table public.zentra_us_erp_ledger_audit drop constraint zentra_us_erp_ledger_audit_check;
alter table public.zentra_us_erp_ledger_audit add constraint zentra_us_erp_ledger_audit_check
  check(jsonb_typeof(payload)='object' and payload->>'revision'=revision::text
    and payload->>'action' in ('posted','period_closed','period_opened'));

-- Financial command hashes are independently reconstructed for the new
-- commands; a balanced substituted source/payload is not sufficient.
create function public.zentra_us_erp_v4_canonical(v jsonb) returns text
language plpgsql immutable security invoker set search_path='' as $$
declare result text;
begin
  if jsonb_typeof(v)='object' then
    select '{'||coalesce(string_agg(to_json(key)::text||':'||public.zentra_us_erp_v4_canonical(value),',' order by key collate "C"),'')||'}' into result from jsonb_each(v);
  elsif jsonb_typeof(v)='array' then
    select '['||coalesce(string_agg(public.zentra_us_erp_v4_canonical(value),',' order by n),'')||']' into result from jsonb_array_elements(v) with ordinality a(value,n);
  else result:=v::text;end if;
  return result;
end $$;

create function public.zentra_us_erp_v4_amount(v jsonb) returns boolean
language sql immutable security invoker set search_path='' as $$
  select coalesce(jsonb_typeof(v)='string' and v#>>'{}' ~ '^(0|[1-9][0-9]{0,35})$',false);
$$;

create function public.zentra_us_erp_v4_assert(org text,h jsonb,previous jsonb,changes jsonb,audits jsonb,receipt jsonb,actor jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare action text:=receipt->>'action';old_periods jsonb:=previous->'ledger'->'periods';periods jsonb:=h->'ledger'->'periods';p jsonb;added jsonb;
  journal jsonb;original jsonb;line jsonb;account jsonb;inverse jsonb;fingerprint jsonb;line_fingerprints jsonb;command jsonb;
  expected_audit jsonb;expected_hash text;max_end text;first_open text;past timestamp with time zone;idx integer;debits numeric:=0;credits numeric:=0;cash_movement numeric:=0;
begin
  if h->'schemaVersion' is distinct from '4'::jsonb then return;end if;
  if not public.zentra_us_tax_actor_valid(actor,org) and not (actor->>'role'='member'
    and public.zentra_us_tax_object(actor,array['organizationId','userId','role','managementEntitled','timestamp'])
    and public.zentra_us_tax_strings(actor,array['organizationId','userId','role','timestamp'])
    and actor->>'organizationId'=org and public.zentra_us_tax_text_valid(actor->>'userId',256,false)
    and actor->'managementEntitled'='true'::jsonb and public.zentra_us_purchase_timestamp(actor->>'timestamp')) then
    raise exception using errcode='PU004',message='Invalid US v4 actor';end if;
  if not public.zentra_us_purchase_timestamp(actor->>'timestamp') or not public.zentra_us_tax_object(receipt,array['idempotencyKey','commandHash','revision','entityId','action'])
    or not public.zentra_us_tax_strings(receipt,array['idempotencyKey','commandHash','entityId','action']) or receipt->'revision' is distinct from h->'revision'
    or receipt->>'idempotencyKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,231}$' then
    raise exception using errcode='PU004',message='Invalid US v4 receipt or final timestamp';end if;
  if jsonb_typeof(periods)<>'array' or jsonb_array_length(periods) not between 1 and 100 then raise exception using errcode='PU020',message='US period limit';end if;
  for p in select value from jsonb_array_elements(periods) loop
    if not public.zentra_us_tax_object(p,array['id','start','end','status']) or not public.zentra_us_tax_strings(p,array['id','start','end','status'])
      or not public.zentra_us_tax_text_valid(p->>'id',160,false) or not public.zentra_us_purchase_date(p->>'start') or not public.zentra_us_purchase_date(p->>'end')
      or p->>'start'>p->>'end' or p->>'status' not in ('open','closed') then raise exception using errcode='PU004',message='Invalid US v4 period';end if;
  end loop;
  if action='initialize' then
    if previous is not null or jsonb_array_length(changes)<>0 or jsonb_array_length(audits)<>0 or h->'counters'<>jsonb_build_object('estimate',0,'invoice',0,'project',0)
      or h->'ledger'->'revision'<>'0'::jsonb or actor->>'role'<>'owner' or receipt->>'entityId'<>org
      or exists(select 1 from jsonb_array_elements(periods) q where q->>'status'<>'open') then raise exception using errcode='PU004',message='Invalid new US v4 book';end if;
    return;
  end if;
  if previous is null then raise exception using errcode='PU004',message='Existing US book required';end if;
  if action='upgrade_accounting' then
    if previous->'schemaVersion' is distinct from '3'::jsonb or actor->>'role'<>'owner' or receipt->>'entityId'<>org
      or h-array['schemaVersion','revision'] is distinct from previous-array['schemaVersion','revision']
      or changes<>'[]'::jsonb or audits<>'[]'::jsonb then raise exception using errcode='PU016',message='Only an explicit owner schema3 upgrade is allowed';end if;
    command:=jsonb_build_object('type',action);
  else
    if previous->'schemaVersion' is distinct from '4'::jsonb then raise exception using errcode='PU016',message='Explicit accounting upgrade required';end if;
    if action not in ('open_period','close_period') and periods is distinct from old_periods then raise exception using errcode='PU003',message='Periods require their explicit command';end if;
  end if;
  if action in ('open_period','close_period','post_manual_journal','reverse_manual_journal') then
    if actor->>'role' not in ('owner','admin','accountant') or h->'counters' is distinct from previous->'counters'
      or (h->'ledger')-array['revision','periods'] is distinct from (previous->'ledger')-array['revision','periods']
      or h->'ledger'->>'revision' is distinct from ((previous->'ledger'->>'revision')::bigint+1)::text then
      raise exception using errcode='PU004',message='Invalid atomic v4 ledger transition';end if;
    select max((a.payload->>'timestamp')::timestamptz) into past from public.zentra_us_erp_ledger_audit a where a.organization_id=org and a.state_revision<(h->>'revision')::bigint;
    if past is not null and (actor->>'timestamp')::timestamptz<past then raise exception using errcode='PU004',message='Audit time cannot move backwards';end if;
  end if;
  if action='open_period' then
    if jsonb_array_length(periods)<>jsonb_array_length(old_periods)+1 or changes<>'[]'::jsonb then raise exception using errcode='PU004',message='Period must append once without records';end if;
    for idx in 0..jsonb_array_length(old_periods)-1 loop
      if periods->idx is distinct from old_periods->idx then raise exception using errcode='PU003',message='Previous period history is immutable';end if;
    end loop;
    added:=periods->(jsonb_array_length(periods)-1);
    select max(q->>'end') into max_end from jsonb_array_elements(old_periods) q;
    if added->>'id' is distinct from receipt->>'entityId' or added->>'status'<>'open' or (max_end is not null and added->>'start'<=max_end)
      or exists(select 1 from jsonb_array_elements(old_periods) q where q->>'id'=added->>'id') then raise exception using errcode='PU004',message='Period must be new and after existing dates';end if;
    expected_audit:=jsonb_build_object('revision',h->'ledger'->'revision','action','period_opened','actorId',actor->>'userId','timestamp',actor->>'timestamp','entityId',added->>'id');
    command:=jsonb_build_object('type',action,'id',added->>'id','start',added->>'start','end',added->>'end');
  elsif action='close_period' then
    select q->>'id' into first_open from jsonb_array_elements(old_periods) q where q->>'status'='open' order by q->>'start' limit 1;
    if first_open is distinct from receipt->>'entityId' or changes<>'[]'::jsonb or jsonb_array_length(periods)<>jsonb_array_length(old_periods) then
      raise exception using errcode='PU017',message='Only the oldest open period may close';end if;
    for idx in 0..jsonb_array_length(old_periods)-1 loop
      p:=old_periods->idx;
      if periods->idx is distinct from (case when p->>'id'=first_open then jsonb_set(p,'{status}','"closed"'::jsonb) else p end) then
        raise exception using errcode='PU003',message='Period closure must preserve exact history';end if;
    end loop;
    expected_audit:=jsonb_build_object('revision',h->'ledger'->'revision','action','period_closed','actorId',actor->>'userId','timestamp',actor->>'timestamp','entityId',first_open);
    command:=jsonb_build_object('type',action,'periodId',first_open);
  elsif action in ('post_manual_journal','reverse_manual_journal') then
    if jsonb_array_length(changes)<>1 or not public.zentra_us_tax_object(changes->0,array['kind','id','payload']) or changes->0->>'kind'<>'journal' then
      raise exception using errcode='PU004',message='Manual command must create one journal only';end if;
    journal:=changes->0->'payload';
    if not public.zentra_us_tax_object(journal,array['id','idempotencyKey','organizationId','currency','basis','transactionDate','accountingDate','periodId','description','source','lines','postedBy','postedAt','revision','fingerprint'],array['cashFlowCategory','reversesEntryId'])
      or not public.zentra_us_tax_strings(journal,array['id','idempotencyKey','organizationId','currency','basis','transactionDate','accountingDate','periodId','description','postedBy','postedAt','fingerprint'])
      or journal->>'organizationId'<>org or journal->>'currency'<>'USD' or journal->'basis' is distinct from h->'ledger'->'basis'
      or journal->>'id' is distinct from receipt->>'entityId' or changes->0->>'id' is distinct from journal->>'id'
      or journal->'idempotencyKey' is distinct from receipt->'idempotencyKey' or journal->'revision' is distinct from h->'ledger'->'revision'
      or journal->>'postedBy' is distinct from actor->>'userId' or journal->'postedAt' is distinct from actor->'timestamp'
      or not public.zentra_us_tax_text_valid(journal->>'id',160,false) or not public.zentra_us_tax_text_valid(journal->>'periodId',160,false)
      or not public.zentra_us_tax_text_valid(journal->>'description',2000,false)
      or not public.zentra_us_purchase_date(journal->>'transactionDate') or not public.zentra_us_purchase_date(journal->>'accountingDate')
      or not public.zentra_us_tax_object(journal->'source',array['type','id']) or not public.zentra_us_tax_strings(journal->'source',array['type','id'])
      or not public.zentra_us_tax_text_valid(journal->'source'->>'id',160,false)
      or jsonb_typeof(journal->'lines')<>'array' or jsonb_array_length(journal->'lines') not between 2 and 1000
      or exists(select 1 from public.zentra_us_erp_records r where r.organization_id=org and r.kind='journal' and (r.id=journal->>'id' or r.payload->>'idempotencyKey'=journal->>'idempotencyKey') and r.state_revision<(h->>'revision')::bigint) then
      raise exception using errcode='PU004',message='Invalid source-bound manual journal';end if;
    for line in select value from jsonb_array_elements(journal->'lines') loop
      if not public.zentra_us_tax_object(line,array['accountId','debitMinor','creditMinor'],array['description']) or not public.zentra_us_tax_strings(line,array['accountId','debitMinor','creditMinor'])
        or not public.zentra_us_tax_text_valid(line->>'accountId',160,false) or not public.zentra_us_erp_v4_amount(line->'debitMinor') or not public.zentra_us_erp_v4_amount(line->'creditMinor')
        or (line ? 'description' and (jsonb_typeof(line->'description')<>'string' or not public.zentra_us_tax_text_valid(line->>'description',2000,false))) then
        raise exception using errcode='PU004',message='Invalid manual line';end if;
      if line->>'accountId' in ('receivables','payables','tax-payable','deposits') then raise exception using errcode='PU018',message='Control account is not allowed';end if;
      select a into account from jsonb_array_elements(h->'ledger'->'accounts') a where a->>'id'=line->>'accountId';
      if account is null or ((line->>'debitMinor')::numeric>0)=((line->>'creditMinor')::numeric>0) then raise exception using errcode='PU004',message='Invalid manual amount/account';end if;
      if account->'cash'='true'::jsonb then cash_movement:=cash_movement+(line->>'debitMinor')::numeric-(line->>'creditMinor')::numeric;end if;
      debits:=debits+(line->>'debitMinor')::numeric;credits:=credits+(line->>'creditMinor')::numeric;
    end loop;
    if debits<>credits or debits<=0 or (cash_movement<>0 and not(journal ? 'cashFlowCategory')) or (journal ? 'cashFlowCategory' and (jsonb_typeof(journal->'cashFlowCategory')<>'string' or journal->>'cashFlowCategory' not in ('operating','investing','financing'))) then
      raise exception using errcode='PU004',message='Balanced journal and explicit cash category required';end if;
    if not exists(select 1 from jsonb_array_elements(old_periods) q where q->>'id'=journal->>'periodId' and q->>'status'='open' and journal->>'accountingDate' between q->>'start' and q->>'end')
      or exists(select 1 from jsonb_array_elements(old_periods) q where q->>'status'='closed' and journal->>'accountingDate'<=q->>'end') then raise exception using errcode='PU004',message='Open accounting period required';end if;
    if action='post_manual_journal' then
      if journal->'source'->>'type' is distinct from 'manual_journal' or journal ? 'reversesEntryId' then raise exception using errcode='PU004',message='Manual source required';end if;
      command:=jsonb_build_object('type',action,'id',journal->>'id','transactionDate',journal->>'transactionDate','accountingDate',journal->>'accountingDate','periodId',journal->>'periodId','description',journal->>'description','sourceReference',journal->'source'->>'id','lines',journal->'lines');
      if journal ? 'cashFlowCategory' then command:=command||jsonb_build_object('cashFlowCategory',journal->'cashFlowCategory');end if;
    else
      select r.payload into original from public.zentra_us_erp_records r where r.organization_id=org and r.kind='journal' and r.id=journal->>'reversesEntryId' and r.state_revision<(h->>'revision')::bigint;
      if original is null or original->'source'->>'type' is distinct from 'manual_journal' or journal->'source' is distinct from jsonb_build_object('type','manual_reversal','id',original->>'id')
        or journal->'cashFlowCategory' is distinct from original->'cashFlowCategory'
        or exists(select 1 from public.zentra_us_erp_records r where r.organization_id=org and r.kind='journal' and r.payload->>'reversesEntryId'=original->>'id' and r.state_revision<(h->>'revision')::bigint) then
        raise exception using errcode='PU019',message='One reversal of a manual original only';end if;
      select jsonb_agg(jsonb_build_object('accountId',l->>'accountId','debitMinor',l->>'creditMinor','creditMinor',l->>'debitMinor')||case when l ? 'description' then jsonb_build_object('description',l->'description') else '{}'::jsonb end order by n) into inverse from jsonb_array_elements(original->'lines') with ordinality a(l,n);
      if journal->'lines' is distinct from inverse then raise exception using errcode='PU019',message='Exact ordered inverse lines required';end if;
      command:=jsonb_build_object('type',action,'id',journal->>'id','entryId',original->>'id','transactionDate',journal->>'transactionDate','accountingDate',journal->>'accountingDate','periodId',journal->>'periodId','reason',journal->>'description');
    end if;
    select jsonb_agg(jsonb_build_array(l->>'accountId',l->>'debitMinor',l->>'creditMinor',l->>'description') order by n) into line_fingerprints from jsonb_array_elements(journal->'lines') with ordinality a(l,n);
    fingerprint:=jsonb_build_array(org,'USD',journal->>'basis',journal->>'transactionDate',journal->>'accountingDate',null,journal->>'periodId',journal->>'description',journal->'source'->>'type',journal->'source'->>'id',journal->>'cashFlowCategory',journal->>'reversesEntryId',line_fingerprints);
    if jsonb_typeof(journal->'fingerprint')<>'string' or journal->>'fingerprint' is distinct from public.zentra_us_erp_v4_canonical(fingerprint) then raise exception using errcode='PU004',message='Manual journal fingerprint mismatch';end if;
    expected_audit:=jsonb_build_object('revision',journal->'revision','action','posted','actorId',actor->>'userId','timestamp',actor->>'timestamp','entityId',journal->>'id');
  end if;
  if expected_audit is not null and audits is distinct from jsonb_build_array(expected_audit) then raise exception using errcode='PU004',message='Exact final actor audit required';end if;
  if command is not null then
    expected_hash:=encode(sha256(convert_to(public.zentra_us_erp_v4_canonical(jsonb_build_array(org,actor->>'userId',jsonb_build_object('idempotencyKey',receipt->>'idempotencyKey','expectedRevision',(h->>'revision')::bigint-1,'command',command))),'UTF8')),'hex');
    if receipt->>'commandHash' is distinct from expected_hash then raise exception using errcode='PU004',message='Accounting command identity mismatch';end if;
  end if;
  if audits is null or exists(select 1 from jsonb_array_elements(audits) a where not public.zentra_us_tax_object(a,array['revision','action','actorId','timestamp','entityId'])
      or a->>'actorId' is distinct from actor->>'userId' or (a->>'timestamp')::timestamptz is distinct from (actor->>'timestamp')::timestamptz)
    or exists(select 1 from jsonb_array_elements(changes) c where c->>'kind'='journal' and (c->'payload'->>'postedBy' is distinct from actor->>'userId' or (c->'payload'->>'postedAt')::timestamptz is distinct from (actor->>'timestamp')::timestamptz)) then
    raise exception using errcode='PU004',message='All new v4 journal/audit timestamps require the final actor';end if;
  if exists(select 1 from jsonb_array_elements(changes) c where c->>'kind'='journal' and
    ((c->'payload'->'source'->>'type'='manual_journal' and action<>'post_manual_journal')
      or (c->'payload'->'source'->>'type'='manual_reversal' and action<>'reverse_manual_journal'))) then
    raise exception using errcode='PU004',message='Manual journal source requires its exact command';end if;
end $$;

-- Existing branches1..3 are retained; all new effects are fenced by v4_assert.

create or replace function public.zentra_us_erp_assert_projects(org text,h jsonb,changes jsonb,receipt jsonb,actor jsonb,previous jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare v_change jsonb;p jsonb;count_projects bigint;action text:=receipt->>'action';
begin
  if previous is null and h->'schemaVersion'='4'::jsonb and action='initialize' then
    if h->'counters'->'project'<>'0'::jsonb or exists(select 1 from public.zentra_us_erp_records where organization_id=org and kind='project') then
      raise exception using errcode='PU004',message='New schema4 project registry must be empty';end if;
    return;
  end if;
  if not coalesce(h->'schemaVersion' in ('3'::jsonb,'4'::jsonb),false) or (previous is null and not(h->'schemaVersion'='4'::jsonb and action='initialize'))
    or not public.zentra_us_tax_revision(h->'counters'->'project',0) then
    raise exception using errcode='PU004',message='Projects require an existing schema3 book';end if;
  select count(*) into count_projects from public.zentra_us_erp_records where organization_id=org and kind='project';
  if h->'counters'->'project' is distinct from to_jsonb(count_projects)
    or exists(select 1 from public.zentra_us_erp_records r where r.organization_id=org and r.kind='project'
      and (not public.zentra_us_project_valid(r.payload,org) or (r.payload->>'revision')::bigint>(h->>'revision')::bigint or substring(r.payload->>'number' from 5)::numeric>count_projects
        or not exists(select 1 from public.zentra_us_erp_records customer where customer.organization_id=org and customer.kind='customer' and customer.id=r.payload->>'customerId'))) then
    raise exception using errcode='PU004',message='Invalid project registry or counter';end if;
  if exists(select 1 from public.zentra_us_erp_records d left join public.zentra_us_erp_records project on project.organization_id=d.organization_id and project.kind='project' and project.id=d.payload->>'projectId'
    where d.organization_id=org and d.kind in ('estimate','invoice') and d.payload ? 'projectId' and project.id is null) then
    raise exception using errcode='PU009',message='Legacy project references require explicit review';end if;
  if exists(select 1 from public.zentra_us_erp_records d join public.zentra_us_erp_records project on project.organization_id=d.organization_id and project.kind='project' and project.id=d.payload->>'projectId'
    where d.organization_id=org and d.kind in ('estimate','invoice') and project.payload->>'customerId' is distinct from d.payload->'customer'->>'id') then
    raise exception using errcode='PU011',message='Project customer is locked by its documents';end if;
  if exists(select 1 from public.zentra_us_erp_records project cross join lateral jsonb_array_elements_text(project.payload->'vendorBillIds') b
    where project.organization_id=org and project.kind='project' and not exists(select 1 from public.zentra_us_erp_records bill where bill.organization_id=org and bill.kind='vendor_bill' and bill.id=b)) then
    raise exception using errcode='PU004',message='Project purchase reference is unavailable';end if;
  if exists(select 1 from public.zentra_us_erp_records project cross join lateral jsonb_array_elements_text(project.payload->'vendorBillIds') b
    where project.organization_id=org and project.kind='project' group by b having count(*)>1) then
    raise exception using errcode='PU012',message='Purchase belongs to one project only';end if;
  if action='save_projects' then
    if not public.zentra_us_tax_actor_valid(actor,org) or not public.zentra_us_purchase_timestamp(actor->>'timestamp')
      or not public.zentra_us_tax_object(receipt,array['idempotencyKey','commandHash','revision','entityId','action'])
      or not public.zentra_us_tax_strings(receipt,array['idempotencyKey','commandHash','entityId','action'])
      or receipt->'revision' is distinct from h->'revision' or receipt->>'idempotencyKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,231}$'
      or jsonb_array_length(changes) not between 1 and 1000
      or not exists(select 1 from jsonb_array_elements(changes) x where x->>'id'=receipt->>'entityId')
      or h->'ledger' is distinct from previous->'ledger'
      or (h->'counters')-'project' is distinct from (previous->'counters')-'project' then
      raise exception using errcode='PU004',message='Invalid project atomic operation';end if;
    for v_change in select value from jsonb_array_elements(changes) loop
      p:=v_change->'payload';
      if not public.zentra_us_tax_object(v_change,array['kind','id','payload']) or v_change->>'kind' is distinct from 'project'
        or v_change->>'id' is distinct from p->>'id' or not public.zentra_us_project_valid(p,org)
        or (p->>'updatedAt')::timestamptz is distinct from (actor->>'timestamp')::timestamptz
        or not exists(select 1 from public.zentra_us_erp_records r where r.organization_id=org and r.kind='project' and r.id=v_change->>'id' and r.payload=p and r.state_revision=(h->>'revision')::bigint) then
        raise exception using errcode='PU004',message='Project must match its exact committed operation';end if;
    end loop;
  elsif h->'counters'->'project' is distinct from previous->'counters'->'project'
    or exists(select 1 from jsonb_array_elements(changes) c where c->>'kind'='project') then
    raise exception using errcode='PU004',message='Only explicit project commands change the registry';end if;
end $$;

create or replace function public.zentra_us_erp_guard_header_shape() returns trigger
language plpgsql security invoker set search_path='' as $$
declare v_header jsonb:=new.header; v_ledger jsonb; v_item jsonb;
begin
  if jsonb_typeof(v_header) is distinct from 'object' or not(v_header ?& array['schemaVersion','revision','configuration','counters','ledger'])
    or v_header-array['schemaVersion','revision','configuration','counters','ledger']<>'{}'::jsonb
    or jsonb_typeof(v_header->'counters') is distinct from 'object' or not(v_header->'counters' ?& array['estimate','invoice'])
    or (v_header->'schemaVersion' in ('3'::jsonb,'4'::jsonb) and (not(v_header->'counters' ? 'project') or not public.zentra_us_tax_revision(v_header->'counters'->'project',0)))
    or (v_header->'counters')-(case when v_header->'schemaVersion' in ('3'::jsonb,'4'::jsonb) then array['estimate','invoice','project'] else array['estimate','invoice'] end)<>'{}'::jsonb then
    raise exception using errcode='PU004',message='US ERP header shape is not supported';
  end if;
  v_ledger:=v_header->'ledger';
  if jsonb_typeof(v_ledger) is distinct from 'object' or not(v_ledger ?& array['organizationId','currency','basis','revision','accounts','periods'])
    or v_ledger-array['organizationId','currency','basis','revision','accounts','periods']<>'{}'::jsonb
    or jsonb_typeof(v_ledger->'accounts') is distinct from 'array' or jsonb_typeof(v_ledger->'periods') is distinct from 'array' then
    raise exception using errcode='PU004',message='US ERP ledger header shape is not supported';
  end if;
  for v_item in select value from jsonb_array_elements(v_ledger->'accounts') loop
    if jsonb_typeof(v_item) is distinct from 'object' or not(v_item ?& array['id','code','name','type'])
      or v_item-array['id','code','name','type','cash']<>'{}'::jsonb then
      raise exception using errcode='PU004',message='US ERP account shape is not supported';
    end if;
  end loop;
  for v_item in select value from jsonb_array_elements(v_ledger->'periods') loop
    if jsonb_typeof(v_item) is distinct from 'object' or not(v_item ?& array['id','start','end','status'])
      or v_item-array['id','start','end','status']<>'{}'::jsonb then
      raise exception using errcode='PU004',message='US ERP period shape is not supported';
    end if;
  end loop;
  return new;
end $$;

create or replace function public.zentra_us_erp_assert_purchase(org text,h jsonb,changes jsonb,receipt jsonb,actor jsonb,new_revision bigint,ledger_before bigint) returns void
language plpgsql security invoker set search_path='' as $$
declare action text:=receipt->>'action'; purchase_kind text;entity jsonb;bill jsonb;vendor jsonb;journal jsonb;expected jsonb;fingerprint jsonb;
  total numeric;paid numeric;amount numeric;period jsonb;entry_input jsonb;line_fingerprints jsonb;expected_count integer;
begin
  purchase_kind:=case action when 'save_vendor' then 'vendor' when 'record_vendor_bill' then 'vendor_bill' when 'record_vendor_payment' then 'vendor_payment' else null end;
  if purchase_kind is null then raise exception using errcode='PU004',message='Unsupported purchasing operation';end if;
  if not public.zentra_us_tax_object(receipt,array['idempotencyKey','commandHash','revision','entityId','action'])
    or not public.zentra_us_tax_strings(receipt,array['idempotencyKey','commandHash','entityId','action'])
    or receipt->'revision' is distinct from to_jsonb(new_revision) then
    raise exception using errcode='PU004',message='Purchasing receipt requires its exact public shape';end if;
  if not public.zentra_us_tax_actor_valid(actor,org) or h->'schemaVersion' not in ('2'::jsonb,'3'::jsonb,'4'::jsonb)
    or (select count(*) from jsonb_array_elements(changes) c where c->>'kind'=purchase_kind)<>1
    or exists(select 1 from jsonb_array_elements(changes) c where c->>'kind' not in (purchase_kind,'journal')) then
    raise exception using errcode='PU004',message='Invalid purchasing authority or changes';end if;
  select c->'payload' into entity from jsonb_array_elements(changes) c where c->>'kind'=purchase_kind;
  if entity->>'id' is distinct from receipt->>'entityId' or not coalesce(public.zentra_us_purchase_payload(purchase_kind,entity,org,new_revision),false) then
    raise exception using errcode='PU004',message='Invalid purchasing payload';end if;
  if purchase_kind='vendor' then
    if jsonb_array_length(changes)<>1 or (h->'ledger'->>'revision')::bigint<>ledger_before then raise exception using errcode='PU004',message='Vendor edit cannot post accounting';end if;
    return;
  end if;
  if exists(select 1 from public.zentra_us_erp_records r where r.organization_id=org and r.kind=purchase_kind and r.id=entity->>'id' and r.state_revision<new_revision) then
    raise exception using errcode='PU003',message='Purchasing financial records are immutable';end if;
  select p into period from jsonb_array_elements(h->'ledger'->'periods') p where p->>'id'=entity->>'periodId';
  if period is null or period->>'status' is distinct from 'open' or entity->>'accountingDate'<period->>'start' or entity->>'accountingDate'>period->>'end'
    or exists(select 1 from jsonb_array_elements(h->'ledger'->'periods') p where p->>'status'='closed' and entity->>'accountingDate'<=p->>'end') then
    raise exception using errcode='PU004',message='Purchasing accounting period is closed or missing';end if;
  if not exists(select 1 from jsonb_array_elements(h->'ledger'->'accounts') a where a->>'id'='purchases' and a->>'type'='expense' and a->'cash' is distinct from 'true'::jsonb)
    or not exists(select 1 from jsonb_array_elements(h->'ledger'->'accounts') a where a->>'id'='payables' and a->>'type'='liability') then
    raise exception using errcode='PU004',message='Purchasing chart mappings required';end if;
  if purchase_kind='vendor_bill' then
    select payload into vendor from public.zentra_us_erp_records r where r.organization_id=org and r.kind='vendor' and r.id=entity->>'vendorId' and r.state_revision<new_revision;
    -- A later edit in the same transaction must not replace the supplier that
    -- this immutable bill actually saw. Captured events retain that snapshot.
    if vendor is null then
      select c->'payload' into vendor from public.zentra_us_erp_events e,
        lateral jsonb_array_elements(e.event->'changes') c where e.organization_id=org and e.revision<new_revision
        and c->>'kind'='vendor' and c->>'id'=entity->>'vendorId' order by e.revision desc limit 1;
    end if;
    if vendor is distinct from entity->'vendorSnapshot' or entity->>'validatedBy' is distinct from actor->>'userId' or entity->>'approvedAt' is distinct from actor->>'timestamp' then
      raise exception using errcode='PU004',message='Vendor snapshot and manual approval must match';end if;
    bill:=entity;amount:=public.zentra_us_erp_minor(bill->'total'->'minorUnits');
    expected_count:=case when h->'ledger'->>'basis'='accrual' then 1 else 0 end;
    expected:=jsonb_build_array(jsonb_build_object('accountId','purchases','debitMinor',amount::text,'creditMinor','0'),jsonb_build_object('accountId','payables','debitMinor','0','creditMinor',amount::text));
    entry_input:=jsonb_build_object('id','entry:vendor-bill:'||(bill->>'id'),'idempotencyKey','vendor-bill:'||(bill->>'id'),'organizationId',org,'currency','USD','basis',h->'ledger'->>'basis','transactionDate',bill->>'date','accountingDate',bill->>'accountingDate','periodId',bill->>'periodId','description','Vendor bill '||(bill->>'reference'),'source',jsonb_build_object('type','vendor_bill','id',bill->>'id'),'lines',expected);
  else
    select payload into bill from public.zentra_us_erp_records r where r.organization_id=org and r.kind='vendor_bill' and r.id=entity->>'billId' and r.state_revision<new_revision;
    if bill is null or entity->>'recordedBy' is distinct from actor->>'userId' or entity->>'recordedAt' is distinct from actor->>'timestamp' or entity->>'idempotencyKey' is distinct from receipt->>'idempotencyKey' then
      raise exception using errcode='PU004',message='Payment scope and manual approval must match';end if;
    total:=public.zentra_us_erp_minor(bill->'total'->'minorUnits');amount:=public.zentra_us_erp_minor(entity->'amount'->'minorUnits');
    select coalesce(sum(public.zentra_us_erp_minor(payload->'amount'->'minorUnits')),0) into paid from public.zentra_us_erp_records r where r.organization_id=org and r.kind='vendor_payment' and r.payload->>'billId'=bill->>'id' and r.state_revision<new_revision;
    if paid+amount>total then raise exception using errcode='PU004',message='Vendor payment exceeds durable balance';end if;
    if h->'ledger'->>'basis'='accrual' and not exists(select 1 from public.zentra_us_erp_records r where r.organization_id=org and r.kind='journal' and r.payload->'source'=jsonb_build_object('type','vendor_bill','id',bill->>'id')) then
      raise exception using errcode='PU004',message='Accrual vendor posting required';end if;
    expected_count:=1;
    expected:=jsonb_build_array(jsonb_build_object('accountId',case when h->'ledger'->>'basis'='accrual' then 'payables' else 'purchases' end,'debitMinor',amount::text,'creditMinor','0'),jsonb_build_object('accountId','cash','debitMinor','0','creditMinor',amount::text,'description',entity->>'id'));
    entry_input:=jsonb_build_object('id','entry:vendor-payment:'||(entity->>'idempotencyKey'),'idempotencyKey','vendor-payment:'||(entity->>'idempotencyKey'),'organizationId',org,'currency','USD','basis',h->'ledger'->>'basis','transactionDate',entity->>'paymentDate','accountingDate',entity->>'accountingDate','paymentDate',entity->>'paymentDate','periodId',entity->>'periodId','cashFlowCategory','operating','description','Payment '||(bill->>'reference'),'source',jsonb_build_object('type','vendor_payment','id',bill->>'id'),'lines',expected);
  end if;
  if (select count(*) from jsonb_array_elements(changes) c where c->>'kind'='journal')<>expected_count or jsonb_array_length(changes)<>expected_count+1
    or (h->'ledger'->>'revision')::bigint<>ledger_before+expected_count then
    raise exception using errcode='PU004',message='Incomplete purchasing journal effect';end if;
  if expected_count=0 then return;end if;
  select c->'payload' into journal from jsonb_array_elements(changes) c where c->>'kind'='journal';
  if journal-array['postedBy','postedAt','revision','fingerprint'] is distinct from entry_input or journal->>'postedBy' is distinct from actor->>'userId'
    or journal->>'postedAt' is distinct from actor->>'timestamp' or journal->'revision' is distinct from to_jsonb(ledger_before+1)
    or jsonb_typeof(journal->'fingerprint') is distinct from 'string' or octet_length(journal->>'fingerprint')>8192 then
    raise exception using errcode='PU004',message='Purchasing journal must match its exact financial effect';end if;
  select jsonb_agg(jsonb_build_array(l->>'accountId',l->>'debitMinor',l->>'creditMinor',l->>'description') order by n) into line_fingerprints from jsonb_array_elements(expected) with ordinality l(l,n);
  fingerprint:=jsonb_build_array(org,'USD',entry_input->>'basis',entry_input->>'transactionDate',entry_input->>'accountingDate',entry_input->>'paymentDate',entry_input->>'periodId',entry_input->>'description',entry_input->'source'->>'type',entry_input->'source'->>'id',entry_input->>'cashFlowCategory',null,line_fingerprints);
  if (journal->>'fingerprint')::jsonb is distinct from fingerprint then raise exception using errcode='PU004',message='Purchasing journal fingerprint mismatch';end if;
end $$;

create or replace function public.zentra_commit_us_erp(p_organization text,p_expected_revision bigint,p_header jsonb,p_changes jsonb,p_ledger_audit jsonb,p_receipt jsonb,p_actor jsonb) returns jsonb
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
  if p_receipt->>'action' in ('save_vendor','record_vendor_bill','record_vendor_payment') and not public.zentra_us_purchase_timestamp(p_actor->>'timestamp') then
    raise exception using errcode='PU004',message='Invalid purchasing authority timestamp';end if;
  v_actor:=p_actor->>'userId'; perform (p_actor->>'timestamp')::timestamptz;
  if jsonb_typeof(p_receipt) is distinct from 'object' or coalesce(length(p_receipt->>'idempotencyKey'),0) not between 1 and 240
    or p_receipt->>'commandHash' is null or p_receipt->>'commandHash' !~ '^[0-9a-f]{64}$'
    or coalesce(length(p_receipt->>'entityId'),0) not between 1 and 512
    or p_receipt->>'action' is null or p_receipt->>'action' not in ('initialize','refresh_configuration','save_customer','save_estimate','accept_estimate','issue_invoice','record_payment','close_period','save_vendor','record_vendor_bill','record_vendor_payment','save_projects','upgrade_accounting','open_period','post_manual_journal','reverse_manual_journal') then
    raise exception using errcode='PU004',message='Invalid US ERP receipt';
  end if;
  v_action:=p_receipt->>'action';
  if v_action in ('save_vendor','record_vendor_bill','record_vendor_payment') and
    (not public.zentra_us_tax_object(p_receipt,array['idempotencyKey','commandHash','revision','entityId','action'])
      or not public.zentra_us_tax_strings(p_receipt,array['idempotencyKey','commandHash','entityId','action'])
      or not public.zentra_us_tax_revision(p_receipt->'revision')
      or p_receipt->>'idempotencyKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$') then
    raise exception using errcode='PU004',message='Purchasing receipt must use its exact public shape';end if;
  -- Recheck the operation permission even when returning an earlier receipt.
  if (v_action in ('initialize','refresh_configuration','upgrade_accounting') and p_actor->>'role'<>'owner') or (v_action in ('issue_invoice','record_payment','close_period','save_vendor','record_vendor_bill','record_vendor_payment','save_projects','upgrade_accounting','open_period','post_manual_journal','reverse_manual_journal') and p_actor->>'role' not in ('owner','admin','accountant')) then
    raise exception using errcode='PU004',message='US ERP operation permission required';
  end if;
  -- Existing snapshot head only supplies a tenant lock. Its revision is never changed.
  perform 1 from public.zentra_workspaces where organization_id=p_organization for update;
  if not found then raise exception using errcode='PU005',message='Workspace not available'; end if;
  select * into v_config from public.zentra_workspace_country_configs where organization_id=p_organization for update;
  if not found or v_config.country<>'US' or v_config.currency<>'USD' then
    raise exception using errcode='PU005',message='Explicit US country configuration required';
  end if;
  select * into v_head from public.zentra_us_erp_heads where organization_id=p_organization for update;
  if v_head.header->'schemaVersion'='4'::jsonb and p_header->'schemaVersion' is distinct from '4'::jsonb then
    raise exception using errcode='PU008',message='Accounting capability4 required before historical replay';end if;
  if (v_head.header->'schemaVersion' in ('3'::jsonb,'4'::jsonb) and not coalesce(p_header->'schemaVersion' in ('3'::jsonb,'4'::jsonb),false))
    or (v_head.header->'schemaVersion'='2'::jsonb and not coalesce(p_header->'schemaVersion' in ('2'::jsonb,'3'::jsonb,'4'::jsonb),false)) then
    raise exception using errcode='PU008',message='US ERP schema upgrade required';
  end if;
  select * into v_saved from public.zentra_us_erp_receipts where organization_id=p_organization and idempotency_key=p_receipt->>'idempotencyKey';
  if found then
    if v_saved.command_hash is distinct from p_receipt->>'commandHash' or v_saved.actor_id is distinct from v_actor
      or v_saved.receipt->>'entityId' is distinct from p_receipt->>'entityId' or v_saved.receipt->>'action' is distinct from p_receipt->>'action' then
      raise exception using errcode='PU002',message='US ERP idempotency conflict';
    end if;
    return v_saved.receipt;
  end if;
  if coalesce(v_head.revision,0)<>p_expected_revision then raise exception using errcode='PU001',message='US ERP revision conflict'; end if;
  v_new_revision:=p_expected_revision+1;
  if (v_head.organization_id is null) <> (v_action='initialize') then raise exception using errcode='PU004',message='US ERP initialization state conflict'; end if;
  if p_header->'configuration' is distinct from v_config.config
    or (v_head.organization_id is not null and v_action<>'refresh_configuration' and p_header->'configuration' is distinct from v_head.header->'configuration') then
    raise exception using errcode='PU006',message='US ERP configuration changed';
  end if;
  if jsonb_typeof(p_header) is distinct from 'object' or p_header->'schemaVersion' not in ('1'::jsonb,'2'::jsonb,'3'::jsonb,'4'::jsonb)
    or p_header->>'revision' is distinct from v_new_revision::text or p_receipt->>'revision' is distinct from v_new_revision::text
    or jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes)>(case when v_action='save_projects' then 1000 else 20 end)
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
  if (v_action='initialize' and not coalesce(p_header->'schemaVersion' in ('1'::jsonb,'4'::jsonb),false))
    or (v_head.header->'schemaVersion'='1'::jsonb and p_header->'schemaVersion'='2'::jsonb and v_action not in ('save_vendor','record_vendor_bill','record_vendor_payment'))
    or (v_action in ('save_vendor','record_vendor_bill','record_vendor_payment') and p_header->'schemaVersion' not in ('2'::jsonb,'3'::jsonb,'4'::jsonb))
    or (p_header->'schemaVersion' in ('3'::jsonb,'4'::jsonb) and v_head.header->'schemaVersion' not in ('3'::jsonb,'4'::jsonb) and v_action<>'save_projects')
    or (v_action='save_projects' and not coalesce(p_header->'schemaVersion' in ('3'::jsonb,'4'::jsonb),false)) then
    raise exception using errcode='PU004',message='Only purchasing may promote an existing US ERP book';
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
      if (not found and not (v_action='open_period' and p_header->'schemaVersion'='4'::jsonb and v_period->>'id'=p_receipt->>'entityId')) or (found and v_period-'status' is distinct from v_old_period-'status')
        or (found and v_period->>'status' is distinct from v_old_period->>'status' and not (v_action='close_period' and v_old_period->>'status'='open' and v_period->>'status'='closed' and p_receipt->>'entityId'=v_period->>'id')) then
        raise exception using errcode='PU003',message='Accounting periods cannot be replaced or reopened';
      end if;
    end if;
  end loop;
  if v_head.organization_id is not null and jsonb_array_length(p_header->'ledger'->'periods')<>jsonb_array_length(v_head.header->'ledger'->'periods')+(case when v_action='open_period' and p_header->'schemaVersion'='4'::jsonb then 1 else 0 end) then
    raise exception using errcode='PU003',message='Accounting periods cannot be removed';
  end if;
  perform public.zentra_us_erp_v4_assert(p_organization,p_header,v_head.header,p_changes,p_ledger_audit,p_receipt,p_actor);
  insert into public.zentra_us_erp_heads values(p_organization,v_new_revision,p_header,v_actor,now())
    on conflict(organization_id) do update set revision=excluded.revision,header=excluded.header,updated_by=excluded.updated_by,updated_at=excluded.updated_at;
  if (select count(*)<>count(distinct (value->>'kind',value->>'id')) from jsonb_array_elements(p_changes)) then
    raise exception using errcode='PU004',message='Duplicate record changes';
  end if;
  if v_action in ('save_vendor','record_vendor_bill','record_vendor_payment') then
    if exists(select 1 from jsonb_array_elements(p_ledger_audit) a where
      not public.zentra_us_tax_object(a,array['revision','action','actorId','timestamp','entityId'])
      or not public.zentra_us_tax_strings(a,array['action','actorId','timestamp','entityId'])
      or a->>'action' is distinct from 'posted' or not public.zentra_us_tax_revision(a->'revision')) then
      raise exception using errcode='PU004',message='Purchasing audit must use its exact public shape';end if;
    perform public.zentra_us_erp_assert_purchase(p_organization,p_header,p_changes,p_receipt,p_actor,v_new_revision,v_ledger_before);
  end if;
  for v_change in select value from jsonb_array_elements(p_changes) loop
    v_kind:=v_change->>'kind'; v_id:=v_change->>'id'; v_payload:=v_change->'payload';
    if v_kind is null or v_kind not in ('customer','estimate','invoice','journal','vendor','vendor_bill','vendor_payment','project') or coalesce(length(v_id),0) not between 1 and 512
      or jsonb_typeof(v_payload) is distinct from 'object' or v_payload->>'organizationId' is distinct from p_organization or v_payload->>'id' is distinct from v_id then
      raise exception using errcode='PU004',message='Invalid scoped record change';
    end if;
    select payload into v_previous from public.zentra_us_erp_records where organization_id=p_organization and kind=v_kind and id=v_id;
    if v_kind='project' then
      if v_action<>'save_projects' then raise exception using errcode='PU004',message='Project requires its exact operation';end if;
    elsif v_kind in ('vendor','vendor_bill','vendor_payment') then
      if v_action is distinct from (case v_kind when 'vendor' then 'save_vendor' when 'vendor_bill' then 'record_vendor_bill' else 'record_vendor_payment' end) then
        raise exception using errcode='PU004',message='Purchasing record requires its exact operation';
      end if;
    elsif v_kind='customer' then
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
      if v_action not in ('issue_invoice','record_payment','record_vendor_bill','record_vendor_payment','post_manual_journal','reverse_manual_journal') or v_previous is not null or v_payload->>'currency' is distinct from 'USD'
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
  if p_header->'schemaVersion' in ('3'::jsonb,'4'::jsonb) then
    perform public.zentra_us_erp_assert_projects(p_organization,p_header,p_changes,p_receipt,p_actor,v_head.header);
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
        or (v_audit->>'action'='period_closed' and v_action='close_period' and p_receipt->>'entityId'=v_audit->>'entityId')
        or (v_audit->>'action'='period_opened' and v_action='open_period' and p_header->'schemaVersion'='4'::jsonb and p_receipt->>'entityId'=v_audit->>'entityId')) then
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
  insert into public.zentra_us_erp_receipts values(p_organization,p_receipt->>'idempotencyKey',p_receipt->>'commandHash',v_new_revision,p_receipt,v_actor,
    case when p_header->'schemaVersion' in ('2'::jsonb,'3'::jsonb,'4'::jsonb) then (p_actor->>'timestamp')::timestamptz else now() end);
  return p_receipt;
end $$;

create or replace function public.zentra_us_erp_guard_purchasing_scope() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if tg_table_name='zentra_us_erp_heads' then
    if tg_op='UPDATE' and (old.header->>'schemaVersion')::integer>(new.header->>'schemaVersion')::integer then
      raise exception using errcode='PU008',message='US ERP schema cannot be downgraded';end if;
  elsif (new.kind in ('vendor','vendor_bill','vendor_payment') or (new.kind='journal' and new.payload->'source'->>'type' in ('vendor_bill','vendor_payment'))) and not exists(select 1 from public.zentra_us_erp_heads h where h.organization_id=new.organization_id and h.header->'schemaVersion' in ('2'::jsonb,'3'::jsonb,'4'::jsonb) and h.revision=new.state_revision) then
    raise exception using errcode='PU004',message='Purchasing records require the exact schema2 head';
  end if;
  return new;
end $$;

create or replace function public.zentra_us_erp_guard_purchasing_complete() returns trigger
language plpgsql security invoker set search_path='' as $$
declare org text;rev bigint;e jsonb;r public.zentra_us_erp_receipts%rowtype;entity jsonb;actor jsonb;before_ledger bigint;
begin
  org:=new.organization_id;
  if tg_table_name='zentra_us_erp_heads' then
    if new.header->'schemaVersion' not in ('2'::jsonb,'3'::jsonb,'4'::jsonb) then return new;end if;
    rev:=new.revision;
  else
    if new.kind not in ('vendor','vendor_bill','vendor_payment') and not (new.kind='journal' and new.payload->'source'->>'type' in ('vendor_bill','vendor_payment')) then return new;end if;
    rev:=new.state_revision;
  end if;
  select event into e from public.zentra_us_erp_events where organization_id=org and revision=rev;
  select * into r from public.zentra_us_erp_receipts where organization_id=org and revision=rev;
  if e is null or e->'header'->'schemaVersion' not in ('2'::jsonb,'3'::jsonb,'4'::jsonb) or e->'receipt' is distinct from r.receipt then
    raise exception using errcode='PU004',message='Purchasing completion requires immutable event and receipt';end if;
  if tg_table_name='zentra_us_erp_heads' then
    if (tg_op='INSERT' and not(new.header->'schemaVersion'='4'::jsonb and r.receipt->>'action'='initialize')) or e->'header' is distinct from new.header or (tg_op='UPDATE' and old.header->'schemaVersion'='1'::jsonb and new.header->'schemaVersion'='2'::jsonb and r.receipt->>'action' not in ('save_vendor','record_vendor_bill','record_vendor_payment')) then
      raise exception using errcode='PU004',message='Schema2 promotion requires a purchasing receipt';end if;
  else
    if r.receipt->>'action' is distinct from (case new.kind when 'vendor' then 'save_vendor' when 'vendor_bill' then 'record_vendor_bill' when 'vendor_payment' then 'record_vendor_payment'
      else case new.payload->'source'->>'type' when 'vendor_bill' then 'record_vendor_bill' else 'record_vendor_payment' end end)
      or not exists(select 1 from jsonb_array_elements(e->'changes') c where c->>'kind'=new.kind and c->>'id'=new.id and c->'payload'=new.payload) then
      raise exception using errcode='PU004',message='Purchasing record must match its exact captured operation';end if;
  end if;
  if r.receipt->>'action' in ('save_vendor','record_vendor_bill','record_vendor_payment') then
    if tg_table_name='zentra_us_erp_heads' then
      if (new.header->'ledger'->>'revision')::bigint is distinct from (old.header->'ledger'->>'revision')::bigint+jsonb_array_length(e->'ledgerAudit')
        or new.header->'counters' is distinct from old.header->'counters' then
        raise exception using errcode='PU004',message='Purchasing counters and ledger must match the previous head';end if;
    end if;
    if exists(select 1 from jsonb_array_elements(e->'ledgerAudit') a where
        not public.zentra_us_tax_object(a,array['revision','action','actorId','timestamp','entityId'])
        or a->>'action' is distinct from 'posted' or a->>'actorId' is distinct from r.actor_id
        or not exists(select 1 from jsonb_array_elements(e->'changes') c where c->>'kind'='journal'
          and c->>'id'=a->>'entityId' and c->'payload'->'revision'=a->'revision' and c->'payload'->>'postedAt'=a->>'timestamp')) then
      raise exception using errcode='PU004',message='Purchasing audit must match its exact journal and previous head';end if;
    select c->'payload' into entity from jsonb_array_elements(e->'changes') c where c->>'kind'=case r.receipt->>'action' when 'save_vendor' then 'vendor' when 'record_vendor_bill' then 'vendor_bill' else 'vendor_payment' end;
    if r.receipt->>'action' in ('record_vendor_bill','record_vendor_payment') and r.created_at is distinct from
      (case r.receipt->>'action' when 'record_vendor_bill' then entity->>'approvedAt' else entity->>'recordedAt' end)::timestamptz then
      raise exception using errcode='PU004',message='Purchasing event instant must match financial approval';end if;
    actor:=jsonb_build_object('organizationId',org,'userId',r.actor_id,'role','owner','managementEntitled',true,
      'timestamp',case r.receipt->>'action' when 'record_vendor_bill' then entity->>'approvedAt' when 'record_vendor_payment' then entity->>'recordedAt' else to_char(r.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end);
    before_ledger:=(e->'header'->'ledger'->>'revision')::bigint-jsonb_array_length(e->'ledgerAudit');
    perform public.zentra_us_erp_assert_purchase(org,e->'header',e->'changes',r.receipt,actor,rev,before_ledger);
  end if;
  return new;
end $$;

create or replace function public.zentra_us_erp_guard_project_record() returns trigger
language plpgsql security invoker set search_path='' as $$
declare h jsonb;p jsonb;prior jsonb;
begin
  if tg_op='DELETE' then
    if old.kind='project' then raise exception using errcode='PU003',message='Project history cannot be removed';end if;
    return old;
  end if;
  select header into h from public.zentra_us_erp_heads where organization_id=new.organization_id;
  if new.kind='project' then
    if not coalesce(h->'schemaVersion' in ('3'::jsonb,'4'::jsonb),false) or h->>'revision' is distinct from new.state_revision::text
      or not public.zentra_us_project_valid(new.payload,new.organization_id) then
      raise exception using errcode='PU004',message='Project requires the exact schema3 head';end if;
    if tg_op='UPDATE' then prior:=old.payload;
    else select payload into prior from public.zentra_us_erp_records where organization_id=new.organization_id and kind='project' and id=new.id;end if;
    -- INSERT ... ON CONFLICT runs INSERT triggers before the UPDATE branch.
    -- Validate its existing row too, rather than mistaking a replayed CAS update
    -- for a new project with initial revision1.
    if prior is not null then
      if new.payload->>'revision' is distinct from ((prior->>'revision')::bigint+1)::text
        or new.payload->'number' is distinct from prior->'number' or new.payload->'createdAt' is distinct from prior->'createdAt'
        or (new.payload->>'updatedAt')::timestamptz<(prior->>'updatedAt')::timestamptz then
        raise exception using errcode='PU010',message='Project revision conflict';end if;
      if new.payload->'customerId' is distinct from prior->'customerId' and exists(select 1 from public.zentra_us_erp_records d where d.organization_id=new.organization_id and d.kind in ('estimate','invoice') and d.payload->>'projectId'=new.id) then
        raise exception using errcode='PU011',message='Project customer is locked by its documents';end if;
    elsif new.payload->'revision'<>'1'::jsonb or (new.payload->>'createdAt')::timestamptz is distinct from (new.payload->>'updatedAt')::timestamptz then
      raise exception using errcode='PU004',message='New project requires initial revision and creation instant';
    end if;
  elsif h->'schemaVersion' in ('3'::jsonb,'4'::jsonb) and new.kind='estimate' and new.payload ? 'projectId' then
    select payload into p from public.zentra_us_erp_records project where project.organization_id=new.organization_id and project.kind='project' and project.id=new.payload->>'projectId';
    if p is null then raise exception using errcode='PU015',message='Project not available';end if;
    if p->>'customerId' is distinct from new.payload->'customer'->>'id' then raise exception using errcode='PU014',message='Project customer mismatch';end if;
    -- Accepted documents and their immutable invoice conversion remain valid
    -- after archival. New or edited drafts require an active actual project.
    if new.payload->>'status'='draft' and p->>'status'<>'active' then raise exception using errcode='PU013',message='Project is archived';end if;
  end if;
  return new;
end $$;

create or replace function public.zentra_us_erp_guard_project_complete() returns trigger
language plpgsql security invoker set search_path='' as $$
declare org text;rev bigint;h jsonb;e jsonb;r public.zentra_us_erp_receipts%rowtype;actor jsonb;previous jsonb;
begin
  org:=new.organization_id;
  if tg_table_name='zentra_us_erp_heads' then
    if new.header->'schemaVersion' not in ('3'::jsonb,'4'::jsonb) then return new;end if;
    if tg_op='INSERT' and not(new.header->'schemaVersion'='4'::jsonb) then raise exception using errcode='PU004',message='A project book requires explicit promotion';end if;
    rev:=new.revision;h:=new.header;previous:=case when tg_op='INSERT' then null else old.header end;
  else
    select header into h from public.zentra_us_erp_heads where organization_id=org;
    if h->'schemaVersion' not in ('3'::jsonb,'4'::jsonb) then return new;end if;
    rev:=new.state_revision;
    select event->'header' into previous from public.zentra_us_erp_events where organization_id=org and revision=rev-1;
  end if;
  select event into e from public.zentra_us_erp_events where organization_id=org and revision=rev;
  select * into r from public.zentra_us_erp_receipts where organization_id=org and revision=rev;
  if e is null or r.revision is null or e->'header' is distinct from h or e->'receipt' is distinct from r.receipt
    or (r.receipt->>'action'='save_projects' and e->'ledgerAudit' is distinct from '[]'::jsonb)
    or (h->'schemaVersion' in ('3'::jsonb,'4'::jsonb) and previous->'schemaVersion' not in ('3'::jsonb,'4'::jsonb) and r.receipt->>'action' not in ('save_projects','initialize','upgrade_accounting')) then
    raise exception using errcode='PU004',message='Project completion requires the exact immutable operation';end if;
  if tg_table_name='zentra_us_erp_records' then
    -- The head trigger validates the entire registry once. Each changed row
    -- must still be in its exact immutable event, including direct writes.
    -- Do not run the batch-wide validator once per project in a 1000-row batch.
    if not exists(select 1 from jsonb_array_elements(e->'changes') c where c->>'kind'=new.kind and c->>'id'=new.id and c->'payload'=new.payload)
      or (new.kind='project' and (r.receipt->>'action'<>'save_projects' or (new.payload->>'updatedAt')::timestamptz is distinct from r.created_at)) then
      raise exception using errcode='PU004',message='Changed row requires its exact immutable receipt';end if;
    return new;
  end if;
  actor:=jsonb_build_object('organizationId',org,'userId',r.actor_id,'role','owner','managementEntitled',true,
    'timestamp',to_char(r.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  perform public.zentra_us_erp_assert_projects(org,h,e->'changes',r.receipt,actor,previous);
  return new;
end $$;

create or replace function public.zentra_read_us_erp_v4(p_organization text) returns jsonb
language sql stable security invoker set search_path='' as $$
  select h.header || jsonb_build_object(
    'customers',coalesce((select jsonb_agg(r.payload order by r.id) from public.zentra_us_erp_records r where r.organization_id=h.organization_id and r.kind='customer'),'[]'::jsonb),
    'estimates',coalesce((select jsonb_agg(r.payload order by r.id) from public.zentra_us_erp_records r where r.organization_id=h.organization_id and r.kind='estimate'),'[]'::jsonb),
    'invoices',coalesce((select jsonb_agg(r.payload order by r.id) from public.zentra_us_erp_records r where r.organization_id=h.organization_id and r.kind='invoice'),'[]'::jsonb),
    'ledger',(h.header->'ledger') || jsonb_build_object(
      'entries',coalesce((select jsonb_agg(r.payload order by (r.payload->>'revision')::bigint) from public.zentra_us_erp_records r where r.organization_id=h.organization_id and r.kind='journal'),'[]'::jsonb),
      'audit',coalesce((select jsonb_agg(a.payload order by a.revision) from public.zentra_us_erp_ledger_audit a where a.organization_id=h.organization_id),'[]'::jsonb)))
  || case when h.header->'schemaVersion' in ('2'::jsonb,'3'::jsonb,'4'::jsonb) then jsonb_build_object(
    'vendors',coalesce((select jsonb_agg(r.payload order by r.id) from public.zentra_us_erp_records r where r.organization_id=h.organization_id and r.kind='vendor'),'[]'::jsonb),
    'vendorBills',coalesce((select jsonb_agg(r.payload order by r.id) from public.zentra_us_erp_records r where r.organization_id=h.organization_id and r.kind='vendor_bill'),'[]'::jsonb),
    'vendorPayments',coalesce((select jsonb_agg(r.payload order by (r.payload->>'recordedRevision')::bigint,r.id) from public.zentra_us_erp_records r where r.organization_id=h.organization_id and r.kind='vendor_payment'),'[]'::jsonb)) else '{}'::jsonb end
  || case when h.header->'schemaVersion' in ('3'::jsonb,'4'::jsonb) then jsonb_build_object('projects',coalesce((select jsonb_agg(r.payload order by r.id) from public.zentra_us_erp_records r where r.organization_id=h.organization_id and r.kind='project'),'[]'::jsonb)) else '{}'::jsonb end
  from public.zentra_us_erp_heads h where h.organization_id=p_organization;
$$;

create or replace function public.zentra_us_erp_receipt_v4(p_organization text,p_idempotency_key text) returns jsonb
language sql stable security invoker set search_path='' as $$
  select receipt from public.zentra_us_erp_receipts where organization_id=p_organization and idempotency_key=p_idempotency_key;
$$;

create or replace function public.zentra_us_erp_revision_v4(p_organization text) returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('schemaVersion',4,'organizationId',organization_id,'revision',revision)
    from public.zentra_us_erp_heads where organization_id=p_organization;
$$;

create or replace function public.zentra_us_erp_delta_v4(p_organization text,p_after_revision bigint,p_limit integer default 50) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare v_head bigint; v_baseline bigint; v_events jsonb:='[]'::jsonb; v_count integer:=0; v_last bigint; v_bytes integer:=0; v_size integer;
  v_page record; v_byte_limited boolean:=false; v_gap boolean:=false;
begin
  if p_organization is null or p_organization !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_after_revision is null or p_after_revision not between 0 and 9007199254740991 or p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode='PU004',message='Invalid US ERP cursor or page limit';
  end if;
  select revision into v_head from public.zentra_us_erp_heads where organization_id=p_organization;
  if not found then return null; end if;
  if p_after_revision>v_head then raise exception using errcode='PU004',message='US ERP cursor is ahead of the workspace'; end if;
  select baseline_revision into v_baseline from public.zentra_us_erp_streams where organization_id=p_organization;
  if not found then raise exception using errcode='PU004',message='US ERP stream metadata missing'; end if;
  if p_after_revision<v_baseline then
    return jsonb_build_object('schemaVersion',4,'organizationId',p_organization,'fromRevision',p_after_revision,'toRevision',p_after_revision,'headRevision',v_head,'hasMore',false,'resetRequired',true,'events','[]'::jsonb);
  end if;
  v_last:=p_after_revision;
  for v_page in select revision,event from public.zentra_us_erp_events where organization_id=p_organization and revision>p_after_revision and revision<=v_head order by revision limit p_limit loop
    if v_page.revision<>v_last+1 then v_gap:=true; exit; end if;
    v_size:=octet_length(v_page.event::text)+2;
    if v_size>2097154 then raise exception using errcode='PU007',message='US ERP event exceeds safe transport limit'; end if;
    -- 4 MiB wire page, with a conservative 4 KiB reserve for the envelope.
    if v_bytes+v_size>4190208 then v_byte_limited:=true; exit; end if;
    v_events:=v_events||jsonb_build_array(v_page.event); v_bytes:=v_bytes+v_size; v_count:=v_count+1; v_last:=v_page.revision;
  end loop;
  -- A gap must trigger an explicit full snapshot recovery; never advance a
  -- cursor over a missing operation or silently return a partial corrupt page.
  if v_gap or (v_last<v_head and v_count<p_limit and not v_byte_limited) then
    return jsonb_build_object('schemaVersion',4,'organizationId',p_organization,'fromRevision',p_after_revision,'toRevision',p_after_revision,'headRevision',v_head,'hasMore',false,'resetRequired',true,'events','[]'::jsonb);
  end if;
  if v_count=0 and v_last<v_head then raise exception using errcode='PU007',message='US ERP event cannot fit in a safe page'; end if;
  return jsonb_build_object('schemaVersion',4,'organizationId',p_organization,'fromRevision',p_after_revision,'toRevision',v_last,'headRevision',v_head,'hasMore',v_last<v_head,'resetRequired',false,'events',v_events);
end $$;

create function public.zentra_us_erp_guard_accounting_complete() returns trigger
language plpgsql security invoker set search_path='' as $$
declare org text;rev bigint;h jsonb;previous jsonb;e jsonb;r public.zentra_us_erp_receipts%rowtype;actor jsonb;
begin
  org:=new.organization_id;
  if tg_table_name='zentra_us_erp_heads' then
    if new.header->'schemaVersion'<>'4'::jsonb then return new;end if;
    rev:=new.revision;h:=new.header;previous:=case when tg_op='INSERT' then null else old.header end;
  else
    select header into h from public.zentra_us_erp_heads where organization_id=org;
    if h->'schemaVersion'<>'4'::jsonb then return new;end if;
    rev:=new.state_revision;
    select event->'header' into previous from public.zentra_us_erp_events where organization_id=org and revision=rev-1;
  end if;
  select event into e from public.zentra_us_erp_events where organization_id=org and revision=rev;
  select * into r from public.zentra_us_erp_receipts where organization_id=org and revision=rev;
  if e is null or r.revision is null or e->'header' is distinct from h or e->'receipt' is distinct from r.receipt
    or e->>'actorId' is distinct from r.actor_id or (e->>'occurredAt')::timestamptz is distinct from r.created_at then
    raise exception using errcode='PU004',message='Exact accounting receipt and captured event required';end if;
  if tg_table_name='zentra_us_erp_records' then
    if not exists(select 1 from jsonb_array_elements(e->'changes') c where c->>'kind'=new.kind and c->>'id'=new.id and c->'payload'=new.payload) then
      raise exception using errcode='PU004',message='Accounting record must belong to its exact event';end if;
    return new;
  end if;
  actor:=jsonb_build_object('organizationId',org,'userId',r.actor_id,'role','owner','managementEntitled',true,
    'timestamp',to_char(r.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  -- Z/.000 are equivalent instants. Preserve the actual audit text for exact
  -- comparison while also demanding its correlation with the receipt above.
  if jsonb_array_length(e->'ledgerAudit')>0 then
    if (e->'ledgerAudit'->0->>'timestamp')::timestamptz is distinct from r.created_at then raise exception using errcode='PU004',message='Final accounting event timestamp mismatch';end if;
    actor:=jsonb_set(actor,'{timestamp}',e->'ledgerAudit'->0->'timestamp');
  end if;
  perform public.zentra_us_erp_v4_assert(org,h,previous,e->'changes',e->'ledgerAudit',r.receipt,actor);
  return new;
end $$;
create constraint trigger zentra_us_erp_accounting_head_complete after insert or update on public.zentra_us_erp_heads
  deferrable initially deferred for each row execute function public.zentra_us_erp_guard_accounting_complete();
create constraint trigger zentra_us_erp_accounting_record_complete after insert or update on public.zentra_us_erp_records
  deferrable initially deferred for each row execute function public.zentra_us_erp_guard_accounting_complete();

create function public.zentra_us_erp_require_v3(org text) returns void
language plpgsql stable security invoker set search_path='' as $$
begin
  if exists(select 1 from public.zentra_us_erp_heads where organization_id=org and (header->>'schemaVersion')::integer>3) then
    raise exception using errcode='PU008',message='US accounting capability4 required';end if;
end $$;
create or replace function public.zentra_us_erp_require_v2(org text) returns void
language plpgsql stable security invoker set search_path='' as $$
begin
  if exists(select 1 from public.zentra_us_erp_heads where organization_id=org and (header->>'schemaVersion')::integer>2) then
    raise exception using errcode='PU008',message='US ERP schema upgrade required';end if;
end $$;
create or replace function public.zentra_read_us_erp_v3(p_organization text) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
begin perform public.zentra_us_erp_require_v3(p_organization);return public.zentra_read_us_erp_v4(p_organization);end $$;
create or replace function public.zentra_us_erp_receipt_v3(p_organization text,p_idempotency_key text) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
begin perform public.zentra_us_erp_require_v3(p_organization);return public.zentra_us_erp_receipt_v4(p_organization,p_idempotency_key);end $$;
create or replace function public.zentra_us_erp_revision_v3(p_organization text) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
begin perform public.zentra_us_erp_require_v3(p_organization);return jsonb_set(public.zentra_us_erp_revision_v4(p_organization),'{schemaVersion}','3'::jsonb);end $$;
create or replace function public.zentra_us_erp_delta_v3(p_organization text,p_after_revision bigint,p_limit integer default 50) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
begin perform public.zentra_us_erp_require_v3(p_organization);return jsonb_set(public.zentra_us_erp_delta_v4(p_organization,p_after_revision,p_limit),'{schemaVersion}','3'::jsonb);end $$;

do $$ declare fn record;
begin
  for fn in select p.oid::regprocedure signature from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and (p.proname like 'zentra_us_erp_v4_%' or p.proname in ('zentra_us_erp_guard_accounting_complete','zentra_us_erp_require_v3','zentra_read_us_erp_v4','zentra_us_erp_receipt_v4','zentra_us_erp_revision_v4','zentra_us_erp_delta_v4')) loop
    execute format('revoke all on function %s from public,anon,authenticated',fn.signature);
    execute format('grant execute on function %s to service_role',fn.signature);
  end loop;
end $$;
comment on function public.zentra_read_us_erp_v4(text) is 'Internal capability4: same organization book, immutable manual journal/reversal and period history. Not an Auth, tax or provider grant; older transports refuse newer heads.';
commit;
