-- Private LOCAL TEST only. Same immutable baseline + canonical ordered tail.
-- No provider, banking execution, public ERP5, legacy thaw or CH mutation.
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
create function public.zentra_us_purchasing_text(v jsonb,maximum integer default 160) returns boolean
language sql immutable security invoker set search_path='' as $$
 select coalesce(jsonb_typeof(v)='string' and public.zentra_us_commercial_trim(v#>>'{}')<>'' and public.zentra_us_commercial_units(v#>>'{}')<=maximum and (v#>>'{}')!~ '[[:cntrl:]]',false);
$$;
-- This private projector is called only on a previously rebuilt prefix. It
-- retains EVERY actual journal/audit, including all purchasing effects.
create function public.zentra_us_purchasing_current(b jsonb) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare r jsonb:=jsonb_build_object('customers',b->'baseline'->'customers','estimates',b->'baseline'->'estimates','vendors',b->'baseline'->'vendors','vendorBills',b->'baseline'->'vendorBills','vendorPayments',b->'baseline'->'vendorPayments','counters',b->'baseline'->'counters','ledger',b->'baseline'->'ledger');e jsonb;c jsonb;rows jsonb;k text;entries jsonb:=b->'baseline'->'ledger'->'entries';audit jsonb:=b->'baseline'->'ledger'->'audit';p jsonb;
begin
 for e in select value from jsonb_array_elements(b->'events') loop
  if e->'operation'->>'type'='erp_command' then
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
 return jsonb_set(r,'{ledger}',r->'ledger'||jsonb_build_object('revision',jsonb_array_length(audit),'entries',entries,'audit',audit));
end $$;
create function public.zentra_us_purchasing_header(b jsonb,counters jsonb) returns jsonb
language sql immutable security invoker set search_path='' as $$
 select jsonb_build_object('schemaVersion',4,'revision',(b->>'revision')::bigint+1,'configuration',b->'baseline'->'configuration','counters',counters,'ledger',((public.zentra_us_purchasing_current(b)->'ledger')-'entries'-'audit')||jsonb_build_object('revision',(public.zentra_us_purchasing_current(b)->'ledger'->>'revision')::bigint-(select count(*) from jsonb_array_elements(b->'events') e where e->'operation'->>'type'='customer_credit')));
$$;
-- Exact postJournal admission and content construction on the true ledger.
create function public.zentra_us_purchasing_post(ledger jsonb,input jsonb,a jsonb) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare line jsonb;account jsonb;period jsonb;dr numeric;cr numeric;debits numeric:=0;credits numeric:=0;cash_movement numeric:=0;revision bigint;fingerprint text;posting jsonb;
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
 fingerprint:=public.zentra_us_erp_v4_canonical(jsonb_build_array(input->>'organizationId','USD','accrual',input->>'transactionDate',input->>'accountingDate',input->>'paymentDate',input->>'periodId',input->>'description',input->'source'->>'type',input->'source'->>'id',input->>'cashFlowCategory',null,(select jsonb_agg(jsonb_build_array(l->>'accountId',l->>'debitMinor',l->>'creditMinor',l->>'description') order by n) from jsonb_array_elements(input->'lines') with ordinality t(l,n))));
 revision:=(ledger->>'revision')::bigint+1;posting:=input||jsonb_build_object('postedBy',a->>'userId','postedAt',a->>'timestamp','revision',revision,'fingerprint',fingerprint);
 return jsonb_build_object('posting',posting,'audit',jsonb_build_object('revision',revision,'action','posted','actorId',a->>'userId','timestamp',a->>'timestamp','entityId',input->>'id'));
end $$;
create function public.zentra_us_purchasing_erp(b jsonb,op jsonb,a jsonb,id text) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare org text:=b->'baseline'->'configuration'->>'organizationId';c jsonb:=op->'command';action text:=c->>'type';r jsonb:=public.zentra_us_purchasing_current(b);ledger jsonb:=r->'ledger';header jsonb:=public.zentra_us_purchasing_header(b,r->'counters');payload jsonb;previous jsonb;vendor jsonb;bill jsonb;account jsonb;posting_input jsonb;effect jsonb;posting jsonb;compat_posting jsonb;changes jsonb;effects jsonb;receipt jsonb;commit jsonb;revision bigint:=(b->>'revision')::bigint+1;compact_revision bigint:=(header->'ledger'->>'revision')::bigint;net numeric;tax numeric;total numeric;amount numeric;paid numeric:=0;cash_paid numeric:=0;keys text[];k text;
begin
 keys:=case action when 'save_vendor' then array['type','vendor'] when 'record_vendor_bill' then array['type','id','vendorId','reference','date','accountingDate','dueDate','periodId','netMinor','purchaseTaxMinor','expenseAccountId','sourceReference'] when 'record_vendor_payment' then array['type','id','billId','amountMinor','paymentDate','accountingDate','periodId','reference'] else null end;
 if keys is null then raise exception using errcode='PF010',message='Purchasing command unavailable';end if;
 if not public.zentra_us_tax_object(c,keys) then raise exception using errcode='PF004',message='Exact purchasing command required';end if;
 if action='save_vendor' then
  if not public.zentra_us_purchase_vendor(c->'vendor',org) or c->'vendor'->>'id' is distinct from id then raise exception using errcode='PF004',message='Scoped vendor required';end if;
  payload:=c->'vendor';select x into previous from jsonb_array_elements(r->'vendors') x where x->>'id'=id;
  -- Purchasing delta requires the selected vendor snapshot even on a no-op.
  changes:=jsonb_build_array(jsonb_build_object('kind','vendor','id',id,'payload',payload));effects:=jsonb_build_object('postings','[]'::jsonb,'audit','[]'::jsonb);
 else
  if not public.zentra_us_tax_strings(c,keys) or c->>'id' is distinct from id or not public.zentra_us_purchasing_text(a->'userId') then raise exception using errcode='PF004',message='Exact purchasing scalar fields required';end if;
  foreach k in array case action when 'record_vendor_bill' then array['id','vendorId','reference','periodId','sourceReference'] else array['id','billId','periodId','reference'] end loop
   if not public.zentra_us_purchasing_text(c->k,case k when 'reference' then 500 when 'sourceReference' then 500 else 160 end) then raise exception using errcode='PF004',message='Invalid purchasing text';end if;
  end loop;
  if not public.zentra_us_purchase_date(c->>'accountingDate') then raise exception using errcode='PF004',message='Invalid purchasing accounting date';end if;
  if action='record_vendor_bill' then
   if not public.zentra_us_purchase_date(c->>'date') or not public.zentra_us_purchase_date(c->>'dueDate') or c->>'dueDate'<c->>'date' or c->>'expenseAccountId' is distinct from 'purchases' then raise exception using errcode='PF004',message='Invalid purchasing bill date or account';end if;
   net:=public.zentra_us_settlement_minor(c->'netMinor');tax:=public.zentra_us_settlement_minor(c->'purchaseTaxMinor');total:=public.zentra_us_settlement_minor(to_jsonb((net+tax)::text),true);
   if exists(select 1 from jsonb_array_elements(r->'vendorBills') x where x->>'id'=id or (x->>'vendorId'=c->>'vendorId' and x->>'reference'=c->>'reference' and x->>'date'=c->>'date')) then raise exception using errcode='PF002',message='Vendor bill already recorded';end if;
   select x into vendor from jsonb_array_elements(r->'vendors') x where x->>'id'=c->>'vendorId';if vendor is null then raise exception using errcode='PF004',message='Current vendor required';end if;
   payload:=jsonb_build_object('id',id,'organizationId',org,'vendorId',c->>'vendorId','reference',c->>'reference','date',c->>'date','accountingDate',c->>'accountingDate','dueDate',c->>'dueDate','currency','USD','net',jsonb_build_object('currency','USD','minorUnits',net::text),'tax',jsonb_build_object('currency','USD','minorUnits',tax::text),'total',jsonb_build_object('currency','USD','minorUnits',total::text),'expenseAccountId','purchases','validatedBy',a->>'userId','vendorSnapshot',vendor,'periodId',c->>'periodId','approvedAt',a->>'timestamp','approvalSource','manual_entry','sourceReference',c->>'sourceReference','recordedRevision',revision);
   bill:=payload;posting_input:=jsonb_build_object('id','entry:vendor-bill:'||id,'idempotencyKey','vendor-bill:'||id,'organizationId',org,'currency','USD','basis','accrual','transactionDate',c->>'date','accountingDate',c->>'accountingDate','periodId',c->>'periodId','description','Vendor bill '||(c->>'reference'),'source',jsonb_build_object('type','vendor_bill','id',id),'lines',jsonb_build_array(jsonb_build_object('accountId','purchases','debitMinor',total::text,'creditMinor','0'),jsonb_build_object('accountId','payables','debitMinor','0','creditMinor',total::text)));
  else
   if not public.zentra_us_purchase_date(c->>'paymentDate') then raise exception using errcode='PF004',message='Invalid vendor payment date';end if;amount:=public.zentra_us_settlement_minor(c->'amountMinor',true);
   if exists(select 1 from jsonb_array_elements(r->'vendorPayments') x where x->>'id'=id or x->>'idempotencyKey'=op->>'idempotencyKey') then raise exception using errcode='PF002',message='Vendor payment identity reserved';end if;
   select x into bill from jsonb_array_elements(r->'vendorBills') x where x->>'id'=c->>'billId';if bill is null then raise exception using errcode='PF004',message='Recorded vendor bill required';end if;
   select coalesce(sum(public.zentra_us_settlement_minor(x->'amount'->'minorUnits')),0) into paid from jsonb_array_elements(r->'vendorPayments') x where x->>'billId'=bill->>'id';total:=public.zentra_us_settlement_minor(bill->'total'->'minorUnits',true);
   perform public.zentra_us_settlement_minor(to_jsonb((paid+amount)::text));if paid+amount>total then raise exception using errcode='PF013',message='Vendor payment exceeds remaining debt';end if;
   if not exists(select 1 from jsonb_array_elements(ledger->'entries') x where x->'source'=jsonb_build_object('type','vendor_bill','id',bill->>'id') and not exists(select 1 from jsonb_array_elements(ledger->'entries') y where y->>'reversesEntryId'=x->>'id')) then raise exception using errcode='PF004',message='Active vendor bill posting required';end if;
   select coalesce(sum(public.zentra_us_settlement_minor(l->'creditMinor')-public.zentra_us_settlement_minor(l->'debitMinor')),0) into cash_paid from jsonb_array_elements(ledger->'entries') x cross join lateral jsonb_array_elements(x->'lines') l where l->>'accountId'='cash' and (x->'source'=jsonb_build_object('type','vendor_payment','id',bill->>'id') or exists(select 1 from jsonb_array_elements(ledger->'entries') y where y->'source'=jsonb_build_object('type','vendor_payment','id',bill->>'id') and x->>'reversesEntryId'=y->>'id'));
   if cash_paid<>paid then raise exception using errcode='PF004',message='Vendor payment register and cash disagree';end if;
   payload:=jsonb_build_object('id',id,'organizationId',org,'billId',bill->>'id','idempotencyKey',op->>'idempotencyKey','amount',jsonb_build_object('currency','USD','minorUnits',amount::text),'paymentDate',c->>'paymentDate','accountingDate',c->>'accountingDate','periodId',c->>'periodId','reference',c->>'reference','recordedBy',a->>'userId','recordedAt',a->>'timestamp','recordedRevision',revision);
   posting_input:=jsonb_build_object('id','entry:vendor-payment:'||(op->>'idempotencyKey'),'idempotencyKey','vendor-payment:'||(op->>'idempotencyKey'),'organizationId',org,'currency','USD','basis','accrual','transactionDate',c->>'paymentDate','accountingDate',c->>'accountingDate','paymentDate',c->>'paymentDate','periodId',c->>'periodId','cashFlowCategory','operating','description','Payment '||(bill->>'reference'),'source',jsonb_build_object('type','vendor_payment','id',bill->>'id'),'lines',jsonb_build_array(jsonb_build_object('accountId','payables','debitMinor',amount::text,'creditMinor','0'),jsonb_build_object('accountId','cash','debitMinor','0','creditMinor',amount::text,'description',id)));
  end if;
  select x into account from jsonb_array_elements(ledger->'accounts') x where x->>'id'=bill->>'expenseAccountId';if account is null or account->>'type' not in('expense','asset') or account->'cash'='true'::jsonb then raise exception using errcode='PF004',message='Purchase cost account required';end if;
  effect:=public.zentra_us_purchasing_post(ledger,posting_input,a);posting:=effect->'posting';compat_posting:=posting||jsonb_build_object('revision',compact_revision+1);
  changes:=jsonb_build_array(jsonb_build_object('kind',case action when 'record_vendor_bill' then 'vendor_bill' else 'vendor_payment' end,'id',id,'payload',payload),jsonb_build_object('kind','journal','id',posting->>'id','payload',compat_posting));
  header:=jsonb_set(header,'{ledger,revision}',to_jsonb(compact_revision+1));effects:=jsonb_build_object('postings',jsonb_build_array(posting),'audit',jsonb_build_array(effect->'audit'));
 end if;
 receipt:=jsonb_build_object('idempotencyKey',op->>'idempotencyKey','commandHash',public.zentra_us_financial_test_hash(jsonb_build_array(org,a->>'userId',jsonb_build_object('idempotencyKey',op->>'idempotencyKey','expectedRevision',(b->>'revision')::bigint,'command',c))),'revision',revision,'entityId',id,'action',action);
 commit:=jsonb_build_object('organizationId',org,'expectedRevision',(b->>'revision')::bigint,'header',header,'changes',changes,'ledgerAudit',case when action='save_vendor' then '[]'::jsonb else jsonb_build_array((effect->'audit')||jsonb_build_object('revision',compact_revision+1)) end,'receipt',receipt,'actor',a);
 return jsonb_build_object('revision',revision,'id',id,'operation',op,'actor',a,'commit',commit,'effects',effects);
end $$;
create function public.zentra_us_purchasing_transition(b jsonb,op jsonb,a jsonb,id text) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare org text:=b->'baseline'->'configuration'->>'organizationId';current_rows jsonb;c jsonb;previous jsonb;payload jsonb;customer jsonb;project jsonb;line jsonb;totals jsonb;changes jsonb;commit jsonb;receipt jsonb;financial_prefix jsonb;counter bigint;revision bigint;subtotal numeric:=0;discount numeric:=0;seen text[]:=array[]::text[];command_keys text[];action text;key text;rebuilt_financial jsonb;real_ledger jsonb;
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
 if op->>'type' in('customer_credit','customer_payment') then
  -- Only financial tail items feed the existing pure financial transition.
  -- Global revision, chronology, identity and budget are checked on the REAL
  -- prefix above; this transient argument is never returned as a valid book.
  if exists(select 1 from jsonb_array_elements(b->'events') x where x->>'id'=id) then raise exception using errcode='PF002',message='Financial entity identity reserved';end if;
  select b||jsonb_build_object('events',coalesce(jsonb_agg(x order by n),'[]'::jsonb)) into financial_prefix from jsonb_array_elements(b->'events') with ordinality t(x,n) where x->'operation'->>'type' in('customer_credit','customer_payment') or (x->'operation'->>'type'='erp_command' and x->'operation'->'command'->>'type' in('record_vendor_bill','record_vendor_payment'));
  rebuilt_financial:=public.zentra_us_settlement_transition(financial_prefix,op,a,id);real_ledger:=public.zentra_us_purchasing_current(b)->'ledger';
  if rebuilt_financial->'posting'->'revision' is distinct from to_jsonb((real_ledger->>'revision')::bigint+1) then raise exception using errcode='PF004',message='Exact true financial revision required';end if;
  if exists(select 1 from jsonb_array_elements(real_ledger->'entries') x where x->>'id'=rebuilt_financial->'posting'->>'id' or x->>'idempotencyKey'=rebuilt_financial->'posting'->>'idempotencyKey') then raise exception using errcode='PF002',message='True ledger identity reserved';end if;
  return rebuilt_financial;
 end if;
 if op->>'type' is distinct from 'erp_command' then raise exception using errcode='PF010',message='Private commercial operation unavailable';end if;
 if not public.zentra_us_tax_object(op,array['type','idempotencyKey','command','facts']) or op->'facts' is distinct from '{"kind":"none"}'::jsonb then raise exception using errcode='PF004',message='Commercial facts must be empty';end if;
 c:=op->'command';action:=c->>'type'; if action in('save_vendor','record_vendor_bill','record_vendor_payment') then return public.zentra_us_purchasing_erp(b,op,a,id);end if;
 if action is null or action not in('save_customer','save_estimate','accept_estimate') then raise exception using errcode='PF010',message='Private commercial command unavailable';end if;
 command_keys:=case action when 'save_customer' then array['type','customer'] when 'save_estimate' then array['type','id','expectedEstimateRevision','customerId','date','expiresAt','paymentTermsDays','lines','notes'] else array['type','estimateId','expectedEstimateRevision'] end;
 if not public.zentra_us_tax_object(c,command_keys,case when action='save_estimate' then array['projectId'] else array[]::text[] end) then raise exception using errcode='PF004',message='Invalid commercial command fields';end if;
 current_rows:=public.zentra_us_purchasing_current(b);revision:=(b->>'revision')::bigint+1;
 if action='save_customer' then
  if not public.zentra_us_purchase_vendor(c->'customer',org) or c->'customer'->>'id' is distinct from id then raise exception using errcode='PF004',message='Valid scoped customer required';end if;
  payload:=c->'customer';select x into previous from jsonb_array_elements(current_rows->'customers') x where x->>'id'=id;
 else
  if not public.zentra_us_tax_revision(c->'expectedEstimateRevision',0) or action='accept_estimate' and not public.zentra_us_tax_strings(c,array['type','estimateId']) then raise exception using errcode='PF004',message='Valid estimate revision required';end if;
  if action='save_estimate' and c->>'id' is distinct from id or action='accept_estimate' and c->>'estimateId' is distinct from id then raise exception using errcode='PF004',message='Exact commercial entity required';end if;
  select x into previous from jsonb_array_elements(current_rows->'estimates') x where x->>'id'=id;
  if coalesce((previous->>'revision')::bigint,0)<>(c->>'expectedEstimateRevision')::bigint then raise exception using errcode='PF001',message='Estimate revision changed';end if;
  if exists(select 1 from jsonb_array_elements(b->'baseline'->'invoices') x where x->>'sourceEstimateId'=id) then raise exception using errcode='PF003',message='Issued estimate cannot be changed';end if;
  if coalesce((previous->>'revision')::bigint,0)>=9007199254740990 then raise exception using errcode='PF012',message='Estimate revision exhausted';end if;
  if action='accept_estimate' then
   if previous is null then raise exception using errcode='PF004',message='Existing estimate required';end if;
   payload:=previous||jsonb_build_object('revision',(previous->>'revision')::bigint+1,'status','accepted');
  else
   if not public.zentra_us_tax_strings(c,array['type','id','customerId','date','expiresAt','notes']) or not public.zentra_us_tax_text_valid(c->>'customerId',160,false)
   or not public.zentra_us_purchase_date(c->>'date') or not public.zentra_us_purchase_date(c->>'expiresAt') or c->>'expiresAt'<c->>'date'
   or not public.zentra_us_tax_safe_integer(c->'paymentTermsDays') or (c->>'paymentTermsDays')::bigint>365 or public.zentra_us_commercial_units(c->>'notes')>20000
   or jsonb_typeof(c->'lines') is distinct from 'array' or jsonb_array_length(c->'lines') not between 1 and 1000 then raise exception using errcode='PF004',message='Invalid estimate content';end if;
   select x into customer from jsonb_array_elements(current_rows->'customers') x where x->>'id'=c->>'customerId';if customer is null then raise exception using errcode='PF004',message='Current customer required';end if;
   if c ? 'projectId' then
    if jsonb_typeof(c->'projectId') is distinct from 'string' or not public.zentra_us_tax_text_valid(c->>'projectId',160,false) then raise exception using errcode='PF004',message='Invalid project association';end if;
    select x into project from jsonb_array_elements(b->'baseline'->'projects') x where x->>'id'=c->>'projectId';
    if project is null or project->>'status'<>'active' or project->>'customerId'<>c->>'customerId' then raise exception using errcode='PF004',message='Active project for this customer required';end if;
   end if;
   for line in select value from jsonb_array_elements(c->'lines') loop
    if not public.zentra_us_tax_object(line,array['id','description','quantityUnits','quantityScale','unitPrice','discountBasisPoints','taxTreatment']) or not public.zentra_us_tax_strings(line,array['id','description','quantityUnits','taxTreatment'])
    or not public.zentra_us_tax_object(line->'unitPrice',array['currency','minorUnits']) or not public.zentra_us_tax_strings(line->'unitPrice',array['currency','minorUnits'])
    or public.zentra_us_commercial_units(line->>'id')>160 or public.zentra_us_commercial_units(line->>'description')>4000
    or public.zentra_us_commercial_trim(line->>'id')='' or public.zentra_us_commercial_trim(line->>'description')='' or line->>'id'=any(seen) then raise exception using errcode='PF004',message='Exact unique sales lines required';end if;
    seen:=array_append(seen,line->>'id');totals:=public.zentra_us_erp_line_totals(line);subtotal:=subtotal+public.zentra_us_settlement_minor(totals->'grossMinor');discount:=discount+public.zentra_us_settlement_minor(totals->'discountMinor');
   end loop;
   perform public.zentra_us_settlement_minor(to_jsonb(subtotal::text));perform public.zentra_us_settlement_minor(to_jsonb(discount::text));
   counter:=(current_rows->'counters'->>'estimate')::bigint;
   if previous is null then if counter>=9007199254740990 then raise exception using errcode='PF012',message='Estimate number exhausted';end if;counter:=counter+1;end if;
   current_rows:=jsonb_set(current_rows,'{counters,estimate}',to_jsonb(counter));
   payload:=jsonb_build_object('id',id,'organizationId',org,'revision',coalesce((previous->>'revision')::bigint,0)+1,'currency','USD','number',coalesce(previous->>'number','EST-'||lpad(counter::text,greatest(6,length(counter::text)),'0')),'customer',customer,'date',c->>'date','expiresAt',c->>'expiresAt','paymentTermsDays',c->'paymentTermsDays','lines',c->'lines','notes',c->'notes','status','draft');
   if c ? 'projectId' then payload:=payload||jsonb_build_object('projectId',c->'projectId');end if;
  end if;
 end if;
 changes:=case when previous=payload then '[]'::jsonb else jsonb_build_array(jsonb_build_object('kind',case when action='save_customer' then 'customer' else 'estimate' end,'id',id,'payload',payload)) end;
 receipt:=jsonb_build_object('idempotencyKey',key,'commandHash',public.zentra_us_financial_test_hash(jsonb_build_array(org,a->>'userId',jsonb_build_object('idempotencyKey',key,'expectedRevision',(b->>'revision')::bigint,'command',c))),'revision',revision,'entityId',id,'action',action);
 commit:=jsonb_build_object('organizationId',org,'expectedRevision',(b->>'revision')::bigint,'header',public.zentra_us_purchasing_header(b,current_rows->'counters'),'changes',changes,'ledgerAudit','[]'::jsonb,'receipt',receipt,'actor',a);
 return jsonb_build_object('revision',revision,'id',id,'operation',op,'actor',a,'commit',commit,'effects',jsonb_build_object('postings','[]'::jsonb,'audit','[]'::jsonb));
exception when sqlstate 'PU004' then raise exception using errcode='PF004',message='Invalid exact commercial value';end $$;
create function public.zentra_us_purchasing_replay(b jsonb) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare current_book jsonb;e jsonb;rebuilt jsonb;
begin
 perform public.zentra_us_financial_test_budget(b);
 if not public.zentra_us_tax_object(b,array['schemaVersion','revision','baseline','policy','promotion','events']) or b->'schemaVersion' is distinct from '5'::jsonb or jsonb_typeof(b->'events') is distinct from 'array'
 or b->'revision' is distinct from to_jsonb((b->'baseline'->>'revision')::bigint+1+jsonb_array_length(b->'events')) then raise exception using errcode='PF004',message='Invalid private commercial book';end if;
 current_book:=b||jsonb_build_object('revision',(b->'baseline'->>'revision')::bigint+1,'events','[]'::jsonb);
 for e in select value from jsonb_array_elements(b->'events') loop
  if not public.zentra_us_tax_object(e,case when e->'operation'->>'type'='erp_command' then array['revision','id','operation','actor','commit','effects'] else array['revision','id','operation','actor','record','posting'] end) or jsonb_typeof(e->'id') is distinct from 'string' then raise exception using errcode='PF004',message='Invalid private commercial event';end if;
  rebuilt:=public.zentra_us_purchasing_transition(current_book,e->'operation',e->'actor',e->>'id');
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
 return public.zentra_us_purchasing_replay(b);
end $$;
create function public.zentra_us_purchasing_admit(org text,a jsonb,v bigint,cap text) returns void
language plpgsql volatile security invoker set search_path='' as $$
begin
 if cap is distinct from 'postgres-test-purchasing-v5' then raise exception using errcode='PF009',message='Private purchasing TEST capability required';end if;
 perform public.zentra_us_settlement_admit(org,a,v,'postgres-test-settlement-v5');
end $$;
create or replace function public.zentra_us_settlement_event_guard() returns trigger
language plpgsql volatile security invoker set search_path='' as $$
declare b jsonb;e jsonb;c public.zentra_us_financial_test_cursors%rowtype;
begin
 if tg_op<>'INSERT' then raise exception using errcode='PF003',message='Financial events are immutable';end if;
 perform public.zentra_us_purchasing_admit(new.organization_id,new.payload->'actor',new.grant_version,'postgres-test-purchasing-v5');
 select * into c from public.zentra_us_financial_test_cursors where organization_id=new.organization_id for update;
 if not found or new.revision<>c.revision+1 then raise exception using errcode='PF001',message='Exact financial event CAS required';end if;
 b:=public.zentra_us_settlement_book(new.organization_id);
 if (b->>'revision')::bigint<>c.revision or public.zentra_us_financial_test_hash(b)<>c.book_sha256 then raise exception using errcode='PF004',message='Financial cursor history mismatch';end if;
 perform public.zentra_us_commercial_source(new.organization_id,new.payload->'operation');
 e:=public.zentra_us_purchasing_transition(b,new.payload->'operation',new.payload->'actor',new.payload->>'id');
 if e is distinct from new.payload or new.revision is distinct from (e->>'revision')::bigint then raise exception using errcode='PF004',message='Uncorroborated commercial event';end if;
 b:=b||jsonb_build_object('revision',e->'revision','events',(b->'events')||jsonb_build_array(e));perform public.zentra_us_financial_test_budget(b);perform public.zentra_us_settlement_plans(b);
 if exists(select 1 from public.zentra_us_financial_test_receipts where organization_id=new.organization_id and idempotency_key=e->'operation'->>'idempotencyKey') then raise exception using errcode='PF002',message='Historical key already reserved';end if;return new;
end $$;
create function public.zentra_read_us_financial_purchasing_test_v5(p_organization text,p_actor jsonb,p_grant_version bigint,p_capability text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare b jsonb;c public.zentra_us_financial_test_cursors%rowtype;
begin
 perform public.zentra_us_purchasing_admit(p_organization,p_actor,p_grant_version,p_capability);b:=public.zentra_us_settlement_book(p_organization);if b is null then return null;end if;
 perform public.zentra_us_settlement_plans(b);select * into c from public.zentra_us_financial_test_cursors where organization_id=p_organization for update;
 if not found or c.revision<>(b->>'revision')::bigint or c.book_sha256<>public.zentra_us_financial_test_hash(b) then raise exception using errcode='PF004',message='Financial cursor mismatch';end if;return b;
end $$;
create function public.zentra_us_financial_purchasing_test_receipt_v5(p_organization text,p_actor jsonb,p_grant_version bigint,p_capability text,p_idempotency_key text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare r public.zentra_us_financial_test_receipts%rowtype;b jsonb;
begin
 b:=public.zentra_read_us_financial_purchasing_test_v5(p_organization,p_actor,p_grant_version,p_capability);
 if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 240 then raise exception using errcode='PF004',message='Invalid financial receipt key';end if;
 select * into r from public.zentra_us_financial_test_receipts where organization_id=p_organization and idempotency_key=p_idempotency_key;if not found then return null;end if;
 return jsonb_build_object('origin',r.origin,'actorId',r.actor_id,'receipt',r.receipt);
end $$;
create function public.zentra_append_us_financial_purchasing_test_v5(p_organization text,p_actor jsonb,p_grant_version bigint,p_capability text,p_expected_revision bigint,p_previous_fingerprint text,p_book jsonb,p_receipt jsonb) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare b jsonb;e jsonb;expected_receipt jsonb;prior public.zentra_us_financial_test_receipts%rowtype;prefix jsonb;
begin
 b:=public.zentra_read_us_financial_purchasing_test_v5(p_organization,p_actor,p_grant_version,p_capability);if b is null then raise exception using errcode='PF004',message='Promoted financial book required';end if;
 perform public.zentra_us_financial_test_budget(p_book);perform public.zentra_us_financial_test_budget(p_receipt);
 if p_expected_revision is null or p_expected_revision<1 or p_previous_fingerprint is null or p_previous_fingerprint !~ '^[a-f0-9]{64}$'
 or not public.zentra_us_tax_object(p_book,array['schemaVersion','revision','baseline','policy','promotion','events']) or jsonb_typeof(p_book->'events') is distinct from 'array' or jsonb_array_length(p_book->'events')<1
 or p_book-'events'-'revision' is distinct from b-'events'-'revision' then raise exception using errcode='PF004',message='Invalid financial commit envelope';end if;
 e:=p_book->'events'->-1;
 if e->'actor' is distinct from p_actor or not public.zentra_us_tax_object(e,case when e->'operation'->>'type'='erp_command' then array['revision','id','operation','actor','commit','effects'] else array['revision','id','operation','actor','record','posting'] end) then raise exception using errcode='PF004',message='Invalid financial event envelope';end if;
 if e->'operation'->>'type' not in('customer_credit','customer_payment','erp_command') or (e->'operation'->>'type'='erp_command' and e->'operation'->'command'->>'type' not in('save_customer','save_estimate','accept_estimate','save_vendor','record_vendor_bill','record_vendor_payment')) then raise exception using errcode='PF010',message='Purchasing capability excludes this command';end if;
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
-- The old commercial reader is closed BEFORE replay on any purchasing tail.
-- Its receipt and append paths delegate to that same admitted reader.
do $$ declare f record;body text;begin
 if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='zentra_read_us_financial_commercial_test_v5')<>1 then raise exception 'Exact commercial reader prerequisite required';end if;
 select p.* into f from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='zentra_read_us_financial_commercial_test_v5';
 body:=replace(f.prosrc,'perform public.zentra_us_commercial_admit(p_organization,p_actor,p_grant_version,p_capability);','perform public.zentra_us_commercial_admit(p_organization,p_actor,p_grant_version,p_capability); if exists(select 1 from public.zentra_us_financial_test_events where organization_id=p_organization and payload->''operation''->>''type''=''erp_command'' and payload->''operation''->''command''->>''type'' in(''save_vendor'',''record_vendor_bill'',''record_vendor_payment'')) then raise exception using errcode=''PF008'',message=''Purchasing capability required'';end if;');
 if body=f.prosrc then raise exception 'Exact commercial admission prerequisite required';end if;
 execute format('create or replace function public.%I(%s) returns jsonb language plpgsql volatile security invoker set search_path='''' as %L',f.proname,pg_get_function_arguments(f.oid),body);
end $$;
do $$ declare f record;begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'zentra_us_purchasing_%' or p.proname in('zentra_read_us_financial_purchasing_test_v5','zentra_us_financial_purchasing_test_receipt_v5','zentra_append_us_financial_purchasing_test_v5')) loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
commit;
