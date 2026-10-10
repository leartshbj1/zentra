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

// Actual private SQL guards and real ERP4 issuance chain on retained local
// NodeFS. Every account, invoice, approval and tax observation is synthetic.
// No external provider/network operation. Serialized PGlite is not proof of
// multi-connection concurrency, D1 atomicity, crash recovery or production SLA.
const directory=process.env.PGLITE_MODULE_DIR,enabled=Boolean(directory&&isAbsolute(directory));
type Sql={exec(sql:string):Promise<unknown>;query<T=Record<string,unknown>>(sql:string,values?:unknown[]):Promise<{rows:T[]}>};
type Db=Sql&{close():Promise<void>;transaction<T>(task:(tx:Sql)=>Promise<T>):Promise<T>};
let db:Db,PGlite:new(dataDir?:string)=>Db,dataDir:string;
const capability='postgres-test-commercial-v5',migration='20261010085523_international_us_financial_test_commercial_v5';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');

type Fixture=Awaited<ReturnType<typeof fixture>>;
let previousFixture:Fixture,previousCommit:UsFinancialCommitV5;
const commercial=(command:ErpCommand,key:string=randomUUID()):UsFinancialOperationV5=>({type:'erp_command',idempotencyKey:key,command:command as Extract<UsFinancialOperationV5,{type:'erp_command'}>['command'],facts:{kind:'none'}});
function quote(f:Fixture,id='new-quote',expectedEstimateRevision=0):ErpCommand{return{type:'save_estimate',id,expectedEstimateRevision,customerId:'customer',date:f.day,expiresAt:f.day,paymentTermsDays:30,lines:[{...f.baseline.estimates[0].lines[0],description:'Synthetic service\nSecond line — 東京 🌍'}],notes:'Synthetic notes\nSecond paragraph\tConditions — Genève 🌍'};}
function erpEvent(c:UsFinancialCommitV5){const e=c.book.events.at(-1)!;if(!('commit' in e))throw Error('ERP event required');return e;}

describe.skipIf(!enabled)('independent private US financial TEST commercial continuity',()=>{
 beforeAll(async()=>{
  const require=createRequire(import.meta.url);({PGlite}=require(join(directory!,'dist/index.cjs')) as {PGlite:new(dataDir?:string)=>Db});dataDir=await mkdtemp(join(tmpdir(),'zentra-commercial-test-v5-'));db=new PGlite(dataDir);
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);grant usage on schema public to service_role;');
  for(const name of migrations)await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`,import.meta.url),'utf8'));
  previousFixture=await fixture();previousCommit=await previousFixture.prepare(await previousFixture.credit(previousFixture.initial),'previous-credit',previousFixture.initial);await previousFixture.settlement.commit(previousCommit);
  await db.exec(await readFile(new URL(`../../supabase/migrations/${migration}.sql`,import.meta.url),'utf8'));
 },30000);
 afterAll(async()=>{await db?.close();});
 it('validates and preserves an existing settlement tail during additive installation',async()=>{
  expect(await previousFixture.read()).toEqual(previousCommit.book);expect(await previousFixture.settlement.read(previousFixture.org)).toEqual(previousCommit.book);expect(await previousFixture.store.commit(previousCommit)).toEqual(previousCommit.receipt);
 });
 it('keeps credit, repeated customer edits, quote acceptance and payment in one exact durable book',async()=>{
  const f=await fixture(),credit=await f.prepare(await f.credit(f.initial),'synthetic-credit');await f.store.commit(credit);
  for(const name of ['Synthetic Customer updated once','Synthetic Customer updated twice']){const c=await f.prepare(commercial({type:'save_customer',customer:{...f.baseline.customers[0],name}}),'customer');await f.store.commit(c);expect(erpEvent(c).effects).toEqual({postings:[],audit:[]});expect(erpEvent(c).commit.header.ledger.revision).toBe(f.baseline.ledger.revision);}
  const saved=await f.prepare(commercial(quote(f)),'new-quote');await f.store.commit(saved);expect(erpEvent(saved).commit.receipt.commandHash).not.toBe(saved.receipt.commandHash);
  const accepted=await f.prepare(commercial({type:'accept_estimate',estimateId:'new-quote',expectedEstimateRevision:1}),'new-quote');await f.store.commit(accepted);
  const paid=await f.prepare(f.payment('100'),'synthetic-payment');await f.store.commit(paid);const view=await projectUsFinancialBookV5(await f.read());
  expect(view.revision).toBe(f.initial.revision+6);expect(view.ledger.revision).toBe(f.baseline.ledger.revision+2);expect(view.ledger.audit).toHaveLength(f.baseline.ledger.audit.length+2);expect(view.estimates.at(-1)).toMatchObject({id:'new-quote',revision:2,status:'accepted',customer:{name:'Synthetic Customer updated twice'}});
  expect(view.settlements[0]).toMatchObject({receivedMinor:'100',creditedMinor:'9826',outstandingMinor:'19552'});expect(view.invoices[0].customer.name).toBe(f.baseline.invoices[0].customer.name);expect(await f.store.commit(saved)).toEqual(saved.receipt);expect(await f.store.receipt(f.org,saved.receipt.idempotencyKey)).toEqual(saved.receipt);
  const later=await f.prepare(commercial(quote(f,'after-payment')),'after-payment');expect(erpEvent(later).commit.header.ledger.revision).toBe(f.baseline.ledger.revision+1);await f.store.commit(later);const nextCredit=await f.prepare(await f.credit(await f.read()),'next-credit');await f.store.commit(nextCredit);const nextView=await projectUsFinancialBookV5(await f.read());expect(nextView.ledger.revision).toBe(f.baseline.ledger.revision+3);expect(nextView.settlements[0]).toMatchObject({receivedMinor:'100',creditedMinor:'19652',outstandingMinor:'9726'});
 });
 it('records a genuine no-op customer operation with empty changes and preserves existing registry ordering',async()=>{
  const f=await fixture(),noop=await f.prepare(commercial({type:'save_customer',customer:f.baseline.customers[0]}),'customer');expect(erpEvent(noop).commit.changes).toEqual([]);await f.store.commit(noop);
  await f.store.commit(await f.prepare(commercial({type:'save_customer',customer:{...f.baseline.customers[0],id:'second',name:'Synthetic second customer'}}),'second'));
  const edit=await f.prepare(commercial({type:'save_customer',customer:{...f.baseline.customers[0],name:'Synthetic original updated'}}),'customer');await f.store.commit(edit);expect((await projectUsFinancialBookV5(await f.read())).customers.map(c=>c.id)).toEqual(['customer','second']);
 });
 it('preserves numbers, counters and source snapshots across edits and repeated acceptances',async()=>{
  const f=await fixture();await f.append(await f.prepare(commercial(quote(f)),'new-quote'));
  await f.append(await f.prepare(commercial({type:'accept_estimate',estimateId:'new-quote',expectedEstimateRevision:1}),'new-quote'));
  await f.append(await f.prepare(commercial(quote(f,'new-quote',2)),'new-quote'));
  for(const revision of [3,4])await f.append(await f.prepare(commercial({type:'accept_estimate',estimateId:'new-quote',expectedEstimateRevision:revision}),'new-quote'));
  const view=await projectUsFinancialBookV5(await f.read());expect(view.counters.estimate).toBe(2);expect(view.estimates.at(-1)).toMatchObject({number:'EST-000002',revision:5,status:'accepted'});expect(view.ledger).toEqual(f.baseline.ledger);
 });
 it('permits matching entity ids across registries and repeated commercial event ids but reserves them for new financial entities',async()=>{
  const f=await fixture();await f.append(await f.prepare(commercial(quote(f,'customer')),'customer'));const b=await f.read();
  await expect(result('select public.zentra_us_commercial_transition($1,$2,$3,$4) result',[b,f.payment(),f.actor,'customer'])).rejects.toMatchObject({code:'PF002'});
  const same=await f.prepare(commercial({type:'save_customer',customer:{...f.baseline.customers[0],name:'Synthetic renamed'}}),'customer');await f.append(same);expect((await projectUsFinancialBookV5(await f.read())).estimates.at(-1)?.id).toBe('customer');
 });
 it.each(['header','counter','customer','inner_receipt','outer_receipt','effects','scope','unknown_field'])('refuses forged commercial %s atomically',async kind=>{
  const f=await fixture(),good=await f.prepare(commercial(quote(f)),'new-quote'),bad=copy(good) as Mutable<UsFinancialCommitV5>,e=bad.book.events.at(-1)!;if(!('commit' in e))throw Error('ERP event required');
  if(kind==='header')e.commit.header.ledger.revision++;
  if(kind==='counter')e.commit.header.counters.estimate++;
  if(kind==='customer')(e.commit.changes[0].payload as {customer:{name:string}}).customer.name='Wrong snapshot';
  if(kind==='inner_receipt')e.commit.receipt.commandHash=bad.receipt.commandHash;
  if(kind==='outer_receipt')bad.receipt.commandHash=e.commit.receipt.commandHash;
  if(kind==='effects')(e.effects as unknown as {postings:unknown[]}).postings=[f.baseline.ledger.entries[0]];
  if(kind==='scope')e.commit.organizationId=randomUUID();
  if(kind==='unknown_field')(e.commit.changes[0].payload as Record<string,unknown>).privateSecret='forbidden';
  await expect(f.append(bad)).rejects.toMatchObject({code:'PF004'});expect(await f.read()).toEqual(f.initial);expect(await sql('select * from public.zentra_us_financial_test_events where organization_id=$1',[f.org])).toEqual([]);
 });
 it('rejects stale book and estimate revisions, issued sources and reused old keys',async()=>{
  const f=await fixture(),first=await f.prepare(commercial(quote(f)),'new-quote'),stale=await f.prepare(commercial(quote(f,'other-quote')),'other-quote');await f.append(first);await expect(f.append(stale)).rejects.toMatchObject({code:'PF001'});
  const bad={...commercial(quote(f,'new-quote',1)),command:quote(f,'new-quote',0)};await expect(result('select public.zentra_us_commercial_transition($1,$2,$3,$4) result',[await f.read(),bad,f.actor,'new-quote'])).rejects.toMatchObject({code:'PF001'});
  for(const command of [quote(f,'quote',2),{type:'accept_estimate' as const,estimateId:'quote',expectedEstimateRevision:2}])await expect(result('select public.zentra_us_commercial_transition($1,$2,$3,$4) result',[await f.read(),commercial(command),f.actor,'quote'])).rejects.toMatchObject({code:'PF003'});
  const reserved=await f.prepare(commercial({type:'save_customer',customer:f.baseline.customers[0]},'synthetic-promotion'),'customer');await expect(f.append(reserved)).rejects.toMatchObject({code:'PF002'});expect(await f.store.commit(first)).toEqual(first.receipt);
 });
 it('rejects invalid line types, duplicates, hidden fields and limits without trusting candidate commits',async()=>{
  const f=await fixture(),op=copy(commercial(quote(f))) as unknown as {command:{lines:Record<string,unknown>[]}};
  for(const mutate of [(x:typeof op)=>{x.command.lines[0].description=1;},(x:typeof op)=>{x.command.lines.push(x.command.lines[0]);},(x:typeof op)=>{x.command.lines[0].extra='bad';},(x:typeof op)=>{x.command.lines[0].description='🌍'.repeat(2001);},(x:typeof op)=>{x.command.lines[0].id='   ';},(x:typeof op)=>{x.command.lines[0].description='\u00a0\ufeff';}]){const bad=copy(op);mutate(bad);await expect(result('select public.zentra_us_commercial_transition($1,$2,$3,$4) result',[f.initial,bad,f.actor,'new-quote'])).rejects.toMatchObject({code:'PF004'});}
  await expect(result('select public.zentra_us_commercial_transition($1,$2,$3,$4) result',[f.initial,commercial({type:'save_customer',customer:{...f.baseline.customers[0],id:' c '}}),f.actor,' c '])).rejects.toMatchObject({code:'PF004'});
  expect(await f.read()).toEqual(f.initial);
 });
 it('uses frozen active orders only for new mutation admission, never for historical reconstruction',async()=>{
  const f=await fixture({activeOrder:true}),c=await f.prepare(commercial(quote(f,'ordered-quote',2)),'ordered-quote');
  await expect(f.append(c)).rejects.toMatchObject({code:'PO008'});await expect(sql('insert into public.zentra_us_financial_test_events values($1,$2,$3,1)',[f.org,c.book.revision,c.book.events.at(-1)])).rejects.toMatchObject({code:'PO008'});
  // Pure replay verifies historical math/commits only, and does not consult
  // a LIVE source admission. This candidate cannot pass the insert guard.
  expect(await result('select public.zentra_us_commercial_replay($1) result',[c.book])).toEqual(c.book);
  const other=await f.prepare(commercial(quote(f)),'new-quote');await f.append(other);expect(await f.read()).toEqual(other.book);
  await expect(sql('update public.zentra_us_sales_orders set state=state where organization_id=$1',[f.org])).rejects.toMatchObject({code:'PF008'});
 });
 it('admits only baseline projects that remain active and belong to the selected customer',async()=>{
  const f=await fixture({projects:true}),base=quote(f);if(base.type!=='save_estimate')throw Error('Synthetic quote required');
  for(const projectId of ['missing-project','archived-project','foreign-customer-project'])await expect(result('select public.zentra_us_commercial_transition($1,$2,$3,$4) result',[f.initial,commercial({...base,projectId}),f.actor,'new-quote'])).rejects.toMatchObject({code:'PF004'});
  const good=await f.prepare(commercial({...base,projectId:'active-project'}),'new-quote');await f.store.commit(good);expect((await projectUsFinancialBookV5(await f.read())).estimates.at(-1)?.projectId).toBe('active-project');expect((await f.read()).baseline.projects).toEqual(f.baseline.projects);
 });
 it('does not consult LIVE source admission on read, receipt or exact historical retry',async()=>{
  const f=await fixture(),saved=await f.prepare(commercial(quote(f)),'new-quote');await f.append(saved);
  const original=(await db.query<{definition:string}>("select pg_get_functiondef('public.zentra_us_commercial_source(text,jsonb)'::regprocedure) definition")).rows[0].definition;
  try{
   await db.exec("create or replace function public.zentra_us_commercial_source(org text,op jsonb) returns void language plpgsql volatile security invoker set search_path='' as $$ begin raise exception using errcode='PO008',message='Synthetic new-operation admission denied';end $$;");
   expect(await f.store.read(f.org)).toEqual(saved.book);expect(await f.store.receipt(f.org,saved.receipt.idempotencyKey)).toEqual(saved.receipt);expect(await f.store.commit(saved)).toEqual(saved.receipt);
   const changed=await f.prepare(commercial(quote(f,'new-quote',1)),'new-quote');await expect(f.append(changed)).rejects.toMatchObject({code:'PO008'});expect(await f.read()).toEqual(saved.book);
  }finally{await db.exec(original);}
 });
 it('rolls back direct events missing receipt or cursor and refuses service self-provisioning',async()=>{
  const f=await fixture(),c=await f.prepare(commercial(quote(f)),'new-quote');await expect(sql('insert into public.zentra_us_financial_test_events values($1,$2,$3,1)',[f.org,c.book.revision,c.book.events.at(-1)])).rejects.toMatchObject({code:'PF004'});
  await expect(sql('update public.zentra_us_financial_test_grants set version=version+1 where organization_id=$1',[f.org])).rejects.toMatchObject({code:'PF003'});
  expect(await f.read()).toEqual(f.initial);await f.append(c);
 });
 it('requires a living matching private grant on reads and historical retries',async()=>{
  const f=await fixture(),c=await f.prepare(commercial(quote(f)),'new-quote');await f.append(c);await db.query('update public.zentra_us_financial_test_grants set version=2,enabled=false where organization_id=$1',[f.org]);
  await expect(f.read()).rejects.toMatchObject({code:'PF005'});await expect(f.append(c)).rejects.toMatchObject({code:'PF005'});await db.query('update public.zentra_us_financial_test_grants set version=3,enabled=true where organization_id=$1',[f.org]);await expect(f.append(c)).rejects.toMatchObject({code:'PF006'});expect(await f.append(c,3)).toEqual(c.receipt);
 });
 it('closes old settlement ports before replay and keeps unsupported ERP commands closed',async()=>{
  const f=await fixture(),c=await f.prepare(commercial(quote(f)),'new-quote');await f.append(c);
  await expect(f.settlement.read(f.org)).rejects.toMatchObject({code:'financial_upgrade_required'});await expect(f.settlement.receipt(f.org,c.receipt.idempotencyKey)).rejects.toMatchObject({code:'financial_upgrade_required'});
  await expect(result('select public.zentra_append_us_financial_settlement_test_v5($1,$2,1,$3,$4,$5,$6,$7) result',[f.org,c.actor,'postgres-test-settlement-v5',c.expectedRevision,c.previousFingerprint,c.book,c.receipt])).rejects.toMatchObject({code:'PF008'});
  for(const command of [{type:'save_vendor',vendor:f.baseline.customers[0]},{type:'close_period',periodId:'year'},{type:'refresh_configuration'}])await expect(result('select public.zentra_us_commercial_transition($1,$2,$3,$4) result',[await f.read(),{type:'erp_command',idempotencyKey:randomUUID(),command,facts:{kind:'none'}},f.actor,'unsupported'])).rejects.toMatchObject({code:'PF010'});
 });
 it('preserves private invoker/RLS gates and rejects foreign scopes, malformed actors and future audit clocks',async()=>{
  const f=await fixture();for(const role of ['anon','authenticated'])for(const q of ['select public.zentra_read_us_financial_commercial_test_v5(null,null,null,null)','select * from public.zentra_us_financial_test_events'])await expect(sql(q,[],role)).rejects.toMatchObject({code:'42501'});
  for(const actor of [{...f.actor,organizationId:randomUUID()},{...f.actor,role:'member'},{...f.actor,role:null},{...f.actor,extra:'forbidden'}])await expect(result('select public.zentra_read_us_financial_commercial_test_v5($1,$2,1,$3) result',[f.org,actor,capability])).rejects.toMatchObject({code:'PF005'});
  await expect(result('select public.zentra_read_us_financial_commercial_test_v5($1,$2,1,$3) result',[f.org,{...f.actor,timestamp:new Date(Date.now()+86400000).toISOString()},capability])).rejects.toMatchObject({code:'PF016'});
  const grants=await sql<{private:boolean}>('select bool_and(not prosecdef and not has_function_privilege(\'anon\',p.oid,\'execute\') and not has_function_privilege(\'authenticated\',p.oid,\'execute\')) private from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=\'public\' and p.proname like \'zentra%financial_commercial%\'');expect(grants[0].private).toBe(true);
 });
 it('accepts commercial actor ids beyond the financial posting limit and preserves notes/newlines exactly',async()=>{
  const f=await fixture(),actor={...f.actor,userId:'synthetic-'+ 'a'.repeat(191)},op=commercial(quote(f)),resultTs=await applyUsFinancialOperationV5(f.initial,op,actor,'new-quote');
  const event=await result('select public.zentra_us_commercial_transition($1,$2,$3,$4) result',[f.initial,op,actor,'new-quote']);expect(event).toEqual(resultTs.book.events.at(-1));
 });
 it('retains the single mixed book, source snapshots, receipts and exact retries after clean NodeFS reopen',async()=>{
  const f=await fixture(),credit=await f.prepare(await f.credit(f.initial),'credit');await f.append(credit);const saved=await f.prepare(commercial(quote(f)),'new-quote');await f.append(saved);const paid=await f.prepare(f.payment('100'),'payment');await f.append(paid);
  await db.close();db=new PGlite(dataDir);expect(await f.read()).toEqual(paid.book);expect(await f.store.commit(saved)).toEqual(saved.receipt);expect(await f.store.receipt(f.org,credit.receipt.idempotencyKey)).toEqual(credit.receipt);expect((await projectUsFinancialBookV5(await f.read())).ledger.revision).toBe(f.baseline.ledger.revision+2);
 },30000);
});
function copy<T>(value:T):T{return JSON.parse(JSON.stringify(value)) as T;}
type Mutable<T>=T extends object?{-readonly[K in keyof T]:Mutable<T[K]>}:T;
const migrations=[
 '202609140100_company_profiles','202609140200_company_collaboration','202609200300_company_content',
 '20261007194528_international_workspace_country_config','20261007222349_international_us_erp_persistence','20261007224820_international_us_erp_delta_stream','20261007225725_international_us_erp_seller_snapshot','20261008001726_new_us_workspace_admission','20261008013200_international_tax_proof_allowlist',
 '20261008034422_international_us_seller_profile','20261008044402_international_us_tax_profile','20261008060826_international_us_tax_operations','20261008081825_international_us_purchasing_v2','20261008105120_international_us_projects_v3','20261008161118_international_us_journal_periods_v4','20261008172520_international_us_tax_invoice_capability_v2',
 '20261008184605_international_us_bank_reconciliation','20261008194930_international_us_supplier_proposals','20261008210008_international_us_automation_analysis','20261009215104_international_us_workspace_sync_heads','20261009222319_international_us_tax_test_merchant','20261009224607_international_us_tax_invoice_preparation','20261010005300_international_us_supplier_originals','20261010024618_international_us_supplier_original_hash_lookup','20261010054644_international_us_sales_orders','20261010075840_international_us_financial_test_foundation_v5','20261010083027_international_us_financial_test_settlement_v5',
];
const parameters:Record<string,readonly string[]>={
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
async function fixture(options:{tax?:string;quantity?:string;scale?:number;discount?:number;unitPrice?:string;lines?:number;paid?:string;closed?:boolean;unpromoted?:boolean;activeOrder?:boolean;projects?:boolean}={}){
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
 if(options.closed)await send({type:'close_period',periodId:'year'});
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
 const settlement=createSupabaseUsFinancialSettlementTestStoreV5(client,scope,async()=>scope),store=createSupabaseUsFinancialCommercialTestStoreV5(client,scope,async()=>scope);
 const read=()=>result<UsFinancialBookV5>('select public.zentra_read_us_financial_commercial_test_v5($1,$2,1,$3) result',[org,actor,capability]);
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
 const append=(c:UsFinancialCommitV5,version=1)=>result<UsFinancialReceiptV5>('select public.zentra_append_us_financial_commercial_test_v5($1,$2,$3,$4,$5,$6,$7,$8) result',[org,c.actor,version,capability,c.expectedRevision,c.previousFingerprint,c.book,c.receipt]);
 return{org,user,config,actor,day,policy,scope,baseline,initial,foundation,settlement,store,read,payment,credit,authorize,prepare,append};
}
