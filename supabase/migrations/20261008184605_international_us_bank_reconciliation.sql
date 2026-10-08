-- Additive, disabled-by-default US bank review. No ERP mutation, CH change,
-- bank connection, automatic adjustment, tax calculation or money transfer.
begin;

create function public.zentra_us_bank_uuid(v text) returns boolean
language sql immutable security invoker set search_path='' as $$
  select coalesce(v ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',false);
$$;
create function public.zentra_us_bank_amount(v jsonb) returns numeric
language plpgsql immutable security invoker set search_path='' as $$
begin
  if not public.zentra_us_tax_object(v,array['currency','minorUnits']) or v->'currency' is distinct from '"USD"'::jsonb
    or jsonb_typeof(v->'minorUnits')<>'string' or v->>'minorUnits' !~ '^-?(0|[1-9][0-9]{0,35})$' or v->>'minorUnits'='-0' then
    raise exception using errcode='PB005',message='Invalid exact bank amount';
  end if;
  return (v->>'minorUnits')::numeric;
end $$;
-- ECMAScript .sort() orders UTF-16 units. Keep opaque Unicode IDs compatible
-- with the unchanged shared reconciliation engine rather than locale collation.
create function public.zentra_us_bank_utf16_key(v text) returns integer[]
language plpgsql immutable security invoker set search_path='' as $$
declare units integer[]:=array[]::integer[];cp integer;i integer;
begin
  for i in 1..char_length(v) loop
    cp:=ascii(substr(v,i,1));
    if cp>65535 then cp:=cp-65536;units:=units||array[55296+(cp/1024),56320+(cp%1024)];else units:=array_append(units,cp);end if;
  end loop;
  return units;
end $$;
-- Keep every admitted aggregate readable by snapshotPrivateJson and the HTTP
-- reader. Decoded UTF8 bytes conservatively bound UTF16 characters; small
-- headroom covers commit actor/receipt envelopes without relaxing shared limits.
create function public.zentra_us_bank_snapshot_capacity(v jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare valid boolean;
begin
  if v is null or octet_length(v::text)>2600000 then return false;end if;
  with recursive nodes(value,key_name,depth) as (
    select v,null::text,0
    union all
    select child.value,child.key_name,n.depth+1
    from nodes n cross join lateral (
      select e.value,e.key key_name from jsonb_each(case when jsonb_typeof(n.value)='object' then n.value else '{}'::jsonb end)e
      union all
      select a.value,null::text from jsonb_array_elements(case when jsonb_typeof(n.value)='array' then n.value else '[]'::jsonb end)a
    )child where n.depth<21
  ) select count(*)<=49000
    and sum(coalesce(octet_length(key_name),0)+case when jsonb_typeof(value)='string' then octet_length(value#>>'{}') else 0 end)<=2000000
    and bool_and(depth<=20 and coalesce(octet_length(key_name),0)<=500000
      and case when jsonb_typeof(value)='string' then octet_length(value#>>'{}')<=500000 else true end
      and case when jsonb_typeof(value)='array' then jsonb_array_length(value)<=1000 else true end)
    into valid from nodes;
  return coalesce(valid,false);
end $$;
create function public.zentra_us_bank_record_valid(v jsonb,org text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare r jsonb;s jsonb;l jsonb;m jsonb;ids text[]:=array[]::text[];matched_lines text[]:=array[]::text[];matched_entries text[]:=array[]::text[];
  match_ids text[]:=array[]::text[];match_keys text[]:=array[]::text[];a text[];b text[];fingerprint text;amount numeric;total numeric:=0;previous_time timestamptz;
begin
  if not public.zentra_us_tax_object(v,array['schemaVersion','reconciliation','createdBy','createdAt'],array['voided'])
    or v->'schemaVersion'<>'1'::jsonb or not public.zentra_us_tax_strings(v,array['createdBy','createdAt']) or not public.zentra_us_tax_text_valid(v->>'createdBy',256,false)
    or not public.zentra_us_purchase_timestamp(v->>'createdAt') then return false;end if;
  r:=v->'reconciliation';s:=r->'statement';previous_time:=(v->>'createdAt')::timestamptz;
  if not public.zentra_us_tax_object(r,array['organizationId','statement','revision','matches'],array['completedAt','completedBy','completedLedgerRevision'])
    or jsonb_typeof(r->'organizationId')<>'string' or r->>'organizationId' is distinct from org or not public.zentra_us_tax_safe_integer(r->'revision',0)
    or not public.zentra_us_tax_object(s,array['id','organizationId','externalConnectionId','currency','cashAccountId','start','end','opening','closing','lines'])
    or not public.zentra_us_tax_strings(s,array['id','organizationId','externalConnectionId','currency','cashAccountId','start','end'])
    or not public.zentra_us_bank_uuid(s->>'id') or s->>'organizationId' is distinct from org or s->>'currency'<>'USD'
    or not public.zentra_us_tax_text_valid(s->>'externalConnectionId',160,false) or not public.zentra_us_tax_text_valid(s->>'cashAccountId',160,false)
    or not public.zentra_us_purchase_date(s->>'start') or not public.zentra_us_purchase_date(s->>'end') or s->>'start'>s->>'end'
    or jsonb_typeof(s->'lines')<>'array' or jsonb_array_length(s->'lines')>1000 or jsonb_typeof(r->'matches')<>'array' or jsonb_array_length(r->'matches')>1000 then return false;end if;
  for l in select value from jsonb_array_elements(s->'lines') loop
    if not public.zentra_us_tax_object(l,array['id','date','amount','reference']) or not public.zentra_us_tax_strings(l,array['id','date','reference']) or not public.zentra_us_tax_text_valid(l->>'id',160,false)
      or l->>'id'=any(ids) or not public.zentra_us_tax_text_valid(l->>'reference',256,false)
      or not public.zentra_us_purchase_date(l->>'date') or l->>'date'<s->>'start' or l->>'date'>s->>'end' then return false;end if;
    amount:=public.zentra_us_bank_amount(l->'amount');if amount=0 then return false;end if;total:=total+amount;ids:=array_append(ids,l->>'id');
  end loop;
  if public.zentra_us_bank_amount(s->'opening')+total<>public.zentra_us_bank_amount(s->'closing') then return false;end if;
  for m in select value from jsonb_array_elements(r->'matches') loop
    if not public.zentra_us_tax_object(m,array['id','idempotencyKey','statementLineIds','ledgerEntryIds','fingerprint','approvedBy','approvedAt'])
      or not public.zentra_us_tax_strings(m,array['id','idempotencyKey','fingerprint','approvedBy','approvedAt'])
      or not public.zentra_us_bank_uuid(m->>'id') or m->>'id'=any(match_ids) or m->>'idempotencyKey'=any(match_keys)
      or m->>'idempotencyKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$'
      or not public.zentra_us_tax_text_valid(m->>'approvedBy',256,false) or not public.zentra_us_purchase_timestamp(m->>'approvedAt')
      or (m->>'approvedAt')::timestamptz<previous_time or jsonb_typeof(m->'statementLineIds')<>'array' or jsonb_typeof(m->'ledgerEntryIds')<>'array'
      or jsonb_array_length(m->'statementLineIds') not between 1 and 1000 or jsonb_array_length(m->'ledgerEntryIds') not between 1 and 1000
      or exists(select 1 from jsonb_array_elements(m->'statementLineIds')x where jsonb_typeof(x)<>'string')
      or exists(select 1 from jsonb_array_elements(m->'ledgerEntryIds')x where jsonb_typeof(x)<>'string') then return false;end if;
    select array_agg(x order by public.zentra_us_bank_utf16_key(x)) into a from jsonb_array_elements_text(m->'statementLineIds')x;
    select array_agg(x order by public.zentra_us_bank_utf16_key(x)) into b from jsonb_array_elements_text(m->'ledgerEntryIds')x;
    if to_jsonb(a)<>m->'statementLineIds' or to_jsonb(b)<>m->'ledgerEntryIds'
      or cardinality(a)<>(select count(distinct x)from unnest(a)x) or cardinality(b)<>(select count(distinct x)from unnest(b)x)
      or not a<@ids or a&&matched_lines or b&&matched_entries
      or exists(select 1 from unnest(b)x where not public.zentra_us_tax_text_valid(x,512,false)) then return false;end if;
    fingerprint:=public.zentra_us_erp_v4_canonical(jsonb_build_array(org,s->>'id','USD',s->>'cashAccountId',to_jsonb(a),to_jsonb(b)));
    if m->>'fingerprint' is distinct from fingerprint then return false;end if;
    matched_lines:=matched_lines||a;matched_entries:=matched_entries||b;match_ids:=array_append(match_ids,m->>'id');match_keys:=array_append(match_keys,m->>'idempotencyKey');previous_time:=(m->>'approvedAt')::timestamptz;
  end loop;
  if r ?| array['completedAt','completedBy','completedLedgerRevision'] then
    if not r ?& array['completedAt','completedBy','completedLedgerRevision'] or not public.zentra_us_tax_strings(r,array['completedAt','completedBy']) or v?'voided' or not public.zentra_us_purchase_timestamp(r->>'completedAt')
      or (r->>'completedAt')::timestamptz<previous_time or not public.zentra_us_tax_text_valid(r->>'completedBy',256,false)
      or not public.zentra_us_tax_safe_integer(r->'completedLedgerRevision',0) or cardinality(matched_lines)<>cardinality(ids) then return false;end if;
  end if;
  if v?'voided' then
    if jsonb_array_length(r->'matches')<>0 or r?'completedAt' or not public.zentra_us_tax_object(v->'voided',array['by','at','reason'])
      or not public.zentra_us_tax_strings(v->'voided',array['by','at','reason'])
      or not public.zentra_us_tax_text_valid(v->'voided'->>'by',256,false) or not public.zentra_us_tax_text_valid(v->'voided'->>'reason',2000,false)
      or not public.zentra_us_purchase_timestamp(v->'voided'->>'at') or (v->'voided'->>'at')::timestamptz<previous_time then return false;end if;
  end if;
  return (r->>'revision')::bigint=jsonb_array_length(r->'matches')+(case when r?'completedAt' then 1 else 0 end)+(case when v?'voided' then 1 else 0 end);
exception when others then return false;end $$;

create table public.zentra_us_bank_reconciliations (
  organization_id text not null references public.zentra_us_erp_heads on delete restrict,
  id uuid not null, revision bigint not null check(revision between 0 and 9007199254740990),
  content_hash text not null check(content_hash ~ '^[0-9a-f]{64}$'),payload jsonb not null,
  primary key(organization_id,id),unique(organization_id,content_hash),
  check(public.zentra_us_bank_record_valid(payload,organization_id) and payload->'reconciliation'->'statement'->>'id'=id::text and payload->'reconciliation'->>'revision'=revision::text)
);
create table public.zentra_us_bank_receipts (
  organization_id text not null,reconciliation_id uuid not null,idempotency_key text not null,command_hash text not null,actor_id text not null,revision bigint not null,receipt jsonb not null,
  primary key(organization_id,idempotency_key),unique(organization_id,reconciliation_id,revision),
  foreign key(organization_id,reconciliation_id) references public.zentra_us_bank_reconciliations on delete restrict,
  check(idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$' and command_hash ~ '^[0-9a-f]{64}$' and revision between 0 and 9007199254740990)
);
create table public.zentra_us_bank_audit (
  organization_id text not null,reconciliation_id uuid not null,revision bigint not null,actor_id text not null,occurred_at timestamptz not null,action text not null,receipt jsonb not null,
  primary key(organization_id,reconciliation_id,revision),foreign key(organization_id,reconciliation_id) references public.zentra_us_bank_reconciliations on delete restrict,
  check(action in ('create_statement','approve_match','complete','void_statement'))
);
create table public.zentra_us_bank_entry_claims (
  organization_id text not null,cash_account_id text not null,entry_id text not null,reconciliation_id uuid not null,match_id uuid not null,
  primary key(organization_id,entry_id),foreign key(organization_id,reconciliation_id) references public.zentra_us_bank_reconciliations on delete restrict
);
create function public.zentra_us_bank_immutable() returns trigger language plpgsql security invoker set search_path='' as $$
begin raise exception using errcode='PB010',message='Bank history is immutable';end $$;
create trigger zentra_us_bank_records_no_delete before delete or truncate on public.zentra_us_bank_reconciliations for each statement execute function public.zentra_us_bank_immutable();
create trigger zentra_us_bank_receipts_immutable before update or delete or truncate on public.zentra_us_bank_receipts for each statement execute function public.zentra_us_bank_immutable();
create trigger zentra_us_bank_audit_immutable before update or delete or truncate on public.zentra_us_bank_audit for each statement execute function public.zentra_us_bank_immutable();
create trigger zentra_us_bank_claims_immutable before update or delete or truncate on public.zentra_us_bank_entry_claims for each statement execute function public.zentra_us_bank_immutable();
alter table public.zentra_us_bank_reconciliations enable row level security;
alter table public.zentra_us_bank_receipts enable row level security;
alter table public.zentra_us_bank_audit enable row level security;
alter table public.zentra_us_bank_entry_claims enable row level security;
revoke all on public.zentra_us_bank_reconciliations,public.zentra_us_bank_receipts,public.zentra_us_bank_audit,public.zentra_us_bank_entry_claims from public,anon,authenticated,service_role;
grant select,insert,update on public.zentra_us_bank_reconciliations to service_role;
grant select,insert on public.zentra_us_bank_receipts,public.zentra_us_bank_audit,public.zentra_us_bank_entry_claims to service_role;

-- Even a direct privileged UPDATE cannot rewrite an imported statement or
-- an earlier approval. Final deferred checks require its atomic history too.
create function public.zentra_us_bank_record_transition() returns trigger
language plpgsql security invoker set search_path='' as $$
declare r jsonb:=new.payload->'reconciliation';prior jsonb:=old.payload->'reconciliation';
begin
  if new.organization_id is distinct from old.organization_id or new.id is distinct from old.id or new.content_hash is distinct from old.content_hash
    or new.revision<>old.revision+1 or old.payload?'voided' or prior?'completedAt'
    or new.payload->'createdBy' is distinct from old.payload->'createdBy' or new.payload->'createdAt' is distinct from old.payload->'createdAt'
    or r->'statement' is distinct from prior->'statement' then raise exception using errcode='PB010',message='Immutable bank facts changed';end if;
  if jsonb_array_length(r->'matches')=jsonb_array_length(prior->'matches')+1 and not(new.payload?'voided') and not(r?'completedAt')
    and (r->'matches')-(jsonb_array_length(r->'matches')-1)=prior->'matches' then return new;end if;
  if r->'matches'=prior->'matches' and ((r?'completedAt' and not(new.payload?'voided'))
    or (new.payload?'voided' and not(r?'completedAt') and r->'matches'='[]'::jsonb)) then return new;end if;
  raise exception using errcode='PB010',message='Bank transition requires an appended approval';
end $$;
create trigger zentra_us_bank_record_transition before update on public.zentra_us_bank_reconciliations for each row execute function public.zentra_us_bank_record_transition();

-- All four records form one transaction. No intermediate row may become a
-- durable reconciliation without its exact receipt, audit and entry claims.
create function public.zentra_us_bank_history_consistent() returns trigger
language plpgsql security invoker set search_path='' as $$
declare stored public.zentra_us_bank_reconciliations%rowtype;org text:=new.organization_id;rid uuid;r jsonb;s jsonb;item public.zentra_us_bank_receipts%rowtype;
  proof jsonb;action text;who text;stamp text;command jsonb;request jsonb;expected_hash text;content jsonb;expected_claims integer;
  association jsonb;entry jsonb;selected_entry text;bank numeric;book numeric;movement numeric;
begin
  if tg_table_name='zentra_us_bank_reconciliations' then rid:=new.id;else rid:=new.reconciliation_id;end if;
  select * into stored from public.zentra_us_bank_reconciliations where organization_id=org and id=rid;
  if not found then raise exception using errcode='PB010',message='Bank history has no statement';end if;
  r:=stored.payload->'reconciliation';s:=r->'statement';
  if (select count(*) from public.zentra_us_bank_reconciliations where organization_id=org)>100
    or not (select public.zentra_us_bank_snapshot_capacity(coalesce(jsonb_agg(payload),'[]'::jsonb)) from public.zentra_us_bank_reconciliations where organization_id=org) then raise exception using errcode='PB009',message='Bank review capacity reached';end if;
  if (select count(*) from public.zentra_us_bank_receipts where organization_id=org and reconciliation_id=rid)<>stored.revision+1
    or (select count(*) from public.zentra_us_bank_audit where organization_id=org and reconciliation_id=rid)<>stored.revision+1 then raise exception using errcode='PB010',message='Bank history is incomplete';end if;
  select jsonb_agg(jsonb_build_array(x->>'date',x->'amount'->>'minorUnits',x->>'reference') order by n) into content from jsonb_array_elements(s->'lines')with ordinality a(x,n);
  content:=jsonb_build_array(s->>'cashAccountId',s->>'start',s->>'end',s->'opening'->>'minorUnits',s->'closing'->>'minorUnits',coalesce(content,'[]'::jsonb));
  if stored.content_hash<>encode(sha256(convert_to(public.zentra_us_erp_v4_canonical(content),'UTF8')),'hex') then raise exception using errcode='PB010',message='Statement fingerprint changed';end if;
  for item in select * from public.zentra_us_bank_receipts where organization_id=org and reconciliation_id=rid order by revision loop
    if item.revision<0 or item.revision>stored.revision then raise exception using errcode='PB010',message='Unexpected history revision';end if;
    if item.revision=0 then action:='create_statement';who:=stored.payload->>'createdBy';stamp:=stored.payload->>'createdAt';command:=jsonb_build_object('type',action,'statement',s);
    elsif item.revision<=jsonb_array_length(r->'matches') then
      proof:=r->'matches'->(item.revision::integer-1);action:='approve_match';who:=proof->>'approvedBy';stamp:=proof->>'approvedAt';
      if item.idempotency_key is distinct from proof->>'idempotencyKey' then raise exception using errcode='PB010',message='Approval receipt differs';end if;
      command:=jsonb_build_object('type',action,'id',proof->>'id','statementLineIds',proof->'statementLineIds','ledgerEntryIds',proof->'ledgerEntryIds');
    elsif r?'completedAt' then action:='complete';who:=r->>'completedBy';stamp:=r->>'completedAt';command:=jsonb_build_object('type',action);
    elsif stored.payload?'voided' then action:='void_statement';who:=stored.payload->'voided'->>'by';stamp:=stored.payload->'voided'->>'at';command:=jsonb_build_object('type',action,'reason',stored.payload->'voided'->>'reason');
    else raise exception using errcode='PB010',message='Unknown bank history';end if;
    proof:=item.receipt;
    if not public.zentra_us_tax_object(proof,array['schemaVersion','organizationId','idempotencyKey','commandHash','actorId','reconciliationId','action','revision','erpRevision'])
      or not public.zentra_us_tax_strings(proof,array['organizationId','idempotencyKey','commandHash','actorId','reconciliationId','action'])
      or proof->'schemaVersion'<>'1'::jsonb or proof->>'organizationId' is distinct from org or proof->>'reconciliationId' is distinct from rid::text
      or proof->>'revision' is distinct from item.revision::text or proof->>'actorId' is distinct from who or item.actor_id is distinct from who
      or proof->>'idempotencyKey' is distinct from item.idempotency_key or proof->>'commandHash' is distinct from item.command_hash
      or proof->>'action' is distinct from action or not public.zentra_us_tax_safe_integer(proof->'erpRevision',1) then raise exception using errcode='PB010',message='Bank receipt changed';end if;
    request:=jsonb_build_object('schemaVersion',1,'idempotencyKey',item.idempotency_key,'reconciliationId',rid::text,'expectedErpRevision',proof->'erpRevision','expectedReconciliationRevision',case when item.revision=0 then null else item.revision-1 end,'command',command);
    expected_hash:=encode(sha256(convert_to(public.zentra_us_erp_v4_canonical(jsonb_build_array(org,who,request)),'UTF8')),'hex');
    if item.command_hash<>expected_hash or not exists(select 1 from public.zentra_us_bank_audit a where a.organization_id=org and a.reconciliation_id=rid and a.revision=item.revision
      and a.actor_id=who and a.occurred_at=stamp::timestamptz and a.action=proof->>'action' and a.receipt=proof) then raise exception using errcode='PB010',message='Bank audit differs';end if;
  end loop;
  select coalesce(sum(jsonb_array_length(x->'ledgerEntryIds')),0)::integer into expected_claims from jsonb_array_elements(r->'matches')x;
  if (select count(*) from public.zentra_us_bank_entry_claims where organization_id=org and reconciliation_id=rid)<>expected_claims
    or exists(select 1 from public.zentra_us_bank_entry_claims c where c.organization_id=org and c.reconciliation_id=rid and
      (c.cash_account_id is distinct from s->>'cashAccountId' or not exists(select 1 from jsonb_array_elements(r->'matches')m where m->>'id'=c.match_id::text and m->'ledgerEntryIds'?c.entry_id))) then raise exception using errcode='PB010',message='Bank entry claims differ';end if;
  -- Correlated history alone must not turn a direct service-role append into
  -- a fictitious cash association. Recheck immutable original journal facts.
  for association in select value from jsonb_array_elements(r->'matches') loop
    bank:=0;book:=0;
    for proof in select value from jsonb_array_elements(s->'lines') where association->'statementLineIds'?(value->>'id') loop bank:=bank+public.zentra_us_bank_amount(proof->'amount');end loop;
    for selected_entry in select value from jsonb_array_elements_text(association->'ledgerEntryIds') loop
      select payload into entry from public.zentra_us_erp_records where organization_id=org and kind='journal' and id=selected_entry;
      if not found or coalesce(entry->>'paymentDate',entry->>'transactionDate')<s->>'start' or coalesce(entry->>'paymentDate',entry->>'transactionDate')>s->>'end'
        or (association->>'approvedAt')::timestamptz<(entry->>'postedAt')::timestamptz then raise exception using errcode='PB010',message='Bank source entry differs';end if;
      select coalesce(sum((x->>'debitMinor')::numeric-(x->>'creditMinor')::numeric),0) into movement from jsonb_array_elements(entry->'lines')x where x->>'accountId'=s->>'cashAccountId';
      if movement=0 then raise exception using errcode='PB010',message='Bank cash movement required';end if;book:=book+movement;
    end loop;
    if bank<>book then raise exception using errcode='PB010',message='Bank cash amounts differ';end if;
  end loop;
  return null;
end $$;
create constraint trigger zentra_us_bank_records_atomic after insert or update on public.zentra_us_bank_reconciliations deferrable initially deferred for each row execute function public.zentra_us_bank_history_consistent();
create constraint trigger zentra_us_bank_receipts_atomic after insert on public.zentra_us_bank_receipts deferrable initially deferred for each row execute function public.zentra_us_bank_history_consistent();
create constraint trigger zentra_us_bank_audit_atomic after insert on public.zentra_us_bank_audit deferrable initially deferred for each row execute function public.zentra_us_bank_history_consistent();
create constraint trigger zentra_us_bank_claims_atomic after insert on public.zentra_us_bank_entry_claims deferrable initially deferred for each row execute function public.zentra_us_bank_history_consistent();

create function public.zentra_us_bank_scope(org text,actor jsonb,cap integer) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare c public.zentra_workspace_country_configs%rowtype;h public.zentra_us_erp_heads%rowtype;
begin
  if not public.zentra_us_bank_uuid(org) or not public.zentra_us_tax_actor_valid(actor,org) or not public.zentra_us_purchase_timestamp(actor->>'timestamp') then raise exception using errcode='PB007',message='Bank financial authority required';end if;
  if cap is distinct from 4 then raise exception using errcode='PB008',message='Bank accounting capability required';end if;
  select * into c from public.zentra_workspace_country_configs where organization_id=org for share;
  if not found or c.country<>'US' or c.currency<>'USD' then raise exception using errcode='PB008',message='US bank workspace required';end if;
  select * into h from public.zentra_us_erp_heads where organization_id=org for update;
  if not found or h.header->'schemaVersion'<>'4'::jsonb or h.header->'configuration' is distinct from c.config then raise exception using errcode='PB008',message='Current US accounting book required';end if;
  return h.header;
end $$;
create function public.zentra_list_us_bank_reconciliations(p_organization text,p_actor jsonb,p_supported_schema_version integer) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare output jsonb;
begin
  perform public.zentra_us_bank_scope(p_organization,p_actor,p_supported_schema_version);
  select coalesce(jsonb_agg(payload order by payload->>'createdAt' desc,id),'[]'::jsonb) into output from public.zentra_us_bank_reconciliations where organization_id=p_organization;
  if jsonb_array_length(output)>100 or octet_length(output::text)>2621440 then raise exception using errcode='PB009',message='Bank review limit';end if;
  return output;
end $$;
create function public.zentra_read_us_bank_reconciliation(p_organization text,p_actor jsonb,p_supported_schema_version integer,p_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare output jsonb;
begin perform public.zentra_us_bank_scope(p_organization,p_actor,p_supported_schema_version);select payload into output from public.zentra_us_bank_reconciliations where organization_id=p_organization and id=p_id;return output;end $$;
create function public.zentra_us_bank_receipt(p_organization text,p_actor jsonb,p_supported_schema_version integer,p_idempotency_key text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare stored public.zentra_us_bank_receipts%rowtype;
begin
  perform public.zentra_us_bank_scope(p_organization,p_actor,p_supported_schema_version);
  if p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$' then raise exception using errcode='PB005',message='Invalid bank key';end if;
  select * into stored from public.zentra_us_bank_receipts where organization_id=p_organization and idempotency_key=p_idempotency_key;
  if not found then return null;end if;
  if stored.actor_id is distinct from p_actor->>'userId' then raise exception using errcode='PB002',message='Bank request identity conflict';end if;
  return stored.receipt;
end $$;
create function public.zentra_commit_us_bank_reconciliation(p_organization text,p_actor jsonb,p_supported_schema_version integer,p_expected_erp_revision bigint,p_expected_reconciliation_revision bigint,p_record jsonb,p_receipt jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare h jsonb;r jsonb:=p_record->'reconciliation';s jsonb:=r->'statement';old public.zentra_us_bank_reconciliations%rowtype;prior public.zentra_us_bank_receipts%rowtype;
  command jsonb;request jsonb;action text:=p_receipt->>'action';record_id uuid;m jsonb;l jsonb;entry jsonb;line jsonb;content jsonb;v_content_hash text;expected_hash text;
  bank numeric:=0;book numeric:=0;movement numeric;opening numeric:=0;closing numeric:=0;unmatched integer;last_time timestamptz;
begin
  h:=public.zentra_us_bank_scope(p_organization,p_actor,p_supported_schema_version);
  if not public.zentra_us_bank_record_valid(p_record,p_organization) or not public.zentra_us_tax_object(p_receipt,array['schemaVersion','organizationId','idempotencyKey','commandHash','actorId','reconciliationId','action','revision','erpRevision'])
    or not public.zentra_us_tax_strings(p_receipt,array['organizationId','idempotencyKey','commandHash','actorId','reconciliationId','action'])
    or p_receipt->'schemaVersion'<>'1'::jsonb or p_receipt->>'organizationId' is distinct from p_organization or p_receipt->>'actorId' is distinct from p_actor->>'userId'
    or p_receipt->>'reconciliationId' is distinct from s->>'id' or p_receipt->'revision' is distinct from r->'revision'
    or not public.zentra_us_tax_safe_integer(p_receipt->'erpRevision',1) or p_receipt->>'erpRevision' is distinct from p_expected_erp_revision::text
    or p_receipt->>'idempotencyKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$' or p_receipt->>'commandHash' !~ '^[0-9a-f]{64}$' then raise exception using errcode='PB005',message='Invalid bank command';end if;
  record_id:=(s->>'id')::uuid;
  -- Reconstruct the canonical original command before a historical receipt is
  -- returned. A receipt key alone cannot attest a different request body.
  if action='create_statement' then
    if p_expected_reconciliation_revision is not null or r->'revision'<>'0'::jsonb or jsonb_array_length(r->'matches')<>0 or r?'completedAt' or p_record?'voided' then raise exception using errcode='PB005',message='Invalid bank replay shape';end if;
    command:=jsonb_build_object('type',action,'statement',s);
  elsif action in ('approve_match','complete','void_statement') then
    if p_expected_reconciliation_revision is null or p_expected_reconciliation_revision<0 or p_expected_reconciliation_revision>=9007199254740990
      or r->>'revision' is distinct from (p_expected_reconciliation_revision+1)::text then raise exception using errcode='PB005',message='Invalid bank replay revision';end if;
    if action='approve_match' then
      m:=r->'matches'->-1;
      if m is null or r?'completedAt' or p_record?'voided' or m->>'idempotencyKey' is distinct from p_receipt->>'idempotencyKey' then raise exception using errcode='PB005',message='Invalid match replay';end if;
      command:=jsonb_build_object('type',action,'id',m->>'id','statementLineIds',m->'statementLineIds','ledgerEntryIds',m->'ledgerEntryIds');
    elsif action='complete' then
      if not(r?'completedAt') or p_record?'voided' then raise exception using errcode='PB005',message='Invalid completion replay';end if;
      command:=jsonb_build_object('type',action);
    else
      if not(p_record?'voided') then raise exception using errcode='PB005',message='Invalid void replay';end if;
      command:=jsonb_build_object('type',action,'reason',p_record->'voided'->>'reason');
    end if;
  else raise exception using errcode='PB005',message='Invalid bank action';end if;
  request:=jsonb_build_object('schemaVersion',1,'idempotencyKey',p_receipt->>'idempotencyKey','reconciliationId',s->>'id','expectedErpRevision',p_expected_erp_revision,'expectedReconciliationRevision',p_expected_reconciliation_revision,'command',command);
  expected_hash:=encode(sha256(convert_to(public.zentra_us_erp_v4_canonical(jsonb_build_array(p_organization,p_actor->>'userId',request)),'UTF8')),'hex');
  if p_receipt->>'commandHash' is distinct from expected_hash then raise exception using errcode='PB002',message='Bank replay fingerprint differs';end if;
  select * into prior from public.zentra_us_bank_receipts where organization_id=p_organization and idempotency_key=p_receipt->>'idempotencyKey';
  if found then
    if prior.receipt is distinct from p_receipt or prior.actor_id is distinct from p_actor->>'userId' then raise exception using errcode='PB002',message='Bank replay conflict';end if;
    return prior.receipt;
  end if;
  if h->>'revision' is distinct from p_expected_erp_revision::text then raise exception using errcode='PB006',message='ERP changed during bank review';end if;
  if not exists(select 1 from jsonb_array_elements(h->'ledger'->'accounts')a where a->>'id'=s->>'cashAccountId' and a->'cash'='true'::jsonb) then raise exception using errcode='PB005',message='Cash account required';end if;
  select * into old from public.zentra_us_bank_reconciliations where organization_id=p_organization and id=record_id for update;
  if p_expected_reconciliation_revision is null then
    if found then raise exception using errcode='PB001',message='Bank record exists';end if;
    if action<>'create_statement' or r->'revision'<>'0'::jsonb or jsonb_array_length(r->'matches')<>0 or r?'completedAt' or p_record?'voided'
      or p_record->>'createdBy' is distinct from p_actor->>'userId' or p_record->>'createdAt' is distinct from p_actor->>'timestamp' then raise exception using errcode='PB005',message='Invalid bank creation';end if;
    if (select count(*)from public.zentra_us_bank_reconciliations where organization_id=p_organization)>=100 then raise exception using errcode='PB009',message='Bank record limit';end if;
    select jsonb_agg(jsonb_build_array(x->>'date',x->'amount'->>'minorUnits',x->>'reference') order by n) into content from jsonb_array_elements(s->'lines')with ordinality a(x,n);
    content:=jsonb_build_array(s->>'cashAccountId',s->>'start',s->>'end',s->'opening'->>'minorUnits',s->'closing'->>'minorUnits',coalesce(content,'[]'::jsonb));
    v_content_hash:=encode(sha256(convert_to(public.zentra_us_erp_v4_canonical(content),'UTF8')),'hex');
    if exists(select 1 from public.zentra_us_bank_reconciliations where organization_id=p_organization and zentra_us_bank_reconciliations.content_hash=v_content_hash) then raise exception using errcode='PB012',message='Statement already imported';end if;
    if exists(select 1 from public.zentra_us_bank_reconciliations where organization_id=p_organization and not(payload?'voided') and payload->'reconciliation'->'statement'->>'cashAccountId'=s->>'cashAccountId'
      and payload->'reconciliation'->'statement'->>'start'<=s->>'end' and payload->'reconciliation'->'statement'->>'end'>=s->>'start') then raise exception using errcode='PB003',message='Statement periods overlap';end if;
    command:=jsonb_build_object('type',action,'statement',s);
  else
    if not found or old.revision<>p_expected_reconciliation_revision or old.revision>=9007199254740990 then raise exception using errcode='PB001',message='Bank revision changed';end if;
    if old.payload?'voided' or old.payload->'reconciliation'?'completedAt' then raise exception using errcode='PB011',message='Bank review is closed';end if;
    if r->>'revision' is distinct from (old.revision+1)::text or p_record->>'createdBy' is distinct from old.payload->>'createdBy' or p_record->>'createdAt' is distinct from old.payload->>'createdAt'
      or s is distinct from old.payload->'reconciliation'->'statement' then raise exception using errcode='PB005',message='Immutable statement changed';end if;
    last_time:=coalesce(old.payload->'reconciliation'->'matches'->-1->>'approvedAt',old.payload->>'createdAt')::timestamptz;
    if (p_actor->>'timestamp')::timestamptz<last_time then raise exception using errcode='PB005',message='Bank time reversed';end if;
    if action='approve_match' then
      if r?'completedAt' or p_record?'voided' or jsonb_array_length(r->'matches')<>jsonb_array_length(old.payload->'reconciliation'->'matches')+1
        or (r->'matches')-(jsonb_array_length(r->'matches')-1) is distinct from old.payload->'reconciliation'->'matches' then raise exception using errcode='PB005',message='Old matches changed';end if;
      m:=r->'matches'->-1;
      if m->>'idempotencyKey' is distinct from p_receipt->>'idempotencyKey' or m->>'approvedBy' is distinct from p_actor->>'userId' or m->>'approvedAt' is distinct from p_actor->>'timestamp' then raise exception using errcode='PB005',message='Match approval missing';end if;
      for l in select value from jsonb_array_elements(s->'lines') where m->'statementLineIds'? (value->>'id') loop bank:=bank+public.zentra_us_bank_amount(l->'amount');end loop;
      for l in select value from jsonb_array_elements(m->'ledgerEntryIds') loop
        select payload into entry from public.zentra_us_erp_records where organization_id=p_organization and kind='journal' and id=l#>>'{}';
        if not found or coalesce(entry->>'paymentDate',entry->>'transactionDate')<s->>'start' or coalesce(entry->>'paymentDate',entry->>'transactionDate')>s->>'end'
          or (p_actor->>'timestamp')::timestamptz<(entry->>'postedAt')::timestamptz then raise exception using errcode='PB005',message='Cash entry unavailable';end if;
        select coalesce(sum((x->>'debitMinor')::numeric-(x->>'creditMinor')::numeric),0) into movement from jsonb_array_elements(entry->'lines')x where x->>'accountId'=s->>'cashAccountId';
        if movement=0 then raise exception using errcode='PB005',message='Cash movement required';end if;book:=book+movement;
        if exists(select 1 from public.zentra_us_bank_entry_claims where organization_id=p_organization and entry_id=l#>>'{}') then raise exception using errcode='PB004',message='Cash entry already matched';end if;
      end loop;
      if bank<>book then raise exception using errcode='PB005',message='Bank amounts differ';end if;
      command:=jsonb_build_object('type',action,'id',m->>'id','statementLineIds',m->'statementLineIds','ledgerEntryIds',m->'ledgerEntryIds');
    elsif action='complete' then
      if p_record?'voided' or r->'matches' is distinct from old.payload->'reconciliation'->'matches' or r->>'completedBy' is distinct from p_actor->>'userId'
        or r->>'completedAt' is distinct from p_actor->>'timestamp' or r->'completedLedgerRevision' is distinct from h->'ledger'->'revision' then raise exception using errcode='PB005',message='Completion review required';end if;
      unmatched:=0;
      for entry in select payload from public.zentra_us_erp_records where organization_id=p_organization and kind='journal' loop
        select coalesce(sum((x->>'debitMinor')::numeric-(x->>'creditMinor')::numeric),0) into movement from jsonb_array_elements(entry->'lines')x where x->>'accountId'=s->>'cashAccountId';
        if coalesce(entry->>'paymentDate',entry->>'transactionDate')<s->>'start' then opening:=opening+movement;end if;
        if coalesce(entry->>'paymentDate',entry->>'transactionDate')<=s->>'end' then closing:=closing+movement;end if;
        if movement<>0 and coalesce(entry->>'paymentDate',entry->>'transactionDate') between s->>'start' and s->>'end'
          and not exists(select 1 from public.zentra_us_bank_entry_claims where organization_id=p_organization and cash_account_id=s->>'cashAccountId' and entry_id=entry->>'id' and reconciliation_id=record_id) then unmatched:=unmatched+1;end if;
      end loop;
      if unmatched<>0 or opening<>public.zentra_us_bank_amount(s->'opening') or closing<>public.zentra_us_bank_amount(s->'closing') then raise exception using errcode='PB005',message='Bank differences remain';end if;
      command:=jsonb_build_object('type',action);
    elsif action='void_statement' then
      if jsonb_array_length(old.payload->'reconciliation'->'matches')<>0 or r->'matches'<>'[]'::jsonb or r?'completedAt' or p_record->'voided'->>'by' is distinct from p_actor->>'userId'
        or p_record->'voided'->>'at' is distinct from p_actor->>'timestamp' then raise exception using errcode='PB005',message='Only unmatched imports can be voided';end if;
      command:=jsonb_build_object('type',action,'reason',p_record->'voided'->>'reason');
    else raise exception using errcode='PB005',message='Invalid bank action';end if;
  end if;
  request:=jsonb_build_object('schemaVersion',1,'idempotencyKey',p_receipt->>'idempotencyKey','reconciliationId',s->>'id','expectedErpRevision',p_expected_erp_revision,'expectedReconciliationRevision',p_expected_reconciliation_revision,'command',command);
  expected_hash:=encode(sha256(convert_to(public.zentra_us_erp_v4_canonical(jsonb_build_array(p_organization,p_actor->>'userId',request)),'UTF8')),'hex');
  if p_receipt->>'commandHash' is distinct from expected_hash then raise exception using errcode='PB002',message='Bank command fingerprint differs';end if;
  -- Refuse the next import/approval before it can make all existing statement
  -- reads exceed their bound. Leave space for the scoped HTTP read envelope.
  if not (select public.zentra_us_bank_snapshot_capacity(coalesce(jsonb_agg(payload),'[]'::jsonb)||jsonb_build_array(p_record)) from public.zentra_us_bank_reconciliations where organization_id=p_organization and id<>record_id) then raise exception using errcode='PB009',message='Bank review capacity reached';end if;
  if p_expected_reconciliation_revision is null then insert into public.zentra_us_bank_reconciliations values(p_organization,record_id,0,v_content_hash,p_record);
  else update public.zentra_us_bank_reconciliations set revision=old.revision+1,payload=p_record where organization_id=p_organization and id=record_id;end if;
  if action='approve_match' then
    insert into public.zentra_us_bank_entry_claims select p_organization,s->>'cashAccountId',value,record_id,(m->>'id')::uuid from jsonb_array_elements_text(m->'ledgerEntryIds');
  end if;
  insert into public.zentra_us_bank_receipts values(p_organization,record_id,p_receipt->>'idempotencyKey',expected_hash,p_actor->>'userId',(r->>'revision')::bigint,p_receipt);
  insert into public.zentra_us_bank_audit values(p_organization,record_id,(r->>'revision')::bigint,p_actor->>'userId',(p_actor->>'timestamp')::timestamptz,action,p_receipt);
  return p_receipt;
end $$;

do $$ declare fn record;begin
  for fn in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'zentra\_us\_bank\_%' escape '\'
    or n.nspname='public' and p.proname in ('zentra_list_us_bank_reconciliations','zentra_read_us_bank_reconciliation','zentra_commit_us_bank_reconciliation') loop
    execute format('revoke all on function %s from public,anon,authenticated',fn.signature);
    execute format('grant execute on function %s to service_role',fn.signature);
  end loop;
end $$;
comment on table public.zentra_us_bank_reconciliations is 'Reviewed USD statements and exact human-approved matches. Does not post adjustments or initiate bank payments.';
commit;
