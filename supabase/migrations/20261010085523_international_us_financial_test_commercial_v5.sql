-- PRIVATE LOCAL TEST commercial continuity, same immutable baseline and tail.
-- No production activation, public ERP5, provider or legacy table thaw.
begin;
-- Refuse installation over any invalid prior settlement book. No baseline,
-- event, receipt or cursor is rewritten. These local TEST installation locks
-- prevent a prior append from changing the checked tail during replacement.
lock table public.zentra_us_financial_test_heads,public.zentra_us_financial_test_events,public.zentra_us_financial_test_cursors,public.zentra_us_financial_test_receipts,public.zentra_us_financial_test_tax_plans in share row exclusive mode;
do $$ declare h record;b jsonb;e jsonb;begin
 for h in select organization_id from public.zentra_us_financial_test_heads loop
  b:=public.zentra_us_settlement_book(h.organization_id);perform public.zentra_us_settlement_plans(b);
  if not exists(select 1 from public.zentra_us_financial_test_cursors c where c.organization_id=h.organization_id and c.revision=(b->>'revision')::bigint and c.book_sha256=public.zentra_us_financial_test_hash(b)) then raise exception using errcode='PF004',message='Valid prior settlement cursor required';end if;
  for e in select value from jsonb_array_elements(b->'events') loop
   if not exists(select 1 from public.zentra_us_financial_test_receipts r where r.organization_id=h.organization_id and r.idempotency_key=e->'operation'->>'idempotencyKey' and r.origin='financial_v5' and r.actor_id=e->'actor'->>'userId' and r.receipt=public.zentra_us_settlement_receipt(b,e)) then raise exception using errcode='PF004',message='Valid prior settlement receipt required';end if;
  end loop;
 end loop;
end $$;
create function public.zentra_us_commercial_units(v text) returns integer
language sql immutable security invoker set search_path='' as $$
 select length(v)+length(regexp_replace(v COLLATE pg_catalog."C",'[^'||chr(65536)||'-'||chr(1114111)||']','','g'));
$$;
-- ECMAScript trim whitespace, preserving the original value and permitted
-- embedded newlines. PostgreSQL trim alone covers only ASCII space.
create function public.zentra_us_commercial_trim(v text) returns text
language sql immutable security invoker set search_path='' as $$
 select btrim(v,chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279));
$$;
create function public.zentra_us_commercial_current(b jsonb) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare customers jsonb:=b->'baseline'->'customers';estimates jsonb:=b->'baseline'->'estimates';counters jsonb:=b->'baseline'->'counters';e jsonb;c jsonb;
begin
 for e in select value from jsonb_array_elements(b->'events') where value->'operation'->>'type'='erp_command' loop
  for c in select value from jsonb_array_elements(e->'commit'->'changes') loop
   if c->>'kind'='customer' then
    if exists(select 1 from jsonb_array_elements(customers) x where x->>'id'=c->>'id') then select jsonb_agg(case when x->>'id'=c->>'id' then c->'payload' else x end order by n) into customers from jsonb_array_elements(customers) with ordinality t(x,n);else customers:=customers||jsonb_build_array(c->'payload');end if;
   elsif c->>'kind'='estimate' then
    if exists(select 1 from jsonb_array_elements(estimates) x where x->>'id'=c->>'id') then select jsonb_agg(case when x->>'id'=c->>'id' then c->'payload' else x end order by n) into estimates from jsonb_array_elements(estimates) with ordinality t(x,n);else estimates:=estimates||jsonb_build_array(c->'payload');end if;
   else raise exception using errcode='PF004',message='Commercial registry is not supported';end if;
  end loop;counters:=e->'commit'->'header'->'counters';
 end loop;return jsonb_build_object('customers',customers,'estimates',estimates,'counters',counters);
end $$;
-- A private transient compatibility header only. Credits are omitted from the
-- captured ERP4 ledger, never from the real financial book or reports. These
-- three commercial commands have no period/journal effect.
create function public.zentra_us_commercial_header(b jsonb,counters jsonb) returns jsonb
language sql immutable security invoker set search_path='' as $$
 select jsonb_build_object('schemaVersion',4,'revision',(b->>'revision')::bigint+1,'configuration',b->'baseline'->'configuration','counters',counters,'ledger',((b->'baseline'->'ledger')-'entries'-'audit')||jsonb_build_object('revision',(b->'baseline'->'ledger'->>'revision')::bigint+(select count(*) from jsonb_array_elements(b->'events') e where e->'operation'->>'type'='customer_payment')));
$$;
create function public.zentra_us_commercial_transition(b jsonb,op jsonb,a jsonb,id text) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare org text:=b->'baseline'->'configuration'->>'organizationId';current_rows jsonb;c jsonb;previous jsonb;payload jsonb;customer jsonb;project jsonb;line jsonb;totals jsonb;changes jsonb;commit jsonb;receipt jsonb;financial_prefix jsonb;counter bigint;revision bigint;subtotal numeric:=0;discount numeric:=0;seen text[]:=array[]::text[];command_keys text[];action text;key text;
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
  select b||jsonb_build_object('events',coalesce(jsonb_agg(x order by n),'[]'::jsonb)) into financial_prefix from jsonb_array_elements(b->'events') with ordinality t(x,n) where x->'operation'->>'type' in('customer_credit','customer_payment');
  return public.zentra_us_settlement_transition(financial_prefix,op,a,id);
 end if;
 if op->>'type' is distinct from 'erp_command' then raise exception using errcode='PF010',message='Private commercial operation unavailable';end if;
 if not public.zentra_us_tax_object(op,array['type','idempotencyKey','command','facts']) or op->'facts' is distinct from '{"kind":"none"}'::jsonb then raise exception using errcode='PF004',message='Commercial facts must be empty';end if;
 c:=op->'command';action:=c->>'type';
 if action is null or action not in('save_customer','save_estimate','accept_estimate') then raise exception using errcode='PF010',message='Private commercial command unavailable';end if;
 command_keys:=case action when 'save_customer' then array['type','customer'] when 'save_estimate' then array['type','id','expectedEstimateRevision','customerId','date','expiresAt','paymentTermsDays','lines','notes'] else array['type','estimateId','expectedEstimateRevision'] end;
 if not public.zentra_us_tax_object(c,command_keys,case when action='save_estimate' then array['projectId'] else array[]::text[] end) then raise exception using errcode='PF004',message='Invalid commercial command fields';end if;
 current_rows:=public.zentra_us_commercial_current(b);revision:=(b->>'revision')::bigint+1;
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
 commit:=jsonb_build_object('organizationId',org,'expectedRevision',(b->>'revision')::bigint,'header',public.zentra_us_commercial_header(b,current_rows->'counters'),'changes',changes,'ledgerAudit','[]'::jsonb,'receipt',receipt,'actor',a);
 return jsonb_build_object('revision',revision,'id',id,'operation',op,'actor',a,'commit',commit,'effects',jsonb_build_object('postings','[]'::jsonb,'audit','[]'::jsonb));
exception when sqlstate 'PU004' then raise exception using errcode='PF004',message='Invalid exact commercial value';end $$;
create function public.zentra_us_commercial_replay(b jsonb) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare current_book jsonb;e jsonb;rebuilt jsonb;
begin
 perform public.zentra_us_financial_test_budget(b);
 if not public.zentra_us_tax_object(b,array['schemaVersion','revision','baseline','policy','promotion','events']) or b->'schemaVersion' is distinct from '5'::jsonb or jsonb_typeof(b->'events') is distinct from 'array'
 or b->'revision' is distinct from to_jsonb((b->'baseline'->>'revision')::bigint+1+jsonb_array_length(b->'events')) then raise exception using errcode='PF004',message='Invalid private commercial book';end if;
 current_book:=b||jsonb_build_object('revision',(b->'baseline'->>'revision')::bigint+1,'events','[]'::jsonb);
 for e in select value from jsonb_array_elements(b->'events') loop
  if not public.zentra_us_tax_object(e,case when e->'operation'->>'type'='erp_command' then array['revision','id','operation','actor','commit','effects'] else array['revision','id','operation','actor','record','posting'] end) or jsonb_typeof(e->'id') is distinct from 'string' then raise exception using errcode='PF004',message='Invalid private commercial event';end if;
  rebuilt:=public.zentra_us_commercial_transition(current_book,e->'operation',e->'actor',e->>'id');
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
 return public.zentra_us_commercial_replay(b);
end $$;
create or replace function public.zentra_us_settlement_receipt(b jsonb,e jsonb) returns jsonb
language sql immutable security invoker set search_path='' as $$
 select jsonb_build_object('idempotencyKey',e->'operation'->>'idempotencyKey','commandHash',public.zentra_us_financial_test_hash(jsonb_build_array(b->'baseline'->'configuration'->>'organizationId',e->'actor'->>'userId',jsonb_build_object('idempotencyKey',e->'operation'->>'idempotencyKey','expectedRevision',(e->>'revision')::bigint-1,'command',case when e->'operation'->>'type'='erp_command' then jsonb_build_object('type','erp_command','request',e->'operation'->'command') else ((e->'operation')-'idempotencyKey'-'taxProof')||jsonb_build_object('id',e->>'id') end))),'revision',e->'revision','entityId',e->>'id','action',e->'operation'->>'type','actorId',e->'actor'->>'userId');
$$;
create function public.zentra_us_commercial_admit(org text,a jsonb,v bigint,cap text) returns void
language plpgsql volatile security invoker set search_path='' as $$
begin
 if cap is distinct from 'postgres-test-commercial-v5' then raise exception using errcode='PF009',message='Private commercial TEST capability required';end if;
 perform public.zentra_us_settlement_admit(org,a,v,'postgres-test-settlement-v5');
end $$;
-- Existing source orders stay frozen. This LIVE new-operation admission is
-- deliberately absent from historical replay/read: a later admission state
-- must not reinterpret an earlier valid receipt/history.
create function public.zentra_us_commercial_source(org text,op jsonb) returns void
language plpgsql volatile security invoker set search_path='' as $$
declare wanted_estimate text;
begin
 if op->>'type'='erp_command' and op->'command'->>'type' in('save_estimate','accept_estimate') then
  wanted_estimate:=case when op->'command'->>'type'='save_estimate' then op->'command'->>'id' else op->'command'->>'estimateId' end;
  if exists(select 1 from public.zentra_us_sales_orders o where o.organization_id=org and o.estimate_id=wanted_estimate and o.state<>'cancelled') then raise exception using errcode='PO008',message='Active sales order locks its source estimate';end if;
 end if;
end $$;
create or replace function public.zentra_us_settlement_event_guard() returns trigger
language plpgsql volatile security invoker set search_path='' as $$
declare b jsonb;e jsonb;c public.zentra_us_financial_test_cursors%rowtype;
begin
 if tg_op<>'INSERT' then raise exception using errcode='PF003',message='Financial events are immutable';end if;
 perform public.zentra_us_commercial_admit(new.organization_id,new.payload->'actor',new.grant_version,'postgres-test-commercial-v5');
 select * into c from public.zentra_us_financial_test_cursors where organization_id=new.organization_id for update;
 if not found or new.revision<>c.revision+1 then raise exception using errcode='PF001',message='Exact financial event CAS required';end if;
 b:=public.zentra_us_settlement_book(new.organization_id);
 if (b->>'revision')::bigint<>c.revision or public.zentra_us_financial_test_hash(b)<>c.book_sha256 then raise exception using errcode='PF004',message='Financial cursor history mismatch';end if;
 perform public.zentra_us_commercial_source(new.organization_id,new.payload->'operation');
 e:=public.zentra_us_commercial_transition(b,new.payload->'operation',new.payload->'actor',new.payload->>'id');
 if e is distinct from new.payload or new.revision is distinct from (e->>'revision')::bigint then raise exception using errcode='PF004',message='Uncorroborated commercial event';end if;
 b:=b||jsonb_build_object('revision',e->'revision','events',(b->'events')||jsonb_build_array(e));perform public.zentra_us_financial_test_budget(b);perform public.zentra_us_settlement_plans(b);
 if exists(select 1 from public.zentra_us_financial_test_receipts where organization_id=new.organization_id and idempotency_key=e->'operation'->>'idempotencyKey') then raise exception using errcode='PF002',message='Historical key already reserved';end if;return new;
end $$;
create function public.zentra_read_us_financial_commercial_test_v5(p_organization text,p_actor jsonb,p_grant_version bigint,p_capability text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare b jsonb;c public.zentra_us_financial_test_cursors%rowtype;
begin
 perform public.zentra_us_commercial_admit(p_organization,p_actor,p_grant_version,p_capability);b:=public.zentra_us_settlement_book(p_organization);if b is null then return null;end if;
 perform public.zentra_us_settlement_plans(b);select * into c from public.zentra_us_financial_test_cursors where organization_id=p_organization for update;
 if not found or c.revision<>(b->>'revision')::bigint or c.book_sha256<>public.zentra_us_financial_test_hash(b) then raise exception using errcode='PF004',message='Financial cursor mismatch';end if;return b;
end $$;
create function public.zentra_us_financial_commercial_test_receipt_v5(p_organization text,p_actor jsonb,p_grant_version bigint,p_capability text,p_idempotency_key text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare r public.zentra_us_financial_test_receipts%rowtype;b jsonb;
begin
 b:=public.zentra_read_us_financial_commercial_test_v5(p_organization,p_actor,p_grant_version,p_capability);
 if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 240 then raise exception using errcode='PF004',message='Invalid financial receipt key';end if;
 select * into r from public.zentra_us_financial_test_receipts where organization_id=p_organization and idempotency_key=p_idempotency_key;if not found then return null;end if;
 return jsonb_build_object('origin',r.origin,'actorId',r.actor_id,'receipt',r.receipt);
end $$;
create function public.zentra_append_us_financial_commercial_test_v5(p_organization text,p_actor jsonb,p_grant_version bigint,p_capability text,p_expected_revision bigint,p_previous_fingerprint text,p_book jsonb,p_receipt jsonb) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare b jsonb;e jsonb;expected_receipt jsonb;prior public.zentra_us_financial_test_receipts%rowtype;prefix jsonb;
begin
 b:=public.zentra_read_us_financial_commercial_test_v5(p_organization,p_actor,p_grant_version,p_capability);if b is null then raise exception using errcode='PF004',message='Promoted financial book required';end if;
 perform public.zentra_us_financial_test_budget(p_book);perform public.zentra_us_financial_test_budget(p_receipt);
 if p_expected_revision is null or p_expected_revision<1 or p_previous_fingerprint is null or p_previous_fingerprint !~ '^[a-f0-9]{64}$'
 or not public.zentra_us_tax_object(p_book,array['schemaVersion','revision','baseline','policy','promotion','events']) or jsonb_typeof(p_book->'events') is distinct from 'array' or jsonb_array_length(p_book->'events')<1
 or p_book-'events'-'revision' is distinct from b-'events'-'revision' then raise exception using errcode='PF004',message='Invalid financial commit envelope';end if;
 e:=p_book->'events'->-1;
 if e->'actor' is distinct from p_actor or not public.zentra_us_tax_object(e,case when e->'operation'->>'type'='erp_command' then array['revision','id','operation','actor','commit','effects'] else array['revision','id','operation','actor','record','posting'] end) then raise exception using errcode='PF004',message='Invalid financial event envelope';end if;
 if e->'operation'->>'type' not in('customer_credit','customer_payment','erp_command') or (e->'operation'->>'type'='erp_command' and e->'operation'->'command'->>'type' not in('save_customer','save_estimate','accept_estimate')) then raise exception using errcode='PF010',message='Commercial capability excludes this command';end if;
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

-- Close the earlier reader before its reconstruction whenever mixed events
-- exist. Its receipt/append paths delegate to this same admitted reader.
do $$ declare f record;body text;begin
 select p.* into f from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='zentra_read_us_financial_settlement_test_v5';
 if not found then raise exception 'Exact settlement reader prerequisite required';end if;
 body:=replace(f.prosrc,'perform public.zentra_us_settlement_admit(p_organization,p_actor,p_grant_version,p_capability);','perform public.zentra_us_settlement_admit(p_organization,p_actor,p_grant_version,p_capability); if exists(select 1 from public.zentra_us_financial_test_events where organization_id=p_organization and payload->''operation''->>''type''=''erp_command'') then raise exception using errcode=''PF008'',message=''Commercial capability required'';end if;');
 if body=f.prosrc then raise exception 'Exact settlement admission prerequisite required';end if;
 execute format('create or replace function public.%I(%s) returns jsonb language plpgsql volatile security invoker set search_path='''' as %L',f.proname,pg_get_function_arguments(f.oid),body);
end $$;
do $$ declare f record;begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'zentra_us_commercial_%' or p.proname in('zentra_read_us_financial_commercial_test_v5','zentra_us_financial_commercial_test_receipt_v5','zentra_append_us_financial_commercial_test_v5')) loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
commit;
