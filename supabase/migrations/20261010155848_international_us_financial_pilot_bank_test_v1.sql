-- Private local TEST bank review sidecar. No financial event/ledger mutation.
begin;

create function public.zentra_us_pilot_bank_request(q jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
#variable_conflict use_column
declare c jsonb;l jsonb;n numeric;ids jsonb;revisions jsonb;
begin
 if not public.zentra_us_tax_object(q,array['consumer','schemaVersion','requestId','expectedRevision','expectedBankRevision','expectedStatementRevision','command'])
 or q->>'consumer' is distinct from 'financial-pilot' or q->'schemaVersion' is distinct from '1'::jsonb or not public.zentra_us_bank_uuid(q->>'requestId')
 or not public.zentra_us_tax_safe_integer(q->'expectedRevision',1) or not public.zentra_us_tax_safe_integer(q->'expectedBankRevision',0)
 or not public.zentra_us_bank_snapshot_capacity(q) or octet_length(public.zentra_us_erp_v4_canonical(q))>1048576 then return false;end if;
 c:=q->'command';
 if c->>'type'='create_statement' then
  if q->'expectedStatementRevision' is distinct from 'null'::jsonb or not public.zentra_us_tax_object(c,array['type','cashAccountId','start','end','openingMinor','closingMinor','lines'])
  or not public.zentra_us_tax_strings(c,array['type','cashAccountId','start','end','openingMinor','closingMinor'])
  or not public.zentra_us_tax_text_valid(c->>'cashAccountId',160,false) or not public.zentra_us_purchase_date(c->>'start') or not public.zentra_us_purchase_date(c->>'end') or c->>'start'>c->>'end'
  or c->>'openingMinor' !~ '^(0|-?[1-9][0-9]{0,35})$' or c->>'closingMinor' !~ '^(0|-?[1-9][0-9]{0,35})$'
  or jsonb_typeof(c->'lines')<>'array' or jsonb_array_length(c->'lines')>1000 then return false;end if;
  n:=(c->>'openingMinor')::numeric;
  for l in select value from jsonb_array_elements(c->'lines') loop
   if not public.zentra_us_tax_object(l,array['date','amountMinor','reference']) or not public.zentra_us_tax_strings(l,array['date','amountMinor','reference'])
   or not public.zentra_us_purchase_date(l->>'date') or l->>'date'<c->>'start' or l->>'date'>c->>'end'
   or l->>'amountMinor' !~ '^-?[1-9][0-9]{0,35}$' or not public.zentra_us_tax_text_valid(l->>'reference',256,false)
   or cardinality(public.zentra_us_bank_utf16_key(l->>'reference'))>256 then return false;end if;
   n:=n+(l->>'amountMinor')::numeric;
  end loop;
  return n=(c->>'closingMinor')::numeric;
 end if;
 if not public.zentra_us_tax_safe_integer(q->'expectedStatementRevision',0) or not public.zentra_us_bank_uuid(c->>'statementId') then return false;end if;
 if c->>'type'='approve_match' then
  if not public.zentra_us_tax_object(c,array['type','statementId','statementLineIds','journalRevisions'])
  or jsonb_typeof(c->'statementLineIds')<>'array' or jsonb_array_length(c->'statementLineIds') not between 1 and 1000
  or jsonb_typeof(c->'journalRevisions')<>'array' or jsonb_array_length(c->'journalRevisions') not between 1 and 1000 then return false;end if;
  if exists(select 1 from jsonb_array_elements(c->'statementLineIds')x where jsonb_typeof(x)<>'string' or not public.zentra_us_tax_text_valid(x#>>'{}',160,false) or cardinality(public.zentra_us_bank_utf16_key(x#>>'{}'))>160)
  or exists(select 1 from jsonb_array_elements(c->'journalRevisions')x where not public.zentra_us_tax_safe_integer(x,1)) then return false;end if;
  select jsonb_agg(x order by public.zentra_us_bank_utf16_key(x#>>'{}')) into ids from jsonb_array_elements(c->'statementLineIds')x;
  select jsonb_agg(x order by (x#>>'{}')::numeric) into revisions from jsonb_array_elements(c->'journalRevisions')x;
  return ids=c->'statementLineIds' and revisions=c->'journalRevisions'
   and (select count(distinct x) from jsonb_array_elements(ids)x)=jsonb_array_length(ids)
   and (select count(distinct x) from jsonb_array_elements(revisions)x)=jsonb_array_length(revisions);
 elsif c->>'type'='complete' then return public.zentra_us_tax_object(c,array['type','statementId']);
 elsif c->>'type'='void_statement' then return public.zentra_us_tax_object(c,array['type','statementId','reason']) and jsonb_typeof(c->'reason')='string' and public.zentra_us_tax_text_valid(c->>'reason',2000,false) and cardinality(public.zentra_us_bank_utf16_key(c->>'reason'))<=2000;
 end if;
 return false;
exception when others then return false;
end $$;

create function public.zentra_us_pilot_bank_content(record jsonb) returns jsonb
language sql immutable security invoker set search_path='' as $$
 select jsonb_build_array(record#>>'{reconciliation,statement,cashAccountId}',record#>>'{reconciliation,statement,start}',record#>>'{reconciliation,statement,end}',record#>>'{reconciliation,statement,opening,minorUnits}',record#>>'{reconciliation,statement,closing,minorUnits}',coalesce((select jsonb_agg(jsonb_build_array(x->>'date',x#>>'{amount,minorUnits}',x->>'reference') order by n) from jsonb_array_elements(record#>'{reconciliation,statement,lines}')with ordinality a(x,n)),'[]'::jsonb));
$$;

-- Independent pure transition on the TRUE V5 ledger. Never calls ERP4 bank RPCs.
create function public.zentra_us_pilot_bank_transition(org text,q jsonb,a jsonb,ledger jsonb,records jsonb,historical boolean default false) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
#variable_conflict use_column
declare c jsonb:=q->'command';id text;old jsonb;r jsonb;s jsonb;lines jsonb;m jsonb;e jsonb;x jsonb;selected jsonb:='[]';native_ids jsonb;matched jsonb;cash text;stamp text:=a->>'timestamp';bank numeric:=0;book numeric:=0;movement numeric;opening numeric:=0;closing numeric:=0;latest timestamptz;output jsonb;
begin
 if not public.zentra_us_pilot_bank_request(q) or not public.zentra_us_tax_actor_valid(a,org) or not public.zentra_us_purchase_timestamp(stamp)
 or cardinality(public.zentra_us_bank_utf16_key(a->>'userId'))>256 or ledger->>'organizationId' is distinct from org or ledger->>'currency' is distinct from 'USD' then raise exception using errcode='BQ005',message='Invalid bank request';end if;
 id:=case when c->>'type'='create_statement' then q->>'requestId' else c->>'statementId' end;
 select x->'record' into old from jsonb_array_elements(records)x where x#>>'{record,reconciliation,statement,id}'=id;
 if c->>'type'='create_statement' then
  if old is not null then raise exception using errcode='BQ012',message='Reserved statement identity';end if;
  cash:=c->>'cashAccountId';
  select coalesce(jsonb_agg(jsonb_build_object('id',id||':'||n::text,'date',x->>'date','reference',x->>'reference','amount',jsonb_build_object('currency','USD','minorUnits',x->>'amountMinor')) order by n),'[]'::jsonb) into lines from jsonb_array_elements(c->'lines')with ordinality t(x,n);
  s:=jsonb_build_object('id',id,'organizationId',org,'currency','USD','externalConnectionId','manual-csv:financial-pilot-v1','cashAccountId',cash,'start',c->>'start','end',c->>'end','opening',jsonb_build_object('currency','USD','minorUnits',c->>'openingMinor'),'closing',jsonb_build_object('currency','USD','minorUnits',c->>'closingMinor'),'lines',lines);
  output:=jsonb_build_object('schemaVersion',1,'createdBy',a->>'userId','createdAt',stamp,'reconciliation',jsonb_build_object('organizationId',org,'statement',s,'revision',0,'matches','[]'::jsonb));
  if jsonb_array_length(records)>=100 then raise exception using errcode='BQ009',message='Bank register capacity';end if;
  if exists(select 1 from jsonb_array_elements(records)x where public.zentra_us_pilot_bank_content(x->'record')=public.zentra_us_pilot_bank_content(output)) then raise exception using errcode='BQ012',message='Duplicate statement content';end if;
  if exists(select 1 from jsonb_array_elements(records)x where not(x->'record'?'voided') and x#>>'{record,reconciliation,statement,cashAccountId}'=cash and x#>>'{record,reconciliation,statement,start}'<=s->>'end' and x#>>'{record,reconciliation,statement,end}'>=s->>'start') then raise exception using errcode='BQ003',message='Overlapping statement';end if;
 else
  if old is null then raise exception using errcode='BQ005',message='Statement unavailable';end if;
  if exists(select 1 from jsonb_array_elements(records)x where x->>'origin'='legacy-frozen' and x#>>'{record,reconciliation,statement,id}'=id) then raise exception using errcode='BQ011',message='Frozen legacy statement';end if;
  r:=old->'reconciliation';s:=r->'statement';cash:=s->>'cashAccountId';
  if old?'voided' or r?'completedAt' then raise exception using errcode='BQ011',message='Closed statement';end if;
  if r->'revision' is distinct from q->'expectedStatementRevision' or (r->>'revision')::numeric>=9007199254740990 then raise exception using errcode='BQ001',message='Statement revision changed';end if;
  latest:=coalesce(r->'matches'->-1->>'approvedAt',old->>'createdAt')::timestamptz;
  if stamp::timestamptz<latest then raise exception using errcode='PF016',message='Bank clock reversed';end if;
  if c->>'type'='approve_match' then
   for x in select value from jsonb_array_elements(c->'statementLineIds') loop
    select value into e from jsonb_array_elements(s->'lines') where value->'id'=x;
    if e is null or exists(select 1 from jsonb_array_elements(r->'matches')p where p->'statementLineIds'? (x#>>'{}')) then raise exception using errcode='BQ004',message='Statement line unavailable';end if;
    bank:=bank+public.zentra_us_bank_amount(e->'amount');
   end loop;
   for x in select value from jsonb_array_elements(c->'journalRevisions') loop
    select value into e from jsonb_array_elements(ledger->'entries') where value->'revision'=x;
    if e is null or coalesce(e->>'paymentDate',e->>'transactionDate')<s->>'start' or coalesce(e->>'paymentDate',e->>'transactionDate')>s->>'end' then raise exception using errcode='BQ005',message='Cash entry unavailable';end if;
    if stamp::timestamptz<(e->>'postedAt')::timestamptz then raise exception using errcode='PF016',message='Bank clock reversed';end if;
    if exists(select 1 from jsonb_array_elements(records)wr cross join lateral jsonb_array_elements(wr#>'{record,reconciliation,matches}')p where p->'ledgerEntryIds'?(e->>'id')) then raise exception using errcode='BQ004',message='Cash entry already claimed';end if;
    select coalesce(sum((l->>'debitMinor')::numeric-(l->>'creditMinor')::numeric),0) into movement from jsonb_array_elements(e->'lines')l where l->>'accountId'=cash;
    if movement=0 then raise exception using errcode='BQ005',message='Cash movement required';end if;
    book:=book+movement;selected:=selected||jsonb_build_array(e->>'id');
   end loop;
   if bank<>book then raise exception using errcode='BQ005',message='Exact cash amounts differ';end if;
   select jsonb_agg(x order by public.zentra_us_bank_utf16_key(x#>>'{}')) into native_ids from jsonb_array_elements(selected)x;
   m:=jsonb_build_object('id',q->>'requestId','idempotencyKey','pilot:bank:'||(q->>'requestId'),'statementLineIds',c->'statementLineIds','ledgerEntryIds',native_ids,'fingerprint',public.zentra_us_erp_v4_canonical(jsonb_build_array(org,id,'USD',cash,c->'statementLineIds',native_ids)),'approvedBy',a->>'userId','approvedAt',stamp);
   r:=r||jsonb_build_object('matches',(r->'matches')||jsonb_build_array(m));
  elsif c->>'type'='complete' then
   select coalesce(jsonb_agg(x),'[]'::jsonb) into matched from jsonb_array_elements(r->'matches')p cross join lateral jsonb_array_elements(p->'ledgerEntryIds')x;
   if exists(select 1 from jsonb_array_elements(s->'lines')l where not exists(select 1 from jsonb_array_elements(r->'matches')p where p->'statementLineIds'?(l->>'id'))) then raise exception using errcode='BQ005',message='Incomplete statement lines';end if;
   for e in select value from jsonb_array_elements(ledger->'entries') loop
    select coalesce(sum((l->>'debitMinor')::numeric-(l->>'creditMinor')::numeric),0) into movement from jsonb_array_elements(e->'lines')l where l->>'accountId'=cash;
    if coalesce(e->>'paymentDate',e->>'transactionDate')<s->>'start' then opening:=opening+movement;end if;
    if coalesce(e->>'paymentDate',e->>'transactionDate')<=s->>'end' then closing:=closing+movement;end if;
    if movement<>0 and coalesce(e->>'paymentDate',e->>'transactionDate') between s->>'start' and s->>'end' and not(matched?(e->>'id')) then raise exception using errcode='BQ005',message='Incomplete book movements';end if;
   end loop;
   if opening<>public.zentra_us_bank_amount(s->'opening') or closing<>public.zentra_us_bank_amount(s->'closing') then raise exception using errcode='BQ005',message='Incomplete bank balances';end if;
   r:=r||jsonb_build_object('completedBy',a->>'userId','completedAt',stamp,'completedLedgerRevision',ledger->'revision');
  elsif c->>'type'='void_statement' then
   if jsonb_array_length(r->'matches')<>0 then raise exception using errcode='BQ011',message='Used statement is not voidable';end if;
  end if;
  r:=r||jsonb_build_object('revision',(r->>'revision')::bigint+1);output:=old||jsonb_build_object('reconciliation',r);
  if c->>'type'='void_statement' then output:=output||jsonb_build_object('voided',jsonb_build_object('by',a->>'userId','at',stamp,'reason',c->>'reason'));end if;
 end if;
 if not exists(select 1 from jsonb_array_elements(ledger->'accounts')x where x->>'id'=cash and x->'cash'='true'::jsonb) then raise exception using errcode='BQ005',message='Cash account required';end if;
 if not historical and exists(select 1 from jsonb_array_elements(records)x where x->>'origin'='legacy-frozen' and not(x->'record'?'voided') and not(x->'record'->'reconciliation'?'completedAt') and x#>>'{record,reconciliation,statement,cashAccountId}'=cash) then raise exception using errcode='BQ013',message='Pending legacy review blocks account';end if;
 if not public.zentra_us_bank_record_valid(output,org) then raise exception using errcode='BQ010',message='Invalid derived bank record';end if;
 return output;
end $$;

create table public.zentra_us_financial_bank_test_reconciliations (
 organization_id text not null references public.zentra_us_financial_test_heads on delete restrict,
 id uuid not null,revision bigint not null check(revision between 0 and 9007199254740990),payload jsonb not null,
 proof jsonb not null,grant_version bigint not null,opt_in_version bigint not null,
 primary key(organization_id,id),check(public.zentra_us_bank_record_valid(payload,organization_id) and payload#>>'{reconciliation,statement,id}'=id::text and payload#>>'{reconciliation,revision}'=revision::text)
);
create table public.zentra_us_financial_bank_test_receipts (
 organization_id text not null,request_id uuid not null,statement_id uuid not null,bank_revision bigint not null check(bank_revision between 1 and 1000),statement_revision bigint not null check(statement_revision between 0 and 9007199254740990),
 proof jsonb not null,grant_version bigint not null,opt_in_version bigint not null,
 primary key(organization_id,request_id),unique(organization_id,bank_revision),unique(organization_id,statement_id,statement_revision),
 foreign key(organization_id,statement_id) references public.zentra_us_financial_bank_test_reconciliations on delete restrict
);
create table public.zentra_us_financial_bank_test_audit (
 organization_id text not null,bank_revision bigint not null check(bank_revision between 1 and 1000),proof jsonb not null,grant_version bigint not null,opt_in_version bigint not null,
 primary key(organization_id,bank_revision),foreign key(organization_id,bank_revision) references public.zentra_us_financial_bank_test_receipts(organization_id,bank_revision) deferrable initially deferred
);
create table public.zentra_us_financial_bank_test_entry_claims (
 organization_id text not null,entry_id text not null,cash_account_id text not null,statement_id uuid not null,match_id uuid not null,bank_revision bigint not null,
 primary key(organization_id,entry_id),foreign key(organization_id,statement_id) references public.zentra_us_financial_bank_test_reconciliations on delete restrict,
 foreign key(organization_id,bank_revision) references public.zentra_us_financial_bank_test_receipts(organization_id,bank_revision) deferrable initially deferred
);

create function public.zentra_us_pilot_bank_records(org text) returns jsonb
language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(v order by v->>'origin',v#>>'{record,reconciliation,statement,id}'),'[]'::jsonb) from (
 select jsonb_build_object('origin','legacy-frozen','record',payload)v from public.zentra_us_bank_reconciliations where organization_id=org
 union all select jsonb_build_object('origin','financial-v5','record',payload)v from public.zentra_us_financial_bank_test_reconciliations where organization_id=org)t;
$$;
create function public.zentra_us_pilot_bank_register(org text) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('schemaVersion',1,'organizationId',org,'bankRevision',coalesce((select max(bank_revision) from public.zentra_us_financial_bank_test_audit where organization_id=org),0),'records',public.zentra_us_pilot_bank_records(org),'operations',coalesce((select jsonb_agg(proof order by bank_revision) from public.zentra_us_financial_bank_test_receipts where organization_id=org),'[]'::jsonb));
$$;
create function public.zentra_us_pilot_bank_prefix(b jsonb,f bigint) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
#variable_conflict use_column
declare p jsonb;
begin
 if f is null or f<(b#>>'{baseline,revision}')::bigint+1 or f>(b->>'revision')::bigint then raise exception using errcode='BQ010',message='Invalid bank source revision';end if;
 p:=b||jsonb_build_object('revision',f,'events',coalesce((select jsonb_agg(x order by n)from jsonb_array_elements(b->'events')with ordinality t(x,n)where (x->>'revision')::bigint<=f),'[]'::jsonb));
 if jsonb_array_length(p->'events')<>f-(b#>>'{baseline,revision}')::bigint-1 then raise exception using errcode='BQ010',message='Invalid financial prefix';end if;
 return p;
end $$;
create function public.zentra_us_pilot_bank_proof(b jsonb,p jsonb) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
#variable_conflict use_column
declare q jsonb:=p->'request';a jsonb:=p->'actor';org text:=b#>>'{baseline,configuration,organizationId}';prefix jsonb;ledger jsonb;id text;digest text;
begin
 if not public.zentra_us_tax_object(p,array['schemaVersion','organizationId','request','actor','idempotencyKey','commandHash','action','statementId','bankRevision','statementRevision','source'])
 or p->'schemaVersion' is distinct from '1'::jsonb or p->>'organizationId' is distinct from org or not public.zentra_us_pilot_bank_request(q)
 or not public.zentra_us_tax_actor_valid(a,org) or not public.zentra_us_purchase_timestamp(a->>'timestamp') or cardinality(public.zentra_us_bank_utf16_key(a->>'userId'))>256
 or not public.zentra_us_tax_object(p->'source',array['revision','ledgerRevision','bookSha256'])
 or p#>'{source,revision}' is distinct from q->'expectedRevision' or not public.zentra_us_tax_safe_integer(p#>'{source,ledgerRevision}',0)
 or not public.zentra_us_tax_safe_integer(p->'bankRevision',1) or not public.zentra_us_tax_safe_integer(p->'statementRevision',0)
 or p->>'bankRevision' is distinct from ((q->>'expectedBankRevision')::bigint+1)::text
 or p->>'statementRevision' is distinct from (case when q->'expectedStatementRevision'='null'::jsonb then 0 else (q->>'expectedStatementRevision')::bigint+1 end)::text
 or p->>'action' is distinct from q#>>'{command,type}' or p->>'idempotencyKey' is distinct from 'pilot:bank:'||(q->>'requestId') then raise exception using errcode='BQ010',message='Invalid bank proof';end if;
 id:=case when q#>>'{command,type}'='create_statement' then q->>'requestId' else q#>>'{command,statementId}' end;
 digest:=public.zentra_us_financial_test_hash(jsonb_build_array(org,a->>'userId',q));
 if p->>'statementId' is distinct from id or p->>'commandHash' is distinct from digest then raise exception using errcode='BQ002',message='Bank proof identity differs';end if;
 prefix:=public.zentra_us_pilot_bank_prefix(b,(q->>'expectedRevision')::bigint);if (a->>'timestamp')::timestamptz<coalesce(prefix->'events'->-1#>>'{actor,timestamp}',prefix#>>'{promotion,actor,timestamp}')::timestamptz then raise exception using errcode='PF016',message='Bank clock precedes source';end if;ledger:=public.zentra_us_invoicing_current(prefix)->'ledger';
 if p#>>'{source,bookSha256}' is distinct from public.zentra_us_financial_test_hash(prefix) or p#>'{source,ledgerRevision}' is distinct from ledger->'revision' then raise exception using errcode='BQ010',message='Bank source fingerprint differs';end if;
 return ledger;
end $$;

-- Rebuild every bank operation against its own immutable financial prefix.
-- Old actors are facts here: current admission belongs to the incoming caller.
create function public.zentra_us_pilot_bank_history(org text) returns void
language plpgsql volatile security invoker set search_path='' as $$
#variable_conflict use_column
declare b jsonb;reg jsonb;records jsonb;ops bigint;max_b bigint;index_b bigint:=0;prior_f bigint;item record;proof jsonb;ledger jsonb;next jsonb;expected jsonb;claims bigint;actual jsonb;cash text;
begin
 b:=public.zentra_us_settlement_book(org);
 if b is null or not exists(select 1 from public.zentra_us_financial_test_cursors where organization_id=org and revision=(b->>'revision')::bigint and book_sha256=public.zentra_us_financial_test_hash(b)) then raise exception using errcode='BQ010',message='Bank financial cursor differs';end if;
 reg:=public.zentra_us_pilot_bank_register(org);
 if jsonb_array_length(reg->'records')>100 or jsonb_array_length(reg->'operations')>1000 or not public.zentra_us_bank_snapshot_capacity(reg) then raise exception using errcode='BQ009',message='Bank register capacity';end if;
 if exists(select 1 from jsonb_array_elements(reg->'records')x where not public.zentra_us_bank_record_valid(x->'record',org))
 or (select count(distinct x#>>'{record,reconciliation,statement,id}') from jsonb_array_elements(reg->'records')x)<>jsonb_array_length(reg->'records') then raise exception using errcode='BQ010',message='Invalid combined bank records';end if;
 select count(*),coalesce(max(bank_revision),0) into ops,max_b from public.zentra_us_financial_bank_test_receipts where organization_id=org;
 if ops<>max_b or ops<>(select count(*) from public.zentra_us_financial_bank_test_audit where organization_id=org) or max_b<>(reg->>'bankRevision')::bigint then raise exception using errcode='BQ010',message='Bank sequence incomplete';end if;
 select coalesce(jsonb_agg(x order by x#>>'{record,reconciliation,statement,id}'),'[]'::jsonb) into records from jsonb_array_elements(reg->'records')x where x->>'origin'='legacy-frozen';
 prior_f:=(b#>>'{baseline,revision}')::bigint+1;
 for item in select * from public.zentra_us_financial_bank_test_receipts where organization_id=org order by bank_revision loop
  index_b:=index_b+1;proof:=item.proof;
  if item.bank_revision<>index_b or proof->>'bankRevision' is distinct from item.bank_revision::text or proof->>'statementId' is distinct from item.statement_id::text or proof->>'statementRevision' is distinct from item.statement_revision::text or proof#>>'{request,requestId}' is distinct from item.request_id::text
  or not exists(select 1 from public.zentra_us_financial_bank_test_audit a where a.organization_id=org and a.bank_revision=item.bank_revision and a.proof=proof and a.grant_version=item.grant_version and a.opt_in_version=item.opt_in_version)
  or (proof#>>'{source,revision}')::bigint<prior_f then raise exception using errcode='BQ010',message='Bank proof history differs';end if;
  prior_f:=(proof#>>'{source,revision}')::bigint;ledger:=public.zentra_us_pilot_bank_proof(b,proof);
  next:=public.zentra_us_pilot_bank_transition(org,proof->'request',proof->'actor',ledger,records,true);
  if next#>>'{reconciliation,revision}' is distinct from item.statement_revision::text then raise exception using errcode='BQ010',message='Bank result revision differs';end if;
  if proof->>'action'='approve_match' then
   cash:=next#>>'{reconciliation,statement,cashAccountId}';expected:=next#>'{reconciliation,matches}'->-1->'ledgerEntryIds';
   select coalesce(jsonb_agg(to_jsonb(entry_id)order by public.zentra_us_bank_utf16_key(entry_id)),'[]'::jsonb) into actual from public.zentra_us_financial_bank_test_entry_claims where organization_id=org and bank_revision=item.bank_revision and statement_id=item.statement_id and match_id=item.request_id and cash_account_id=cash;
   if actual<>expected then raise exception using errcode='BQ010',message='Bank claim delta differs';end if;
  elsif exists(select 1 from public.zentra_us_financial_bank_test_entry_claims where organization_id=org and bank_revision=item.bank_revision) then raise exception using errcode='BQ010',message='Unexpected bank claim';end if;
  select coalesce(jsonb_agg(x),'[]'::jsonb) into records from jsonb_array_elements(records)x where x#>>'{record,reconciliation,statement,id}'<>item.statement_id::text;
  records:=records||jsonb_build_array(jsonb_build_object('origin','financial-v5','record',next));
 end loop;
 select coalesce(jsonb_agg(x order by x->>'origin',x#>>'{record,reconciliation,statement,id}'),'[]'::jsonb) into expected from jsonb_array_elements(records)x;
 if expected<>reg->'records' then raise exception using errcode='BQ010',message='Bank record replay differs';end if;
 if exists(select 1 from public.zentra_us_financial_bank_test_reconciliations r where r.organization_id=org and not exists(select 1 from public.zentra_us_financial_bank_test_receipts p where p.organization_id=org and p.statement_id=r.id and p.statement_revision=r.revision and p.proof=r.proof and p.grant_version=r.grant_version and p.opt_in_version=r.opt_in_version)) then raise exception using errcode='BQ010',message='Latest bank operation differs';end if;
 select coalesce(sum(jsonb_array_length(m->'ledgerEntryIds')),0) into claims from jsonb_array_elements(reg->'records')x cross join lateral jsonb_array_elements(x#>'{record,reconciliation,matches}')m where x->>'origin'='financial-v5';
 if claims<>(select count(*)from public.zentra_us_financial_bank_test_entry_claims where organization_id=org)
 or exists(select 1 from public.zentra_us_financial_bank_test_entry_claims c join public.zentra_us_bank_entry_claims l on l.organization_id=c.organization_id and l.entry_id=c.entry_id where c.organization_id=org) then raise exception using errcode='BQ010',message='Global bank claims differ';end if;
end $$;

create function public.zentra_us_pilot_bank_guard() returns trigger
language plpgsql volatile security invoker set search_path='' as $$
#variable_conflict use_column
declare proof jsonb;g bigint;o bigint;b jsonb;ledger jsonb;expected jsonb;prior_b bigint;
begin
 if tg_op in('DELETE','TRUNCATE') or (tg_op='UPDATE' and tg_table_name<>'zentra_us_financial_bank_test_reconciliations') then raise exception using errcode='BQ010',message='Bank history immutable';end if;
 if tg_table_name='zentra_us_financial_bank_test_entry_claims' then
  select r.proof,r.grant_version,r.opt_in_version into proof,g,o from public.zentra_us_financial_bank_test_receipts r where r.organization_id=new.organization_id and r.bank_revision=new.bank_revision;
  if proof is null then raise exception using errcode='BQ010',message='Bank claim has no receipt';end if;
 else proof:=new.proof;g:=new.grant_version;o:=new.opt_in_version;end if;
 perform public.zentra_us_financial_pilot_test_admit(new.organization_id,proof->'actor',g,o,'postgres-test-financial-pilot-dto1');
 perform 1 from public.zentra_us_financial_test_cursors where organization_id=new.organization_id for update;
 b:=public.zentra_us_settlement_book(new.organization_id);ledger:=public.zentra_us_pilot_bank_proof(b,proof);
 if tg_table_name='zentra_us_financial_bank_test_reconciliations' then
  select coalesce(max(bank_revision),0)into prior_b from public.zentra_us_financial_bank_test_audit where organization_id=new.organization_id;
  if proof#>'{request,expectedRevision}' is distinct from b->'revision' then raise exception using errcode='PF001',message='Financial revision changed';end if;
  if proof#>>'{request,expectedBankRevision}' is distinct from prior_b::text then raise exception using errcode='BQ001',message='Bank revision changed';end if;
  if tg_op='UPDATE' and (new.organization_id is distinct from old.organization_id or new.id is distinct from old.id) then raise exception using errcode='BQ010',message='Bank identity immutable';end if;
  expected:=public.zentra_us_pilot_bank_transition(new.organization_id,proof->'request',proof->'actor',ledger,public.zentra_us_pilot_bank_records(new.organization_id),false);
  if new.payload is distinct from expected or new.payload#>>'{reconciliation,statement,id}' is distinct from proof->>'statementId' or new.revision::text is distinct from proof->>'statementRevision' then raise exception using errcode='BQ010',message='Bank transition differs';end if;
 end if;
 return new;
end $$;
create function public.zentra_us_pilot_bank_complete() returns trigger
language plpgsql volatile security invoker set search_path='' as $$begin perform public.zentra_us_pilot_bank_history(new.organization_id);return null;end $$;
do $$declare name text;begin
 foreach name in array array['zentra_us_financial_bank_test_reconciliations','zentra_us_financial_bank_test_receipts','zentra_us_financial_bank_test_audit','zentra_us_financial_bank_test_entry_claims'] loop
  execute format('alter table public.%I enable row level security',name);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',name);
  execute format('grant select,insert%s on public.%I to service_role',case when name='zentra_us_financial_bank_test_reconciliations' then ',update' else '' end,name);
  execute format('create trigger bank_test_guard before insert or update or delete on public.%I for each row execute function public.zentra_us_pilot_bank_guard()',name);
  execute format('create trigger bank_test_no_truncate before truncate on public.%I for each statement execute function public.zentra_us_pilot_bank_guard()',name);
  execute format('create constraint trigger bank_test_atomic after insert or update on public.%I deferrable initially deferred for each row execute function public.zentra_us_pilot_bank_complete()',name);
 end loop;
end $$;

create function public.zentra_us_financial_pilot_bank_test_head_v1(p_organization text,p_actor jsonb,p_grant_version bigint,p_opt_in_version bigint,p_capability text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
#variable_conflict use_column
declare f bigint;b bigint;
begin
 perform public.zentra_us_financial_pilot_test_admit(p_organization,p_actor,p_grant_version,p_opt_in_version,p_capability);
 select revision into f from public.zentra_us_financial_test_cursors where organization_id=p_organization for update;
 if f is null then raise exception using errcode='BQ010',message='Promoted financial cursor required';end if;
 select coalesce(max(bank_revision),0) into b from public.zentra_us_financial_bank_test_audit where organization_id=p_organization;
 return jsonb_build_object('consumer','financial-pilot','schemaVersion',1,'organizationId',p_organization,'revision',f,'bankRevision',b);
end $$;
create function public.zentra_read_us_financial_pilot_bank_test_v1(p_organization text,p_actor jsonb,p_grant_version bigint,p_opt_in_version bigint,p_capability text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
#variable_conflict use_column
declare b jsonb;
begin
 perform public.zentra_us_financial_pilot_bank_test_head_v1(p_organization,p_actor,p_grant_version,p_opt_in_version,p_capability);
 b:=public.zentra_read_us_financial_pilot_test_v1(p_organization,p_actor,p_grant_version,p_opt_in_version,p_capability);
 perform public.zentra_us_pilot_bank_history(p_organization);
 return jsonb_build_object('book',b,'register',public.zentra_us_pilot_bank_register(p_organization));
end $$;
create function public.zentra_us_financial_pilot_bank_test_receipt_v1(p_organization text,p_actor jsonb,p_grant_version bigint,p_opt_in_version bigint,p_capability text,p_request_id uuid) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
#variable_conflict use_column
declare p jsonb;
begin
 perform public.zentra_us_financial_pilot_bank_test_head_v1(p_organization,p_actor,p_grant_version,p_opt_in_version,p_capability);
 select proof into p from public.zentra_us_financial_bank_test_receipts where organization_id=p_organization and request_id=p_request_id;
 if p is null then return null;end if;
 if p#>>'{actor,userId}' is distinct from p_actor->>'userId' then raise exception using errcode='BQ002',message='Bank receipt actor differs';end if;
 perform public.zentra_us_pilot_bank_history(p_organization);
 return p;
end $$;
create function public.zentra_commit_us_financial_pilot_bank_test_v1(p_organization text,p_actor jsonb,p_grant_version bigint,p_opt_in_version bigint,p_capability text,p_request jsonb,p_record jsonb,p_proof jsonb) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
#variable_conflict use_column
declare h jsonb;b jsonb;prior jsonb;ledger jsonb;expected jsonb;v_id uuid;match jsonb;x jsonb;before_hash text;
begin
 h:=public.zentra_us_financial_pilot_bank_test_head_v1(p_organization,p_actor,p_grant_version,p_opt_in_version,p_capability);
 if not public.zentra_us_pilot_bank_request(p_request) or p_proof->'request' is distinct from p_request or p_proof->'actor' is distinct from p_actor
 or p_proof->>'organizationId' is distinct from p_organization or p_proof->>'commandHash' is distinct from public.zentra_us_financial_test_hash(jsonb_build_array(p_organization,p_actor->>'userId',p_request)) then raise exception using errcode='BQ002',message='Bank request identity differs';end if;
 select proof into prior from public.zentra_us_financial_bank_test_receipts where organization_id=p_organization and request_id=(p_request->>'requestId')::uuid;
 if prior is not null then
  if prior is distinct from p_proof then raise exception using errcode='BQ002',message='Bank replay differs';end if;
  perform public.zentra_us_pilot_bank_history(p_organization);return prior;
 end if;
 if h->'revision' is distinct from p_request->'expectedRevision' then raise exception using errcode='PF001',message='Financial revision changed';end if;
 if h->'bankRevision' is distinct from p_request->'expectedBankRevision' then raise exception using errcode='BQ001',message='Bank revision changed';end if;
 b:=public.zentra_read_us_financial_pilot_test_v1(p_organization,p_actor,p_grant_version,p_opt_in_version,p_capability);before_hash:=public.zentra_us_financial_test_hash(b);
 perform public.zentra_us_pilot_bank_history(p_organization);ledger:=public.zentra_us_pilot_bank_proof(b,p_proof);
 expected:=public.zentra_us_pilot_bank_transition(p_organization,p_request,p_actor,ledger,public.zentra_us_pilot_bank_records(p_organization),false);
 if p_record is distinct from expected then raise exception using errcode='BQ010',message='Bank candidate differs';end if;
 v_id:=(p_proof->>'statementId')::uuid;
 if p_request#>>'{command,type}'='create_statement' then
  insert into public.zentra_us_financial_bank_test_reconciliations values(p_organization,v_id,(p_proof->>'statementRevision')::bigint,p_record,p_proof,p_grant_version,p_opt_in_version);
 else
  update public.zentra_us_financial_bank_test_reconciliations set revision=(p_proof->>'statementRevision')::bigint,payload=p_record,proof=p_proof,grant_version=p_grant_version,opt_in_version=p_opt_in_version where organization_id=p_organization and zentra_us_financial_bank_test_reconciliations.id=v_id;
  if not found then raise exception using errcode='BQ010',message='Bank record unavailable';end if;
 end if;
 insert into public.zentra_us_financial_bank_test_receipts values(p_organization,(p_request->>'requestId')::uuid,v_id,(p_proof->>'bankRevision')::bigint,(p_proof->>'statementRevision')::bigint,p_proof,p_grant_version,p_opt_in_version);
 insert into public.zentra_us_financial_bank_test_audit values(p_organization,(p_proof->>'bankRevision')::bigint,p_proof,p_grant_version,p_opt_in_version);
 if p_request#>>'{command,type}'='approve_match' then
  match:=p_record#>'{reconciliation,matches}'->-1;
  for x in select value from jsonb_array_elements(match->'ledgerEntryIds') loop
   insert into public.zentra_us_financial_bank_test_entry_claims values(p_organization,x#>>'{}',p_record#>>'{reconciliation,statement,cashAccountId}',v_id,(p_request->>'requestId')::uuid,(p_proof->>'bankRevision')::bigint);
  end loop;
 end if;
 perform public.zentra_us_pilot_bank_history(p_organization);
 if before_hash<>public.zentra_us_financial_test_hash(public.zentra_us_settlement_book(p_organization)) then raise exception using errcode='BQ010',message='Bank review changed financial book';end if;
 return p_proof;
end $$;

do $$declare f record;begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'zentra_us_pilot_bank_%' or p.proname in('zentra_us_financial_pilot_bank_test_head_v1','zentra_read_us_financial_pilot_bank_test_v1','zentra_us_financial_pilot_bank_test_receipt_v1','zentra_commit_us_financial_pilot_bank_test_v1')) loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
commit;
