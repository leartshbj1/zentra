-- Private LOCAL TEST only. Same immutable baseline + canonical ordered tail.
-- Accounting continuation: no provider, public ERP5, legacy thaw or CH mutation.
begin;
lock table public.zentra_us_financial_test_heads,public.zentra_us_financial_test_events,public.zentra_us_financial_test_cursors,public.zentra_us_financial_test_receipts,public.zentra_us_financial_test_tax_plans in share row exclusive mode;
do $$ declare h record;b jsonb;e jsonb;begin
 for h in select organization_id from public.zentra_us_financial_test_heads order by organization_id loop
  b:=public.zentra_us_settlement_book(h.organization_id);perform public.zentra_us_settlement_plans(b);
  if not exists(select 1 from public.zentra_us_financial_test_cursors c where c.organization_id=h.organization_id and c.revision=(b->>'revision')::bigint and c.book_sha256=public.zentra_us_financial_test_hash(b)) then raise exception using errcode='PF004',message='Valid prior private cursor required';end if;
  for e in select value from jsonb_array_elements(b->'events') loop
   if not exists(select 1 from public.zentra_us_financial_test_receipts r where r.organization_id=h.organization_id and r.idempotency_key=e->'operation'->>'idempotencyKey' and r.origin='financial_v5' and r.actor_id=e->'actor'->>'userId' and r.receipt=public.zentra_us_settlement_receipt(b,e)) then raise exception using errcode='PF004',message='Valid prior private receipt required';end if;
  end loop;
 end loop;
end $$;

-- Domain rejects ASCII control bytes and DEL, not Unicode C1 characters.
-- Reuse its existing explicit UTF16/trim/ASCII helper, not POSIX cntrl ranges.
create or replace function public.zentra_us_purchasing_text(v jsonb,maximum integer default 160) returns boolean
language sql immutable security invoker set search_path='' as $$
 select coalesce(jsonb_typeof(v)='string' and public.zentra_us_tax_text_valid(v#>>'{}',maximum,false),false);
$$;

create function public.zentra_us_accounting_current(b jsonb) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare r jsonb:=jsonb_build_object('customers',b->'baseline'->'customers','estimates',b->'baseline'->'estimates','vendors',b->'baseline'->'vendors','vendorBills',b->'baseline'->'vendorBills','vendorPayments',b->'baseline'->'vendorPayments','counters',b->'baseline'->'counters','ledger',b->'baseline'->'ledger');e jsonb;c jsonb;rows jsonb;k text;entries jsonb:=b->'baseline'->'ledger'->'entries';audit jsonb:=b->'baseline'->'ledger'->'audit';p jsonb;periods jsonb:=b->'baseline'->'ledger'->'periods';
begin
 for e in select value from jsonb_array_elements(b->'events') loop
  if e->'operation'->>'type'='erp_command' then
   if e->'operation'->'command'->>'type'='open_period' then
    periods:=periods||jsonb_build_array(jsonb_build_object('id',e->'operation'->'command'->>'id','start',e->'operation'->'command'->>'start','end',e->'operation'->'command'->>'end','status','open'));
   elsif e->'operation'->'command'->>'type'='close_period' then
    select jsonb_agg(case when x->>'id'=e->'operation'->'command'->>'periodId' then x||jsonb_build_object('status','closed') else x end order by n) into periods from jsonb_array_elements(periods) with ordinality t(x,n);
   end if;
   for c in select value from jsonb_array_elements(e->'commit'->'changes') loop
    k:=case c->>'kind' when 'customer' then 'customers' when 'estimate' then 'estimates' when 'vendor' then 'vendors' when 'vendor_bill' then 'vendorBills' when 'vendor_payment' then 'vendorPayments' when 'journal' then null else 'invalid' end;
    if k='invalid' then raise exception using errcode='PF004',message='Private registry unsupported';end if;
    if k is not null then
     rows:=r->k;if exists(select 1 from jsonb_array_elements(rows) x where x->>'id'=c->>'id') then select jsonb_agg(case when x->>'id'=c->>'id' then c->'payload' else x end order by n) into rows from jsonb_array_elements(rows) with ordinality t(x,n);else rows:=rows||jsonb_build_array(c->'payload');end if;r:=jsonb_set(r,array[k],rows);
    end if;
   end loop;
   r:=jsonb_set(r,'{counters}',e->'commit'->'header'->'counters');entries:=entries||(e->'effects'->'postings');audit:=audit||(e->'effects'->'audit');
  else
   p:=e->'posting';entries:=entries||jsonb_build_array(p);audit:=audit||jsonb_build_array(jsonb_build_object('revision',p->'revision','action','posted','actorId',e->'actor'->>'userId','timestamp',e->'actor'->>'timestamp','entityId',p->>'id'));
  end if;
 end loop;
 return jsonb_set(r,'{ledger}',r->'ledger'||jsonb_build_object('revision',jsonb_array_length(audit),'entries',entries,'audit',audit,'periods',periods));
end $$;
create function public.zentra_us_accounting_header(b jsonb,counters jsonb) returns jsonb
language sql immutable security invoker set search_path='' as $$
 select jsonb_build_object('schemaVersion',4,'revision',(b->>'revision')::bigint+1,'configuration',b->'baseline'->'configuration','counters',counters,'ledger',((public.zentra_us_accounting_current(b)->'ledger')-'entries'-'audit')||jsonb_build_object('revision',(public.zentra_us_accounting_current(b)->'ledger'->>'revision')::bigint-(select count(*) from jsonb_array_elements(b->'events') e where e->'operation'->>'type'='customer_credit')));
$$;
create function public.zentra_us_accounting_post(ledger jsonb,input jsonb,a jsonb) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare line jsonb;account jsonb;period jsonb;dr numeric;cr numeric;debits numeric:=0;credits numeric:=0;cash_movement numeric:=0;revision bigint;fingerprint text;posting jsonb;original jsonb;
begin
 if not public.zentra_us_purchasing_text(a->'userId') or not public.zentra_us_purchasing_text(input->'id',512) or not public.zentra_us_purchasing_text(input->'idempotencyKey',240)
 or not public.zentra_us_purchasing_text(input->'description',2000) or not public.zentra_us_purchasing_text(input->'source'->'type') or not public.zentra_us_purchasing_text(input->'source'->'id')
 or input->>'organizationId' is distinct from ledger->>'organizationId' or input->>'currency' is distinct from 'USD' or input->>'basis' is distinct from 'accrual'
 or not public.zentra_us_purchase_date(input->>'transactionDate') or not public.zentra_us_purchase_date(input->>'accountingDate') or input ? 'paymentDate' and not public.zentra_us_purchase_date(input->>'paymentDate') then raise exception using errcode='PF004',message='Invalid purchasing journal authority';end if;
 if exists(select 1 from jsonb_array_elements(ledger->'entries') x where x->>'id'=input->>'id' or x->>'idempotencyKey'=input->>'idempotencyKey') then raise exception using errcode='PF002',message='Purchasing posting identity reserved';end if;
 if (ledger->>'revision')::bigint>=9007199254740990 then raise exception using errcode='PF012',message='Ledger revision exhausted';end if;
 select x into period from jsonb_array_elements(ledger->'periods') x where x->>'id'=input->>'periodId';
 if period is null or period->>'status'<>'open' or input->>'accountingDate'<period->>'start' or input->>'accountingDate'>period->>'end'
 or exists(select 1 from jsonb_array_elements(ledger->'periods') x where x->>'status'='closed' and input->>'accountingDate'<=x->>'end') then raise exception using errcode='PF015',message='Open purchasing period required';end if;
 if jsonb_typeof(input->'lines') is distinct from 'array' or jsonb_array_length(input->'lines') not between 2 and 1000 then raise exception using errcode='PF004',message='Purchasing journal lines required';end if;
 for line in select value from jsonb_array_elements(input->'lines') loop
  select x into account from jsonb_array_elements(ledger->'accounts') x where x->>'id'=line->>'accountId';dr:=public.zentra_us_settlement_minor(line->'debitMinor');cr:=public.zentra_us_settlement_minor(line->'creditMinor');
  if account is null or (dr=0 and cr=0) or (dr>0 and cr>0) then raise exception using errcode='PF004',message='Exact exclusive purchasing lines required';end if;
  debits:=debits+dr;credits:=credits+cr;if account->'cash'='true'::jsonb then cash_movement:=cash_movement+dr-cr;end if;
 end loop;
 if debits<>credits or debits=0 or (cash_movement<>0 and coalesce(input->>'cashFlowCategory','') not in('operating','investing','financing')) then raise exception using errcode='PF004',message='Balanced classified purchasing effect required';end if;
 if input ? 'reversesEntryId' then
  select x into original from jsonb_array_elements(ledger->'entries') x where x->>'id'=input->>'reversesEntryId';
  if original is null or original->'source'->>'type'<>'manual_journal' or exists(select 1 from jsonb_array_elements(ledger->'entries') x where x->>'reversesEntryId'=original->>'id')
  or original->'cashFlowCategory' is distinct from input->'cashFlowCategory' or jsonb_array_length(original->'lines')<>jsonb_array_length(input->'lines')
  or exists(select 1 from jsonb_array_elements(original->'lines') with ordinality t(x,n) where x->>'accountId' is distinct from input->'lines'->((n-1)::integer)->>'accountId' or x->>'debitMinor' is distinct from input->'lines'->((n-1)::integer)->>'creditMinor' or x->>'creditMinor' is distinct from input->'lines'->((n-1)::integer)->>'debitMinor' or x->'description' is distinct from input->'lines'->((n-1)::integer)->'description') then raise exception using errcode='PF004',message='Exact unique manual reversal required';end if;
 end if;
 fingerprint:=public.zentra_us_erp_v4_canonical(jsonb_build_array(input->>'organizationId','USD','accrual',input->>'transactionDate',input->>'accountingDate',input->>'paymentDate',input->>'periodId',input->>'description',input->'source'->>'type',input->'source'->>'id',input->>'cashFlowCategory',input->>'reversesEntryId',(select jsonb_agg(jsonb_build_array(l->>'accountId',l->>'debitMinor',l->>'creditMinor',l->>'description') order by n) from jsonb_array_elements(input->'lines') with ordinality t(l,n))));
 revision:=(ledger->>'revision')::bigint+1;posting:=input||jsonb_build_object('postedBy',a->>'userId','postedAt',a->>'timestamp','revision',revision,'fingerprint',fingerprint);
 return jsonb_build_object('posting',posting,'audit',jsonb_build_object('revision',revision,'action','posted','actorId',a->>'userId','timestamp',a->>'timestamp','entityId',input->>'id'));
end $$;
create function public.zentra_us_accounting_settlement_transition(b jsonb,op jsonb,a jsonb,id text,ledger jsonb) returns jsonb
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
 if jsonb_array_length(b->'events')>=1000 or (b->>'revision')::bigint>=9007199254740990 or (ledger->>'revision')::bigint>=9007199254740990 then raise exception using errcode='PF012',message='Settlement history limit reached';end if;
 if exists(select 1 from jsonb_array_elements(b->'events') x where x->'operation'->>'idempotencyKey'=key or x->>'id'=id)
 or exists(select 1 from jsonb_array_elements(b->'baseline'->'invoices') i cross join lateral jsonb_array_elements(i->'payments') x where x->>'idempotencyKey'=key or x->>'id'=id)
 or exists(select 1 from jsonb_array_elements(coalesce(b->'baseline'->'vendorPayments','[]')) x where x->>'idempotencyKey'=key)
 or exists(select 1 from jsonb_array_elements(b->'baseline'->'ledger'->'entries') x where x->>'idempotencyKey'=key) then raise exception using errcode='PF002',message='Settlement identity already reserved';end if;
 if (a->>'timestamp')::timestamptz<(b->'policy'->'approval'->>'reviewedAt')::timestamptz or (a->>'timestamp')::timestamptz<(b->'promotion'->'actor'->>'timestamp')::timestamptz
 or exists(select 1 from jsonb_array_elements(ledger->'audit') x where (x->>'timestamp')::timestamptz>(a->>'timestamp')::timestamptz)
 or exists(select 1 from jsonb_array_elements(b->'baseline'->'invoices') x where (x->>'issuedAt')::timestamptz>(a->>'timestamp')::timestamptz)
 or exists(select 1 from jsonb_array_elements(b->'events') x where (x->'actor'->>'timestamp')::timestamptz>(a->>'timestamp')::timestamptz) then raise exception using errcode='PF016',message='Settlement chronology reversed';end if;
 select x into inv from jsonb_array_elements(b->'baseline'->'invoices') x where x->>'id'=op->>'invoiceId';
 if inv is null or not exists(select 1 from jsonb_array_elements(ledger->'entries') x where x->'source'->>'type'='customer_invoice' and x->'source'->>'id'=inv->>'id' and not exists(select 1 from jsonb_array_elements(ledger->'entries') r where r->>'reversesEntryId'=x->>'id')) then raise exception using errcode='PF004',message='Posted source invoice required';end if;
 if not exists(select 1 from jsonb_array_elements(ledger->'periods') x where x->>'id'=op->>'periodId' and x->>'status'='open' and op->>'accountingDate'>=x->>'start' and op->>'accountingDate'<=x->>'end')
 or exists(select 1 from jsonb_array_elements(ledger->'periods') x where x->>'status'='closed' and op->>'accountingDate'<=x->>'end') then raise exception using errcode='PF015',message='Open accounting period required';end if;
 select coalesce(sum(public.zentra_us_settlement_minor(x->'amount'->'minorUnits')),0) into received from jsonb_array_elements(inv->'payments') x;
 for e in select value from jsonb_array_elements(b->'events') loop
  if e->'operation'->>'type'='customer_credit' then credit_count:=credit_count+1;end if;
  if e->'operation'->>'type' in('customer_credit','customer_payment') and e->'operation'->>'invoiceId'=inv->>'id' then
   if e->'operation'->>'type'='customer_credit' then credited:=credited+public.zentra_us_settlement_minor(e->'record'->'allocation'->'totalMinor');else received:=received+public.zentra_us_settlement_minor(e->'record'->'amount'->'minorUnits');end if;
  end if;
 end loop;
 outstanding:=public.zentra_us_settlement_minor(inv->'total'->'minorUnits')-received-credited;
 event_revision:=(b->>'revision')::bigint+1;ledger_revision:=(ledger->>'revision')::bigint+1;
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
 if exists(select 1 from jsonb_array_elements(ledger->'entries') x where x->>'idempotencyKey'=key or x->>'id'='entry:'||key)
 or exists(select 1 from jsonb_array_elements(b->'events') x where x->'posting'->>'idempotencyKey'=key or x->'posting'->>'id'='entry:'||key) then raise exception using errcode='PF002',message='Posting identity already reserved';end if;
 for l in select value from jsonb_array_elements(journal_lines) loop
  dr:=public.zentra_us_settlement_minor(l->'debitMinor');cr:=public.zentra_us_settlement_minor(l->'creditMinor');
  if (dr=0 and cr=0) or (dr>0 and cr>0) then raise exception using errcode='PF004',message='Exclusive nonzero journal line required';end if;
  select x into t from jsonb_array_elements(ledger->'accounts') x where x->>'id'=l->>'accountId';
  if t is null then raise exception using errcode='PF004',message='Required ledger account missing';end if;
  debits:=debits+dr;credits:=credits+cr;if t->'cash'='true'::jsonb then cash_movement:=cash_movement+dr-cr;end if;
 end loop;
 if debits<>credits or debits=0 or (cash_movement<>0 and kind<>'customer_payment') then raise exception using errcode='PF004',message='Balanced classified financial posting required';end if;
 fingerprint:=public.zentra_us_erp_v4_canonical(jsonb_build_array(org,'USD','accrual',transaction_date,op->>'accountingDate',payment_date,op->>'periodId',description,source_type,source_id,case when kind='customer_payment' then 'operating' else null end,null,(select jsonb_agg(jsonb_build_array(x->>'accountId',x->>'debitMinor',x->>'creditMinor',x->>'description') order by n) from jsonb_array_elements(journal_lines) with ordinality t(x,n))));
 posting:=jsonb_build_object('id','entry:'||key,'idempotencyKey',key,'organizationId',org,'currency','USD','basis','accrual','transactionDate',transaction_date,'accountingDate',op->>'accountingDate','periodId',op->>'periodId','description',description,'source',jsonb_build_object('type',source_type,'id',source_id),'lines',journal_lines,'postedBy',a->>'userId','postedAt',a->>'timestamp','revision',ledger_revision,'fingerprint',fingerprint);
 if kind='customer_payment' then posting:=posting||jsonb_build_object('paymentDate',payment_date,'cashFlowCategory','operating');end if;
 return jsonb_build_object('revision',event_revision,'id',id,'operation',op,'actor',a,'record',rec,'posting',posting);
end $$;
-- Existing pure commercial/purchase constructors now see the actual current
-- periods and compact header. No legacy state/table is thawed or persisted.
create or replace function public.zentra_us_purchasing_current(b jsonb) returns jsonb
language sql immutable security invoker set search_path='' as $$ select public.zentra_us_accounting_current(b); $$;
create or replace function public.zentra_us_purchasing_header(b jsonb,counters jsonb) returns jsonb
language sql immutable security invoker set search_path='' as $$ select public.zentra_us_accounting_header(b,counters); $$;

-- Rebuild only the four accounting commands from the admitted prefix and raw
-- operation. A declaration is not archival evidence or GAAP certification.
create function public.zentra_us_accounting_erp(b jsonb,op jsonb,a jsonb,id text) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare org text:=b->'baseline'->'configuration'->>'organizationId';c jsonb:=op->'command';action text:=c->>'type';r jsonb:=public.zentra_us_accounting_current(b);ledger jsonb:=r->'ledger';header jsonb:=public.zentra_us_accounting_header(b,r->'counters');periods jsonb:=ledger->'periods';period jsonb;original jsonb;lines jsonb;line jsonb;input jsonb;effect jsonb;posting jsonb;audit jsonb;compact_posting jsonb;changes jsonb:='[]';effects jsonb;receipt jsonb;commit jsonb;revision bigint:=(b->>'revision')::bigint+1;next_ledger bigint:=(ledger->>'revision')::bigint+1;next_compact bigint:=(header->'ledger'->>'revision')::bigint+1;keys text[];k text;
begin
 if not public.zentra_us_purchasing_text(a->'userId') then raise exception using errcode='PF004',message='Accounting authority invalid';end if;
 if (ledger->>'revision')::bigint>=9007199254740990 then raise exception using errcode='PF012',message='Accounting ledger revision exhausted';end if;
 keys:=case action when 'open_period' then array['type','id','start','end'] when 'close_period' then array['type','periodId'] when 'post_manual_journal' then array['type','id','transactionDate','accountingDate','periodId','description','sourceReference','lines'] when 'reverse_manual_journal' then array['type','id','entryId','transactionDate','accountingDate','periodId','reason'] else null end;
 if keys is null then raise exception using errcode='PF010',message='Accounting command unavailable';end if;
 if not public.zentra_us_tax_object(c,keys,case when action='post_manual_journal' then array['cashFlowCategory'] else array[]::text[] end)
 or not public.zentra_us_tax_strings(c,array_remove(keys,'lines')) then raise exception using errcode='PF004',message='Exact accounting command required';end if;
 if (case when action='close_period' then c->>'periodId' else c->>'id' end) is distinct from id then raise exception using errcode='PF004',message='Exact accounting entity required';end if;
 if action in('open_period','close_period') then
  if action='open_period' then
   if not public.zentra_us_purchasing_text(c->'id') or not public.zentra_us_purchase_date(c->>'start') or not public.zentra_us_purchase_date(c->>'end') or c->>'end'<c->>'start' then raise exception using errcode='PF004',message='Valid accounting period required';end if;
   if jsonb_array_length(periods)>=100 then raise exception using errcode='PF012',message='Accounting period limit reached';end if;
   if exists(select 1 from jsonb_array_elements(periods) x where x->>'id'=id) then raise exception using errcode='PF002',message='Accounting period already exists';end if;
   if exists(select 1 from jsonb_array_elements(periods) x where c->>'start'<=x->>'end') then raise exception using errcode='PF015',message='New period must follow existing periods';end if;
   periods:=periods||jsonb_build_array(jsonb_build_object('id',id,'start',c->>'start','end',c->>'end','status','open'));
  else
   if not public.zentra_us_purchasing_text(c->'periodId') then raise exception using errcode='PF004',message='Valid accounting period required';end if;
   select x into period from jsonb_array_elements(periods) x where x->>'id'=id;
   if period is null or period->>'status'<>'open' or exists(select 1 from jsonb_array_elements(periods) x where x->>'status'='open' and x->>'start'<period->>'start') then raise exception using errcode='PF015',message='Earliest open accounting period required';end if;
   select jsonb_agg(case when x->>'id'=id then x||jsonb_build_object('status','closed') else x end order by n) into periods from jsonb_array_elements(periods) with ordinality t(x,n);
  end if;
  audit:=jsonb_build_object('revision',next_ledger,'action',case action when 'open_period' then 'period_opened' else 'period_closed' end,'actorId',a->>'userId','timestamp',a->>'timestamp','entityId',id);
  effects:=jsonb_build_object('postings','[]'::jsonb,'audit',jsonb_build_array(audit));header:=jsonb_set(header,'{ledger,periods}',periods);
 else
  if not public.zentra_us_purchasing_text(c->'id') or not public.zentra_us_purchase_date(c->>'transactionDate') or not public.zentra_us_purchase_date(c->>'accountingDate') or not public.zentra_us_purchasing_text(c->'periodId') then raise exception using errcode='PF004',message='Valid manual accounting dates required';end if;
  if action='post_manual_journal' then
   if not public.zentra_us_purchasing_text(c->'description',2000) or not public.zentra_us_purchasing_text(c->'sourceReference') or (c ? 'cashFlowCategory' and (jsonb_typeof(c->'cashFlowCategory') is distinct from 'string' or c->>'cashFlowCategory' not in('operating','investing','financing'))) then raise exception using errcode='PF004',message='Valid manual declaration required';end if;
   lines:=c->'lines';input:=jsonb_build_object('id',id,'idempotencyKey',op->>'idempotencyKey','organizationId',org,'currency','USD','basis','accrual','transactionDate',c->>'transactionDate','accountingDate',c->>'accountingDate','periodId',c->>'periodId','description',c->>'description','source',jsonb_build_object('type','manual_journal','id',c->>'sourceReference'));
   if c ? 'cashFlowCategory' then input:=input||jsonb_build_object('cashFlowCategory',c->'cashFlowCategory');end if;
  else
   if not public.zentra_us_purchasing_text(c->'entryId') or not public.zentra_us_purchasing_text(c->'reason',2000) then raise exception using errcode='PF004',message='Valid manual correction required';end if;
   select x into original from jsonb_array_elements(ledger->'entries') x where x->>'id'=c->>'entryId';
   if original is null or original->'source'->>'type'<>'manual_journal' then raise exception using errcode='PF004',message='Original manual journal required';end if;
   select jsonb_agg(jsonb_build_object('accountId',x->>'accountId','debitMinor',x->>'creditMinor','creditMinor',x->>'debitMinor')||case when x ? 'description' then jsonb_build_object('description',x->'description') else '{}'::jsonb end order by n) into lines from jsonb_array_elements(original->'lines') with ordinality t(x,n);
   input:=jsonb_build_object('id',id,'idempotencyKey',op->>'idempotencyKey','organizationId',org,'currency','USD','basis','accrual','transactionDate',c->>'transactionDate','accountingDate',c->>'accountingDate','periodId',c->>'periodId','description',c->>'reason','source',jsonb_build_object('type','manual_reversal','id',original->>'id'),'reversesEntryId',original->>'id');
   if original ? 'cashFlowCategory' then input:=input||jsonb_build_object('cashFlowCategory',original->'cashFlowCategory');end if;
  end if;
  if jsonb_typeof(lines) is distinct from 'array' or jsonb_array_length(lines) not between 2 and 1000 then raise exception using errcode='PF004',message='Manual journal lines required';end if;
  for line in select value from jsonb_array_elements(lines) loop
   if not public.zentra_us_tax_object(line,array['accountId','debitMinor','creditMinor'],array['description']) or not public.zentra_us_tax_strings(line,array['accountId','debitMinor','creditMinor'])
   or not public.zentra_us_purchasing_text(line->'accountId') or line->>'accountId' in('receivables','payables','tax-payable','deposits') or (line ? 'description' and not public.zentra_us_purchasing_text(line->'description',2000)) then raise exception using errcode='PF004',message='Exact permitted manual journal line required';end if;
   perform public.zentra_us_settlement_minor(line->'debitMinor');perform public.zentra_us_settlement_minor(line->'creditMinor');
  end loop;
  input:=input||jsonb_build_object('lines',lines);effect:=public.zentra_us_accounting_post(ledger,input,a);posting:=effect->'posting';audit:=effect->'audit';compact_posting:=posting||jsonb_build_object('revision',next_compact);
  changes:=jsonb_build_array(jsonb_build_object('kind','journal','id',id,'payload',compact_posting));effects:=jsonb_build_object('postings',jsonb_build_array(posting),'audit',jsonb_build_array(audit));
 end if;
 header:=jsonb_set(header,'{ledger,revision}',to_jsonb(next_compact));
 receipt:=jsonb_build_object('idempotencyKey',op->>'idempotencyKey','commandHash',public.zentra_us_financial_test_hash(jsonb_build_array(org,a->>'userId',jsonb_build_object('idempotencyKey',op->>'idempotencyKey','expectedRevision',(b->>'revision')::bigint,'command',c))),'revision',revision,'entityId',id,'action',action);
 commit:=jsonb_build_object('organizationId',org,'expectedRevision',(b->>'revision')::bigint,'header',header,'changes',changes,'ledgerAudit',jsonb_build_array(audit||jsonb_build_object('revision',next_compact)),'receipt',receipt,'actor',a);
 return jsonb_build_object('revision',revision,'id',id,'operation',op,'actor',a,'commit',commit,'effects',effects);
end $$;

create function public.zentra_us_accounting_transition(b jsonb,op jsonb,a jsonb,id text) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare org text:=b->'baseline'->'configuration'->>'organizationId';key text;ledger jsonb;
begin
 perform public.zentra_us_financial_test_budget(b);perform public.zentra_us_financial_test_budget(op);
 if not public.zentra_us_tax_object(a,array['organizationId','userId','role','managementEntitled','timestamp']) or not public.zentra_us_tax_strings(a,array['organizationId','userId','role','timestamp'])
 or a->>'organizationId' is distinct from org or a->'managementEntitled' is distinct from 'true'::jsonb or a->>'role' not in('owner','admin','accountant')
 or not public.zentra_us_tax_text_valid(a->>'userId',256,false) or not public.zentra_us_purchase_timestamp(a->>'timestamp') or not public.zentra_us_tax_text_valid(id,160,true) then raise exception using errcode='PF004',message='Invalid private commercial authority';end if;
 if (a->>'timestamp')::timestamptz<(b->'policy'->'approval'->>'reviewedAt')::timestamptz or (a->>'timestamp')::timestamptz<(b->'promotion'->'actor'->>'timestamp')::timestamptz
 or exists(select 1 from jsonb_array_elements(b->'baseline'->'ledger'->'audit') x where (x->>'timestamp')::timestamptz>(a->>'timestamp')::timestamptz)
 or exists(select 1 from jsonb_array_elements(b->'baseline'->'invoices') x where (x->>'issuedAt')::timestamptz>(a->>'timestamp')::timestamptz)
 or exists(select 1 from jsonb_array_elements(b->'events') x where (x->'actor'->>'timestamp')::timestamptz>(a->>'timestamp')::timestamptz) then raise exception using errcode='PF016',message='Commercial chronology reversed';end if;
 if jsonb_array_length(b->'events')>=1000 or (b->>'revision')::bigint>=9007199254740990 then raise exception using errcode='PF012',message='Private commercial history limit reached';end if;
 key:=op->>'idempotencyKey';
 if jsonb_typeof(op->'idempotencyKey') is distinct from 'string' or key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' then raise exception using errcode='PF004',message='Invalid private operation key';end if;
 if exists(select 1 from jsonb_array_elements(b->'events') x where x->'operation'->>'idempotencyKey'=key)
 or exists(select 1 from jsonb_array_elements(b->'baseline'->'invoices') i cross join lateral jsonb_array_elements(i->'payments') x where x->>'idempotencyKey'=key)
 or exists(select 1 from jsonb_array_elements(b->'baseline'->'vendorPayments') x where x->>'idempotencyKey'=key)
 or exists(select 1 from jsonb_array_elements(b->'baseline'->'ledger'->'entries') x where x->>'idempotencyKey'=key) then raise exception using errcode='PF002',message='Private operation key already reserved';end if;
 ledger:=public.zentra_us_accounting_current(b)->'ledger';
 if op->>'type' in('customer_credit','customer_payment') then return public.zentra_us_accounting_settlement_transition(b,op,a,id,ledger);end if;
 if op->>'type' is distinct from 'erp_command' then raise exception using errcode='PF010',message='Private accounting operation unavailable';end if;
 if not public.zentra_us_tax_object(op,array['type','idempotencyKey','command','facts']) or op->'facts' is distinct from '{"kind":"none"}'::jsonb then raise exception using errcode='PF004',message='Accounting facts must be empty';end if;
 if op->'command'->>'type' in('open_period','close_period','post_manual_journal','reverse_manual_journal') then return public.zentra_us_accounting_erp(b,op,a,id);end if;
 return public.zentra_us_purchasing_transition(b,op,a,id);
end $$;
create function public.zentra_us_accounting_replay(b jsonb) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare current_book jsonb;e jsonb;rebuilt jsonb;
begin
 perform public.zentra_us_financial_test_budget(b);
 if not public.zentra_us_tax_object(b,array['schemaVersion','revision','baseline','policy','promotion','events']) or b->'schemaVersion' is distinct from '5'::jsonb or jsonb_typeof(b->'events') is distinct from 'array'
 or b->'revision' is distinct from to_jsonb((b->'baseline'->>'revision')::bigint+1+jsonb_array_length(b->'events')) then raise exception using errcode='PF004',message='Invalid private commercial book';end if;
 current_book:=b||jsonb_build_object('revision',(b->'baseline'->>'revision')::bigint+1,'events','[]'::jsonb);
 for e in select value from jsonb_array_elements(b->'events') loop
  if not public.zentra_us_tax_object(e,case when e->'operation'->>'type'='erp_command' then array['revision','id','operation','actor','commit','effects'] else array['revision','id','operation','actor','record','posting'] end) or jsonb_typeof(e->'id') is distinct from 'string' then raise exception using errcode='PF004',message='Invalid private commercial event';end if;
  rebuilt:=public.zentra_us_accounting_transition(current_book,e->'operation',e->'actor',e->>'id');
  if rebuilt is distinct from e then raise exception using errcode='PF004',message='Commercial event differs from independent reconstruction';end if;
  current_book:=current_book||jsonb_build_object('revision',e->'revision','events',(current_book->'events')||jsonb_build_array(rebuilt));
 end loop;return current_book;
end $$;
create or replace function public.zentra_us_settlement_book(org text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare h public.zentra_us_financial_test_heads%rowtype;b jsonb;
begin
 select * into h from public.zentra_us_financial_test_heads where organization_id=org;if not found then return null;end if;
 select public.zentra_us_financial_test_book(h)||jsonb_build_object('revision',h.revision+count(*),'events',coalesce(jsonb_agg(payload order by revision),'[]'::jsonb)) into b from public.zentra_us_financial_test_events where organization_id=org;
 return public.zentra_us_accounting_replay(b);
end $$;
create function public.zentra_us_accounting_admit(org text,a jsonb,v bigint,cap text) returns void
language plpgsql volatile security invoker set search_path='' as $$
begin
 if cap is distinct from 'postgres-test-accounting-v5' then raise exception using errcode='PF009',message='Private accounting TEST capability required';end if;
 perform public.zentra_us_settlement_admit(org,a,v,'postgres-test-settlement-v5');
end $$;
create or replace function public.zentra_us_settlement_event_guard() returns trigger
language plpgsql volatile security invoker set search_path='' as $$
declare b jsonb;e jsonb;c public.zentra_us_financial_test_cursors%rowtype;
begin
 if tg_op<>'INSERT' then raise exception using errcode='PF003',message='Financial events are immutable';end if;
 perform public.zentra_us_accounting_admit(new.organization_id,new.payload->'actor',new.grant_version,'postgres-test-accounting-v5');
 select * into c from public.zentra_us_financial_test_cursors where organization_id=new.organization_id for update;
 if not found or new.revision<>c.revision+1 then raise exception using errcode='PF001',message='Exact financial event CAS required';end if;
 b:=public.zentra_us_settlement_book(new.organization_id);
 if (b->>'revision')::bigint<>c.revision or public.zentra_us_financial_test_hash(b)<>c.book_sha256 then raise exception using errcode='PF004',message='Financial cursor history mismatch';end if;
 perform public.zentra_us_commercial_source(new.organization_id,new.payload->'operation');
 e:=public.zentra_us_accounting_transition(b,new.payload->'operation',new.payload->'actor',new.payload->>'id');
 if e is distinct from new.payload or new.revision is distinct from (e->>'revision')::bigint then raise exception using errcode='PF004',message='Uncorroborated accounting event';end if;
 b:=b||jsonb_build_object('revision',e->'revision','events',(b->'events')||jsonb_build_array(e));perform public.zentra_us_financial_test_budget(b);perform public.zentra_us_settlement_plans(b);
 if exists(select 1 from public.zentra_us_financial_test_receipts where organization_id=new.organization_id and idempotency_key=e->'operation'->>'idempotencyKey') then raise exception using errcode='PF002',message='Historical key already reserved';end if;return new;
end $$;
create function public.zentra_read_us_financial_accounting_test_v5(p_organization text,p_actor jsonb,p_grant_version bigint,p_capability text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare b jsonb;c public.zentra_us_financial_test_cursors%rowtype;
begin
 perform public.zentra_us_accounting_admit(p_organization,p_actor,p_grant_version,p_capability);b:=public.zentra_us_settlement_book(p_organization);if b is null then return null;end if;
 perform public.zentra_us_settlement_plans(b);select * into c from public.zentra_us_financial_test_cursors where organization_id=p_organization for update;
 if not found or c.revision<>(b->>'revision')::bigint or c.book_sha256<>public.zentra_us_financial_test_hash(b) then raise exception using errcode='PF004',message='Financial cursor mismatch';end if;return b;
end $$;
create function public.zentra_us_financial_accounting_test_receipt_v5(p_organization text,p_actor jsonb,p_grant_version bigint,p_capability text,p_idempotency_key text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare r public.zentra_us_financial_test_receipts%rowtype;b jsonb;
begin
 b:=public.zentra_read_us_financial_accounting_test_v5(p_organization,p_actor,p_grant_version,p_capability);
 if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 240 then raise exception using errcode='PF004',message='Invalid financial receipt key';end if;
 select * into r from public.zentra_us_financial_test_receipts where organization_id=p_organization and idempotency_key=p_idempotency_key;if not found then return null;end if;
 return jsonb_build_object('origin',r.origin,'actorId',r.actor_id,'receipt',r.receipt);
end $$;
create function public.zentra_append_us_financial_accounting_test_v5(p_organization text,p_actor jsonb,p_grant_version bigint,p_capability text,p_expected_revision bigint,p_previous_fingerprint text,p_book jsonb,p_receipt jsonb) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare b jsonb;e jsonb;expected_receipt jsonb;prior public.zentra_us_financial_test_receipts%rowtype;prefix jsonb;
begin
 b:=public.zentra_read_us_financial_accounting_test_v5(p_organization,p_actor,p_grant_version,p_capability);if b is null then raise exception using errcode='PF004',message='Promoted financial book required';end if;
 perform public.zentra_us_financial_test_budget(p_book);perform public.zentra_us_financial_test_budget(p_receipt);
 if p_expected_revision is null or p_expected_revision<1 or p_previous_fingerprint is null or p_previous_fingerprint !~ '^[a-f0-9]{64}$'
 or not public.zentra_us_tax_object(p_book,array['schemaVersion','revision','baseline','policy','promotion','events']) or jsonb_typeof(p_book->'events') is distinct from 'array' or jsonb_array_length(p_book->'events')<1
 or p_book-'events'-'revision' is distinct from b-'events'-'revision' then raise exception using errcode='PF004',message='Invalid financial commit envelope';end if;
 e:=p_book->'events'->-1;
 if e->'actor' is distinct from p_actor or not public.zentra_us_tax_object(e,case when e->'operation'->>'type'='erp_command' then array['revision','id','operation','actor','commit','effects'] else array['revision','id','operation','actor','record','posting'] end) then raise exception using errcode='PF004',message='Invalid financial event envelope';end if;
 if e->'operation'->>'type' not in('customer_credit','customer_payment','erp_command') or (e->'operation'->>'type'='erp_command' and e->'operation'->'command'->>'type' not in('save_customer','save_estimate','accept_estimate','save_vendor','record_vendor_bill','record_vendor_payment','open_period','close_period','post_manual_journal','reverse_manual_journal')) then raise exception using errcode='PF010',message='Accounting capability excludes this command';end if;
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
-- Every old port refuses an accounting tail BEFORE replay/receipt/retry.
-- The existing immutable baseline, key index and history remain preserved.
do $$ declare f record;body text;admission text;counted integer:=0;begin
 for f in select p.* from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('zentra_read_us_financial_purchasing_test_v5','zentra_read_us_financial_commercial_test_v5') loop
  counted:=counted+1;admission:=case f.proname when 'zentra_read_us_financial_purchasing_test_v5' then 'perform public.zentra_us_purchasing_admit(p_organization,p_actor,p_grant_version,p_capability);' else 'perform public.zentra_us_commercial_admit(p_organization,p_actor,p_grant_version,p_capability);' end;
  body:=replace(f.prosrc,admission,admission||' if exists(select 1 from public.zentra_us_financial_test_events where organization_id=p_organization and payload->''operation''->>''type''=''erp_command'' and payload->''operation''->''command''->>''type'' in(''open_period'',''close_period'',''post_manual_journal'',''reverse_manual_journal'')) then raise exception using errcode=''PF008'',message=''Accounting capability required'';end if;');
  if body=f.prosrc then raise exception 'Exact old accounting admission prerequisite required';end if;
  execute format('create or replace function public.%I(%s) returns jsonb language plpgsql volatile security invoker set search_path='''' as %L',f.proname,pg_get_function_arguments(f.oid),body);
 end loop;
 if counted<>2 then raise exception 'Two exact prior readers required';end if;
end $$;
do $$ declare f record;begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'zentra_us_accounting_%' or p.proname in('zentra_read_us_financial_accounting_test_v5','zentra_us_financial_accounting_test_receipt_v5','zentra_append_us_financial_accounting_test_v5')) loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
-- New replay must also preserve every validated prior book exactly. If this
-- independent reader differs, installation rolls back all function changes.
do $$ declare h record;b jsonb;e jsonb;begin
 for h in select organization_id from public.zentra_us_financial_test_heads order by organization_id loop
  b:=public.zentra_us_settlement_book(h.organization_id);perform public.zentra_us_settlement_plans(b);
  if not exists(select 1 from public.zentra_us_financial_test_cursors c where c.organization_id=h.organization_id and c.revision=(b->>'revision')::bigint and c.book_sha256=public.zentra_us_financial_test_hash(b)) then raise exception using errcode='PF004',message='Valid continued private cursor required';end if;
  for e in select value from jsonb_array_elements(b->'events') loop
   if not exists(select 1 from public.zentra_us_financial_test_receipts r where r.organization_id=h.organization_id and r.idempotency_key=e->'operation'->>'idempotencyKey' and r.origin='financial_v5' and r.actor_id=e->'actor'->>'userId' and r.receipt=public.zentra_us_settlement_receipt(b,e)) then raise exception using errcode='PF004',message='Valid continued private receipt required';end if;
  end loop;
 end loop;
end $$;
commit;
