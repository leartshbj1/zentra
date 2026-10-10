import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import type { FinancialAuthority } from './accounting/ledger';
import { canonicalErpJson } from './erp-contract';
import { buildTaxRequest, estimateTotals, type TaxAssessment } from './invoicing';
import { executeErp } from './runtime';
import { createSupabaseErpStore } from './runtime-store';
import type { ErpCommand, ErpCommit } from './runtime-types';
import type { CompanyConfiguration } from './types';
import { prepareStripeTaxResolvedRequest, type StripeTaxTestBinding } from './stripe-tax-resolved-request';
import type { StripeTaxPrivateProof } from './stripe-tax-calculation';
import type { UsTaxFacts } from './us-tax-profile';
import { applyUsFinancialOperationV5, buildUsFinancialCreditCandidateV5, projectUsFinancialBookV5, promoteUsFinancialBookV5 } from './us-financial-kernel';
import type { UsFinancialBookV5, UsFinancialCreditInputV5, UsFinancialOperationV5, UsFinancialPolicyV5, UsFinancialTaxProofV5 } from './us-financial-kernel-types';
import type { UsFinancialCommitV5, UsFinancialReceiptV5 } from './us-financial-kernel-runtime';
import { createSupabaseUsFinancialTestFoundationV5 } from './us-financial-test-foundation';
import { createSupabaseUsFinancialSettlementTestStoreV5 } from './us-financial-test-settlement';
import { createSupabaseUsFinancialCommercialTestStoreV5 } from './us-financial-test-commercial';
import { createSupabaseUsFinancialPurchasingTestStoreV5 } from './us-financial-test-purchasing';

// Actual private SQL guards and real ERP4 issuance chain on retained local
// NodeFS. Every account, invoice, approval and tax observation is synthetic.
// No external provider/network operation. Serialized PGlite is not proof of
// multi-connection concurrency, D1 atomicity, crash recovery or production SLA.
const directory=process.env.PGLITE_MODULE_DIR,enabled=Boolean(directory&&isAbsolute(directory));
type Sql={exec(sql:string):Promise<unknown>;query<T=Record<string,unknown>>(sql:string,values?:unknown[]):Promise<{rows:T[]}>};
type Db=Sql&{close():Promise<void>;transaction<T>(task:(tx:Sql)=>Promise<T>):Promise<T>};
let db:Db,PGlite:new(dataDir?:string)=>Db,dataDir:string;
const capability='postgres-test-purchasing-v5',migration='20261010091729_international_us_financial_test_purchasing_v5';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');

type Fixture=Awaited<ReturnType<typeof fixture>>;
let previousFixture:Fixture,previousBook:UsFinancialBookV5,previousCommit:UsFinancialCommitV5;
const operation=(command:ErpCommand,key:string=randomUUID()):UsFinancialOperationV5=>({type:'erp_command',idempotencyKey:key,command:command as Extract<UsFinancialOperationV5,{type:'erp_command'}>['command'],facts:{kind:'none'}});
const vendor=(f:Fixture,name='Synthetic supplier')=>({...f.baseline.customers[0],id:'vendor',name});
const bill=(f:Fixture,id='bill',netMinor='10000',purchaseTaxMinor='825'):ErpCommand=>({type:'record_vendor_bill',id,vendorId:'vendor',reference:`Synthetic invoice ${id}`,date:f.day,accountingDate:f.day,dueDate:f.day,periodId:'year',netMinor,purchaseTaxMinor,expenseAccountId:'purchases',sourceReference:'Synthetic declared original, no file/provider'});
const vendorPayment=(f:Fixture,id='vendor-payment',amountMinor='4000'):ErpCommand=>({type:'record_vendor_payment',id,billId:'bill',amountMinor,paymentDate:f.day,accountingDate:f.day,periodId:'year',reference:'Synthetic bank entry, no money moved'});
const quote=(f:Fixture):ErpCommand=>({type:'save_estimate',id:'new-quote',expectedEstimateRevision:0,customerId:'customer',date:f.day,expiresAt:f.day,paymentTermsDays:30,lines:f.baseline.estimates[0].lines,notes:'Synthetic terms\nSecond paragraph'});
function erpEvent(c:UsFinancialCommitV5){const e=c.book.events.at(-1)!;if(!('commit'in e))throw Error('ERP event required');return e;}
async function addVendorBill(f:Fixture){await f.append(await f.prepare(operation({type:'save_vendor',vendor:vendor(f)}),'vendor'));const c=await f.prepare(operation(bill(f)),'bill');await f.append(c);return c;}
async function sqlTransition(f:Fixture,op:unknown,id:string,before?:UsFinancialBookV5){return result('select public.zentra_us_purchasing_transition($1,$2,$3,$4) result',[before??await f.read(),op,f.actor,id]);}

describe.skipIf(!enabled)('independent private US financial TEST purchasing continuity',()=>{
 beforeAll(async()=>{
  const require=createRequire(import.meta.url);({PGlite}=require(join(directory!,'dist/index.cjs')) as {PGlite:new(dataDir?:string)=>Db});dataDir=await mkdtemp(join(tmpdir(),'zentra-purchasing-test-v5-'));db=new PGlite(dataDir);
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);grant usage on schema public to service_role;');
  for(const name of migrations)await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`,import.meta.url),'utf8'));
  previousFixture=await fixture();let b=previousFixture.initial;
  for(const [op,id] of [[await previousFixture.credit(b),'prior-credit'],[operation({type:'save_customer',customer:{...previousFixture.baseline.customers[0],name:'Synthetic prior edit'}}),'customer'],[previousFixture.payment('100'),'prior-payment']] as const){previousCommit=await previousFixture.prepare(op,id,b);await previousFixture.commercialStore.commit(previousCommit);b=previousCommit.book;}previousBook=b;
  await db.exec(await readFile(new URL(`../../supabase/migrations/${migration}.sql`,import.meta.url),'utf8'));
 },30000);
 afterAll(async()=>{await db?.close();});
 it('validates and preserves an existing mixed commercial/settlement tail during additive installation',async()=>{
  expect(await previousFixture.read()).toEqual(previousBook);expect(await previousFixture.commercialStore.read(previousFixture.org)).toEqual(previousBook);expect(await previousFixture.store.commit(previousCommit)).toEqual(previousCommit.receipt);
 });
 it('records supplier debt and cumulative payments in the same book as customer credits, edits, quotes and receipts',async()=>{
  const f=await fixture();await f.store.commit(await f.prepare(await f.credit(f.initial),'credit-before'));
  await f.store.commit(await f.prepare(operation({type:'save_vendor',vendor:vendor(f)}),'vendor'));
  const invoice=await f.prepare(operation(bill(f)),'bill');await f.store.commit(invoice);const event=erpEvent(invoice);
  expect(event.effects.postings[0]).toMatchObject({revision:f.baseline.ledger.revision+2,source:{type:'vendor_bill',id:'bill'},lines:[{accountId:'purchases',debitMinor:'10825',creditMinor:'0'},{accountId:'payables',debitMinor:'0',creditMinor:'10825'}]});expect(event.commit.header.ledger.revision).toBe(f.baseline.ledger.revision+1);expect(event.commit.ledgerAudit[0].revision).toBe(f.baseline.ledger.revision+1);
  await f.store.commit(await f.prepare(operation({type:'save_vendor',vendor:vendor(f,'Synthetic updated supplier')}),'vendor'));await f.store.commit(await f.prepare(operation({type:'save_customer',customer:{...f.baseline.customers[0],name:'Synthetic customer edit'}}),'customer'));
  await f.store.commit(await f.prepare(operation(quote(f)),'new-quote'));await f.store.commit(await f.prepare(operation({type:'accept_estimate',estimateId:'new-quote',expectedEstimateRevision:1}),'new-quote'));
  await f.store.commit(await f.prepare(f.payment('100'),'customer-payment'));
  const first=await f.prepare(operation(vendorPayment(f)),'vendor-payment');await f.store.commit(first);const last=await f.prepare(operation(vendorPayment(f,'vendor-payment-last','6825')),'vendor-payment-last');await f.store.commit(last);
  await f.store.commit(await f.prepare(await f.credit(await f.read()),'credit-after'));const view=await projectUsFinancialBookV5(await f.read());
  expect(view.vendorBills[0]).toMatchObject({vendorSnapshot:{name:'Synthetic supplier'},tax:{minorUnits:'825'},total:{minorUnits:'10825'},approvalSource:'manual_entry',recordedRevision:invoice.book.revision});expect(view.vendors[0].name).toBe('Synthetic updated supplier');expect(view.vendorPayments.map(p=>p.amount.minorUnits)).toEqual(['4000','6825']);expect(view.ledger.revision).toBe(f.baseline.ledger.revision+6);expect(view.ledger.entries.filter(e=>e.source.type==='vendor_payment').map(e=>e.source.id)).toEqual(['bill','bill']);expect(view.settlements[0]).toMatchObject({receivedMinor:'100',creditedMinor:'19652',outstandingMinor:'9726'});expect(await f.store.commit(invoice)).toEqual(invoice.receipt);expect(await f.store.commit(first)).toEqual(first.receipt);
 },30000);
 it('preserves baseline purchasing and a genuine ERP4 vendor no-op before promotion',async()=>{
  const f=await fixture({baselinePurchases:true});expect(f.baseline.vendorBills).toHaveLength(1);expect(f.baseline.vendorPayments?.[0].amount.minorUnits).toBe('50');
  const c=await f.prepare(operation(vendorPayment(f,'remaining','57')),'remaining');await f.store.commit(c);const view=await projectUsFinancialBookV5(await f.read());expect(view.vendorPayments.map(p=>p.amount.minorUnits)).toEqual(['50','57']);expect(view.ledger.revision).toBe(f.baseline.ledger.revision+1);
 });
 it('retains the required vendor snapshot on no-op and changes no financial state',async()=>{
  const f=await fixture();await addVendorBill(f);const before=await f.read(),c=await f.prepare(operation({type:'save_vendor',vendor:vendor(f)}),'vendor');expect(erpEvent(c).commit.changes).toEqual([{kind:'vendor',id:'vendor',payload:vendor(f)}]);expect(erpEvent(c).effects).toEqual({postings:[],audit:[]});await f.store.commit(c);expect((await projectUsFinancialBookV5(await f.read())).ledger).toEqual((await projectUsFinancialBookV5(before)).ledger);
 });
 it('allows ERP entity IDs across registries but rejects their reuse by new customer settlements',async()=>{
  const f=await fixture();await f.append(await f.prepare(operation({type:'save_customer',customer:{...f.baseline.customers[0],name:'Synthetic customer changed'}}),'customer'));
  await f.append(await f.prepare(operation({type:'save_vendor',vendor:{...vendor(f),id:'customer'}}),'customer'));
  await f.append(await f.prepare(operation({...bill(f,'customer','100','7'),vendorId:'customer'} as ErpCommand),'customer'));
  await f.append(await f.prepare(operation({...vendorPayment(f,'customer','107'),billId:'customer'} as ErpCommand),'customer'));
  const view=await projectUsFinancialBookV5(await f.read());expect(view.customers[0].id).toBe('customer');expect(view.vendors[0].id).toBe('customer');expect(view.vendorBills[0].id).toBe('customer');expect(view.vendorPayments[0].id).toBe('customer');
  await expect(sqlTransition(f,await f.credit(await f.read()),'customer')).rejects.toMatchObject({code:'PF002'});await expect(sqlTransition(f,f.payment('1'),'customer')).rejects.toMatchObject({code:'PF002'});
 });
 it('counts period audits independently from postings when purchases enter a later open period',async()=>{
  const f=await fixture({baselinePurchases:true,closed:true,laterOpen:true}),next=`${Number(f.day.slice(0,4))+1}-01-01`;
  expect(f.baseline.ledger.revision).toBe(f.baseline.ledger.audit.length);expect(f.baseline.ledger.revision).toBeGreaterThan(f.baseline.ledger.entries.length);
  const c=await f.prepare(operation({...bill(f,'next-bill','100','7'),periodId:'next',accountingDate:next} as ErpCommand),'next-bill');await f.append(c);
  await f.append(await f.prepare(operation({...vendorPayment(f,'next-payment','107'),billId:'next-bill',periodId:'next',accountingDate:next} as ErpCommand),'next-payment'));
  const view=await projectUsFinancialBookV5(await f.read());expect(view.ledger.revision).toBe(f.baseline.ledger.revision+2);expect(view.ledger.audit).toHaveLength(f.baseline.ledger.audit.length+2);expect(view.ledger.entries).toHaveLength(f.baseline.ledger.entries.length+2);expect(erpEvent(c).effects.postings[0].revision).toBe(f.baseline.ledger.revision+1);expect(erpEvent(c).commit.header.ledger.revision).toBe(f.baseline.ledger.revision+1);
 });
 it('allows net-zero positive declared purchase tax without inventing recoverable VAT',async()=>{
  const f=await fixture();await f.append(await f.prepare(operation({type:'save_vendor',vendor:vendor(f)}),'vendor'));const c=await f.prepare(operation(bill(f,'tax-only','0','107')),'tax-only');await f.append(c);expect(erpEvent(c).effects.postings[0].lines).toEqual([{accountId:'purchases',debitMinor:'107',creditMinor:'0'},{accountId:'payables',debitMinor:'0',creditMinor:'107'}]);
 });
 it.each(['0','-1','01','1.00','1e3',1,'9'.repeat(37)])('rejects noncanonical or zero vendor payment %s without mutation',async amountMinor=>{
  const f=await fixture();await addVendorBill(f);const before=await f.read();await expect(sqlTransition(f,operation({...vendorPayment(f),amountMinor} as ErpCommand),'vendor-payment')).rejects.toMatchObject({code:'PF004'});expect(await f.read()).toEqual(before);
 });
 it('keeps exact integers beyond bigint, validates net+tax overflow and blocks cumulative overpayment',async()=>{
  const f=await fixture();await f.append(await f.prepare(operation({type:'save_vendor',vendor:vendor(f)}),'vendor'));const huge='123456789012345678901234567890';await f.append(await f.prepare(operation(bill(f,'bill',huge,'7')),'bill'));await f.append(await f.prepare(operation(vendorPayment(f,'part',huge)),'part'));await f.append(await f.prepare(operation(vendorPayment(f,'last','7')),'last'));await expect(sqlTransition(f,operation(vendorPayment(f,'extra','1')),'extra')).rejects.toMatchObject({code:'PF013'});
  await expect(sqlTransition(f,operation(bill(f,'overflow','9'.repeat(36),'1')),'overflow')).rejects.toMatchObject({code:'PF004'});expect((await projectUsFinancialBookV5(await f.read())).vendorPayments.map(p=>p.amount.minorUnits)).toEqual([huge,'7']);
 });
 it('requires unique immutable bill ids and exact vendor/reference/date without silently normalizing references',async()=>{
  const f=await fixture();await addVendorBill(f);const first=bill(f);if(first.type!=='record_vendor_bill')throw Error('Synthetic bill required');
  for(const c of [{...first,id:'other'},{...first,reference:'different'}])await expect(sqlTransition(f,operation(c),c.id)).rejects.toMatchObject({code:'PF002'});
  await f.append(await f.prepare(operation({...first,id:'spaced',reference:` ${first.reference} `}),'spaced'));expect((await projectUsFinancialBookV5(await f.read())).vendorBills.map(b=>b.reference)).toEqual([first.reference,` ${first.reference} `]);
 });
 it.each(['snapshot','total','account','source','cash_flow','global_revision','compact_revision','audit','inner_receipt','outer_receipt'])('rejects forged independent purchase %s with atomic rollback',async kind=>{
  const f=await fixture();await f.append(await f.prepare(operation({type:'save_vendor',vendor:vendor(f)}),'vendor'));const before=await f.read(),good=await f.prepare(operation(bill(f)),'bill'),bad=copy(good) as Mutable<UsFinancialCommitV5>,e=bad.book.events.at(-1)!;if(!('commit'in e))throw Error('ERP required');
  if(kind==='snapshot')(e.commit.changes[0].payload as {vendorSnapshot:{name:string}}).vendorSnapshot.name='Forged supplier';
  if(kind==='total')(e.commit.changes[0].payload as {total:{minorUnits:string}}).total.minorUnits='10826';
  if(kind==='account')e.effects.postings[0].lines[0].accountId='sales';
  if(kind==='source')e.effects.postings[0].source.id='wrong';
  if(kind==='cash_flow')(e.effects.postings[0] as unknown as {cashFlowCategory:string}).cashFlowCategory='investing';
  if(kind==='global_revision')(e.commit.changes[0].payload as {recordedRevision:number}).recordedRevision--;
  if(kind==='compact_revision')e.commit.header.ledger.revision++;
  if(kind==='audit')e.effects.audit[0].entityId='wrong';
  if(kind==='inner_receipt')e.commit.receipt.commandHash=bad.receipt.commandHash;
  if(kind==='outer_receipt')bad.receipt.commandHash=e.commit.receipt.commandHash;
  await expect(f.append(bad)).rejects.toMatchObject({code:'PF004'});expect(await f.read()).toEqual(before);
 });
 it('checks open periods, civil dates and exact account mapping and preserves the existing payment date policy',async()=>{
  const f=await fixture();await addVendorBill(f);const c=bill(f,'invalid');if(c.type!=='record_vendor_bill')throw Error('Synthetic bill required');
  for(const changed of [{...c,date:'2026-02-30'},{...c,dueDate:'2020-01-01'},{...c,accountingDate:'2020-01-01'},{...c,periodId:'foreign'},{...c,expenseAccountId:'sales'}])await expect(sqlTransition(f,operation(changed),'invalid')).rejects.toMatchObject({code:changed.accountingDate==='2020-01-01'||changed.periodId==='foreign'?'PF015':'PF004'});
  const old=vendorPayment(f);if(old.type!=='record_vendor_payment')throw Error('Synthetic payment required');const paid=await f.prepare(operation({...old,paymentDate:'2020-01-01'}),'vendor-payment');await f.append(paid);expect(erpEvent(paid).effects.postings[0].paymentDate).toBe('2020-01-01');
  const closed=await fixture({closed:true});await closed.append(await closed.prepare(operation({type:'save_vendor',vendor:vendor(closed)}),'vendor'));await expect(sqlTransition(closed,operation(bill(closed)),'bill')).rejects.toMatchObject({code:'PF015'});
 });
 it('requires existing scoped vendors and bills, exact command fields and financial actor length',async()=>{
  const f=await fixture();await expect(sqlTransition(f,operation(bill(f)),'bill')).rejects.toMatchObject({code:'PF004'});await expect(sqlTransition(f,operation(vendorPayment(f)),'vendor-payment')).rejects.toMatchObject({code:'PF004'});
  const v=vendor(f);await expect(sqlTransition(f,operation({type:'save_vendor',vendor:{...v,organizationId:randomUUID()}}),'vendor')).rejects.toMatchObject({code:'PF004'});await f.append(await f.prepare(operation({type:'save_vendor',vendor:v}),'vendor'));
  await expect(sqlTransition(f,{...operation(bill(f)),facts:{kind:'invoice_issuance'}},'bill')).rejects.toMatchObject({code:'PF004'});const actor={...f.actor,userId:'a'.repeat(200)},op=operation({type:'save_vendor',vendor:vendor(f,'Synthetic alternate')});expect(await result('select public.zentra_us_purchasing_transition($1,$2,$3,$4) result',[await f.read(),op,actor,'vendor'])).toEqual((await applyUsFinancialOperationV5(await f.read(),op,actor,'vendor')).book.events.at(-1));await expect(result('select public.zentra_us_purchasing_transition($1,$2,$3,$4) result',[await f.read(),operation(bill(f)),actor,'bill'])).rejects.toMatchObject({code:'PF004'});
 });
 it('preserves CAS, key reservations and exact retries after later commercial and financial events',async()=>{
  const f=await fixture();await f.append(await f.prepare(operation({type:'save_vendor',vendor:vendor(f)}),'vendor'));const first=await f.prepare(operation(bill(f)),'bill'),stale=await f.prepare(operation(bill(f,'other')),'other');await f.append(first);await expect(f.append(stale)).rejects.toMatchObject({code:'PF001'});await f.append(await f.prepare(operation(vendorPayment(f)),'vendor-payment'));expect(await f.store.commit(first)).toEqual(first.receipt);expect(await f.store.receipt(f.org,first.receipt.idempotencyKey)).toEqual(first.receipt);
  const changed=copy(first) as Mutable<UsFinancialCommitV5>;changed.actor.timestamp=new Date(Date.now()-1000).toISOString();await expect(f.append(changed)).rejects.toMatchObject({code:'PF004'});await expect(sqlTransition(f,operation(vendorPayment(f,'new'),'synthetic-promotion'),'new')).resolves.toBeTruthy();const reserved=await f.prepare(operation(vendorPayment(f,'reserved'),'synthetic-promotion'),'reserved');await expect(f.append(reserved)).rejects.toMatchObject({code:'PF002'});
 });
 it('closes foundation, settlement and commercial ports before replay once purchases exist',async()=>{
  const f=await fixture(),c=await f.prepare(operation({type:'save_vendor',vendor:vendor(f)}),'vendor');await f.append(c);await expect(f.foundation.read()).rejects.toMatchObject({code:'financial_upgrade_required'});for(const old of [f.settlement,f.commercialStore]){await expect(old.read(f.org)).rejects.toMatchObject({code:'financial_upgrade_required'});await expect(old.receipt(f.org,c.receipt.idempotencyKey)).rejects.toMatchObject({code:'financial_upgrade_required'});}
  await expect(result('select public.zentra_append_us_financial_commercial_test_v5($1,$2,1,$3,$4,$5,$6,$7) result',[f.org,c.actor,'postgres-test-commercial-v5',c.expectedRevision,c.previousFingerprint,c.book,c.receipt])).rejects.toMatchObject({code:'PF008'});await expect(sql('select public.zentra_read_us_erp_v4($1)',[f.org])).rejects.toMatchObject({code:'PU008'});
 });
 it('requires complete atomic direct inserts and keeps history/grants/plans private and immutable',async()=>{
  const f=await fixture(),c=await f.prepare(operation({type:'save_vendor',vendor:vendor(f)}),'vendor');await expect(sql('insert into public.zentra_us_financial_test_events values($1,$2,$3,1)',[f.org,c.book.revision,c.book.events.at(-1)])).rejects.toMatchObject({code:'PF004'});expect(await f.read()).toEqual(f.initial);await f.append(c);
  for(const [q,code] of [['update public.zentra_us_financial_test_events set payload=payload where organization_id=$1','PF003'],['delete from public.zentra_us_financial_test_events where organization_id=$1','42501']]){await expect(sql(q,[f.org])).rejects.toMatchObject({code});await expect(db.query(q,[f.org])).rejects.toMatchObject({code:'PF003'});}await expect(sql('truncate public.zentra_us_financial_test_events')).rejects.toMatchObject({code:'42501'});await expect(db.exec('truncate public.zentra_us_financial_test_events')).rejects.toMatchObject({code:'PF003'});await expect(sql('update public.zentra_us_financial_test_grants set version=2 where organization_id=$1',[f.org])).rejects.toMatchObject({code:'PF003'});
  for(const role of ['anon','authenticated'])for(const q of ['select public.zentra_read_us_financial_purchasing_test_v5(null,null,null,null)','select * from public.zentra_us_financial_test_events'])await expect(sql(q,[],role)).rejects.toMatchObject({code:'42501'});
 });
 it('requires living versioned grants and rejects malformed scopes, future clocks and unsupported commands',async()=>{
  const f=await fixture(),c=await f.prepare(operation({type:'save_vendor',vendor:vendor(f)}),'vendor');await f.append(c);await db.query('update public.zentra_us_financial_test_grants set version=2,enabled=false where organization_id=$1',[f.org]);await expect(f.read()).rejects.toMatchObject({code:'PF005'});await expect(f.append(c)).rejects.toMatchObject({code:'PF005'});await db.query('update public.zentra_us_financial_test_grants set version=3,enabled=true where organization_id=$1',[f.org]);await expect(f.append(c)).rejects.toMatchObject({code:'PF006'});expect(await f.append(c,3)).toEqual(c.receipt);
  for(const actor of [{...f.actor,role:'member'},{...f.actor,managementEntitled:false},{...f.actor,organizationId:randomUUID()},{...f.actor,role:null}])await expect(result('select public.zentra_read_us_financial_purchasing_test_v5($1,$2,3,$3) result',[f.org,actor,capability])).rejects.toMatchObject({code:'PF005'});await expect(result('select public.zentra_read_us_financial_purchasing_test_v5($1,$2,3,$3) result',[f.org,{...f.actor,timestamp:new Date(Date.now()+86400000).toISOString()},capability])).rejects.toMatchObject({code:'PF016'});
  for(const command of [{type:'close_period',periodId:'year'},{type:'open_period',id:'next'},{type:'save_projects',projects:[]},{type:'issue_invoice',id:'new-invoice'}])await expect(sqlTransition(f,{type:'erp_command',idempotencyKey:randomUUID(),command,facts:{kind:'none'}},'unsupported',c.book)).rejects.toMatchObject({code:'PF010'});
 });
 it('keeps PO008 only on new quote actions and not private historical reads or retries',async()=>{
  const f=await fixture({activeOrder:true});await addVendorBill(f);const op=operation({...quote(f),id:'ordered-quote',expectedEstimateRevision:2} as ErpCommand),c=await f.prepare(op,'ordered-quote');await expect(f.append(c)).rejects.toMatchObject({code:'PO008'});await expect(sql('insert into public.zentra_us_financial_test_events values($1,$2,$3,1)',[f.org,c.book.revision,c.book.events.at(-1)])).rejects.toMatchObject({code:'PO008'});expect(await result('select public.zentra_us_purchasing_replay($1) result',[c.book])).toEqual(c.book);
  const saved=await f.prepare(operation(quote(f)),'new-quote');await f.append(saved);const original=(await db.query<{definition:string}>("select pg_get_functiondef('public.zentra_us_commercial_source(text,jsonb)'::regprocedure) definition")).rows[0].definition;try{await db.exec("create or replace function public.zentra_us_commercial_source(org text,op jsonb) returns void language plpgsql volatile security invoker set search_path='' as $$ begin raise exception using errcode='PO008',message='Synthetic denied';end $$;");expect(await f.store.read(f.org)).toEqual(saved.book);expect(await f.store.receipt(f.org,saved.receipt.idempotencyKey)).toEqual(saved.receipt);expect(await f.store.commit(saved)).toEqual(saved.receipt);}finally{await db.exec(original);}
 });
 it('retains the true purchasing ledger, immutable snapshots, receipts and exact retry after clean NodeFS reopen',async()=>{
  const f=await fixture();await f.append(await f.prepare(await f.credit(f.initial),'credit'));const c=await addVendorBill(f);await f.append(await f.prepare(operation(vendorPayment(f)),'vendor-payment'));await f.append(await f.prepare(f.payment('100'),'customer-payment'));const before=await f.read();await db.close();db=new PGlite(dataDir);expect(await f.read()).toEqual(before);expect(await f.store.commit(c)).toEqual(c.receipt);const view=await projectUsFinancialBookV5(await f.read());expect(view.ledger.revision).toBe(f.baseline.ledger.revision+4);expect(view.vendorBills[0].total.minorUnits).toBe('10825');expect(view.vendorPayments[0].amount.minorUnits).toBe('4000');
 },30000);
});

function copy<T>(value:T):T{return JSON.parse(JSON.stringify(value)) as T;}
type Mutable<T>=T extends object?{-readonly[K in keyof T]:Mutable<T[K]>}:T;
const migrations=[
 '202609140100_company_profiles','202609140200_company_collaboration','202609200300_company_content',
 '20261007194528_international_workspace_country_config','20261007222349_international_us_erp_persistence','20261007224820_international_us_erp_delta_stream','20261007225725_international_us_erp_seller_snapshot','20261008001726_new_us_workspace_admission','20261008013200_international_tax_proof_allowlist',
 '20261008034422_international_us_seller_profile','20261008044402_international_us_tax_profile','20261008060826_international_us_tax_operations','20261008081825_international_us_purchasing_v2','20261008105120_international_us_projects_v3','20261008161118_international_us_journal_periods_v4','20261008172520_international_us_tax_invoice_capability_v2',
 '20261008184605_international_us_bank_reconciliation','20261008194930_international_us_supplier_proposals','20261008210008_international_us_automation_analysis','20261009215104_international_us_workspace_sync_heads','20261009222319_international_us_tax_test_merchant','20261009224607_international_us_tax_invoice_preparation','20261010005300_international_us_supplier_originals','20261010024618_international_us_supplier_original_hash_lookup','20261010054644_international_us_sales_orders','20261010075840_international_us_financial_test_foundation_v5','20261010083027_international_us_financial_test_settlement_v5','20261010085523_international_us_financial_test_commercial_v5',
];
const parameters:Record<string,readonly string[]>={
 zentra_read_us_financial_purchasing_test_v5:['p_organization','p_actor','p_grant_version','p_capability'],zentra_us_financial_purchasing_test_receipt_v5:['p_organization','p_actor','p_grant_version','p_capability','p_idempotency_key'],zentra_append_us_financial_purchasing_test_v5:['p_organization','p_actor','p_grant_version','p_capability','p_expected_revision','p_previous_fingerprint','p_book','p_receipt'],
 zentra_read_us_erp_v4:['p_organization'],zentra_us_erp_receipt_v4:['p_organization','p_idempotency_key'],zentra_commit_us_erp:['p_organization','p_expected_revision','p_header','p_changes','p_ledger_audit','p_receipt','p_actor'],
 zentra_read_us_financial_test_v5:['p_organization','p_actor','p_grant_version','p_capability'],zentra_us_financial_test_receipt_v5:['p_organization','p_actor','p_grant_version','p_capability','p_idempotency_key'],zentra_promote_us_financial_test_v5:['p_organization','p_actor','p_grant_version','p_capability','p_book','p_idempotency_key','p_command_hash'],
 zentra_read_us_financial_settlement_test_v5:['p_organization','p_actor','p_grant_version','p_capability'],zentra_us_financial_settlement_test_receipt_v5:['p_organization','p_actor','p_grant_version','p_capability','p_idempotency_key'],zentra_append_us_financial_settlement_test_v5:['p_organization','p_actor','p_grant_version','p_capability','p_expected_revision','p_previous_fingerprint','p_book','p_receipt'],
 zentra_read_us_financial_commercial_test_v5:['p_organization','p_actor','p_grant_version','p_capability'],zentra_us_financial_commercial_test_receipt_v5:['p_organization','p_actor','p_grant_version','p_capability','p_idempotency_key'],zentra_append_us_financial_commercial_test_v5:['p_organization','p_actor','p_grant_version','p_capability','p_expected_revision','p_previous_fingerprint','p_book','p_receipt'],
};
async function sql<T=Record<string,unknown>>(q:string,v:unknown[]=[],role='service_role'){return db.transaction(async tx=>{await tx.exec(`set local role ${role}`);return(await tx.query<T>(q,v)).rows;});}
async function result<T=unknown>(q:string,v:unknown[]=[]){return(await sql<{result:T}>(q,v))[0].result;}
const client:Pick<SupabaseServerClient,'rpc'>={async rpc<T>(name:string,input:Readonly<Record<string,unknown>>):Promise<T>{
 const keys=parameters[name];if(!keys)throw Error('Unexpected synthetic SQL RPC');
 try{return await result<T>(`select public.${name}(${keys.map((_,i)=>`$${i+1}`).join(',')}) result`,keys.map(k=>input[k]));}
 catch(error){if(process.env.ZENTRA_LOCAL_SQL_DEBUG==='1')console.error((error as Error).message,(error as {where?:string}).where);throw new SupabaseServerError(503,(error as {code:string}).code,'private SQL TEST');}
}};
async function fixture(options:{tax?:string;quantity?:string;scale?:number;discount?:number;unitPrice?:string;lines?:number;paid?:string;closed?:boolean;laterOpen?:boolean;unpromoted?:boolean;activeOrder?:boolean;projects?:boolean;baselinePurchases?:boolean}={}){
 const org=randomUUID(),user=randomUUID(),now=new Date(),day=now.toISOString().slice(0,10),year=now.getUTCFullYear();
 const config:CompanyConfiguration={schemaVersion:1,organizationId:org,country:'US',currency:'USD',language:'en',timeZone:'America/New_York',address:{country:'US',line1:'1 Synthetic Example Street',city:'Brooklyn',postalCode:'11201',subdivision:'NY'},accountingBasis:'accrual',invoiceNumberPrefix:'SYNTHETIC',taxConfiguration:{status:'configured'}};
 let actor:FinancialAuthority={organizationId:org,userId:user,role:'owner',managementEntitled:true,timestamp:now.toISOString()};
 await sql('select public.zentra_admit_new_us_workspace_v1($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6)',[org,randomUUID(),user,randomUUID(),{...config,taxConfiguration:{status:'unconfigured'}},hash(org)]);
 await sql('select public.zentra_put_workspace_country_config($1,$2,1,$3::uuid,$4)',[org,user,randomUUID(),config]);
 const seller={displayName:'Synthetic Seller — local tests only',contactEmail:'synthetic@example.test'};
 await sql('select public.zentra_put_us_seller_profile($1,$2,0,$3::uuid,$4)',[org,user,randomUUID(),seller]);
 const facts:UsTaxFacts={schemaVersion:1,legalName:'SYNTHETIC PRIVATE TEST NAME',timeZone:config.timeZone,taxOrigin:config.address};
 await sql('select public.zentra_put_us_tax_profile($1,$2,0,$3::uuid,$4)',[org,user,randomUUID(),facts]);
 const binding:StripeTaxTestBinding={organizationId:org,accountId:'acct_SyntheticSettlement',mode:'test',apiVersion:'2026-08-26.dahlia',revision:1,settingsSha256:hash('synthetic-settings'),registrationsSha256:hash('synthetic-registrations'),observedAt:new Date(now.getTime()-1000).toISOString(),validUntil:new Date(now.getTime()+3600000).toISOString(),evidenceKind:'test_fixture',scope:'erp_invoice_tax'};
 await sql('select public.zentra_put_us_tax_provider_binding($1,$2,0,$3::uuid,$4)',[org,user,randomUUID(),binding]);
 const erp=createSupabaseErpStore(client,{supportedSchemaVersion:4});let n=0;
 const deps={store:erp,configuration:config,actor,revalidate:async()=>({...actor,timestamp:new Date().toISOString()}),taxProvider:async()=>null,seller:async()=>({organizationId:org,...seller})};
 const send=async(command:ErpCommand)=>executeErp(deps,{idempotencyKey:`synthetic-${++n}`,expectedRevision:(await erp.read(org))?.revision??0,command});
 await send({type:'initialize',periods:[{id:'year',start:`${year}-01-01`,end:`${year}-12-31`,status:'open'}]});
 await send({type:'save_customer',customer:{id:'customer',organizationId:org,kind:'business',name:'Synthetic Customer — no real transaction',billingAddress:config.address,paymentTermsDays:30}});
 if(options.projects){
  await send({type:'save_customer',customer:{id:'other-customer',organizationId:org,kind:'business',name:'Synthetic other customer',billingAddress:config.address,paymentTermsDays:30}});
  await send({type:'save_projects',projects:[['active-project','customer','active'],['archived-project','customer','archived'],['foreign-customer-project','other-customer','active']].map(([id,customerId,status])=>({id,customerId,status:status as 'active'|'archived',expectedProjectRevision:0,name:`Synthetic ${id}`,notes:'Synthetic local project',startDate:null,targetDate:null,budgetMinor:null,vendorBillIds:[]}))});
 }
 const lines=Array.from({length:options.lines??1},(_,i)=>({id:`line-${i}`,description:`Synthetic service ${i}`,quantityUnits:options.quantity??'3',quantityScale:options.scale??0,unitPrice:{currency:'USD' as const,minorUnits:options.unitPrice??'10001'},discountBasisPoints:options.discount??1000,taxTreatment:'taxable' as const}));
 await send({type:'save_estimate',id:'quote',expectedEstimateRevision:0,customerId:'customer',date:day,expiresAt:`${year}-12-31`,paymentTermsDays:30,notes:'Synthetic local-only terms · Genève · 東京 · 🌍',lines});await send({type:'accept_estimate',estimateId:'quote',expectedEstimateRevision:1});
 const before=(await erp.read(org))!,key='synthetic-invoice',operationId=randomUUID(),source=buildTaxRequest(config,before.estimates[0],day),net=estimateTotals(before.estimates[0]).net.minorUnits,lineTax=options.tax??'2475',tax=(BigInt(lineTax)*BigInt(lines.length)).toString();
 const calculatedAt=new Date().toISOString(),expiresAt=new Date(now.getTime()+1800000).toISOString(),calculationId='taxcalc_SyntheticSettlement';
 const assessment:TaxAssessment={organizationId:org,country:'US',currency:'USD',documentId:source.documentId,documentRevision:source.documentRevision,fingerprint:source.fingerprint,source:'external-provider',providerReference:calculationId,determinedAt:calculatedAt,validUntil:expiresAt,lines:lines.map((l,i)=>({id:l.id,taxMinor:lineTax,jurisdiction:'US-NY',evidenceReference:`${calculationId}:tax_li_Synthetic${i}`}))};
 let captured:ErpCommit|undefined;
 await expect(executeErp({...deps,taxProvider:async()=>({id:'synthetic-no-network',calculate:async()=>assessment}),store:{...erp,commit:async input=>{captured=input;throw Error('synthetic_capture_only');}}},{idempotencyKey:key,expectedRevision:before.revision,command:{type:'issue_invoice',id:'invoice',estimateId:'quote',expectedEstimateRevision:2,date:day,accountingDate:day,dueDate:day,periodId:'year'}})).rejects.toThrow('synthetic_capture_only');
 if(!captured)throw Error('Missing synthetic invoice candidate');const commit=captured;
 const resolved=await prepareStripeTaxResolvedRequest({organizationId:org,operationId,invoiceId:'invoice',actorUserId:user,erpIdempotencyKey:key,commandHash:commit.receipt.commandHash,expectedErpRevision:before.revision,countryRevision:2,sellerRevision:1,taxFactsRevision:1,configuration:config,estimate:before.estimates[0],taxFacts:facts,binding,classifications:lines.map(l=>({lineId:l.id,taxCode:'txcd_10000000',kind:'service' as const,taxBehavior:'exclusive' as const,revision:1,evidenceReference:'Synthetic classification, no live provider'})),invoiceDate:day,taxDateInstant:`${day}T12:00:00Z`,taxDatePolicy:'caller_supplied_invoice_instant',now:new Date().toISOString(),addressSource:'billing'});
 const proof:StripeTaxPrivateProof={schemaVersion:1,organizationId:org,operationId,provider:'stripe_tax',accountId:binding.accountId,mode:'test',apiVersion:binding.apiVersion,bindingRevision:1,resolvedSha256:resolved.resolvedSha256,paramsSha256:resolved.paramsSha256,settingsSha256:binding.settingsSha256,registrationsSha256:binding.registrationsSha256,evidenceKind:'test_fixture',calculationId,calculatedAt,expiresAt,taxDate:resolved.params.tax_date,currency:'USD',netMinor:net,taxMinor:tax,totalMinor:(BigInt(net)+BigInt(tax)).toString(),lines:lines.map((l,i)=>({lineId:l.id,providerLineId:`tax_li_Synthetic${i}`,netMinor:resolved.params.line_items[i].amount.toString(),quantity:resolved.params.line_items[i].quantity.toString(),taxCode:'txcd_10000000',taxMinor:lineTax,breakdowns:[{amountMinor:lineTax,taxableMinor:resolved.params.line_items[i].amount.toString(),taxabilityReason:'standard_rated' as const,sourcing:'destination' as const,jurisdiction:{country:'US' as const,state:'NY',level:'state',displayName:'Synthetic TEST jurisdiction'}}]}))};
 await sql('select public.zentra_reserve_us_tax_operation($1,$2,$3::uuid,$4,$5,$6,$7,$8)',[org,actor,operationId,resolved.resolvedBody,resolved.resolvedSha256,resolved.paramsBody,resolved.paramsSha256,resolved.idempotencyKey]);
 await sql('select public.zentra_record_us_tax_calculation($1,$2::uuid,$3,$4,$5,$6)',[org,operationId,actor,canonicalErpJson(proof),hash(canonicalErpJson(proof)),assessment]);
 await sql('select public.zentra_commit_us_tax_invoice_test_v2($1,$2::uuid,$3,$4,$5,$6,$7,$8,4)',[org,operationId,commit.expectedRevision,commit.header,commit.changes,commit.ledgerAudit,commit.receipt,commit.actor]);
 if(options.paid)await send({type:'record_payment',id:'baseline-payment',invoiceId:'invoice',amountMinor:options.paid,paymentDate:day,accountingDate:day,periodId:'year',reference:'Synthetic baseline payment, no money moved'});
 if(options.baselinePurchases){
  const supplier={...(await erp.read(org))!.customers[0],id:'vendor',name:'Synthetic historical supplier'};await send({type:'save_vendor',vendor:supplier});await send({type:'save_vendor',vendor:supplier});
  await send({type:'record_vendor_bill',id:'bill',vendorId:'vendor',reference:'Synthetic historical bill',date:day,accountingDate:day,dueDate:day,periodId:'year',netMinor:'100',purchaseTaxMinor:'7',expenseAccountId:'purchases',sourceReference:'Synthetic historical declared original'});
  await send({type:'record_vendor_payment',id:'baseline-vendor-payment',billId:'bill',amountMinor:'50',paymentDate:day,accountingDate:day,periodId:'year',reference:'Synthetic historical payment'});
 }
 if(options.closed)await send({type:'close_period',periodId:'year'});
 if(options.laterOpen)await send({type:'open_period',id:'next',start:`${year+1}-01-01`,end:`${year+1}-12-31`});
 if(options.activeOrder){
  await send({type:'save_estimate',id:'ordered-quote',expectedEstimateRevision:0,customerId:'customer',date:day,expiresAt:day,paymentTermsDays:30,lines,notes:'Synthetic locked order source'});await send({type:'accept_estimate',estimateId:'ordered-quote',expectedEstimateRevision:1});
  const request={schemaVersion:1,idempotencyKey:'synthetic-sales-order',orderId:randomUUID(),expectedErpRevision:(await erp.read(org))!.revision,expectedHeadRevision:0,expectedOrderRevision:null,command:{type:'create_from_estimate',estimateId:'ordered-quote',expectedEstimateRevision:2,orderDate:day,customerReference:null}};
  await sql('select public.zentra_execute_us_sales_order($1,$2,4,$3,$4)',[org,{...actor,timestamp:new Date().toISOString()},request,hash(canonicalErpJson([org,user,request]))]);
 }
 const baseline=(await erp.read(org))!;actor={...actor,timestamp:new Date().toISOString()};
 const policy:UsFinancialPolicyV5={version:'us-accrual-receivable-credit-v1',environment:'test',approval:{reference:'SYNTHETIC-LOCAL-TEST-ONLY',reviewedBy:'synthetic-reviewer',reviewedAt:new Date(now.getTime()-2000).toISOString()}};
 await db.query('insert into public.zentra_us_financial_test_grants values($1,$2,$3,1,true,$4)',[org,user,'owner',policy]);
 const scope={organizationId:org,actor,policy,grantVersion:1},foundation=createSupabaseUsFinancialTestFoundationV5(client,scope,async()=>scope),initial=await promoteUsFinancialBookV5(baseline,policy,actor);
 if(!options.unpromoted)await foundation.promote({book:initial,idempotencyKey:'synthetic-promotion'});
 const settlement=createSupabaseUsFinancialSettlementTestStoreV5(client,scope,async()=>scope),commercialStore=createSupabaseUsFinancialCommercialTestStoreV5(client,scope,async()=>scope),store=createSupabaseUsFinancialPurchasingTestStoreV5(client,scope,async()=>scope);
 const read=()=>result<UsFinancialBookV5>('select public.zentra_read_us_financial_purchasing_test_v5($1,$2,1,$3) result',[org,actor,capability]);
 const payment=(amountMinor='100'):UsFinancialOperationV5=>({type:'customer_payment',idempotencyKey:randomUUID(),invoiceId:'invoice',amountMinor,paymentDate:day,accountingDate:day,periodId:'year',reference:'Synthetic payment · référence "quoted"'});
 const authorize=async(book:UsFinancialBookV5,input:UsFinancialCreditInputV5,persist=true):Promise<Extract<UsFinancialOperationV5,{type:'customer_credit'}>>=>{
  const c=await buildUsFinancialCreditCandidateV5(book,input),common={schemaVersion:1 as const,environment:'test' as const,invoiceFingerprint:c.invoiceFingerprint,allocationSha256:c.allocationSha256,reference:'Synthetic authorization, no tax reversal executed',verifiedBy:'synthetic-test-reviewer',verifiedAt:actor.timestamp};
  const taxProof:UsFinancialTaxProofV5=c.allocation.taxMinor==='0'?{...common,kind:'historical_zero_tax'}:{...common,kind:'test_adjustment_authorization',providerAccountReference:'acct_SyntheticSettlement',originalTaxTransactionReference:'testtxn_SyntheticInvoice',adjustmentPlanReference:`synthetic-plan-${input.idempotencyKey}`,authorizedTaxMinor:c.allocation.taxMinor};
  if(persist)await db.query('insert into public.zentra_us_financial_test_tax_plans values($1,$2,$3,$4)',[org,input.idempotencyKey,input.invoiceId,taxProof]);
  return{...input,taxProof};
 };
 const credit=(book:UsFinancialBookV5,quantities:readonly string[]=['1'],persist=true)=>authorize(book,{type:'customer_credit',idempotencyKey:randomUUID(),invoiceId:'invoice',transactionDate:day,accountingDate:day,periodId:'year',reason:'Synthetic customer credit — local tests only',selections:quantities.map((quantityUnits,i)=>({lineId:`line-${i}`,quantityUnits}))},persist);
 const prepare=async(op:UsFinancialOperationV5,id:string=randomUUID(),beforeBook?:UsFinancialBookV5):Promise<UsFinancialCommitV5>=>{
  const before=beforeBook??await read(),after=await applyUsFinancialOperationV5(before,op,actor,id),{idempotencyKey,...rest}=op;
  const command=rest.type==='erp_command'?{type:'erp_command',request:rest.command}:rest.type==='customer_credit'?(()=>{const{taxProof:_proof,...fields}=rest;return{...fields,id};})():{...rest,id};
  const receipt:UsFinancialReceiptV5={idempotencyKey,commandHash:hash(canonicalErpJson([org,user,{idempotencyKey,expectedRevision:before.revision,command}])),revision:after.book.revision,entityId:id,action:op.type,actorId:user};
  return{organizationId:org,expectedRevision:before.revision,previousFingerprint:hash(canonicalErpJson(before)),book:after.book,receipt,actor};
 };
 const append=(c:UsFinancialCommitV5,version=1)=>result<UsFinancialReceiptV5>('select public.zentra_append_us_financial_purchasing_test_v5($1,$2,$3,$4,$5,$6,$7,$8) result',[org,c.actor,version,capability,c.expectedRevision,c.previousFingerprint,c.book,c.receipt]);
 return{org,user,config,actor,day,policy,scope,baseline,initial,foundation,settlement,commercialStore,store,read,payment,credit,authorize,prepare,append};
}
