-- Private LOCAL TEST only. Same immutable baseline + canonical ordered tail.
-- Invoice continuation: no provider, public ERP5, legacy thaw or CH mutation.
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

create function public.zentra_us_invoicing_current(b jsonb) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare r jsonb:=jsonb_build_object('customers',b->'baseline'->'customers','estimates',b->'baseline'->'estimates','invoices',b->'baseline'->'invoices','vendors',b->'baseline'->'vendors','vendorBills',b->'baseline'->'vendorBills','vendorPayments',b->'baseline'->'vendorPayments','counters',b->'baseline'->'counters','ledger',b->'baseline'->'ledger');e jsonb;c jsonb;rows jsonb;k text;entries jsonb:=b->'baseline'->'ledger'->'entries';audit jsonb:=b->'baseline'->'ledger'->'audit';p jsonb;periods jsonb:=b->'baseline'->'ledger'->'periods';
begin
 for e in select value from jsonb_array_elements(b->'events') loop
  if e->'operation'->>'type'='erp_command' then
   if e->'operation'->'command'->>'type'='open_period' then
    periods:=periods||jsonb_build_array(jsonb_build_object('id',e->'operation'->'command'->>'id','start',e->'operation'->'command'->>'start','end',e->'operation'->'command'->>'end','status','open'));
   elsif e->'operation'->'command'->>'type'='close_period' then
    select jsonb_agg(case when x->>'id'=e->'operation'->'command'->>'periodId' then x||jsonb_build_object('status','closed') else x end order by n) into periods from jsonb_array_elements(periods) with ordinality t(x,n);
   end if;
   for c in select value from jsonb_array_elements(e->'commit'->'changes') loop
    k:=case c->>'kind' when 'customer' then 'customers' when 'estimate' then 'estimates' when 'invoice' then 'invoices' when 'vendor' then 'vendors' when 'vendor_bill' then 'vendorBills' when 'vendor_payment' then 'vendorPayments' when 'journal' then null else 'invalid' end;
    if k='invalid' then raise exception using errcode='PF004',message='Private registry unsupported';end if;
    if k is not null then
     rows:=r->k;if exists(select 1 from jsonb_array_elements(rows) x where x->>'id'=c->>'id') then select jsonb_agg(case when x->>'id'=c->>'id' then c->'payload' else x end order by n) into rows from jsonb_array_elements(rows) with ordinality t(x,n);else rows:=rows||jsonb_build_array(c->'payload');end if;r:=jsonb_set(r,array[k],rows);
    end if;
   end loop;
   r:=jsonb_set(r,'{counters}',e->'commit'->'header'->'counters');entries:=entries||(e->'effects'->'postings');audit:=audit||(e->'effects'->'audit');
  else
   if e->'operation'->>'type'='customer_payment' then
    select jsonb_agg(case when x->>'id'=e->'operation'->>'invoiceId' then x||jsonb_build_object('payments',(x->'payments')||jsonb_build_array(e->'record')) else x end order by n) into rows from jsonb_array_elements(r->'invoices') with ordinality t(x,n);r:=jsonb_set(r,'{invoices}',rows);
   end if;
   p:=e->'posting';entries:=entries||jsonb_build_array(p);audit:=audit||jsonb_build_array(jsonb_build_object('revision',p->'revision','action','posted','actorId',e->'actor'->>'userId','timestamp',e->'actor'->>'timestamp','entityId',p->>'id'));
  end if;
 end loop;
 return jsonb_set(r,'{ledger}',r->'ledger'||jsonb_build_object('revision',jsonb_array_length(audit),'entries',entries,'audit',audit,'periods',periods));
end $$;
create or replace function public.zentra_us_accounting_current(b jsonb) returns jsonb language sql immutable security invoker set search_path='' as $$select public.zentra_us_invoicing_current(b)$$;
create function public.zentra_us_invoicing_settlement_transition(b jsonb,op jsonb,a jsonb,id text,ledger jsonb) returns jsonb
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
 select x into inv from jsonb_array_elements(public.zentra_us_invoicing_current(b)->'invoices') x where x->>'id'=op->>'invoiceId';
 if inv is null or not exists(select 1 from jsonb_array_elements(ledger->'entries') x where x->'source'->>'type'='customer_invoice' and x->'source'->>'id'=inv->>'id' and not exists(select 1 from jsonb_array_elements(ledger->'entries') r where r->>'reversesEntryId'=x->>'id')) then raise exception using errcode='PF004',message='Posted source invoice required';end if;
 if not exists(select 1 from jsonb_array_elements(ledger->'periods') x where x->>'id'=op->>'periodId' and x->>'status'='open' and op->>'accountingDate'>=x->>'start' and op->>'accountingDate'<=x->>'end')
 or exists(select 1 from jsonb_array_elements(ledger->'periods') x where x->>'status'='closed' and op->>'accountingDate'<=x->>'end') then raise exception using errcode='PF015',message='Open accounting period required';end if;
 select coalesce(sum(public.zentra_us_settlement_minor(x->'amount'->'minorUnits')),0) into received from jsonb_array_elements(inv->'payments') x;
 for e in select value from jsonb_array_elements(b->'events') loop
  if e->'operation'->>'type'='customer_credit' then credit_count:=credit_count+1;end if;
  if e->'operation'->>'type' in('customer_credit','customer_payment') and e->'operation'->>'invoiceId'=inv->>'id' then
   if e->'operation'->>'type'='customer_credit' then credited:=credited+public.zentra_us_settlement_minor(e->'record'->'allocation'->'totalMinor');end if;
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

create function public.zentra_us_invoicing_seller(s jsonb,org text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare k text;l jsonb;
begin
 if not public.zentra_us_tax_object(s,array['organizationId','displayName'],array['contactEmail','contactPhone','logoRef']) or s->>'organizationId' is distinct from org or not public.zentra_us_tax_strings(s,array['organizationId','displayName']) then return false;end if;
 foreach k in array array['displayName','contactEmail','contactPhone'] loop
  if s ? k and (jsonb_typeof(s->k) is distinct from 'string' or not public.zentra_us_tax_text_valid(s->>k,case k when 'displayName' then 256 when 'contactEmail' then 254 else 80 end,true)) then return false;end if;
 end loop;
 if s ? 'contactEmail' and s->>'contactEmail' !~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$' then return false;end if;
 if s ? 'logoRef' then l:=s->'logoRef';if not public.zentra_us_tax_object(l,array['assetId','contentSha256']) or not public.zentra_us_tax_strings(l,array['assetId','contentSha256']) or l->>'assetId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or l->>'contentSha256' !~ '^[0-9a-f]{64}$' then return false;end if;end if;
 return true;
exception when others then return false;end $$;

create function public.zentra_us_invoicing_command(b jsonb,c jsonb,id text) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare r jsonb:=public.zentra_us_invoicing_current(b);e jsonb;k text;l jsonb;net numeric;total numeric:=0;
begin
 if not public.zentra_us_tax_object(c,array['type','id','estimateId','expectedEstimateRevision','date','accountingDate','dueDate','periodId']) or not public.zentra_us_tax_strings(c,array['type','id','estimateId','date','accountingDate','dueDate','periodId']) or c->>'type' is distinct from 'issue_invoice' or c->>'id' is distinct from id or not public.zentra_us_tax_revision(c->'expectedEstimateRevision') then raise exception using errcode='PF004',message='Exact invoice command required';end if;
 foreach k in array array['id','estimateId','periodId'] loop if not public.zentra_us_tax_text_valid(c->>k,160,false) then raise exception using errcode='PF004',message='Invalid invoice command identity';end if;end loop;
 foreach k in array array['date','accountingDate','dueDate'] loop if not public.zentra_us_purchase_date(c->>k) then raise exception using errcode='PF004',message='Invalid invoice date';end if;end loop;
 if c->>'dueDate'<c->>'date' then raise exception using errcode='PF004',message='Invalid invoice due date';end if;
 select x into e from jsonb_array_elements(r->'estimates') x where x->>'id'=c->>'estimateId';
 if e is null or e->>'status'<>'accepted' or e->'revision' is distinct from c->'expectedEstimateRevision' then raise exception using errcode='PF001',message='Current accepted estimate required';end if;
 if exists(select 1 from jsonb_array_elements(r->'invoices') x where x->>'id'=id or x->>'sourceEstimateId'=e->>'id') then raise exception using errcode='PF002',message='Invoice source already issued';end if;
 if not exists(select 1 from jsonb_array_elements(r->'ledger'->'periods') x where x->>'id'=c->>'periodId' and x->>'status'='open' and c->>'accountingDate' between x->>'start' and x->>'end') or exists(select 1 from jsonb_array_elements(r->'ledger'->'periods') x where x->>'status'='closed' and c->>'accountingDate'<=x->>'end') then raise exception using errcode='PF015',message='Open invoice period required';end if;
 if (e ? 'projectId' and not public.zentra_us_tax_text_valid(e->>'projectId',160,true)) or not public.zentra_us_tax_text_valid(e->>'id',160,true) or not public.zentra_us_tax_text_valid(e->>'number',160,true) or not public.zentra_us_tax_text_valid(e->'customer'->>'id',160,true) or not public.zentra_us_tax_text_valid(e->'customer'->>'name',160,true) or jsonb_array_length(e->'lines') not between 1 and 100 then raise exception using errcode='PF014',message='Supported invoice source required';end if;
 for l in select value from jsonb_array_elements(e->'lines') loop
  net:=(public.zentra_us_erp_line_totals(l)->>'netMinor')::numeric;total:=total+net;
  if not public.zentra_us_tax_text_valid(l->>'id',160,true) or l->>'taxTreatment'<>'taxable' or (l->>'quantityUnits')::numeric%power(10::numeric,(l->>'quantityScale')::integer)<>0 or (l->>'quantityUnits')::numeric/power(10::numeric,(l->>'quantityScale')::integer) not between 1 and 9007199254740991 or net not between 1 and 9007199254740991 or total>9007199254740991 then raise exception using errcode='PF014',message='Supported TEST service lines required';end if;
 end loop;
 return e;
end $$;
create function public.zentra_us_invoicing_erp(b jsonb,op jsonb,a jsonb,id text) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare org text:=b->'baseline'->'configuration'->>'organizationId';config jsonb:=b->'baseline'->'configuration';r jsonb:=public.zentra_us_invoicing_current(b);c jsonb:=op->'command';e jsonb;p jsonb:=op->'facts'->'taxAssessment';seller jsonb:=op->'facts'->'sellerSnapshot';line jsonb;t jsonb;l jsonb;request_lines jsonb:='[]';seen text[]:=array[]::text[];subtotal numeric:=0;discount numeric:=0;tax numeric:=0;net numeric;total numeric;counter bigint;number text;invoice jsonb;header jsonb;effect jsonb;posting jsonb;compact bigint;changes jsonb;receipt jsonb;commit jsonb;fingerprint text;lines jsonb;
begin
 e:=public.zentra_us_invoicing_command(b,c,id);
 if not public.zentra_us_tax_object(op->'facts',array['kind','sellerSnapshot','taxAssessment']) or op->'facts'->>'kind' is distinct from 'invoice_issuance' or not public.zentra_us_invoicing_seller(seller,org) or not public.zentra_us_erp_tax_proof_valid(p,org) or config->'taxConfiguration'->>'status' is distinct from 'configured' then raise exception using errcode='PF004',message='Exact private invoice facts required';end if;
 for line in select value from jsonb_array_elements(e->'lines') loop
  t:=public.zentra_us_erp_line_totals(line);subtotal:=subtotal+public.zentra_us_settlement_minor(t->'grossMinor');discount:=discount+public.zentra_us_settlement_minor(t->'discountMinor');request_lines:=request_lines||jsonb_build_array(jsonb_build_object('id',line->>'id','netMinor',t->>'netMinor','taxTreatment',line->>'taxTreatment'));
 end loop;
 fingerprint:=public.zentra_us_erp_v4_canonical(jsonb_build_array(org,'US','USD',config->'address',e->>'id',e->'revision',c->>'date',e->'customer'->'billingAddress',coalesce(e->'customer'->'shippingAddress','null'::jsonb),request_lines));
 if p->>'documentId' is distinct from e->>'id' or p->'documentRevision' is distinct from e->'revision' or p->>'fingerprint' is distinct from fingerprint or p->>'source' is distinct from 'external-provider' or not public.zentra_us_tax_text_valid(p->>'providerReference',500,false) or not public.zentra_us_tax_instant(p->>'determinedAt') or not public.zentra_us_tax_instant(p->>'validUntil') or (p->>'determinedAt')::timestamptz>(a->>'timestamp')::timestamptz or (p->>'validUntil')::timestamptz<(a->>'timestamp')::timestamptz or jsonb_array_length(p->'lines')<>jsonb_array_length(e->'lines') then raise exception using errcode='PF004',message='Scoped original invoice tax assessment required';end if;
 for l in select value from jsonb_array_elements(p->'lines') loop
  select x into line from jsonb_array_elements(e->'lines') x where x->>'id'=l->>'id';if line is null or l->>'id'=any(seen) or not public.zentra_us_tax_text_valid(l->>'jurisdiction',160,false) or not public.zentra_us_tax_text_valid(l->>'evidenceReference',500,false) then raise exception using errcode='PF004',message='Exact invoice tax coverage required';end if;seen:=seen||array[l->>'id'];
  net:=public.zentra_us_settlement_minor(l->'taxMinor');if line->>'taxTreatment'<>'taxable' and net<>0 then raise exception using errcode='PF004',message='Untaxed line cannot contain tax';end if;tax:=tax+net;
 end loop;
 perform public.zentra_us_settlement_minor(to_jsonb(subtotal::text));perform public.zentra_us_settlement_minor(to_jsonb(discount::text));net:=public.zentra_us_settlement_minor(to_jsonb((subtotal-discount)::text),true);total:=public.zentra_us_settlement_minor(to_jsonb((net+tax)::text),true);perform public.zentra_us_settlement_minor(to_jsonb(tax::text));
 counter:=(r->'counters'->>'invoice')::bigint;if counter>=9007199254740990 then raise exception using errcode='PF012',message='Invoice counter exhausted';end if;counter:=counter+1;number:=(config->>'invoiceNumberPrefix')||'-'||lpad(counter::text,greatest(6,length(counter::text)),'0');
 invoice:=jsonb_build_object('id',id,'number',number,'date',c->>'date','accountingDate',c->>'accountingDate','dueDate',c->>'dueDate','organizationId',org,'currency','USD','companyConfiguration',config,'sellerSnapshot',seller,'sourceEstimateId',e->>'id','sourceEstimateRevision',e->'revision','customer',e->'customer','lines',e->'lines','notes',e->>'notes','subtotal',jsonb_build_object('currency','USD','minorUnits',subtotal::text),'discount',jsonb_build_object('currency','USD','minorUnits',discount::text),'tax',jsonb_build_object('currency','USD','minorUnits',tax::text),'total',jsonb_build_object('currency','USD','minorUnits',total::text),'taxAssessment',p,'payments','[]'::jsonb,'issuedAt',a->>'timestamp','issuedBy',a->>'userId');if e ? 'projectId' then invoice:=invoice||jsonb_build_object('projectId',e->>'projectId');end if;
 lines:=jsonb_build_array(jsonb_build_object('accountId','receivables','debitMinor',total::text,'creditMinor','0'),jsonb_build_object('accountId','sales','debitMinor','0','creditMinor',net::text));if tax>0 then lines:=lines||jsonb_build_array(jsonb_build_object('accountId','tax-payable','debitMinor','0','creditMinor',tax::text));end if;
 effect:=public.zentra_us_accounting_post(r->'ledger',jsonb_build_object('id','entry:invoice:'||id,'idempotencyKey','invoice:'||id,'organizationId',org,'currency','USD','basis','accrual','transactionDate',c->>'date','accountingDate',c->>'accountingDate','periodId',c->>'periodId','description','Invoice '||number,'source',jsonb_build_object('type','customer_invoice','id',id),'lines',lines),a);posting:=effect->'posting';
 header:=public.zentra_us_accounting_header(b,jsonb_set(r->'counters','{invoice}',to_jsonb(counter)));compact:=(header->'ledger'->>'revision')::bigint+1;header:=jsonb_set(header,'{ledger,revision}',to_jsonb(compact));changes:=jsonb_build_array(jsonb_build_object('kind','invoice','id',id,'payload',invoice),jsonb_build_object('kind','journal','id',posting->>'id','payload',posting||jsonb_build_object('revision',compact)));
 receipt:=jsonb_build_object('idempotencyKey',op->>'idempotencyKey','commandHash',public.zentra_us_financial_test_hash(jsonb_build_array(org,a->>'userId',jsonb_build_object('idempotencyKey',op->>'idempotencyKey','expectedRevision',(b->>'revision')::bigint,'command',c))),'revision',(b->>'revision')::bigint+1,'entityId',id,'action','issue_invoice');
 commit:=jsonb_build_object('organizationId',org,'expectedRevision',(b->>'revision')::bigint,'header',header,'changes',changes,'ledgerAudit',jsonb_build_array((effect->'audit')||jsonb_build_object('revision',compact)),'receipt',receipt,'actor',a);
 return jsonb_build_object('revision',(b->>'revision')::bigint+1,'id',id,'operation',op,'actor',a,'commit',commit,'effects',jsonb_build_object('postings',jsonb_build_array(posting),'audit',jsonb_build_array(effect->'audit')));
end $$;

create function public.zentra_us_invoicing_transition(b jsonb,op jsonb,a jsonb,id text) returns jsonb
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
 if op->>'type' in('customer_credit','customer_payment') then return public.zentra_us_invoicing_settlement_transition(b,op,a,id,ledger);end if;
 if op->>'type' is distinct from 'erp_command' then raise exception using errcode='PF010',message='Private accounting operation unavailable';end if;
 if not public.zentra_us_tax_object(op,array['type','idempotencyKey','command','facts']) then raise exception using errcode='PF004',message='Exact invoice operation required';end if;
 if op->'command'->>'type'='issue_invoice' then return public.zentra_us_invoicing_erp(b,op,a,id);end if;
 if op->'command'->>'type' in('save_estimate','accept_estimate') and exists(select 1 from jsonb_array_elements(public.zentra_us_invoicing_current(b)->'invoices') x where x->>'sourceEstimateId'=id) then raise exception using errcode='PF003',message='Issued estimate cannot be changed';end if;
 return public.zentra_us_accounting_transition(b,op,a,id);
end $$;
create function public.zentra_us_invoicing_replay(b jsonb) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare current_book jsonb;e jsonb;rebuilt jsonb;
begin
 perform public.zentra_us_financial_test_budget(b);
 if not public.zentra_us_tax_object(b,array['schemaVersion','revision','baseline','policy','promotion','events']) or b->'schemaVersion' is distinct from '5'::jsonb or jsonb_typeof(b->'events') is distinct from 'array'
 or b->'revision' is distinct from to_jsonb((b->'baseline'->>'revision')::bigint+1+jsonb_array_length(b->'events')) then raise exception using errcode='PF004',message='Invalid private commercial book';end if;
 current_book:=b||jsonb_build_object('revision',(b->'baseline'->>'revision')::bigint+1,'events','[]'::jsonb);
 for e in select value from jsonb_array_elements(b->'events') loop
  if not public.zentra_us_tax_object(e,case when e->'operation'->>'type'='erp_command' then array['revision','id','operation','actor','commit','effects'] else array['revision','id','operation','actor','record','posting'] end) or jsonb_typeof(e->'id') is distinct from 'string' then raise exception using errcode='PF004',message='Invalid private commercial event';end if;
  rebuilt:=public.zentra_us_invoicing_transition(current_book,e->'operation',e->'actor',e->>'id');
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
 return public.zentra_us_invoicing_replay(b);
end $$;
create function public.zentra_us_invoicing_admit(org text,a jsonb,v bigint,cap text) returns void
language plpgsql volatile security invoker set search_path='' as $$
begin
 if cap is distinct from 'postgres-test-invoicing-v5' then raise exception using errcode='PF009',message='Private invoicing TEST capability required';end if;
 perform public.zentra_us_settlement_admit(org,a,v,'postgres-test-settlement-v5');
end $$;
create function public.zentra_read_us_financial_invoicing_test_v5(p_organization text,p_actor jsonb,p_grant_version bigint,p_capability text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare b jsonb;c public.zentra_us_financial_test_cursors%rowtype;
begin
 perform public.zentra_us_invoicing_admit(p_organization,p_actor,p_grant_version,p_capability);b:=public.zentra_us_settlement_book(p_organization);if b is null then return null;end if;
 perform public.zentra_us_settlement_plans(b);select * into c from public.zentra_us_financial_test_cursors where organization_id=p_organization for update;
 if not found or c.revision<>(b->>'revision')::bigint or c.book_sha256<>public.zentra_us_financial_test_hash(b) then raise exception using errcode='PF004',message='Financial cursor mismatch';end if;return b;
end $$;
create function public.zentra_us_financial_invoicing_test_receipt_v5(p_organization text,p_actor jsonb,p_grant_version bigint,p_capability text,p_idempotency_key text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare r public.zentra_us_financial_test_receipts%rowtype;b jsonb;
begin
 b:=public.zentra_read_us_financial_invoicing_test_v5(p_organization,p_actor,p_grant_version,p_capability);
 if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 240 then raise exception using errcode='PF004',message='Invalid financial receipt key';end if;
 select * into r from public.zentra_us_financial_test_receipts where organization_id=p_organization and idempotency_key=p_idempotency_key;if not found then return null;end if;
 return jsonb_build_object('origin',r.origin,'actorId',r.actor_id,'receipt',r.receipt);
end $$;
create function public.zentra_append_us_financial_invoicing_test_v5(p_organization text,p_actor jsonb,p_grant_version bigint,p_capability text,p_expected_revision bigint,p_previous_fingerprint text,p_book jsonb,p_receipt jsonb) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare b jsonb;e jsonb;expected_receipt jsonb;prior public.zentra_us_financial_test_receipts%rowtype;prefix jsonb;
begin
 b:=public.zentra_read_us_financial_invoicing_test_v5(p_organization,p_actor,p_grant_version,p_capability);if b is null then raise exception using errcode='PF004',message='Promoted financial book required';end if;
 perform public.zentra_us_financial_test_budget(p_book);perform public.zentra_us_financial_test_budget(p_receipt);
 if p_expected_revision is null or p_expected_revision<1 or p_previous_fingerprint is null or p_previous_fingerprint !~ '^[a-f0-9]{64}$'
 or not public.zentra_us_tax_object(p_book,array['schemaVersion','revision','baseline','policy','promotion','events']) or jsonb_typeof(p_book->'events') is distinct from 'array' or jsonb_array_length(p_book->'events')<1
 or p_book-'events'-'revision' is distinct from b-'events'-'revision' then raise exception using errcode='PF004',message='Invalid financial commit envelope';end if;
 e:=p_book->'events'->-1;
 if e->'actor' is distinct from p_actor or not public.zentra_us_tax_object(e,case when e->'operation'->>'type'='erp_command' then array['revision','id','operation','actor','commit','effects'] else array['revision','id','operation','actor','record','posting'] end) then raise exception using errcode='PF004',message='Invalid financial event envelope';end if;
 if e->'operation'->>'type' not in('customer_credit','customer_payment','erp_command') or (e->'operation'->>'type'='erp_command' and e->'operation'->'command'->>'type' not in('save_customer','save_estimate','accept_estimate','save_vendor','record_vendor_bill','record_vendor_payment','open_period','close_period','post_manual_journal','reverse_manual_journal','issue_invoice')) then raise exception using errcode='PF010',message='Invoicing capability excludes this command';end if;
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
 perform public.zentra_us_invoicing_key(p_organization,e->'operation',p_actor);
 insert into public.zentra_us_financial_test_events values(p_organization,p_expected_revision+1,e,p_grant_version);
 insert into public.zentra_us_financial_test_receipts values(p_organization,e->'operation'->>'idempotencyKey','financial_v5',p_actor->>'userId',p_receipt);
 if e->'operation'->'command'->>'type'='issue_invoice' then perform public.zentra_us_invoicing_commit_operation(p_organization,e,p_receipt);end if;
 update public.zentra_us_financial_test_cursors set revision=p_expected_revision+1,book_sha256=public.zentra_us_financial_test_hash(p_book) where organization_id=p_organization and revision=p_expected_revision and book_sha256=p_previous_fingerprint;
 if not found then raise exception using errcode='PF001',message='Financial CAS changed';end if;return p_receipt;
end $$;

create function public.zentra_us_invoicing_review_valid(p jsonb,org text,actor_id text,financial_hash text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare r jsonb;c jsonb;m jsonb;e jsonb;b jsonb;line jsonb;k jsonb;i integer:=0;hash text;destination jsonb;instant timestamptz;net numeric;total numeric:=0;
begin
  if not public.zentra_us_tax_object(p,array['schemaVersion','organizationId','actorUserId','request','commandHash','context','merchant','estimate','estimateSha256','classifications','taxDateInstant','addressSource'])
    or p->'schemaVersion' is distinct from '1'::jsonb or p->>'organizationId' is distinct from org or p->>'actorUserId' is distinct from actor_id then return false;end if;
  r:=p->'request';c:=p->'context';m:=p->'merchant';e:=p->'estimate';b:=c->'binding';
  if not public.zentra_us_tax_object(r,array['idempotencyKey','expectedRevision','command']) or not public.zentra_us_tax_revision(r->'expectedRevision',0)
    or jsonb_typeof(r->'idempotencyKey') is distinct from 'string' or r->>'idempotencyKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,231}$'
    or not public.zentra_us_tax_object(r->'command',array['type','id','estimateId','expectedEstimateRevision','date','accountingDate','dueDate','periodId'])
    or not public.zentra_us_tax_strings(r->'command',array['type','id','estimateId','date','accountingDate','dueDate','periodId'])
    or r->'command'->>'type' is distinct from 'issue_invoice' or not public.zentra_us_tax_revision(r->'command'->'expectedEstimateRevision') then return false;end if;
  foreach hash in array array['id','estimateId','periodId'] loop
    if not public.zentra_us_tax_text_valid(r->'command'->>hash,160,false) then return false;end if;
  end loop;
  foreach hash in array array['date','accountingDate','dueDate'] loop
    if r->'command'->>hash !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or to_char((r->'command'->>hash)::date,'YYYY-MM-DD') is distinct from r->'command'->>hash then return false;end if;
  end loop;
  if (r->'command'->>'dueDate')::date<(r->'command'->>'date')::date then return false;end if;
  hash:=encode(sha256(convert_to(public.zentra_us_erp_v4_canonical(jsonb_build_array(org,actor_id,r)),'UTF8')),'hex');
  if p->>'commandHash' is distinct from hash
    or not public.zentra_us_tax_object(c,array['organizationId','countryRevision','configuration','sellerRevision','seller','taxFactsRevision','taxFacts','binding'])
    or c->>'organizationId' is distinct from org or not public.zentra_us_tax_revision(c->'countryRevision') or not public.zentra_us_tax_revision(c->'sellerRevision') or not public.zentra_us_tax_revision(c->'taxFactsRevision')
    or not public.zentra_country_config_valid(c->'configuration',org) or c->'configuration'->>'country' is distinct from 'US' or c->'configuration'->>'currency' is distinct from 'USD'
    or c->'configuration'->'taxConfiguration'->>'status' is distinct from 'configured' or not public.zentra_us_seller_profile_valid(c->'seller') or not public.zentra_us_tax_facts_valid(c->'taxFacts')
    or c->'configuration'->>'timeZone' is distinct from c->'taxFacts'->>'timeZone'
    or not coalesce(public.zentra_us_tax_binding_valid(b,org,(b->>'revision')::bigint),false) or b->>'evidenceKind' not in('provider_observation','test_fixture')
    or not public.zentra_us_tax_object(m,array['credential','configurationFingerprint']) or jsonb_typeof(m->'configurationFingerprint') is distinct from 'string' or m->>'configurationFingerprint' !~ '^[0-9a-f]{64}$'
    or not public.zentra_us_tax_object(m->'credential',array['reference','revision','accountId']) or not public.zentra_us_tax_strings(m->'credential',array['reference','accountId'])
    or not public.zentra_us_tax_text_valid(m->'credential'->>'reference',256,true) or not public.zentra_us_tax_safe_integer(m->'credential'->'revision',1) or m->'credential'->>'accountId' is distinct from b->>'accountId'
    or e->>'organizationId' is distinct from org or e->>'currency' is distinct from 'USD' or e->>'status' is distinct from 'accepted'
    or e->>'id' is distinct from r->'command'->>'estimateId' or e->'revision' is distinct from r->'command'->'expectedEstimateRevision'
    or p->>'estimateSha256' is distinct from encode(sha256(convert_to(public.zentra_us_erp_v4_canonical(e),'UTF8')),'hex')
    or jsonb_typeof(e->'lines') is distinct from 'array' or jsonb_array_length(e->'lines') not between 1 and 100
    or jsonb_typeof(p->'classifications') is distinct from 'array' or jsonb_array_length(p->'classifications')<>jsonb_array_length(e->'lines')
    or not public.zentra_us_tax_strings(p,array['taxDateInstant','addressSource']) or p->>'addressSource' not in ('billing','shipping') or not public.zentra_us_tax_instant(p->>'taxDateInstant') then return false;end if;
  instant:=(p->>'taxDateInstant')::timestamptz;
  if extract(epoch from instant)<0 or extract(epoch from instant)%1<>0 or to_char(instant at time zone (c->'taxFacts'->>'timeZone'),'YYYY-MM-DD') is distinct from r->'command'->>'date' then return false;end if;
  destination:=e->'customer'->(case when p->>'addressSource'='billing' then 'billingAddress' else 'shippingAddress' end);
  if destination->>'country' is distinct from 'US' then return false;end if;
  for line in select value from jsonb_array_elements(e->'lines') loop
    k:=p->'classifications'->i;i:=i+1;
    if not public.zentra_us_tax_object(k,array['lineId','taxCode','kind','taxBehavior','revision','evidenceReference']) or not public.zentra_us_tax_strings(k,array['lineId','taxCode','kind','taxBehavior','evidenceReference'])
      or k->>'lineId' is distinct from line->>'id' or k->>'taxCode' !~ '^txcd_[0-9]{8}$' or k->>'kind' is distinct from 'service' or k->>'taxBehavior' is distinct from 'exclusive' or k->'revision' is distinct from '1'::jsonb
      or k->>'evidenceReference' is distinct from 'ztaxprep_'||encode(sha256(convert_to(public.zentra_us_erp_v4_canonical(jsonb_build_array('zentra:us:financial:invoice:classification:v5',org,actor_id,financial_hash,k->>'lineId',k->>'taxCode')),'UTF8')),'hex')
      or line->>'taxTreatment' is distinct from 'taxable' or line->'unitPrice'->>'currency' is distinct from 'USD'
      or line->>'quantityUnits' !~ '^[1-9][0-9]{0,35}$' or not public.zentra_us_tax_safe_integer(line->'quantityScale') or (line->>'quantityScale')::integer>6
      or (line->>'quantityUnits')::numeric%power(10::numeric,(line->>'quantityScale')::integer)<>0
      or (line->>'quantityUnits')::numeric/power(10::numeric,(line->>'quantityScale')::integer)>9007199254740991
      or not public.zentra_us_tax_amount(line->'unitPrice'->'minorUnits') or (line->'unitPrice'->>'minorUnits')::numeric<=0
      or not public.zentra_us_tax_safe_integer(line->'discountBasisPoints') or (line->>'discountBasisPoints')::integer>=10000 then return false;end if;
    net:=(public.zentra_us_erp_line_totals(line)->>'netMinor')::numeric;total:=total+net;
    if net not between 1 and 9007199254740991 or total>9007199254740991 then return false;end if;
  end loop;
  return not exists(select 1 from jsonb_array_elements(p->'classifications') a group by a->>'lineId' having count(*)>1);
exception when others then return false;end $$;
create function public.zentra_us_invoicing_instant(v text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$ begin return coalesce(v ~ '^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' and to_char(v::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=v,false);exception when others then return false;end $$;
create function public.zentra_us_invoicing_context_valid(c jsonb,org text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
begin
 return coalesce(public.zentra_us_tax_object(c,array['schemaVersion','organizationId','revision','countryRevision','configuration','sellerRevision','seller','taxFactsRevision','taxFacts','binding','merchant','admittedBy','admittedAt','contextSha256']) and c->'schemaVersion'='1'::jsonb and c->>'organizationId'=org
 and public.zentra_us_tax_strings(c,array['organizationId','admittedBy','admittedAt','contextSha256']) and public.zentra_us_tax_text_valid(c->>'admittedBy',256,true) and public.zentra_us_purchase_timestamp(c->>'admittedAt')
 and public.zentra_us_tax_revision(c->'revision') and public.zentra_us_tax_revision(c->'countryRevision') and public.zentra_us_tax_revision(c->'sellerRevision') and public.zentra_us_tax_revision(c->'taxFactsRevision')
 and public.zentra_country_config_valid(c->'configuration',org) and c->'configuration'->>'country'='US' and c->'configuration'->>'currency'='USD' and c->'configuration'->>'accountingBasis'='accrual' and c->'configuration'->'taxConfiguration'->>'status'='configured'
 and public.zentra_us_seller_profile_valid(c->'seller') and public.zentra_us_tax_facts_valid(c->'taxFacts') and c->'configuration'->>'timeZone'=c->'taxFacts'->>'timeZone'
 and public.zentra_us_tax_binding_valid(c->'binding',org,(c->'binding'->>'revision')::bigint)
 and public.zentra_us_tax_object(c->'merchant',array['credential','configurationFingerprint']) and public.zentra_us_tax_strings(c->'merchant',array['configurationFingerprint']) and c->'merchant'->>'configurationFingerprint' ~ '^[0-9a-f]{64}$'
 and public.zentra_us_tax_object(c->'merchant'->'credential',array['reference','revision','accountId']) and public.zentra_us_tax_strings(c->'merchant'->'credential',array['reference','accountId']) and public.zentra_us_tax_text_valid(c->'merchant'->'credential'->>'reference',256,true) and public.zentra_us_tax_revision(c->'merchant'->'credential'->'revision') and c->'merchant'->'credential'->>'accountId'=c->'binding'->>'accountId'
 and public.zentra_us_invoicing_instant(c->>'admittedAt') and public.zentra_us_invoicing_instant(c->'binding'->>'observedAt') and public.zentra_us_invoicing_instant(c->'binding'->>'validUntil') and (c->'binding'->>'observedAt')::timestamptz<=(c->>'admittedAt')::timestamptz and (c->>'admittedAt')::timestamptz<(c->'binding'->>'validUntil')::timestamptz and (c->'binding'->>'validUntil')::timestamptz-(c->'binding'->>'observedAt')::timestamptz<=interval '120 seconds'
 and c->>'contextSha256'=public.zentra_us_financial_test_hash(c-'contextSha256'),false);
exception when others then return false;end $$;
create table public.zentra_us_financial_invoice_test_contexts(
 organization_id text not null references public.zentra_us_financial_test_heads on delete restrict,revision bigint not null,payload jsonb not null,primary key(organization_id,revision),check(payload->'revision'=to_jsonb(revision)),check(public.zentra_us_invoicing_context_valid(payload,organization_id))
);
create table public.zentra_us_financial_invoice_test_preparations(
 organization_id text not null references public.zentra_us_financial_test_heads on delete restrict,idempotency_key text not null,payload jsonb not null,authority jsonb not null,grant_version bigint not null,primary key(organization_id,idempotency_key),check(idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$')
);
create table public.zentra_us_financial_invoice_test_operations(
 organization_id text not null,operation_id uuid not null,idempotency_key text not null,payload jsonb not null,authority jsonb not null,grant_version bigint not null,primary key(organization_id,operation_id),unique(organization_id,idempotency_key),foreign key(organization_id,idempotency_key) references public.zentra_us_financial_invoice_test_preparations on delete restrict
);
create unique index zentra_invoice_test_invoice_unique on public.zentra_us_financial_invoice_test_operations(organization_id,(payload->'preparation'->'erpRequest'->'command'->>'id'));
create unique index zentra_invoice_test_provider_unique on public.zentra_us_financial_invoice_test_operations(organization_id,(payload->>'providerKey'));
create function public.zentra_us_invoicing_context_guard() returns trigger
language plpgsql volatile security invoker set search_path='' as $$
declare c public.zentra_workspace_country_configs%rowtype;s public.zentra_us_seller_profiles%rowtype;f public.zentra_us_tax_profiles%rowtype;
begin
 if current_user='service_role' or tg_op<>'INSERT' then raise exception using errcode='PF003',message='Immutable DB-owner TEST context administration required';end if;
 perform 1 from public.zentra_workspaces where organization_id=new.organization_id for update;select * into c from public.zentra_workspace_country_configs where organization_id=new.organization_id for update;perform 1 from public.zentra_us_erp_heads where organization_id=new.organization_id for update;
 select * into s from public.zentra_us_seller_profiles where organization_id=new.organization_id for update;select * into f from public.zentra_us_tax_profiles where organization_id=new.organization_id for update;
 perform public.zentra_us_financial_test_budget(new.payload);
 if not public.zentra_us_invoicing_context_valid(new.payload,new.organization_id) or c.config is distinct from new.payload->'configuration' or c.revision is distinct from (new.payload->>'countryRevision')::bigint or s.profile is distinct from new.payload->'seller' or s.revision is distinct from (new.payload->>'sellerRevision')::bigint or f.facts is distinct from new.payload->'taxFacts' or f.revision is distinct from (new.payload->>'taxFactsRevision')::bigint or new.revision<>coalesce((select max(revision) from public.zentra_us_financial_invoice_test_contexts where organization_id=new.organization_id),0)+1
 or (new.payload->>'admittedAt')::timestamptz>clock_timestamp()+interval '30 seconds' or (new.payload->'binding'->>'observedAt')::timestamptz>(new.payload->>'admittedAt')::timestamptz or (new.payload->'binding'->>'validUntil')::timestamptz<=clock_timestamp() then raise exception using errcode='PF007',message='Corroborated original TEST context required';end if;
 return new;
end $$;
create trigger zentra_invoice_test_context_guard before insert or update or delete on public.zentra_us_financial_invoice_test_contexts for each row execute function public.zentra_us_invoicing_context_guard();
create trigger zentra_invoice_test_context_truncate before truncate on public.zentra_us_financial_invoice_test_contexts for each statement execute function public.zentra_us_invoicing_context_guard();
create function public.zentra_us_invoicing_context(org text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare c jsonb;
begin
 perform 1 from public.zentra_us_seller_profiles where organization_id=org for update;perform 1 from public.zentra_us_tax_profiles where organization_id=org for update;perform 1 from public.zentra_us_tax_provider_bindings where organization_id=org for update;
 select payload into c from public.zentra_us_financial_invoice_test_contexts where organization_id=org order by revision desc limit 1 for update;
 if c is null or (c->'binding'->>'observedAt')::timestamptz>clock_timestamp() or (c->'binding'->>'validUntil')::timestamptz<=clock_timestamp() then raise exception using errcode='PF014',message='Fresh admitted TEST context required';end if;return c;
end $$;
create function public.zentra_us_invoicing_preparation_valid(p jsonb,org text,actor_id text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare legacy jsonb;c jsonb;request jsonb;
begin
 if not public.zentra_us_tax_object(p,array['schemaVersion','organizationId','actorId','request','financialCommandHash','erpRequest','erpCommandHash','previousBookFingerprint','context','estimate','estimateSha256','classifications','taxDateInstant','addressSource','preparedAt','preparationSha256']) or p->'schemaVersion' is distinct from '1'::jsonb or p->>'organizationId' is distinct from org or p->>'actorId' is distinct from actor_id or not public.zentra_us_tax_strings(p,array['organizationId','actorId','financialCommandHash','erpCommandHash','previousBookFingerprint','estimateSha256','taxDateInstant','addressSource','preparedAt','preparationSha256']) or p->>'previousBookFingerprint' !~ '^[0-9a-f]{64}$' or not public.zentra_us_purchase_timestamp(p->>'preparedAt') then return false;end if;
 request:=p->'request';c:=p->'context';
 if not public.zentra_us_tax_object(request,array['idempotencyKey','expectedRevision','command']) or not public.zentra_us_tax_object(request->'command',array['type','request']) or request->'command'->>'type' is distinct from 'erp_command' or p->'erpRequest' is distinct from jsonb_build_object('idempotencyKey',request->>'idempotencyKey','expectedRevision',request->'expectedRevision','command',request->'command'->'request') or request->>'idempotencyKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' or p->>'financialCommandHash' is distinct from public.zentra_us_financial_test_hash(jsonb_build_array(org,actor_id,request)) or not public.zentra_us_invoicing_context_valid(c,org) or p->>'preparationSha256' is distinct from public.zentra_us_financial_test_hash(p-'preparationSha256') then return false;end if;
 if (p->'estimate' ? 'projectId' and not public.zentra_us_tax_text_valid(p->'estimate'->>'projectId',160,true)) or not public.zentra_us_invoicing_instant(p->>'preparedAt') or (p->>'preparedAt')::timestamptz<(c->>'admittedAt')::timestamptz or (p->>'preparedAt')::timestamptz>=(c->'binding'->>'validUntil')::timestamptz or abs(extract(epoch from (p->>'taxDateInstant')::timestamptz-(p->>'preparedAt')::timestamptz))>31*86400 then return false;end if;
 legacy:=jsonb_build_object('schemaVersion',1,'organizationId',org,'actorUserId',actor_id,'request',p->'erpRequest','commandHash',p->>'erpCommandHash','context',c-array['schemaVersion','revision','merchant','admittedBy','admittedAt','contextSha256'],'merchant',c->'merchant','estimate',p->'estimate','estimateSha256',p->>'estimateSha256','classifications',p->'classifications','taxDateInstant',p->>'taxDateInstant','addressSource',p->>'addressSource');
 return public.zentra_us_invoicing_review_valid(legacy,org,actor_id,p->>'financialCommandHash');
exception when others then return false;end $$;
create function public.zentra_us_invoicing_source(org text,estimate jsonb,issued_at text) returns void
language plpgsql volatile security invoker set search_path='' as $$
declare o public.zentra_us_sales_orders%rowtype;
begin
 perform 1 from public.zentra_workspaces where organization_id=org for update;
 select * into o from public.zentra_us_sales_orders where organization_id=org and estimate_id=estimate->>'id' and state<>'cancelled' for update;
 if found and (o.state<>'confirmed' or o.payload->'sourceEstimate'->'revision' is distinct from estimate->'revision' or o.payload->'sourceEstimate'->'lines' is distinct from estimate->'lines' or o.payload->'sourceEstimate'->'customer' is distinct from estimate->'customer' or o.payload->'sourceEstimate'->'projectId' is distinct from estimate->'projectId' or o.payload->'sourceEstimate'->'notes' is distinct from estimate->'notes' or (issued_at)::timestamptz<(o.payload->'confirmation'->>'confirmedAt')::timestamptz) then raise exception using errcode='PO011',message='Internally confirmed exact order source required before invoicing';end if;
end $$;
create function public.zentra_us_invoicing_preparation_current(org text,p jsonb,a jsonb) returns void
language plpgsql volatile security invoker set search_path='' as $$
declare b jsonb;c jsonb;e jsonb;head public.zentra_us_financial_test_cursors%rowtype;
begin
 select * into head from public.zentra_us_financial_test_cursors where organization_id=org for update;
 b:=public.zentra_us_settlement_book(org);if head.revision is distinct from (b->>'revision')::bigint or head.book_sha256 is distinct from public.zentra_us_financial_test_hash(b) then raise exception using errcode='PF004',message='Exact invoice cursor required';end if;c:=public.zentra_us_invoicing_context(org);e:=public.zentra_us_invoicing_command(b,p->'erpRequest'->'command',p->'erpRequest'->'command'->>'id');
 if b->'revision' is distinct from p->'request'->'expectedRevision' or public.zentra_us_financial_test_hash(b) is distinct from p->>'previousBookFingerprint' or c is distinct from p->'context' or e is distinct from p->'estimate' then raise exception using errcode='PF001',message='Reviewed financial invoice source changed';end if;
 if (p->>'preparedAt')::timestamptz>clock_timestamp()+interval '30 seconds' or abs(extract(epoch from (p->>'taxDateInstant')::timestamptz-clock_timestamp()))>31*86400 then raise exception using errcode='PF016',message='Original invoice review clock unavailable';end if;
 perform public.zentra_us_invoicing_source(org,e,a->>'timestamp');
end $$;
create function public.zentra_us_invoicing_key(org text,op jsonb,a jsonb) returns void
language plpgsql volatile security invoker set search_path='' as $$
declare p jsonb;key text:=op->>'idempotencyKey';
begin
 if exists(select 1 from public.zentra_us_tax_invoice_preparations where organization_id=org and erp_idempotency_key=key) or exists(select 1 from public.zentra_us_tax_operations where organization_id=org and erp_idempotency_key=key) then raise exception using errcode='PF002',message='Historical fiscal key remains reserved';end if;
 select payload into p from public.zentra_us_financial_invoice_test_preparations where organization_id=org and idempotency_key=key for update;
 if p is not null and (op->>'type' is distinct from 'erp_command' or op->'command' is distinct from p->'erpRequest'->'command' or a->>'userId' is distinct from p->>'actorId') then raise exception using errcode='PF002',message='Prepared invoice key remains reserved';end if;
 if op->'command'->>'type'='issue_invoice' and p is null then raise exception using errcode='PF014',message='Durable invoice preparation required';end if;
end $$;

create function public.zentra_us_invoicing_resolved_valid(p jsonb,payload jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare o public.zentra_us_tax_operations%rowtype;r jsonb;v jsonb;line jsonb;class jsonb;original jsonb;address jsonb;i integer:=0;total numeric:=0;providerkey text;
begin
 r:=(payload->>'resolvedBody')::jsonb;
 o:=jsonb_populate_record(null::public.zentra_us_tax_operations,jsonb_build_object('organization_id',p->>'organizationId','operation_id',payload->>'operationId','invoice_id',p->'erpRequest'->'command'->>'id','actor_id',p->>'actorId','erp_idempotency_key',p->'erpRequest'->>'idempotencyKey','command_hash',p->>'erpCommandHash','expected_erp_revision',p->'erpRequest'->'expectedRevision','country_revision',p->'context'->'countryRevision','seller_revision',p->'context'->'sellerRevision','tax_facts_revision',p->'context'->'taxFactsRevision','binding_revision',p->'context'->'binding'->'revision','resolved_sha256',payload->>'resolvedSha256','provider_idempotency_key',payload->>'providerKey','status','reserved'));
 if not public.zentra_us_tax_body_valid(payload->>'resolvedBody') or not public.zentra_us_tax_body_valid(payload->>'paramsBody') or payload->>'resolvedBody' is distinct from public.zentra_us_erp_v4_canonical(r) or payload->>'resolvedSha256' is distinct from public.zentra_us_financial_test_hash(r) or payload->>'paramsBody' is distinct from public.zentra_us_erp_v4_canonical(r->'params') or payload->>'paramsSha256' is distinct from public.zentra_us_financial_test_hash(r->'params') or r->>'paramsSha256' is distinct from payload->>'paramsSha256' or r->'snapshots' is distinct from jsonb_build_object('configuration',p->'context'->'configuration','estimate',p->'estimate','taxFacts',p->'context'->'taxFacts') or r->'binding' is distinct from p->'context'->'binding' or r->'classifications' is distinct from p->'classifications' or r->>'taxDateInstant' is distinct from p->>'taxDateInstant' or r->'params'->'customer_details'->>'address_source' is distinct from p->>'addressSource' or r->>'invoiceDate' is distinct from p->'erpRequest'->'command'->>'date' then return false;end if;
  if not public.zentra_us_tax_object(r,array['schemaVersion','organizationId','operationId','invoiceId','actorUserId','erpIdempotencyKey','commandHash','expectedErpRevision','sourceEstimateId','sourceEstimateRevision','countryRevision','sellerRevision','taxFactsRevision','binding','classifications','invoiceDate','taxDateInstant','taxDatePolicy','timeZone','snapshots','params','netTotalMinor','paramsSha256'])
    or not public.zentra_us_tax_strings(r,array['organizationId','operationId','invoiceId','actorUserId','erpIdempotencyKey','commandHash','sourceEstimateId','invoiceDate','taxDateInstant','taxDatePolicy','timeZone','netTotalMinor','paramsSha256'])
    or r->'schemaVersion' is distinct from '1'::jsonb or r->>'organizationId' is distinct from o.organization_id or r->>'operationId' is distinct from o.operation_id::text
    or r->>'invoiceId' is distinct from o.invoice_id or r->>'actorUserId' is distinct from o.actor_id or r->>'erpIdempotencyKey' is distinct from o.erp_idempotency_key or r->>'commandHash' is distinct from o.command_hash
    or not public.zentra_us_tax_text_valid(o.actor_id,256,false) or o.erp_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,231}$'
    or not public.zentra_us_tax_text_valid(o.invoice_id,160,false) or o.status<>'reserved'
    or not public.zentra_us_tax_revision(r->'expectedErpRevision',0) or (r->>'expectedErpRevision')::bigint<>o.expected_erp_revision
    or not public.zentra_us_tax_revision(r->'countryRevision') or (r->>'countryRevision')::bigint<>o.country_revision
    or not public.zentra_us_tax_revision(r->'sellerRevision') or (r->>'sellerRevision')::bigint<>o.seller_revision
    or not public.zentra_us_tax_revision(r->'taxFactsRevision') or (r->>'taxFactsRevision')::bigint<>o.tax_facts_revision
    or not public.zentra_us_tax_revision(r->'sourceEstimateRevision') or not public.zentra_us_tax_binding_valid(r->'binding',o.organization_id,o.binding_revision)
    or not public.zentra_us_tax_object(r->'snapshots',array['configuration','estimate','taxFacts']) or not public.zentra_us_tax_facts_valid(r->'snapshots'->'taxFacts')
    or r->>'timeZone' is distinct from r->'snapshots'->'taxFacts'->>'timeZone' or r->>'taxDatePolicy' is distinct from 'caller_supplied_invoice_instant'
    or not public.zentra_us_tax_instant(r->>'taxDateInstant') or extract(epoch from (r->>'taxDateInstant')::timestamptz)%1<>0 or r->>'invoiceDate' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or to_char((r->>'taxDateInstant')::timestamptz at time zone (r->>'timeZone'),'YYYY-MM-DD') is distinct from r->>'invoiceDate'
    or not public.zentra_us_tax_amount(r->'netTotalMinor') then raise exception using errcode='PF004',message='Invalid resolved TEST tax operation';end if;
  v:=r->'params';
  if not public.zentra_us_tax_object(v,array['currency','customer_details','tax_date','line_items','expand']) or v->>'currency' is distinct from 'usd' or v->'expand' is distinct from '["line_items.data.tax_breakdown"]'::jsonb
    or not public.zentra_us_tax_object(v->'customer_details',array['address','address_source']) or not public.zentra_us_tax_strings(v->'customer_details',array['address_source']) or v->'customer_details'->>'address_source' not in ('billing','shipping')
    or not public.zentra_us_tax_safe_integer(v->'tax_date') or (v->>'tax_date')::numeric<>floor(extract(epoch from (r->>'taxDateInstant')::timestamptz))
    or jsonb_typeof(v->'line_items') is distinct from 'array' or jsonb_array_length(v->'line_items') not between 1 and 100
    or jsonb_typeof(r->'classifications') is distinct from 'array' or jsonb_array_length(r->'classifications')<>jsonb_array_length(v->'line_items') then raise exception using errcode='PF004',message='Unsupported TEST calculation params';end if;
  address:=r->'snapshots'->'estimate'->'customer'->(case when v->'customer_details'->>'address_source'='billing' then 'billingAddress' else 'shippingAddress' end);
  if v->'customer_details'->'address' is distinct from jsonb_strip_nulls(jsonb_build_object('country',address->'country','line1',address->'line1','line2',address->'line2','city',address->'city','state',address->'subdivision','postal_code',address->'postalCode')) then raise exception using errcode='PF004',message='Calculation address does not match the snapshot';end if;
  for line in select value from jsonb_array_elements(v->'line_items') loop
    class:=r->'classifications'->i;i:=i+1;
    select value into original from jsonb_array_elements(r->'snapshots'->'estimate'->'lines') where value->>'id'=line->>'reference';
    if not public.zentra_us_tax_object(line,array['amount','quantity','reference','tax_code','tax_behavior']) or not public.zentra_us_tax_safe_integer(line->'amount',1) or not public.zentra_us_tax_safe_integer(line->'quantity',1)
      or not public.zentra_us_tax_strings(line,array['reference','tax_code','tax_behavior']) or line->>'tax_behavior' is distinct from 'exclusive' or line->>'tax_code' !~ '^txcd_[0-9]{8}$' or not public.zentra_us_tax_text_valid(line->>'reference',160,false)
      or not public.zentra_us_tax_object(class,array['lineId','taxCode','kind','taxBehavior','revision','evidenceReference']) or class->>'kind' is distinct from 'service' or class->>'taxBehavior' is distinct from 'exclusive'
      or not public.zentra_us_tax_strings(class,array['lineId','taxCode','kind','taxBehavior','evidenceReference']) or class->>'lineId' is distinct from line->>'reference' or class->>'taxCode' is distinct from line->>'tax_code' or not public.zentra_us_tax_revision(class->'revision') or not public.zentra_us_tax_text_valid(class->>'evidenceReference',256,false)
      or original is null or original->>'taxTreatment' is distinct from 'taxable' or (line->>'amount')::numeric is distinct from (public.zentra_us_erp_line_totals(original)->>'netMinor')::numeric
      or (line->>'quantity')::numeric is distinct from (original->>'quantityUnits')::numeric/power(10::numeric,(original->>'quantityScale')::integer) then raise exception using errcode='PF004',message='Invalid explicit line classification or quantity';end if;
    total:=total+(line->>'amount')::numeric;
  end loop;
  if total<>(r->>'netTotalMinor')::numeric or (select count(*)<>count(distinct value->>'reference') from jsonb_array_elements(v->'line_items')) then raise exception using errcode='PF004',message='Calculation line identity or sum mismatch';end if;
  providerkey:='ztax_test_'||pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('["zentra:us:stripe-tax:calculation:v1",'||to_json(o.organization_id)::text||','||to_json(o.operation_id::text)::text||','||to_json(r->'binding'->>'accountId')::text||',"test",'||to_json(o.resolved_sha256)::text||']','UTF8')),'hex');
  if o.provider_idempotency_key is distinct from providerkey then raise exception using errcode='PF004',message='Provider operation key mismatch';end if;
  if jsonb_array_length(v->'line_items')<>jsonb_array_length(r->'snapshots'->'estimate'->'lines') then raise exception using errcode='PF004',message='Incomplete calculation line coverage';end if;
 return true;
exception when others then return false;end $$;
create function public.zentra_us_invoicing_operation_valid(v jsonb,org text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare p jsonb;o public.zentra_us_tax_operations%rowtype;proof jsonb;
begin
 if not public.zentra_us_tax_object(v,array['schemaVersion','status','organizationId','operationId','preparation','resolvedBody','resolvedSha256','paramsBody','paramsSha256','providerKey','reservedAt','retryUntil','proofBody','proofSha256','assessment','receipt']) or v->'schemaVersion' is distinct from '1'::jsonb or v->>'organizationId' is distinct from org or not public.zentra_us_tax_strings(v,array['status','organizationId','operationId','resolvedBody','resolvedSha256','paramsBody','paramsSha256','providerKey','reservedAt','retryUntil']) or v->>'status' not in('reserved','calculated','committed') or not public.zentra_us_purchase_timestamp(v->>'reservedAt') or not public.zentra_us_purchase_timestamp(v->>'retryUntil') or (v->>'retryUntil')::timestamptz<>(v->>'reservedAt')::timestamptz+interval '23 hours' then return false;end if;
 p:=v->'preparation';if not public.zentra_us_invoicing_instant(v->>'reservedAt') or not public.zentra_us_invoicing_instant(v->>'retryUntil') or v->>'operationId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or (v->>'reservedAt')::timestamptz<(p->>'preparedAt')::timestamptz or (v->>'reservedAt')::timestamptz>=(p->'context'->'binding'->>'validUntil')::timestamptz or abs(extract(epoch from (p->>'taxDateInstant')::timestamptz-(v->>'reservedAt')::timestamptz))>31*86400 then return false;end if;if not public.zentra_us_invoicing_preparation_valid(p,org,p->>'actorId') or not public.zentra_us_invoicing_resolved_valid(p,v) then return false;end if;
 if v->>'status'='reserved' then return v->'proofBody'='null'::jsonb and v->'proofSha256'='null'::jsonb and v->'assessment'='null'::jsonb and v->'receipt'='null'::jsonb;end if;
 if not public.zentra_us_tax_strings(v,array['proofBody','proofSha256']) or not public.zentra_us_tax_body_valid(v->>'proofBody') then return false;end if;proof:=(v->>'proofBody')::jsonb;
 if v->>'proofBody' is distinct from public.zentra_us_erp_v4_canonical(proof) or v->>'proofSha256' is distinct from public.zentra_us_financial_test_hash(proof) then return false;end if;
 o:=jsonb_populate_record(null::public.zentra_us_tax_operations,jsonb_build_object('organization_id',org,'operation_id',v->>'operationId','resolved',(v->>'resolvedBody')::jsonb,'resolved_sha256',v->>'resolvedSha256','params_sha256',v->>'paramsSha256'));
 if exists(select 1 from jsonb_array_elements(proof->'lines') with ordinality l(x,n) where x->>'lineId' is distinct from ((v->>'resolvedBody')::jsonb->'params'->'line_items'->((n-1)::integer)->>'reference') or x->>'lineId' is distinct from (v->'assessment'->'lines'->((n-1)::integer)->>'id')) or exists(select 1 from jsonb_array_elements(proof->'lines') l cross join lateral jsonb_array_elements(l->'breakdowns') br where not public.zentra_us_tax_text_valid(br->'jurisdiction'->>'displayName',256,true)) then return false;end if;
 return coalesce(public.zentra_us_invoicing_instant(proof->>'calculatedAt') and (proof->>'calculatedAt')::timestamptz<(p->'context'->'binding'->>'validUntil')::timestamptz and abs(extract(epoch from (p->>'taxDateInstant')::timestamptz-(proof->>'calculatedAt')::timestamptz))<=31*86400 and (proof->>'calculatedAt')::timestamptz>=(v->>'reservedAt')::timestamptz and (proof->>'calculatedAt')::timestamptz<(v->>'retryUntil')::timestamptz and public.zentra_us_tax_private_proof_valid(o,proof,v->'assessment') and (v->>'status'='committed' or v->'receipt'='null'::jsonb),false);
exception when others then return false;end $$;
create function public.zentra_us_invoicing_preparation_guard() returns trigger
language plpgsql volatile security invoker set search_path='' as $$
declare c jsonb;
begin
 if tg_op<>'INSERT' then raise exception using errcode='PF003',message='Invoice preparations are immutable';end if;
 perform public.zentra_us_invoicing_admit(new.organization_id,new.authority,new.grant_version,'postgres-test-invoicing-v5');perform public.zentra_us_financial_test_budget(new.payload);
 if not public.zentra_us_invoicing_preparation_valid(new.payload,new.organization_id,new.authority->>'userId') or new.idempotency_key is distinct from new.payload->'request'->>'idempotencyKey' then raise exception using errcode='PF004',message='Exact invoice preparation required';end if;
 if exists(select 1 from public.zentra_us_tax_operations where organization_id=new.organization_id and invoice_id=new.payload->'erpRequest'->'command'->>'id') or exists(select 1 from public.zentra_us_tax_invoice_preparations where organization_id=new.organization_id and preparation->'request'->'command'->>'id'=new.payload->'erpRequest'->'command'->>'id') or exists(select 1 from public.zentra_us_financial_test_receipts where organization_id=new.organization_id and idempotency_key=new.idempotency_key) or exists(select 1 from public.zentra_us_tax_invoice_preparations where organization_id=new.organization_id and erp_idempotency_key=new.idempotency_key) or exists(select 1 from public.zentra_us_tax_operations where organization_id=new.organization_id and erp_idempotency_key=new.idempotency_key) then raise exception using errcode='PF002',message='Invoice operation key is reserved';end if;
 perform public.zentra_us_invoicing_preparation_current(new.organization_id,new.payload,new.authority);return new;
end $$;
create trigger zentra_invoice_test_preparation_guard before insert or update or delete on public.zentra_us_financial_invoice_test_preparations for each row execute function public.zentra_us_invoicing_preparation_guard();
create trigger zentra_invoice_test_preparation_truncate before truncate on public.zentra_us_financial_invoice_test_preparations for each statement execute function public.zentra_us_invoicing_preparation_guard();
create function public.zentra_us_invoicing_operation_guard() returns trigger
language plpgsql volatile security invoker set search_path='' as $$
declare p jsonb;e jsonb;b jsonb;expected_receipt jsonb;proof jsonb;
begin
 if tg_op not in('INSERT','UPDATE') then raise exception using errcode='PF003',message='Invoice operations must be retained';end if;
 perform public.zentra_us_invoicing_admit(new.organization_id,new.authority,new.grant_version,'postgres-test-invoicing-v5');perform public.zentra_us_financial_test_budget(new.payload);
 select payload into p from public.zentra_us_financial_invoice_test_preparations where organization_id=new.organization_id and idempotency_key=new.idempotency_key for update;
 if p is null or p is distinct from new.payload->'preparation' or p->>'actorId' is distinct from new.authority->>'userId' or new.operation_id::text is distinct from new.payload->>'operationId' or not public.zentra_us_invoicing_operation_valid(new.payload,new.organization_id) then raise exception using errcode='PF004',message='Corroborated private invoice operation required';end if;
 if tg_op='INSERT' then
  if exists(select 1 from public.zentra_us_financial_invoice_test_operations where organization_id=new.organization_id and (operation_id=new.operation_id or payload->>'providerKey'=new.payload->>'providerKey' or payload->'preparation'->'erpRequest'->'command'->>'id'=p->'erpRequest'->'command'->>'id')) then raise exception using errcode='PF002',message='Fiscal operation identity remains reserved';end if;
  if exists(select 1 from public.zentra_us_tax_operations where organization_id=new.organization_id and (operation_id=new.operation_id or invoice_id=p->'erpRequest'->'command'->>'id' or provider_idempotency_key=new.payload->>'providerKey')) then raise exception using errcode='PF002',message='Legacy fiscal identifiers remain reserved';end if;
  if new.payload->>'status'<>'reserved' or (new.payload->>'reservedAt')::timestamptz>clock_timestamp()+interval '30 seconds' or (new.payload->>'reservedAt')::timestamptz<(p->>'preparedAt')::timestamptz then raise exception using errcode='PF016',message='Original invoice reservation clock required';end if;perform public.zentra_us_invoicing_preparation_current(new.organization_id,p,new.authority);
 else
  if new.organization_id is distinct from old.organization_id or new.operation_id is distinct from old.operation_id or new.idempotency_key is distinct from old.idempotency_key or new.authority is distinct from old.authority or new.grant_version is distinct from old.grant_version or new.payload-array['status','proofBody','proofSha256','assessment','receipt'] is distinct from old.payload-array['status','proofBody','proofSha256','assessment','receipt'] then raise exception using errcode='PF003',message='Invoice operation identity is immutable';end if;
  if old.payload->>'status'='reserved' and new.payload->>'status'='calculated' then
   if (old.payload->>'retryUntil')::timestamptz<=clock_timestamp() then raise exception using errcode='PF014',message='Original invoice retry window expired';end if;perform public.zentra_us_invoicing_preparation_current(new.organization_id,p,new.authority);proof:=(new.payload->>'proofBody')::jsonb;
   if (proof->>'calculatedAt')::timestamptz>clock_timestamp() or (new.payload->'assessment'->>'validUntil')::timestamptz<=clock_timestamp() then raise exception using errcode='PF014',message='Fresh original invoice proof required';end if;
  elsif old.payload->>'status'='calculated' and new.payload->>'status'='committed' then
   if new.payload-array['status','receipt'] is distinct from old.payload-array['status','receipt'] then raise exception using errcode='PF003',message='Invoice proof is immutable';end if;
   b:=public.zentra_us_settlement_book(new.organization_id);select payload into e from public.zentra_us_financial_test_events where organization_id=new.organization_id and payload->'operation'->>'idempotencyKey'=new.idempotency_key;
   expected_receipt:=public.zentra_us_settlement_receipt(b,e);
   if e is null or e->'operation'->'command' is distinct from p->'erpRequest'->'command' or e->'actor'->>'userId' is distinct from p->>'actorId' or e->'operation'->'facts'->'taxAssessment' is distinct from new.payload->'assessment' or e->'operation'->'facts'->'sellerSnapshot' is distinct from (jsonb_build_object('organizationId',new.organization_id)||(p->'context'->'seller')) or new.payload->'receipt' is distinct from expected_receipt or expected_receipt->>'commandHash' is distinct from p->>'financialCommandHash' or not exists(select 1 from public.zentra_us_financial_test_receipts r where r.organization_id=new.organization_id and r.idempotency_key=new.idempotency_key and r.receipt=expected_receipt) then raise exception using errcode='PF004',message='Exact atomic invoice event and receipt required';end if;
  else raise exception using errcode='PF003',message='Invoice operation transition is immutable';end if;
 end if;return new;
end $$;
create trigger zentra_invoice_test_operation_guard before insert or update or delete on public.zentra_us_financial_invoice_test_operations for each row execute function public.zentra_us_invoicing_operation_guard();
create trigger zentra_invoice_test_operation_truncate before truncate on public.zentra_us_financial_invoice_test_operations for each statement execute function public.zentra_us_invoicing_operation_guard();
-- Historical corroboration is separate from live merchant/source admission.
create function public.zentra_us_invoicing_plans(b jsonb,completed boolean default true) returns void
language plpgsql volatile security invoker set search_path='' as $$
declare e jsonb;plan public.zentra_us_financial_test_tax_plans%rowtype;o public.zentra_us_financial_invoice_test_operations%rowtype;p jsonb;prefix jsonb;org text:=b->'baseline'->'configuration'->>'organizationId';
begin
 for e in select value from jsonb_array_elements(b->'events') loop
  if e->'operation'->>'type'='customer_credit' then
   select * into plan from public.zentra_us_financial_test_tax_plans where organization_id=org and idempotency_key=e->'operation'->>'idempotencyKey';
   if not found or plan.invoice_id is distinct from e->'operation'->>'invoiceId' or plan.proof is distinct from e->'operation'->'taxProof' then raise exception using errcode='PF014',message='Private TEST tax plan required';end if;
  elsif e->'operation'->'command'->>'type'='issue_invoice' then
   select * into o from public.zentra_us_financial_invoice_test_operations where organization_id=org and idempotency_key=e->'operation'->>'idempotencyKey';p:=o.payload->'preparation';
   prefix:=b||jsonb_build_object('revision',(e->>'revision')::bigint-1,'events',(select coalesce(jsonb_agg(x order by n),'[]'::jsonb) from jsonb_array_elements(b->'events') with ordinality t(x,n) where (x->>'revision')::bigint<(e->>'revision')::bigint));
   if o.payload is null or not public.zentra_us_invoicing_operation_valid(o.payload,org) or o.payload->>'status' not in('calculated','committed') or (completed and o.payload->>'status'<>'committed')
    or public.zentra_us_invoicing_command(prefix,p->'erpRequest'->'command',p->'erpRequest'->'command'->>'id') is distinct from p->'estimate' or p->'context'->'configuration' is distinct from b->'baseline'->'configuration' or p->'request'->'expectedRevision' is distinct from prefix->'revision' or p->>'previousBookFingerprint' is distinct from public.zentra_us_financial_test_hash(prefix)
    or e->'actor'->>'userId' is distinct from p->>'actorId' or e->'operation'->'command' is distinct from p->'erpRequest'->'command'
    or e->'operation'->'facts'->'taxAssessment' is distinct from o.payload->'assessment' or e->'operation'->'facts'->'sellerSnapshot' is distinct from (jsonb_build_object('organizationId',org)||(p->'context'->'seller'))
    or not exists(select 1 from public.zentra_us_financial_invoice_test_preparations q where q.organization_id=org and q.idempotency_key=o.idempotency_key and q.payload=p)
    or not exists(select 1 from public.zentra_us_financial_invoice_test_contexts q where q.organization_id=org and q.revision=(p->'context'->>'revision')::bigint and q.payload=p->'context')
    or (completed and (o.payload->'receipt' is distinct from public.zentra_us_settlement_receipt(b,e) or not exists(select 1 from public.zentra_us_financial_test_receipts q where q.organization_id=org and q.idempotency_key=o.idempotency_key and q.receipt=o.payload->'receipt')))
   then raise exception using errcode='PF014',message='Corroborated original invoice operation required';end if;
  end if;
 end loop;
end $$;
create or replace function public.zentra_us_settlement_plans(b jsonb) returns void
language plpgsql volatile security invoker set search_path='' as $$ begin perform public.zentra_us_invoicing_plans(b,true);end $$;
create function public.zentra_us_invoicing_commit_operation(org text,e jsonb,r jsonb) returns void
language plpgsql volatile security invoker set search_path='' as $$
begin
 update public.zentra_us_financial_invoice_test_operations set payload=payload||jsonb_build_object('status','committed','receipt',r) where organization_id=org and idempotency_key=e->'operation'->>'idempotencyKey' and payload->>'status'='calculated';
 if not found then raise exception using errcode='PF014',message='Calculated original invoice operation required';end if;
end $$;
create or replace function public.zentra_us_settlement_event_guard() returns trigger
language plpgsql volatile security invoker set search_path='' as $$
declare b jsonb;e jsonb;c public.zentra_us_financial_test_cursors%rowtype;o jsonb;
begin
 if tg_op<>'INSERT' then raise exception using errcode='PF003',message='Financial events are immutable';end if;
 perform public.zentra_us_invoicing_admit(new.organization_id,new.payload->'actor',new.grant_version,'postgres-test-invoicing-v5');
 select * into c from public.zentra_us_financial_test_cursors where organization_id=new.organization_id for update;
 if not found or new.revision<>c.revision+1 then raise exception using errcode='PF001',message='Exact financial event CAS required';end if;
 b:=public.zentra_us_settlement_book(new.organization_id);
 if (b->>'revision')::bigint<>c.revision or public.zentra_us_financial_test_hash(b)<>c.book_sha256 then raise exception using errcode='PF004',message='Financial cursor history mismatch';end if;
 perform public.zentra_us_commercial_source(new.organization_id,new.payload->'operation');perform public.zentra_us_invoicing_key(new.organization_id,new.payload->'operation',new.payload->'actor');
 if new.payload->'operation'->'command'->>'type'='issue_invoice' then
  select payload into o from public.zentra_us_financial_invoice_test_operations where organization_id=new.organization_id and idempotency_key=new.payload->'operation'->>'idempotencyKey' for update;
  if o is null or o->>'status'<>'calculated' or (o->>'retryUntil')::timestamptz<=clock_timestamp() or (o->'assessment'->>'validUntil')::timestamptz<=clock_timestamp() then raise exception using errcode='PF014',message='Original fresh invoice calculation required';end if;
  perform public.zentra_us_invoicing_preparation_current(new.organization_id,o->'preparation',new.payload->'actor');
 end if;
 e:=public.zentra_us_invoicing_transition(b,new.payload->'operation',new.payload->'actor',new.payload->>'id');
 if e is distinct from new.payload or new.revision is distinct from (e->>'revision')::bigint then raise exception using errcode='PF004',message='Uncorroborated invoicing event';end if;
 b:=b||jsonb_build_object('revision',e->'revision','events',(b->'events')||jsonb_build_array(e));perform public.zentra_us_financial_test_budget(b);perform public.zentra_us_invoicing_plans(b,false);
 if exists(select 1 from public.zentra_us_financial_test_receipts where organization_id=new.organization_id and idempotency_key=e->'operation'->>'idempotencyKey') then raise exception using errcode='PF002',message='Historical key already reserved';end if;return new;
end $$;
create function public.zentra_us_invoicing_operation_complete() returns trigger
language plpgsql volatile security invoker set search_path='' as $$
declare b jsonb;c public.zentra_us_financial_test_cursors%rowtype;
begin
 if new.payload->>'status'<>'committed' then return null;end if;
 b:=public.zentra_us_settlement_book(new.organization_id);perform public.zentra_us_settlement_plans(b);select * into c from public.zentra_us_financial_test_cursors where organization_id=new.organization_id;
 if c.revision is distinct from (b->>'revision')::bigint or c.book_sha256 is distinct from public.zentra_us_financial_test_hash(b) then raise exception using errcode='PF004',message='Atomic invoice completion required';end if;return null;
end $$;
create constraint trigger zentra_invoice_test_operation_complete after insert or update on public.zentra_us_financial_invoice_test_operations deferrable initially deferred for each row execute function public.zentra_us_invoicing_operation_complete();
create function public.zentra_read_us_financial_invoice_test_operation_v5(p_organization text,p_actor jsonb,p_grant_version bigint,p_capability text,p_idempotency_key text,p_financial_command_hash text,p_erp_command_hash text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare v jsonb;
begin
 perform public.zentra_us_invoicing_admit(p_organization,p_actor,p_grant_version,p_capability);
 if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' or p_financial_command_hash is null or p_financial_command_hash !~ '^[a-f0-9]{64}$' or p_erp_command_hash is null or p_erp_command_hash !~ '^[a-f0-9]{64}$' then raise exception using errcode='PF004',message='Exact fiscal operation identity required';end if;
 select payload into v from public.zentra_us_financial_invoice_test_operations where organization_id=p_organization and idempotency_key=p_idempotency_key;
 if not found then return null;end if;
 if v->'preparation'->>'actorId' is distinct from p_actor->>'userId' or v->'preparation'->>'financialCommandHash' is distinct from p_financial_command_hash or v->'preparation'->>'erpCommandHash' is distinct from p_erp_command_hash then raise exception using errcode='PF002',message='Fiscal operation identity differs';end if;
 if not public.zentra_us_invoicing_operation_valid(v,p_organization) then raise exception using errcode='PF004',message='Corroborated fiscal operation required';end if;
 if v->>'status'='committed' then perform public.zentra_read_us_financial_invoicing_test_v5(p_organization,p_actor,p_grant_version,p_capability);end if;return v;
end $$;
create function public.zentra_preflight_us_financial_invoice_test_v5(p_organization text,p_actor jsonb,p_grant_version bigint,p_capability text,p_request jsonb,p_financial_command_hash text,p_erp_command_hash text,p_previous_fingerprint text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare b jsonb;c jsonb;e jsonb;inner_request jsonb;prior jsonb;
begin
 b:=public.zentra_read_us_financial_invoicing_test_v5(p_organization,p_actor,p_grant_version,p_capability);
 perform public.zentra_us_financial_test_budget(p_request);
 if not public.zentra_us_tax_object(p_request,array['idempotencyKey','expectedRevision','command']) or not public.zentra_us_tax_object(p_request->'command',array['type','request']) or p_request->'command'->>'type' is distinct from 'erp_command' or p_request->>'idempotencyKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' then raise exception using errcode='PF004',message='Exact invoice financial request required';end if;
 inner_request:=jsonb_build_object('idempotencyKey',p_request->>'idempotencyKey','expectedRevision',p_request->'expectedRevision','command',p_request->'command'->'request');
 if p_financial_command_hash is distinct from public.zentra_us_financial_test_hash(jsonb_build_array(p_organization,p_actor->>'userId',p_request)) or p_erp_command_hash is distinct from public.zentra_us_financial_test_hash(jsonb_build_array(p_organization,p_actor->>'userId',inner_request)) then raise exception using errcode='PF002',message='Distinct exact financial and ERP request hashes required';end if;
 if b is null or b->'revision' is distinct from p_request->'expectedRevision' or public.zentra_us_financial_test_hash(b) is distinct from p_previous_fingerprint then raise exception using errcode='PF001',message='Financial invoice source changed';end if;
 if exists(select 1 from public.zentra_us_financial_test_receipts where organization_id=p_organization and idempotency_key=p_request->>'idempotencyKey') or exists(select 1 from public.zentra_us_tax_operations where organization_id=p_organization and erp_idempotency_key=p_request->>'idempotencyKey') or exists(select 1 from public.zentra_us_tax_invoice_preparations where organization_id=p_organization and erp_idempotency_key=p_request->>'idempotencyKey') then raise exception using errcode='PF002',message='Fiscal request key remains reserved';end if;
 select payload into prior from public.zentra_us_financial_invoice_test_preparations where organization_id=p_organization and idempotency_key=p_request->>'idempotencyKey' for update;
 if prior is not null and (prior->'request' is distinct from p_request or prior->>'actorId' is distinct from p_actor->>'userId' or prior->>'financialCommandHash' is distinct from p_financial_command_hash or prior->>'erpCommandHash' is distinct from p_erp_command_hash) then raise exception using errcode='PF002',message='Prepared fiscal identity differs';end if;
 if exists(select 1 from public.zentra_us_financial_invoice_test_operations where organization_id=p_organization and idempotency_key<>p_request->>'idempotencyKey' and payload->'preparation'->'erpRequest'->'command'->>'id'=p_request->'command'->'request'->>'id') then raise exception using errcode='PF002',message='Prepared invoice identity remains reserved';end if;
 if exists(select 1 from public.zentra_us_tax_operations where organization_id=p_organization and invoice_id=p_request->'command'->'request'->>'id') or exists(select 1 from public.zentra_us_tax_invoice_preparations where organization_id=p_organization and preparation->'request'->'command'->>'id'=p_request->'command'->'request'->>'id') then raise exception using errcode='PF002',message='Legacy invoice identity remains reserved';end if;
 e:=public.zentra_us_invoicing_command(b,p_request->'command'->'request',p_request->'command'->'request'->>'id');perform public.zentra_us_invoicing_source(p_organization,e,p_actor->>'timestamp');c:=public.zentra_us_invoicing_context(p_organization);
 if c->'configuration' is distinct from b->'baseline'->'configuration' then raise exception using errcode='PF007',message='Exact financial configuration required';end if;
 return jsonb_build_object('context',c,'estimate',e,'bookRevision',b->'revision','bookFingerprint',public.zentra_us_financial_test_hash(b));
end $$;
create function public.zentra_reserve_us_financial_invoice_test_v5(p_organization text,p_actor jsonb,p_grant_version bigint,p_capability text,p_preparation jsonb,p_resolved_body text,p_resolved_sha256 text,p_params_body text,p_params_sha256 text,p_provider_idempotency_key text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare v jsonb;prior jsonb;op uuid;reserved_at text;
begin
 perform public.zentra_us_invoicing_admit(p_organization,p_actor,p_grant_version,p_capability);
 perform public.zentra_us_financial_test_budget(p_preparation);
 if not public.zentra_us_invoicing_preparation_valid(p_preparation,p_organization,p_actor->>'userId') then raise exception using errcode='PF004',message='Exact fiscal review required';end if;
 select payload into prior from public.zentra_us_financial_invoice_test_operations where organization_id=p_organization and idempotency_key=p_preparation->'request'->>'idempotencyKey' for update;
 if prior is not null then
  if prior->'preparation' is distinct from p_preparation or prior->>'resolvedBody' is distinct from p_resolved_body or prior->>'resolvedSha256' is distinct from p_resolved_sha256 or prior->>'paramsBody' is distinct from p_params_body or prior->>'paramsSha256' is distinct from p_params_sha256 or prior->>'providerKey' is distinct from p_provider_idempotency_key then raise exception using errcode='PF002',message='Original fiscal reservation differs';end if;return prior;
 end if;
 op:=(p_resolved_body::jsonb->>'operationId')::uuid;reserved_at:=to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 v:=jsonb_build_object('schemaVersion',1,'status','reserved','organizationId',p_organization,'operationId',op::text,'preparation',p_preparation,'resolvedBody',p_resolved_body,'resolvedSha256',p_resolved_sha256,'paramsBody',p_params_body,'paramsSha256',p_params_sha256,'providerKey',p_provider_idempotency_key,'reservedAt',reserved_at,'retryUntil',to_char((reserved_at::timestamptz+interval '23 hours') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'proofBody',null,'proofSha256',null,'assessment',null,'receipt',null);
 insert into public.zentra_us_financial_invoice_test_preparations values(p_organization,p_preparation->'request'->>'idempotencyKey',p_preparation,p_actor,p_grant_version);
 insert into public.zentra_us_financial_invoice_test_operations values(p_organization,op,p_preparation->'request'->>'idempotencyKey',v,p_actor,p_grant_version);return v;
end $$;
create function public.zentra_record_us_financial_invoice_test_calculation_v5(p_organization text,p_actor jsonb,p_grant_version bigint,p_capability text,p_operation_id uuid,p_proof_body text,p_proof_sha256 text,p_assessment jsonb) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare v jsonb;candidate jsonb;
begin
 perform public.zentra_us_invoicing_admit(p_organization,p_actor,p_grant_version,p_capability);
 select payload into v from public.zentra_us_financial_invoice_test_operations where organization_id=p_organization and operation_id=p_operation_id for update;
 if v is null or v->'preparation'->>'actorId' is distinct from p_actor->>'userId' then raise exception using errcode='PF014',message='Original actor reservation required';end if;
 if v->>'status' in('calculated','committed') then
  if v->>'proofBody' is distinct from p_proof_body or v->>'proofSha256' is distinct from p_proof_sha256 or v->'assessment' is distinct from p_assessment then raise exception using errcode='PF002',message='Original fiscal proof differs';end if;return v;
 end if;
 candidate:=v||jsonb_build_object('status','calculated','proofBody',p_proof_body,'proofSha256',p_proof_sha256,'assessment',p_assessment);
 update public.zentra_us_financial_invoice_test_operations set payload=candidate where organization_id=p_organization and operation_id=p_operation_id;return candidate;
end $$;
create function public.zentra_us_invoicing_preparation_complete() returns trigger
language plpgsql volatile security invoker set search_path='' as $$ begin if not exists(select 1 from public.zentra_us_financial_invoice_test_operations o where o.organization_id=new.organization_id and o.idempotency_key=new.idempotency_key and o.payload->'preparation'=new.payload) then raise exception using errcode='PF014',message='Atomic invoice reservation required';end if;return null;end $$;
create constraint trigger zentra_invoice_test_preparation_complete after insert on public.zentra_us_financial_invoice_test_preparations deferrable initially deferred for each row execute function public.zentra_us_invoicing_preparation_complete();
-- No older financial capability is allowed to replay a newly issued invoice.
do $$ declare f record;body text;admission text;counted integer:=0;begin
 for f in select p.* from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('zentra_read_us_financial_accounting_test_v5','zentra_read_us_financial_purchasing_test_v5','zentra_read_us_financial_commercial_test_v5') loop
  counted:=counted+1;admission:=case f.proname when 'zentra_read_us_financial_accounting_test_v5' then 'perform public.zentra_us_accounting_admit(p_organization,p_actor,p_grant_version,p_capability);' when 'zentra_read_us_financial_purchasing_test_v5' then 'perform public.zentra_us_purchasing_admit(p_organization,p_actor,p_grant_version,p_capability);' else 'perform public.zentra_us_commercial_admit(p_organization,p_actor,p_grant_version,p_capability);' end;
  body:=replace(f.prosrc,admission,admission||' if exists(select 1 from public.zentra_us_financial_test_events where organization_id=p_organization and payload->''operation''->''command''->>''type''=''issue_invoice'') then raise exception using errcode=''PF008'',message=''Invoicing capability required'';end if;');
  if body=f.prosrc then raise exception 'Exact old invoicing admission prerequisite required';end if;
  execute format('create or replace function public.%I(%s) returns jsonb language plpgsql volatile security invoker set search_path='''' as %L',f.proname,pg_get_function_arguments(f.oid),body);
 end loop;if counted<>3 then raise exception 'Three exact prior readers required';end if;
end $$;
do $$ declare t text;f record;begin
 foreach t in array array['zentra_us_financial_invoice_test_contexts','zentra_us_financial_invoice_test_preparations','zentra_us_financial_invoice_test_operations'] loop
  execute format('alter table public.%I enable row level security',t);execute format('revoke all on table public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select,update on table public.%I to service_role',t);
 end loop;
 grant insert on public.zentra_us_financial_invoice_test_preparations,public.zentra_us_financial_invoice_test_operations to service_role;
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'zentra_us_invoicing_%' or p.proname in('zentra_read_us_financial_invoicing_test_v5','zentra_us_financial_invoicing_test_receipt_v5','zentra_append_us_financial_invoicing_test_v5','zentra_read_us_financial_invoice_test_operation_v5','zentra_preflight_us_financial_invoice_test_v5','zentra_reserve_us_financial_invoice_test_v5','zentra_record_us_financial_invoice_test_calculation_v5')) loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
-- Independently validate old history under the new reconstruction before commit.
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
