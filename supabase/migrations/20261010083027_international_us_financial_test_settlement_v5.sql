-- PRIVATE LOCAL TEST SETTLEMENT ONLY. No public/native ERP5, live tax write,
-- mixed ERP command, D1 atomicity, or production activation is introduced.
begin;
do $$ begin
 if exists(select 1 from public.zentra_us_financial_test_events) then raise exception 'Empty foundation event registry required';end if;
end $$;
alter table public.zentra_us_financial_test_events add column grant_version bigint not null check(grant_version between 1 and 9007199254740990);
create table public.zentra_us_financial_test_cursors(
 organization_id text primary key references public.zentra_us_financial_test_heads on delete restrict,
 revision bigint not null check(revision between 2 and 9007199254740990),
 book_sha256 text not null check(book_sha256 ~ '^[a-f0-9]{64}$')
);
create table public.zentra_us_financial_test_tax_plans(
 organization_id text not null references public.zentra_us_financial_test_heads on delete restrict,
 idempotency_key text not null check(idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
 invoice_id text not null,proof jsonb not null,
 primary key(organization_id,idempotency_key)
);
create unique index zentra_financial_test_adjustment_plan on public.zentra_us_financial_test_tax_plans(organization_id,(proof->>'providerAccountReference'),(proof->>'adjustmentPlanReference')) where proof->>'kind'='test_adjustment_authorization';

create function public.zentra_us_settlement_minor(v jsonb,positive boolean default false) returns numeric
language plpgsql immutable security invoker set search_path='' as $$
begin
 if jsonb_typeof(v) is distinct from 'string' or v#>>'{}' !~ '^(0|[1-9][0-9]{0,35})$' or (positive and v#>>'{}'='0') then raise exception using errcode='PF004',message='Canonical integer financial amount required';end if;
 return (v#>>'{}')::numeric;
end $$;
create function public.zentra_us_settlement_round(n numeric,d numeric) returns numeric
language sql immutable security invoker set search_path='' as $$select div(n,d)+case when mod(n,d)*2>=d then 1 else 0 end$$;
create function public.zentra_us_settlement_text(v jsonb,max_length integer default 160) returns boolean
language sql immutable security invoker set search_path='' as $$
 select coalesce(jsonb_typeof(v)='string' and public.zentra_us_tax_text_valid(v#>>'{}',max_length,true) and v#>>'{}'=btrim(v#>>'{}'),false)
$$;
create function public.zentra_us_settlement_proof_valid(p jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
begin
 if not public.zentra_us_tax_object(p,array['schemaVersion','environment','invoiceFingerprint','allocationSha256','reference','verifiedBy','verifiedAt','kind'],case when p->>'kind'='test_adjustment_authorization' then array['providerAccountReference','originalTaxTransactionReference','adjustmentPlanReference','authorizedTaxMinor'] else array[]::text[] end)
 or p->'schemaVersion' is distinct from '1'::jsonb or p->>'environment' is distinct from 'test'
 or p->>'kind' not in('historical_zero_tax','test_adjustment_authorization')
 or p->>'invoiceFingerprint' !~ '^[a-f0-9]{64}$' or p->>'allocationSha256' !~ '^[a-f0-9]{64}$'
 or not public.zentra_us_tax_strings(p,array['invoiceFingerprint','allocationSha256','verifiedAt','kind','environment'])
 or not public.zentra_us_settlement_text(p->'reference',500) or not public.zentra_us_settlement_text(p->'verifiedBy',256)
 or not public.zentra_us_purchase_timestamp(p->>'verifiedAt') then return false;end if;
 if p->>'kind'='test_adjustment_authorization' then
  if not public.zentra_us_settlement_text(p->'providerAccountReference',256) or not public.zentra_us_settlement_text(p->'adjustmentPlanReference',256)
  or not public.zentra_us_settlement_text(p->'originalTaxTransactionReference',256) or p->>'originalTaxTransactionReference' !~ '^(tax_[A-Za-z0-9]+|testtxn_[A-Za-z0-9._:-]+)$' then return false;end if;
  perform public.zentra_us_settlement_minor(p->'authorizedTaxMinor');
 end if;return true;
exception when others then return false;end $$;

-- Pure transition: all current facts come from the immutable baseline and
-- already reconstructed prefix. No legacy projection/table assertion is used.
create function public.zentra_us_settlement_transition(b jsonb,op jsonb,a jsonb,id text) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare org text:=b->'baseline'->'configuration'->>'organizationId';inv jsonb;e jsonb;l jsonb;s jsonb;t jsonb;p jsonb;rec jsonb;posting jsonb;allocation jsonb;allocation_lines jsonb:='[]';journal_lines jsonb;fingerprint text;invoice_hash text;key text;kind text;event_revision bigint;ledger_revision bigint;credit_count integer:=0;received numeric:=0;credited numeric:=0;outstanding numeric;qty numeric;oldqty numeric;nextqty numeric;originalqty numeric;gross numeric;originalnet numeric;originaltax numeric;net numeric:=0;tax numeric:=0;line_net numeric;line_tax numeric;total numeric;debits numeric:=0;credits numeric:=0;cash_movement numeric:=0;dr numeric;cr numeric;seen text[]:=array[]::text[];payment_date text;transaction_date text;number text;source_id text;source_type text;description text;expected_keys text[];
begin
 perform public.zentra_us_financial_test_budget(b);perform public.zentra_us_financial_test_budget(op);
 if not public.zentra_us_tax_object(a,array['organizationId','userId','role','managementEntitled','timestamp']) or not public.zentra_us_tax_strings(a,array['organizationId','userId','role','timestamp']) or a->>'organizationId' is distinct from org or a->'managementEntitled' is distinct from 'true'::jsonb
 or a->>'role' not in('owner','admin','accountant') or not public.zentra_us_settlement_text(a->'userId',160) or not public.zentra_us_purchase_timestamp(a->>'timestamp')
 or not public.zentra_us_settlement_text(to_jsonb(id),160) then raise exception using errcode='PF004',message='Invalid settlement authority';end if;
 kind:=op->>'type';key:=op->>'idempotencyKey';
 if kind is distinct from 'customer_credit' and kind is distinct from 'customer_payment' then raise exception using errcode='PF010',message='Settlement capability excludes ERP commands';end if;
 expected_keys:=case kind when 'customer_credit' then array['type','idempotencyKey','invoiceId','transactionDate','accountingDate','periodId','reason','selections','taxProof'] else array['type','idempotencyKey','invoiceId','amountMinor','paymentDate','accountingDate','periodId','reference'] end;
 if not public.zentra_us_tax_object(op,expected_keys) or not public.zentra_us_tax_strings(op,array['type','idempotencyKey','invoiceId','accountingDate','periodId'])
 or key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' or not public.zentra_us_settlement_text(op->'invoiceId') or not public.zentra_us_settlement_text(op->'periodId')
 or not public.zentra_us_purchase_date(op->>'accountingDate') then raise exception using errcode='PF004',message='Invalid settlement operation';end if;
 if jsonb_array_length(b->'events')>=1000 or (b->>'revision')::bigint>=9007199254740990 or (b->'baseline'->'ledger'->>'revision')::bigint+jsonb_array_length(b->'events')>=9007199254740990 then raise exception using errcode='PF012',message='Settlement history limit reached';end if;
 if exists(select 1 from jsonb_array_elements(b->'events') x where x->'operation'->>'idempotencyKey'=key or x->>'id'=id)
 or exists(select 1 from jsonb_array_elements(b->'baseline'->'invoices') i cross join lateral jsonb_array_elements(i->'payments') x where x->>'idempotencyKey'=key or x->>'id'=id)
 or exists(select 1 from jsonb_array_elements(coalesce(b->'baseline'->'vendorPayments','[]')) x where x->>'idempotencyKey'=key)
 or exists(select 1 from jsonb_array_elements(b->'baseline'->'ledger'->'entries') x where x->>'idempotencyKey'=key) then raise exception using errcode='PF002',message='Settlement identity already reserved';end if;
 if (a->>'timestamp')::timestamptz<(b->'policy'->'approval'->>'reviewedAt')::timestamptz or (a->>'timestamp')::timestamptz<(b->'promotion'->'actor'->>'timestamp')::timestamptz
 or exists(select 1 from jsonb_array_elements(b->'baseline'->'ledger'->'audit') x where (x->>'timestamp')::timestamptz>(a->>'timestamp')::timestamptz)
 or exists(select 1 from jsonb_array_elements(b->'baseline'->'invoices') x where (x->>'issuedAt')::timestamptz>(a->>'timestamp')::timestamptz)
 or exists(select 1 from jsonb_array_elements(b->'events') x where (x->'actor'->>'timestamp')::timestamptz>(a->>'timestamp')::timestamptz) then raise exception using errcode='PF016',message='Settlement chronology reversed';end if;
 select x into inv from jsonb_array_elements(b->'baseline'->'invoices') x where x->>'id'=op->>'invoiceId';
 if inv is null or not exists(select 1 from jsonb_array_elements(b->'baseline'->'ledger'->'entries') x where x->'source'->>'type'='customer_invoice' and x->'source'->>'id'=inv->>'id' and not exists(select 1 from jsonb_array_elements(b->'baseline'->'ledger'->'entries') r where r->>'reversesEntryId'=x->>'id')) then raise exception using errcode='PF004',message='Posted source invoice required';end if;
 if not exists(select 1 from jsonb_array_elements(b->'baseline'->'ledger'->'periods') x where x->>'id'=op->>'periodId' and x->>'status'='open' and op->>'accountingDate'>=x->>'start' and op->>'accountingDate'<=x->>'end')
 or exists(select 1 from jsonb_array_elements(b->'baseline'->'ledger'->'periods') x where x->>'status'='closed' and op->>'accountingDate'<=x->>'end') then raise exception using errcode='PF015',message='Open accounting period required';end if;
 select coalesce(sum(public.zentra_us_settlement_minor(x->'amount'->'minorUnits')),0) into received from jsonb_array_elements(inv->'payments') x;
 for e in select value from jsonb_array_elements(b->'events') loop
  if e->'operation'->>'type'='customer_credit' then credit_count:=credit_count+1;end if;
  if e->'operation'->>'invoiceId'=inv->>'id' then
   if e->'operation'->>'type'='customer_credit' then credited:=credited+public.zentra_us_settlement_minor(e->'record'->'allocation'->'totalMinor');else received:=received+public.zentra_us_settlement_minor(e->'record'->'amount'->'minorUnits');end if;
  end if;
 end loop;
 outstanding:=public.zentra_us_settlement_minor(inv->'total'->'minorUnits')-received-credited;
 event_revision:=(b->>'revision')::bigint+1;ledger_revision:=(b->'baseline'->'ledger'->>'revision')::bigint+jsonb_array_length(b->'events')+1;
 if kind='customer_credit' then
  if not public.zentra_us_purchase_date(op->>'transactionDate') or op->>'transactionDate'<inv->>'date' or not public.zentra_us_settlement_text(op->'reason',500)
  or jsonb_typeof(op->'selections') is distinct from 'array' or jsonb_array_length(op->'selections') not between 1 and 1000 then raise exception using errcode='PF004',message='Invalid customer credit';end if;
  invoice_hash:=public.zentra_us_financial_test_hash(inv-'payments');
  for s in select value from jsonb_array_elements(op->'selections') loop
   if not public.zentra_us_tax_object(s,array['lineId','quantityUnits']) or not public.zentra_us_settlement_text(s->'lineId') or s->>'lineId'=any(seen)
   or not exists(select 1 from jsonb_array_elements(inv->'lines') x where x->>'id'=s->>'lineId') then raise exception using errcode='PF004',message='Invalid credit selection';end if;
   perform public.zentra_us_settlement_minor(s->'quantityUnits',true);seen:=array_append(seen,s->>'lineId');
  end loop;
  for l in select value from jsonb_array_elements(inv->'lines') loop
   select x into s from jsonb_array_elements(op->'selections') x where x->>'lineId'=l->>'id';if s is null then continue;end if;
   qty:=public.zentra_us_settlement_minor(s->'quantityUnits',true);originalqty:=public.zentra_us_settlement_minor(l->'quantityUnits',true);oldqty:=0;
   for e in select value from jsonb_array_elements(b->'events') where value->'operation'->>'type'='customer_credit' and value->'operation'->>'invoiceId'=inv->>'id' loop
    select x into t from jsonb_array_elements(e->'record'->'allocation'->'lines') x where x->>'lineId'=l->>'id';if t is not null then oldqty:=oldqty+public.zentra_us_settlement_minor(t->'quantityUnits',true);end if;
   end loop;
   nextqty:=oldqty+qty;if nextqty>originalqty then raise exception using errcode='PF013',message='Credit quantity exceeds remainder';end if;
   gross:=public.zentra_us_settlement_round(public.zentra_us_settlement_minor(l->'unitPrice'->'minorUnits')*originalqty,power(10::numeric,(l->>'quantityScale')::integer));
   originalnet:=gross-public.zentra_us_settlement_round(gross*(l->>'discountBasisPoints')::numeric,10000);
   select x into t from jsonb_array_elements(inv->'taxAssessment'->'lines') x where x->>'id'=l->>'id';originaltax:=public.zentra_us_settlement_minor(t->'taxMinor');
   line_net:=public.zentra_us_settlement_round(originalnet*nextqty,originalqty)-public.zentra_us_settlement_round(originalnet*oldqty,originalqty);
   line_tax:=public.zentra_us_settlement_round(originaltax*nextqty,originalqty)-public.zentra_us_settlement_round(originaltax*oldqty,originalqty);
   allocation_lines:=allocation_lines||jsonb_build_array(jsonb_build_object('lineId',l->>'id','quantityUnits',qty::text,'netMinor',line_net::text,'taxMinor',line_tax::text,'totalMinor',(line_net+line_tax)::text));net:=net+line_net;tax:=tax+line_tax;
  end loop;
  total:=net+tax;if total<=0 or total>outstanding then raise exception using errcode='PF013',message='Credit exceeds outstanding amount or is zero';end if;
  allocation:=jsonb_build_object('invoiceFingerprint',invoice_hash,'lines',allocation_lines,'netMinor',net::text,'taxMinor',tax::text,'totalMinor',total::text);p:=op->'taxProof';
  if not public.zentra_us_settlement_proof_valid(p) or p->>'invoiceFingerprint' is distinct from invoice_hash or p->>'allocationSha256' is distinct from public.zentra_us_financial_test_hash(allocation)
  or (p->>'verifiedAt')::timestamptz>(a->>'timestamp')::timestamptz or (p->>'verifiedAt')::timestamptz<(inv->>'issuedAt')::timestamptz or inv->'taxAssessment'->>'source' not in('external-provider','documented-exemption') then raise exception using errcode='PF014',message='Corroborated historical tax plan required';end if;
  if p->>'kind'='historical_zero_tax' then
   if tax<>0 or exists(select 1 from jsonb_array_elements(op->'selections') selected_line join lateral jsonb_array_elements(inv->'taxAssessment'->'lines') tax_line on tax_line->>'id'=selected_line->>'lineId' where public.zentra_us_settlement_minor(tax_line->'taxMinor')<>0) then raise exception using errcode='PF014',message='Nonzero historical tax requires an adjustment plan';end if;
  else
   if public.zentra_us_settlement_minor(p->'authorizedTaxMinor')<>tax or exists(select 1 from jsonb_array_elements(b->'events') x where x->'operation'->>'type'='customer_credit' and x->'operation'->'taxProof'->>'kind'='test_adjustment_authorization' and x->'operation'->'taxProof'->>'providerAccountReference'=p->>'providerAccountReference' and (x->'operation'->'taxProof'->>'adjustmentPlanReference'=p->>'adjustmentPlanReference' or (x->'operation'->'taxProof'->>'originalTaxTransactionReference'=p->>'originalTaxTransactionReference' and x->'operation'->>'invoiceId'<>inv->>'id'))) then raise exception using errcode='PF014',message='Tax adjustment plan conflict';end if;
  end if;
  number:='CR-'||left(op->>'transactionDate',4)||'-'||lpad((credit_count+1)::text,6,'0');
  rec:=jsonb_build_object('id',id,'organizationId',org,'number',number,'invoiceId',inv->>'id','invoiceNumber',inv->>'number','invoiceFingerprint',invoice_hash,'customerId',inv->'customer'->>'id','currency','USD','transactionDate',op->>'transactionDate','accountingDate',op->>'accountingDate','periodId',op->>'periodId','reason',op->>'reason','allocation',allocation,'taxDisposition',case when p->>'kind'='historical_zero_tax' then 'historical_zero_tax' else 'adjustment_pending' end,'issuedBy',a->>'userId','issuedAt',a->>'timestamp','recordedRevision',event_revision);
  journal_lines:='[]';if net<>0 then journal_lines:=journal_lines||jsonb_build_array(jsonb_build_object('accountId','sales','debitMinor',net::text,'creditMinor','0'));end if;if tax<>0 then journal_lines:=journal_lines||jsonb_build_array(jsonb_build_object('accountId','tax-payable','debitMinor',tax::text,'creditMinor','0'));end if;
  journal_lines:=journal_lines||jsonb_build_array(jsonb_build_object('accountId','receivables','debitMinor','0','creditMinor',total::text));
  transaction_date:=op->>'transactionDate';payment_date:=null;key:='credit:'||key;source_type:='customer_credit';source_id:=id;description:='Credit '||number;
 else
  total:=public.zentra_us_settlement_minor(op->'amountMinor',true);if total>outstanding then raise exception using errcode='PF013',message='Payment exceeds outstanding amount';end if;
  if not public.zentra_us_purchase_date(op->>'paymentDate') or op->>'paymentDate'<inv->>'date' or not public.zentra_us_settlement_text(op->'reference',500) then raise exception using errcode='PF004',message='Invalid customer payment';end if;
  rec:=jsonb_build_object('id',id,'idempotencyKey',key,'organizationId',org,'invoiceId',inv->>'id','amount',jsonb_build_object('currency','USD','minorUnits',total::text),'paymentDate',op->>'paymentDate','accountingDate',op->>'accountingDate','reference',op->>'reference','recordedBy',a->>'userId');
  journal_lines:=jsonb_build_array(jsonb_build_object('accountId','cash','debitMinor',total::text,'creditMinor','0','description',public.zentra_us_erp_v4_canonical(jsonb_build_array(id,op->>'reference'))),jsonb_build_object('accountId','receivables','debitMinor','0','creditMinor',total::text));
  transaction_date:=op->>'paymentDate';payment_date:=transaction_date;key:='payment:'||key;source_type:='customer_payment';source_id:=inv->>'id';description:='Payment '||(inv->>'number');
 end if;
 if exists(select 1 from jsonb_array_elements(b->'baseline'->'ledger'->'entries') x where x->>'idempotencyKey'=key or x->>'id'='entry:'||key)
 or exists(select 1 from jsonb_array_elements(b->'events') x where x->'posting'->>'idempotencyKey'=key or x->'posting'->>'id'='entry:'||key) then raise exception using errcode='PF002',message='Posting identity already reserved';end if;
 for l in select value from jsonb_array_elements(journal_lines) loop
  dr:=public.zentra_us_settlement_minor(l->'debitMinor');cr:=public.zentra_us_settlement_minor(l->'creditMinor');
  if (dr=0 and cr=0) or (dr>0 and cr>0) then raise exception using errcode='PF004',message='Exclusive nonzero journal line required';end if;
  select x into t from jsonb_array_elements(b->'baseline'->'ledger'->'accounts') x where x->>'id'=l->>'accountId';
  if t is null then raise exception using errcode='PF004',message='Required ledger account missing';end if;
  debits:=debits+dr;credits:=credits+cr;if t->'cash'='true'::jsonb then cash_movement:=cash_movement+dr-cr;end if;
 end loop;
 if debits<>credits or debits=0 or (cash_movement<>0 and kind<>'customer_payment') then raise exception using errcode='PF004',message='Balanced classified financial posting required';end if;
 fingerprint:=public.zentra_us_erp_v4_canonical(jsonb_build_array(org,'USD','accrual',transaction_date,op->>'accountingDate',payment_date,op->>'periodId',description,source_type,source_id,case when kind='customer_payment' then 'operating' else null end,null,(select jsonb_agg(jsonb_build_array(x->>'accountId',x->>'debitMinor',x->>'creditMinor',x->>'description') order by n) from jsonb_array_elements(journal_lines) with ordinality t(x,n))));
 posting:=jsonb_build_object('id','entry:'||key,'idempotencyKey',key,'organizationId',org,'currency','USD','basis','accrual','transactionDate',transaction_date,'accountingDate',op->>'accountingDate','periodId',op->>'periodId','description',description,'source',jsonb_build_object('type',source_type,'id',source_id),'lines',journal_lines,'postedBy',a->>'userId','postedAt',a->>'timestamp','revision',ledger_revision,'fingerprint',fingerprint);
 if kind='customer_payment' then posting:=posting||jsonb_build_object('paymentDate',payment_date,'cashFlowCategory','operating');end if;
 return jsonb_build_object('revision',event_revision,'id',id,'operation',op,'actor',a,'record',rec,'posting',posting);
end $$;

create function public.zentra_us_settlement_replay(b jsonb) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare current_book jsonb;e jsonb;rebuilt jsonb;
begin
 perform public.zentra_us_financial_test_budget(b);
 if not public.zentra_us_tax_object(b,array['schemaVersion','revision','baseline','policy','promotion','events']) or b->'schemaVersion' is distinct from '5'::jsonb or jsonb_typeof(b->'events') is distinct from 'array'
 or b->'revision' is distinct from to_jsonb((b->'baseline'->>'revision')::bigint+1+jsonb_array_length(b->'events')) then raise exception using errcode='PF004',message='Invalid settlement book';end if;
 current_book:=b||jsonb_build_object('revision',(b->'baseline'->>'revision')::bigint+1,'events','[]'::jsonb);
 for e in select value from jsonb_array_elements(b->'events') loop
  if not public.zentra_us_tax_object(e,array['revision','id','operation','actor','record','posting']) or jsonb_typeof(e->'id') is distinct from 'string' then raise exception using errcode='PF004',message='Invalid settlement event';end if;
  rebuilt:=public.zentra_us_settlement_transition(current_book,e->'operation',e->'actor',e->>'id');
  if rebuilt is distinct from e then raise exception using errcode='PF004',message='Settlement event differs from independent reconstruction';end if;
  current_book:=current_book||jsonb_build_object('revision',e->'revision','events',(current_book->'events')||jsonb_build_array(rebuilt));
 end loop;return current_book;
end $$;
create function public.zentra_us_settlement_receipt(b jsonb,e jsonb) returns jsonb
language sql immutable security invoker set search_path='' as $$
 select jsonb_build_object('idempotencyKey',e->'operation'->>'idempotencyKey','commandHash',public.zentra_us_financial_test_hash(jsonb_build_array(b->'baseline'->'configuration'->>'organizationId',e->'actor'->>'userId',jsonb_build_object('idempotencyKey',e->'operation'->>'idempotencyKey','expectedRevision',(e->>'revision')::bigint-1,'command',((e->'operation')-'idempotencyKey'-'taxProof')||jsonb_build_object('id',e->>'id')))),'revision',e->'revision','entityId',e->>'id','action',e->'operation'->>'type','actorId',e->'actor'->>'userId');
$$;
create function public.zentra_us_settlement_admit(org text,a jsonb,v bigint,cap text) returns void
language plpgsql volatile security invoker set search_path='' as $$
begin
 if cap is distinct from 'postgres-test-settlement-v5' then raise exception using errcode='PF009',message='Private settlement TEST capability required';end if;
 perform public.zentra_us_financial_test_admit(org,a,v,'postgres-test-foundation-v5');
 -- TEST audit-clock tolerance, not a tax/accounting rule. Evaluated after
 -- authoritative locks; historical read/retry actors remain valid.
 if (a->>'timestamp')::timestamptz>clock_timestamp()+interval '30 seconds' then raise exception using errcode='PF016',message='Financial actor clock exceeds TEST tolerance';end if;
end $$;
create function public.zentra_us_settlement_book(org text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare h public.zentra_us_financial_test_heads%rowtype;b jsonb;
begin
 select * into h from public.zentra_us_financial_test_heads where organization_id=org;if not found then return null;end if;
 select public.zentra_us_financial_test_book(h)||jsonb_build_object('revision',h.revision+count(*),'events',coalesce(jsonb_agg(payload order by revision),'[]'::jsonb)) into b from public.zentra_us_financial_test_events where organization_id=org;
 return public.zentra_us_settlement_replay(b);
end $$;
create function public.zentra_us_settlement_plans(b jsonb) returns void
language plpgsql volatile security invoker set search_path='' as $$
declare e jsonb;p public.zentra_us_financial_test_tax_plans%rowtype;
begin
 for e in select value from jsonb_array_elements(b->'events') where value->'operation'->>'type'='customer_credit' loop
  select * into p from public.zentra_us_financial_test_tax_plans where organization_id=b->'baseline'->'configuration'->>'organizationId' and idempotency_key=e->'operation'->>'idempotencyKey';
  if not found or p.invoice_id is distinct from e->'operation'->>'invoiceId' or p.proof is distinct from e->'operation'->'taxProof' then raise exception using errcode='PF014',message='Private TEST tax plan required';end if;
 end loop;
end $$;
create function public.zentra_us_settlement_plan_guard() returns trigger
language plpgsql volatile security invoker set search_path='' as $$
begin
 if current_user='service_role' or tg_op<>'INSERT' then raise exception using errcode='PF003',message='Private immutable TEST plan administration required';end if;
 if not public.zentra_us_settlement_proof_valid(new.proof) or not public.zentra_us_settlement_text(to_jsonb(new.invoice_id)) then raise exception using errcode='PF004',message='Invalid private TEST plan';end if;
 return new;
end $$;
create trigger zentra_settlement_plan_guard before insert or update or delete on public.zentra_us_financial_test_tax_plans for each row execute function public.zentra_us_settlement_plan_guard();
create trigger zentra_settlement_plan_truncate before truncate on public.zentra_us_financial_test_tax_plans for each statement execute function public.zentra_us_settlement_plan_guard();

create function public.zentra_us_settlement_cursor_guard() returns trigger
language plpgsql volatile security invoker set search_path='' as $$
declare b jsonb;h public.zentra_us_financial_test_heads%rowtype;
begin
 if tg_op not in('INSERT','UPDATE') then raise exception using errcode='PF003',message='Settlement cursor cannot be removed';end if;
 if tg_op='UPDATE' and (new.organization_id is distinct from old.organization_id or new.revision<>old.revision+1) then raise exception using errcode='PF001',message='Exact settlement cursor CAS required';end if;
 b:=public.zentra_us_settlement_book(new.organization_id);perform public.zentra_us_settlement_plans(b);
 if b is null or new.revision is distinct from (b->>'revision')::bigint or new.book_sha256 is distinct from public.zentra_us_financial_test_hash(b) then raise exception using errcode='PF004',message='Invalid settlement cursor';end if;
 if tg_op='INSERT' and jsonb_array_length(b->'events')<>0 then raise exception using errcode='PF004',message='Cursor must start at immutable promotion';end if;
 return new;
end $$;
create trigger zentra_settlement_cursor_guard before insert or update or delete on public.zentra_us_financial_test_cursors for each row execute function public.zentra_us_settlement_cursor_guard();
create trigger zentra_settlement_cursor_truncate before truncate on public.zentra_us_financial_test_cursors for each statement execute function public.zentra_us_settlement_cursor_guard();
create function public.zentra_us_settlement_seed() returns trigger
language plpgsql volatile security invoker set search_path='' as $$
begin insert into public.zentra_us_financial_test_cursors values(new.organization_id,new.revision,new.book_sha256);return null;end $$;
insert into public.zentra_us_financial_test_cursors select organization_id,revision,book_sha256 from public.zentra_us_financial_test_heads;
create trigger zentra_settlement_seed after insert on public.zentra_us_financial_test_heads for each row execute function public.zentra_us_settlement_seed();

create function public.zentra_us_settlement_event_guard() returns trigger
language plpgsql volatile security invoker set search_path='' as $$
declare b jsonb;e jsonb;c public.zentra_us_financial_test_cursors%rowtype;
begin
 if tg_op<>'INSERT' then raise exception using errcode='PF003',message='Financial events are immutable';end if;
 perform public.zentra_us_settlement_admit(new.organization_id,new.payload->'actor',new.grant_version,'postgres-test-settlement-v5');
 select * into c from public.zentra_us_financial_test_cursors where organization_id=new.organization_id for update;
 if not found or new.revision<>c.revision+1 then raise exception using errcode='PF001',message='Exact financial event CAS required';end if;
 b:=public.zentra_us_settlement_book(new.organization_id);
 if (b->>'revision')::bigint<>c.revision or public.zentra_us_financial_test_hash(b)<>c.book_sha256 then raise exception using errcode='PF004',message='Financial cursor history mismatch';end if;
 e:=public.zentra_us_settlement_transition(b,new.payload->'operation',new.payload->'actor',new.payload->>'id');
 if e is distinct from new.payload or new.revision is distinct from (e->>'revision')::bigint then raise exception using errcode='PF004',message='Uncorroborated financial event';end if;
 b:=b||jsonb_build_object('revision',e->'revision','events',(b->'events')||jsonb_build_array(e));perform public.zentra_us_financial_test_budget(b);perform public.zentra_us_settlement_plans(b);
 if exists(select 1 from public.zentra_us_financial_test_receipts where organization_id=new.organization_id and idempotency_key=e->'operation'->>'idempotencyKey') then raise exception using errcode='PF002',message='Historical key already reserved';end if;
 return new;
end $$;
drop trigger zentra_financial_test_event_guard on public.zentra_us_financial_test_events;
create trigger zentra_settlement_event_guard before insert or update or delete on public.zentra_us_financial_test_events for each row execute function public.zentra_us_settlement_event_guard();
create function public.zentra_us_settlement_receipt_guard() returns trigger
language plpgsql volatile security invoker set search_path='' as $$
declare h public.zentra_us_financial_test_heads%rowtype;r public.zentra_us_erp_receipts%rowtype;e jsonb;b jsonb;
begin
 if tg_op<>'INSERT' then raise exception using errcode='PF003',message='Financial receipts are immutable';end if;
 if new.origin='financial_v5' then
  b:=public.zentra_us_settlement_book(new.organization_id);select payload into e from public.zentra_us_financial_test_events where organization_id=new.organization_id and payload->'operation'->>'idempotencyKey'=new.idempotency_key;
  if e is null or new.actor_id is distinct from e->'actor'->>'userId' or new.receipt is distinct from public.zentra_us_settlement_receipt(b,e) then raise exception using errcode='PF004',message='Invalid corroborated financial receipt';end if;
 elsif new.origin='promotion' then
  select * into h from public.zentra_us_financial_test_heads where organization_id=new.organization_id;
  if not found or new.idempotency_key is distinct from h.promotion_key or new.actor_id is distinct from h.promotion->'actor'->>'userId' or new.receipt is distinct from h.promotion_receipt then raise exception using errcode='PF004',message='Invalid promotion receipt';end if;
 else
  select * into r from public.zentra_us_erp_receipts where organization_id=new.organization_id and idempotency_key=new.idempotency_key;
  if not found or new.actor_id is distinct from r.actor_id or new.receipt is distinct from r.receipt then raise exception using errcode='PF004',message='Invalid historical receipt';end if;
 end if;return new;
end $$;
drop trigger zentra_financial_test_receipt_guard on public.zentra_us_financial_test_receipts;
create trigger zentra_settlement_receipt_guard before insert or update or delete on public.zentra_us_financial_test_receipts for each row execute function public.zentra_us_settlement_receipt_guard();
create function public.zentra_us_settlement_complete() returns trigger
language plpgsql volatile security invoker set search_path='' as $$
declare b jsonb;c public.zentra_us_financial_test_cursors%rowtype;e jsonb;
begin
 b:=public.zentra_us_settlement_book(new.organization_id);perform public.zentra_us_settlement_plans(b);select * into c from public.zentra_us_financial_test_cursors where organization_id=new.organization_id;
 if b is null or not found or c.revision<>(b->>'revision')::bigint or c.book_sha256<>public.zentra_us_financial_test_hash(b) then raise exception using errcode='PF004',message='Complete financial cursor required';end if;
 for e in select value from jsonb_array_elements(b->'events') loop
  if not exists(select 1 from public.zentra_us_financial_test_receipts r where r.organization_id=new.organization_id and r.idempotency_key=e->'operation'->>'idempotencyKey' and r.origin='financial_v5' and r.actor_id=e->'actor'->>'userId' and r.receipt=public.zentra_us_settlement_receipt(b,e)) then raise exception using errcode='PF004',message='Complete financial receipt history required';end if;
 end loop;return null;
end $$;
create constraint trigger zentra_settlement_event_complete after insert on public.zentra_us_financial_test_events deferrable initially deferred for each row execute function public.zentra_us_settlement_complete();
create constraint trigger zentra_settlement_cursor_complete after insert or update on public.zentra_us_financial_test_cursors deferrable initially deferred for each row execute function public.zentra_us_settlement_complete();
create constraint trigger zentra_settlement_receipt_complete after insert on public.zentra_us_financial_test_receipts deferrable initially deferred for each row execute function public.zentra_us_settlement_complete();

create function public.zentra_read_us_financial_settlement_test_v5(p_organization text,p_actor jsonb,p_grant_version bigint,p_capability text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare b jsonb;c public.zentra_us_financial_test_cursors%rowtype;
begin
 perform public.zentra_us_settlement_admit(p_organization,p_actor,p_grant_version,p_capability);b:=public.zentra_us_settlement_book(p_organization);if b is null then return null;end if;
 perform public.zentra_us_settlement_plans(b);select * into c from public.zentra_us_financial_test_cursors where organization_id=p_organization for update;
 if not found or c.revision<>(b->>'revision')::bigint or c.book_sha256<>public.zentra_us_financial_test_hash(b) then raise exception using errcode='PF004',message='Financial cursor mismatch';end if;return b;
end $$;
create function public.zentra_us_financial_settlement_test_receipt_v5(p_organization text,p_actor jsonb,p_grant_version bigint,p_capability text,p_idempotency_key text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare r public.zentra_us_financial_test_receipts%rowtype;b jsonb;
begin
 b:=public.zentra_read_us_financial_settlement_test_v5(p_organization,p_actor,p_grant_version,p_capability);
 if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 240 then raise exception using errcode='PF004',message='Invalid financial receipt key';end if;
 select * into r from public.zentra_us_financial_test_receipts where organization_id=p_organization and idempotency_key=p_idempotency_key;if not found then return null;end if;
 return jsonb_build_object('origin',r.origin,'actorId',r.actor_id,'receipt',r.receipt);
end $$;
create function public.zentra_append_us_financial_settlement_test_v5(p_organization text,p_actor jsonb,p_grant_version bigint,p_capability text,p_expected_revision bigint,p_previous_fingerprint text,p_book jsonb,p_receipt jsonb) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare b jsonb;e jsonb;expected_receipt jsonb;prior public.zentra_us_financial_test_receipts%rowtype;prefix jsonb;
begin
 b:=public.zentra_read_us_financial_settlement_test_v5(p_organization,p_actor,p_grant_version,p_capability);if b is null then raise exception using errcode='PF004',message='Promoted financial book required';end if;
 perform public.zentra_us_financial_test_budget(p_book);perform public.zentra_us_financial_test_budget(p_receipt);
 if p_expected_revision is null or p_expected_revision<1 or p_previous_fingerprint is null or p_previous_fingerprint !~ '^[a-f0-9]{64}$'
 or not public.zentra_us_tax_object(p_book,array['schemaVersion','revision','baseline','policy','promotion','events']) or jsonb_typeof(p_book->'events') is distinct from 'array' or jsonb_array_length(p_book->'events')<1
 or p_book-'events'-'revision' is distinct from b-'events'-'revision' then raise exception using errcode='PF004',message='Invalid financial commit envelope';end if;
 e:=p_book->'events'->-1;
 if e->'actor' is distinct from p_actor or not public.zentra_us_tax_object(e,array['revision','id','operation','actor','record','posting']) then raise exception using errcode='PF004',message='Invalid financial event envelope';end if;
 if e->'operation'->>'type' is distinct from 'customer_credit' and e->'operation'->>'type' is distinct from 'customer_payment' then raise exception using errcode='PF010',message='Settlement capability excludes ERP commands';end if;
 expected_receipt:=public.zentra_us_settlement_receipt(p_book,e);if p_receipt is distinct from expected_receipt then raise exception using errcode='PF004',message='Financial request hash differs';end if;
 select * into prior from public.zentra_us_financial_test_receipts where organization_id=p_organization and idempotency_key=e->'operation'->>'idempotencyKey';
 if found then
  if prior.origin<>'financial_v5' or prior.receipt is distinct from p_receipt or prior.actor_id is distinct from p_actor->>'userId' then raise exception using errcode='PF002',message='Financial idempotency conflict';end if;
  prefix:=b||jsonb_build_object('revision',p_expected_revision+1,'events',(select coalesce(jsonb_agg(x order by n),'[]'::jsonb) from jsonb_array_elements(b->'events') with ordinality t(x,n) where (x->>'revision')::bigint<=p_expected_revision+1));
  if prefix is distinct from p_book or p_expected_revision<>(e->>'revision')::bigint-1 or p_previous_fingerprint<>public.zentra_us_financial_test_hash(prefix||jsonb_build_object('revision',p_expected_revision,'events',(prefix->'events')-((jsonb_array_length(prefix->'events'))-1))) then raise exception using errcode='PF002',message='Financial replay envelope differs';end if;return prior.receipt;
 end if;
 if (b->>'revision')::bigint<>p_expected_revision then raise exception using errcode='PF001',message='Financial revision changed';end if;
 if p_previous_fingerprint<>public.zentra_us_financial_test_hash(b) then raise exception using errcode='PF001',message='Financial source fingerprint changed';end if;
 if p_book->'revision' is distinct from to_jsonb(p_expected_revision+1) or p_book->'events' is distinct from (b->'events')||jsonb_build_array(e) then raise exception using errcode='PF004',message='Exact financial prefix required';end if;
 insert into public.zentra_us_financial_test_events values(p_organization,p_expected_revision+1,e,p_grant_version);
 insert into public.zentra_us_financial_test_receipts values(p_organization,e->'operation'->>'idempotencyKey','financial_v5',p_actor->>'userId',p_receipt);
 update public.zentra_us_financial_test_cursors set revision=p_expected_revision+1,book_sha256=public.zentra_us_financial_test_hash(p_book) where organization_id=p_organization and revision=p_expected_revision and book_sha256=p_previous_fingerprint;
 if not found then raise exception using errcode='PF001',message='Financial CAS changed';end if;return p_receipt;
end $$;

-- The earlier capability must never label a frozen promotion as current after
-- a settlement tail exists. Replace in place; no unguarded renamed RPC.
do $$ declare f record;body text;wrapped integer:=0;begin
 for f in select p.* from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('zentra_read_us_financial_test_v5','zentra_us_financial_test_receipt_v5','zentra_promote_us_financial_test_v5') loop
  body:=regexp_replace(f.prosrc,'perform public.zentra_us_financial_test_admit\(p_organization,p_actor,p_grant_version,p_capability\);','perform public.zentra_us_financial_test_admit(p_organization,p_actor,p_grant_version,p_capability); if exists(select 1 from public.zentra_us_financial_test_events where organization_id=p_organization) then raise exception using errcode=''PF008'',message=''Settlement capability required'';end if;');
  if f.proname='zentra_promote_us_financial_test_v5' then body:=regexp_replace(f.prosrc,'approved:=public.zentra_us_financial_test_admit\(p_organization,p_actor,p_grant_version,p_capability\);','approved:=public.zentra_us_financial_test_admit(p_organization,p_actor,p_grant_version,p_capability); if exists(select 1 from public.zentra_us_financial_test_events where organization_id=p_organization) then raise exception using errcode=''PF008'',message=''Settlement capability required'';end if;');end if;
  if body=f.prosrc then raise exception 'Exact foundation admission prerequisite required';end if;
  execute format('create or replace function public.%I(%s) returns jsonb language plpgsql volatile security invoker set search_path='''' as %L',f.proname,pg_get_function_arguments(f.oid),body);
  wrapped:=wrapped+1;
 end loop;
 if wrapped<>3 then raise exception 'Three exact foundation prerequisites required';end if;
end $$;
do $$ declare t text;f record;begin
 foreach t in array array['zentra_us_financial_test_cursors','zentra_us_financial_test_tax_plans'] loop
  execute format('alter table public.%I enable row level security',t);execute format('revoke all on table public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select,insert,update on table public.%I to service_role',t);execute format('create policy zentra_settlement_server on public.%I for all to service_role using(true) with check(true)',t);
 end loop;
 revoke insert,update on public.zentra_us_financial_test_tax_plans from service_role;
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'zentra_us_settlement_%' or p.proname in('zentra_read_us_financial_settlement_test_v5','zentra_us_financial_settlement_test_receipt_v5','zentra_append_us_financial_settlement_test_v5')) loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
commit;
