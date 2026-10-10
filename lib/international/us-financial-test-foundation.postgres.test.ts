import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import type { FinancialAuthority } from './accounting/ledger';
import { canonicalErpJson } from './erp-contract';
import { executeErp } from './runtime';
import { createSupabaseErpStore } from './runtime-store';
import type { ErpCommand } from './runtime-types';
import type { CompanyConfiguration } from './types';
import { promoteUsFinancialBookV5 } from './us-financial-kernel';
import type { UsFinancialBookV5, UsFinancialPolicyV5 } from './us-financial-kernel-types';
import { createSupabaseUsFinancialTestFoundationV5 } from './us-financial-test-foundation';

// Real additive PostgreSQL chain on a fresh retained local NodeFS directory,
// synthetic entities only. PGlite serializes transactions: this proves SQL
// invariants and clean close/reopen, not multi-connection or crash recovery,
// hosted/D1/provider revocation, installation, persistence SLA or throughput.
const directory=process.env.PGLITE_MODULE_DIR,enabled=Boolean(directory&&isAbsolute(directory));
type Sql={exec(sql:string):Promise<unknown>;query<T=Record<string,unknown>>(sql:string,values?:unknown[]):Promise<{rows:T[]}>};
type Db=Sql&{close():Promise<void>;transaction<T>(task:(sql:Sql)=>Promise<T>):Promise<T>};let db:Db;
let PGlite:new(dataDir?:string)=>Db,dataDir:string;
const capability='postgres-test-foundation-v5';
const migration='20261010075840_international_us_financial_test_foundation_v5';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const migrations=[
 '202609140100_company_profiles','202609140200_company_collaboration','202609200300_company_content',
 '20261007194528_international_workspace_country_config','20261007222349_international_us_erp_persistence','20261007224820_international_us_erp_delta_stream',
 '20261007225725_international_us_erp_seller_snapshot','20261008001726_new_us_workspace_admission','20261008013200_international_tax_proof_allowlist',
 '20261008034422_international_us_seller_profile','20261008044402_international_us_tax_profile','20261008060826_international_us_tax_operations',
 '20261008081825_international_us_purchasing_v2','20261008105120_international_us_projects_v3','20261008161118_international_us_journal_periods_v4',
 '20261008172520_international_us_tax_invoice_capability_v2','20261008184605_international_us_bank_reconciliation','20261008194930_international_us_supplier_proposals',
 '20261008210008_international_us_automation_analysis','20261009215104_international_us_workspace_sync_heads','20261009222319_international_us_tax_test_merchant',
 '20261009224607_international_us_tax_invoice_preparation','20261010005300_international_us_supplier_originals','20261010024618_international_us_supplier_original_hash_lookup',
 '20261010054644_international_us_sales_orders',
];
const core=['zentra_us_erp_heads','zentra_us_erp_records','zentra_us_erp_receipts','zentra_us_erp_ledger_audit','zentra_us_erp_streams','zentra_us_erp_events','zentra_us_erp_wakeups'];
const parameters:Record<string,readonly string[]>={
 zentra_read_us_erp_v4:['p_organization'],zentra_us_erp_receipt_v4:['p_organization','p_idempotency_key'],
 zentra_commit_us_erp:['p_organization','p_expected_revision','p_header','p_changes','p_ledger_audit','p_receipt','p_actor'],
 zentra_read_us_financial_test_v5:['p_organization','p_actor','p_grant_version','p_capability'],
 zentra_us_financial_test_receipt_v5:['p_organization','p_actor','p_grant_version','p_capability','p_idempotency_key'],
 zentra_promote_us_financial_test_v5:['p_organization','p_actor','p_grant_version','p_capability','p_book','p_idempotency_key','p_command_hash'],
};
async function sql<T=Record<string,unknown>>(query:string,values:unknown[]=[],role='service_role'){return db.transaction(async tx=>{await tx.exec(`set local role ${role}`);return(await tx.query<T>(query,values)).rows;});}
async function result<T=unknown>(query:string,values:unknown[]=[]){return(await sql<{result:T}>(query,values))[0].result;}
const client:Pick<SupabaseServerClient,'rpc'>={async rpc<T>(name:string,input:Readonly<Record<string,unknown>>):Promise<T>{
 const keys=parameters[name];if(!keys)throw Error('Unexpected synthetic SQL RPC');
 try{return await result<T>(`select public.${name}(${keys.map((_,i)=>`$${i+1}`).join(',')}) result`,keys.map(k=>input[k]));}
 catch(error){throw new SupabaseServerError(503,(error as {code:string}).code,'private SQL TEST');}
}};
async function fixture(basis:'cash'|'accrual'='accrual'){
 const org=randomUUID(),user=randomUUID(),actor:FinancialAuthority={organizationId:org,userId:user,role:'owner',managementEntitled:true,timestamp:'2026-10-10T12:00:00.000Z'};
 const config:CompanyConfiguration={schemaVersion:1,organizationId:org,country:'US',currency:'USD',language:'en',timeZone:'America/New_York',address:{country:'US',line1:'1 Synthetic Example Street',city:'Brooklyn',postalCode:'11201',subdivision:'NY'},accountingBasis:basis,invoiceNumberPrefix:'SYNTHETIC',taxConfiguration:{status:'unconfigured'},ein:'12-3456789'};
 await sql('select public.zentra_admit_new_us_workspace_v1($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::jsonb,$6)',[org,randomUUID(),user,randomUUID(),config,hash(org)]);
 const erp=createSupabaseErpStore(client,{supportedSchemaVersion:4});let sequence=0;
 const send=async(command:ErpCommand,key=`synthetic-${++sequence}`)=>executeErp({store:erp,configuration:config,actor,revalidate:async()=>actor,taxProvider:async()=>null},{idempotencyKey:key,expectedRevision:(await erp.read(org))?.revision??0,command});
 await send({type:'initialize',periods:[{id:'2026',start:'2026-01-01',end:'2026-12-31',status:'open'}]});
 await send({type:'save_customer',customer:{id:'customer',organizationId:org,kind:'business',name:'Synthetic Customer — no real transaction',billingAddress:config.address,paymentTermsDays:30}},'L'.repeat(232));
 await send({type:'save_estimate',id:'quote',expectedEstimateRevision:0,customerId:'customer',date:'2026-10-10',expiresAt:'2026-11-10',paymentTermsDays:30,notes:'Synthetic terms\nUnicode: Genève · 東京 · 🌍',lines:[{id:'line',description:'Synthetic local-only service',quantityUnits:'3',quantityScale:0,unitPrice:{currency:'USD',minorUnits:'10000'},discountBasisPoints:1000,taxTreatment:'taxable'}]});
 await send({type:'accept_estimate',estimateId:'quote',expectedEstimateRevision:1});
 await send({type:'post_manual_journal',id:'synthetic-capital',transactionDate:'2026-10-10',accountingDate:'2026-10-10',periodId:'2026',description:'Synthetic local-only approved opening capital',sourceReference:'SYNTHETIC-NO-MONEY-MOVED',cashFlowCategory:'financing',lines:[{accountId:'cash',debitMinor:'9007199254740993',creditMinor:'0'},{accountId:'equity',debitMinor:'0',creditMinor:'9007199254740993'}]});
 const baseline=(await erp.read(org))!;
 const policy:UsFinancialPolicyV5={version:'us-accrual-receivable-credit-v1',environment:'test',approval:{reference:'SYNTHETIC-LOCAL-APPROVAL',reviewedBy:'synthetic-reviewer',reviewedAt:'2026-10-10T11:00:00.000Z'}};
 await db.query('insert into public.zentra_us_financial_test_grants values($1,$2,$3,1,true,$4)',[org,user,'owner',policy]);
 const scope={organizationId:org,actor,policy,grantVersion:1},foundation=createSupabaseUsFinancialTestFoundationV5(client,scope,async()=>scope);
 const book=basis==='accrual'?await promoteUsFinancialBookV5(baseline,policy,actor):null;
 const identity=(input:UsFinancialBookV5,key:string)=>hash(canonicalErpJson([org,actor.userId,{type:'promote_financial_book',idempotencyKey:key,baselineRevision:input.baseline.revision,baselineSha256:input.promotion.baselineSha256,policy:input.policy}]));
 const promote=(input:UsFinancialBookV5=book!,key='synthetic-promotion',digest=identity(input,key))=>result<{book:UsFinancialBookV5;receipt:unknown;replayed:boolean}>('select public.zentra_promote_us_financial_test_v5($1,$2,$3,$4,$5,$6,$7) result',[org,actor,1,capability,input,key,digest]);
 const read=(a:FinancialAuthority=actor,version=1,cap=capability)=>result('select public.zentra_read_us_financial_test_v5($1,$2,$3,$4) result',[org,a,version,cap]);
 return{org,user,actor,config,erp,send,baseline,policy,scope,foundation,book:book!,identity,promote,read};
}
const chOrg=randomUUID(),chUser=randomUUID();let chBefore:unknown;

describe.skipIf(!enabled)('private US financial TEST PostgreSQL foundation',()=>{
 beforeAll(async()=>{
  const require=createRequire(import.meta.url);({PGlite}=require(join(directory!,'dist/index.cjs')) as {PGlite:new(dataDir?:string)=>Db});
  dataDir=await mkdtemp(join(tmpdir(),'zentra-financial-test-v5-'));db=new PGlite(dataDir);
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);grant usage on schema public to service_role;');
  for(const name of migrations)await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`,import.meta.url),'utf8'));
  await db.query('insert into public.zentra_workspaces(organization_id,updated_by) values($1,$2)',[chOrg,chUser]);
  await db.query('select public.zentra_put_workspace_country_config($1,$2,0,$3::uuid,$4::jsonb)',[chOrg,chUser,randomUUID(),{schemaVersion:1,organizationId:chOrg,country:'CH',currency:'CHF',language:'fr',timeZone:'Europe/Zurich',address:{country:'CH',line1:'1 Rue Fictive',city:'Genève',subdivision:'GE',postalCode:'1201'},accountingBasis:'accrual',invoiceNumberPrefix:'CH',taxConfiguration:{status:'unconfigured'}}]);
  chBefore=(await db.query('select to_jsonb(w) workspace,to_jsonb(c) config from public.zentra_workspaces w join public.zentra_workspace_country_configs c using(organization_id) where organization_id=$1',[chOrg])).rows;
  await db.exec(await readFile(new URL(`../../supabase/migrations/${migration}.sql`,import.meta.url),'utf8'));
 },30000);
 afterAll(async()=>{await db?.close();});
 it('promotes through the real adapter/RPC, preserves exact Unicode baseline and restores its immutable retry',async()=>{
  const f=await fixture();expect(await f.foundation.read()).toBeNull();
  const promoted=await f.foundation.promote({book:f.book,idempotencyKey:'synthetic-promotion'});
  expect(promoted).toMatchObject({book:f.book,replayed:false,receipt:{baselineRevision:f.baseline.revision,revision:f.baseline.revision+1,actorId:f.user,action:'promote_financial_book'}});
  expect(await f.foundation.read()).toEqual(f.book);
  expect(f.book.baseline.ledger.entries[0].lines[0].debitMinor).toBe('9007199254740993');expect(f.book.baseline.ledger.audit).not.toHaveLength(0);
  expect(await f.foundation.promote({book:f.book,idempotencyKey:'synthetic-promotion'})).toEqual({...promoted,replayed:true});
  expect(await f.foundation.receipt('synthetic-promotion')).toMatchObject({origin:'promotion',actorId:f.user,receipt:promoted.receipt});
  expect(await f.foundation.receipt('L'.repeat(232))).toMatchObject({origin:'legacy_erp4',actorId:f.user,receipt:{action:'save_customer',idempotencyKey:'L'.repeat(232)}});
  expect(await f.foundation.receipt('unknown')).toBeNull();
  expect((await sql<{hash:string}>('select public.zentra_us_financial_test_hash($1) hash',[f.book]))[0].hash).toBe(hash(canonicalErpJson(f.book)));
 });
 it('reserves every legacy key without requiring it to occur in financial events',async()=>{
  const f=await fixture(),before=await sql('select idempotency_key,actor_id,receipt from public.zentra_us_erp_receipts where organization_id=$1 order by idempotency_key',[f.org]);
  await f.promote();const after=await sql('select idempotency_key,actor_id,receipt from public.zentra_us_financial_test_receipts where organization_id=$1 and origin=\'legacy_erp4\' order by idempotency_key',[f.org]);
  expect(after).toEqual(before);expect(before).toHaveLength(5);
 });
 it('rejects stale or altered real baselines and persists no partial promotion',async()=>{
  const f=await fixture();await f.send({type:'save_customer',customer:{...f.baseline.customers[0],name:'Synthetic changed customer'}});
  await expect(f.promote()).rejects.toMatchObject({code:'PF001'});
  expect(await f.read()).toBeNull();expect(await sql('select * from public.zentra_us_financial_test_receipts where organization_id=$1',[f.org])).toEqual([]);
 });
 it('rejects opaque hashes, event tails, foreign provenance and existing legacy keys',async()=>{
  const f=await fixture();await expect(f.promote(f.book,'key','0'.repeat(64))).rejects.toMatchObject({code:'PF004'});
  await expect(f.promote({...f.book,events:[{} as never]})).rejects.toMatchObject({code:'PF004'});
  await expect(f.promote({...f.book,promotion:{...f.book.promotion,actor:{...f.actor,userId:randomUUID()}}})).rejects.toMatchObject({code:'PF004'});
  await expect(f.promote(f.book,'L'.repeat(200))).resolves.toMatchObject({replayed:false});
  await expect(f.promote(f.book,'different-key')).rejects.toMatchObject({code:'PF002'});
  const other=await fixture();await expect(other.promote(other.book,'synthetic-1')).rejects.toMatchObject({code:'PF002'});expect(await other.read()).toBeNull();
 });
 it('requires a living matching TEST grant on read, receipts, promotion and disabled append',async()=>{
  const f=await fixture();await f.promote();
  await expect(f.read({...f.actor,userId:randomUUID()})).rejects.toMatchObject({code:'PF005'});
  await expect(f.read({...f.actor,organizationId:randomUUID()})).rejects.toMatchObject({code:'PF005'});
  await expect(f.read({...f.actor,role:'admin'})).rejects.toMatchObject({code:'PF005'});
  await expect(f.read(f.actor,2)).rejects.toMatchObject({code:'PF006'});
  await expect(f.read(f.actor,1,'memory-test-v5')).rejects.toMatchObject({code:'PF009'});
  await db.query('update public.zentra_us_financial_test_grants set enabled=false,version=2 where organization_id=$1',[f.org]);
  await expect(f.read()).rejects.toMatchObject({code:'PF005'});
  await expect(f.promote()).rejects.toMatchObject({code:'PF005'});
  await expect(result('select public.zentra_us_financial_test_receipt_v5($1,$2,1,$3,$4) result',[f.org,f.actor,capability,'synthetic-promotion'])).rejects.toMatchObject({code:'PF005'});
  await expect(result('select public.zentra_append_us_financial_test_v5($1,$2,1,$3,1,$4,$5,$6) result',[f.org,f.actor,capability,hash('anything'),f.book,{}])).rejects.toMatchObject({code:'PF005'});
 });
 it('keeps append closed at RPC and direct table boundaries, without a flag bypass',async()=>{
  const f=await fixture();await f.promote();
  await expect(result('select public.zentra_append_us_financial_test_v5($1,$2,1,$3,$4,$5,$6,$7) result',[f.org,f.actor,capability,f.book.revision,hash(canonicalErpJson(f.book)),f.book,{}])).rejects.toMatchObject({code:'PF010'});
  await expect(sql('insert into public.zentra_us_financial_test_events values($1,$2,$3)',[f.org,f.book.revision+1,{operation:'forged'}])).rejects.toMatchObject({code:'PF010'});
  await expect(sql('insert into public.zentra_us_financial_test_receipts values($1,$2,$3,$4,$5)',[f.org,'forged','financial_v5',f.user,{}])).rejects.toMatchObject({code:'PF010'});
  expect(await f.read()).toEqual(f.book);
 });
 it('protects promotion metadata, receipt history, grant administration and completeness from direct service writes',async()=>{
  const f=await fixture();await f.promote();
  await expect(sql('update public.zentra_us_financial_test_heads set revision=revision+1 where organization_id=$1',[f.org])).rejects.toMatchObject({code:'PF003'});
  await expect(sql('update public.zentra_us_financial_test_receipts set actor_id=$2 where organization_id=$1',[f.org,randomUUID()])).rejects.toMatchObject({code:'PF003'});
  await expect(sql('update public.zentra_us_financial_test_grants set version=version+1 where organization_id=$1',[f.org])).rejects.toMatchObject({code:'PF003'});
  await expect(sql('insert into public.zentra_us_financial_test_receipts values($1,$2,$3,$4,$5)',[f.org,'unknown','legacy_erp4',f.user,{}])).rejects.toMatchObject({code:'PF004'});
  const another=await fixture();
  await expect(sql('insert into public.zentra_us_financial_test_heads select $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1',[another.org,another.book.revision,another.baseline,another.book.promotion.baselineSha256,another.policy,another.book.promotion,hash(canonicalErpJson(another.book)),'synthetic-promotion',another.identity(another.book,'synthetic-promotion'),{schemaVersion:1,organizationId:another.org,idempotencyKey:'synthetic-promotion',commandHash:another.identity(another.book,'synthetic-promotion'),revision:another.book.revision,baselineRevision:another.baseline.revision,baselineSha256:another.book.promotion.baselineSha256,actorId:another.user,action:'promote_financial_book'}])).rejects.toMatchObject({code:'PF004'});
  expect(await another.read()).toBeNull();
  expect(await another.erp.read(another.org)).toEqual(another.baseline);
 });
 it('enforces provenance chronology against the actual nonempty ledger',async()=>{
  const f=await fixture(),earlier={...f.actor,timestamp:'2026-10-10T11:30:00.000Z'},book={...f.book,promotion:{...f.book.promotion,actor:earlier}};
  await expect(result('select public.zentra_promote_us_financial_test_v5($1,$2,1,$3,$4,$5,$6) result',[f.org,earlier,capability,book,'synthetic-promotion',f.identity(book,'synthetic-promotion')])).rejects.toMatchObject({code:'PF004'});
  expect(await f.read()).toBeNull();expect(await f.erp.read(f.org)).toEqual(f.baseline);
 });
 it('refuses malformed JSON promotion/revisions without committing or leaking a marker',async()=>{
  const f=await fixture();
  for(const input of [null,[],false,42,'book',{...f.book,revision:String(f.book.revision)},{...f.book,revision:1.5},{...f.book,revision:Number.MAX_SAFE_INTEGER},{...f.book,promotion:{...f.book.promotion,actor:null}},{...f.book,secret:'untrusted'}]){
   const digest=input&&typeof input==='object'&&!Array.isArray(input)&&'baseline'in input?f.identity(input as UsFinancialBookV5,'synthetic-promotion'):'0'.repeat(64);
   await expect(result('select public.zentra_promote_us_financial_test_v5($1,$2,1,$3,$4::jsonb,$5,$6) result',[f.org,f.actor,capability,input===null?null:JSON.stringify(input),'synthetic-promotion',digest])).rejects.toMatchObject({code:input===null?'PF012':'PF004'});
   expect(await f.read()).toBeNull();expect(await sql('select * from public.zentra_us_financial_test_receipts where organization_id=$1',[f.org])).toEqual([]);
  }
  expect(await f.erp.read(f.org)).toEqual(f.baseline);
 });
 it('requires authoritative tenant membership and monotonic grant version/policy after reactivation',async()=>{
  const a=await fixture(),b=await fixture();await a.promote();await b.promote();
  await expect(result('select public.zentra_read_us_financial_test_v5($1,$2,1,$3) result',[b.org,{...a.actor,organizationId:b.org},capability])).rejects.toMatchObject({code:'PF005'});
  for(const actor of [{...a.actor,managementEntitled:false},{...a.actor,secret:'not-an-actor'}])await expect(result('select public.zentra_read_us_financial_test_v5($1,$2,1,$3) result',[a.org,actor,capability])).rejects.toMatchObject({code:'PF005'});
  await db.query('update public.zentra_us_financial_test_grants set enabled=false,version=2 where organization_id=$1',[a.org]);
  await db.query('update public.zentra_us_financial_test_grants set enabled=true,version=3 where organization_id=$1',[a.org]);
  await expect(a.read()).rejects.toMatchObject({code:'PF006'});expect(await a.read(a.actor,3)).toEqual(a.book);
  await db.query('update public.zentra_us_financial_test_grants set version=4,policy=$2 where organization_id=$1',[a.org,{...a.policy,approval:{...a.policy.approval,reference:'SYNTHETIC-CHANGED-POLICY'}}]);
  await expect(a.read(a.actor,3)).rejects.toMatchObject({code:'PF006'});await expect(a.read(a.actor,4)).rejects.toMatchObject({code:'PF007'});
 });
 it('rejects a real foreign legacy receipt copied into another promoted tenant',async()=>{
  const a=await fixture(),b=await fixture();await a.send({type:'save_customer',customer:{...a.baseline.customers[0],name:'Synthetic tenant A only'}},'tenant-a-only');await b.promote();
  const receipt=(await sql<{receipt:unknown}>('select receipt from public.zentra_us_erp_receipts where organization_id=$1 and idempotency_key=$2',[a.org,'tenant-a-only']))[0].receipt;
  await expect(sql('insert into public.zentra_us_financial_test_receipts values($1,$2,$3,$4,$5)',[b.org,'tenant-a-only','legacy_erp4',a.user,receipt])).rejects.toMatchObject({code:'PF004'});
  expect(await b.read()).toEqual(b.book);
 });
 it('lets the NOLOGIN admission inspect only markers, never a financial baseline or grant',async()=>{
  const f=await fixture();await f.promote();
  expect((await db.query("select has_column_privilege('zentra_us_admission_owner','public.zentra_us_financial_test_heads','organization_id','SELECT') marker,has_column_privilege('zentra_us_admission_owner','public.zentra_us_financial_test_heads','baseline','SELECT') baseline,has_table_privilege('zentra_us_admission_owner','public.zentra_us_financial_test_grants','SELECT') grants")).rows).toEqual([{marker:true,baseline:false,grants:false}]);
  await expect(sql('select public.zentra_us_financial_test_require_legacy($1)',[f.org],'zentra_us_admission_owner')).rejects.toMatchObject({code:'PF008'});
  await expect(sql('select baseline from public.zentra_us_financial_test_heads where organization_id=$1',[f.org],'zentra_us_admission_owner')).rejects.toMatchObject({code:'42501'});
  expect(await (await fixture()).read()).toBeNull();
 });
 it('bounds SQL JSON strings, keys, aggregate text, depth and arrays conservatively',async()=>{
  for(const query of [
   "select public.zentra_us_financial_test_budget(jsonb_build_object('value',repeat('x',524289)))",
   "select public.zentra_us_financial_test_budget(jsonb_build_object(repeat('x',524289),'v'))",
   "select public.zentra_us_financial_test_budget(jsonb_build_object('unicode',repeat('é',262145)))",
   "select public.zentra_us_financial_test_budget(to_jsonb(array_fill(repeat('x',524288),array[5])))",
   "select public.zentra_us_financial_test_budget(to_jsonb(array_fill(0,array[1001])))",
  ])await expect(sql(query)).rejects.toMatchObject({code:'PF012'});
  let nested:unknown=0;for(let i=0;i<21;i++)nested={nested};await expect(sql('select public.zentra_us_financial_test_budget($1)',[nested])).rejects.toMatchObject({code:'PF012'});
  await expect(sql("select public.zentra_us_financial_test_budget(jsonb_build_object('unicode','Genève · 東京 · 🌍'))")).resolves.toHaveLength(1);
 });
 it.each(core)('freezes existing %s rows as well as truncate',async table=>{
  const f=await fixture();await f.promote();expect((await sql<{count:string}>(`select count(*) from public.${table} where organization_id=$1`,[f.org]))[0].count).not.toBe('0');
  // The historical append-only tables already deny service_role UPDATE. Use
  // the local DB owner too, proving the row trigger independently of grants.
  await expect(sql(`update public.${table} set organization_id=organization_id where organization_id=$1`,[f.org],'postgres')).rejects.toMatchObject({code:'PF008'});expect(await f.read()).toEqual(f.book);
 });
 it.each(['','_v2','_v3','_v4'])('refuses every old ERP%s snapshot/head/delta/receipt instead of serving frozen current data',async suffix=>{
  const f=await fixture();await f.promote();
  for(const [name,args] of [[`zentra_read_us_erp${suffix}`,[f.org]],[`zentra_us_erp_revision${suffix}`,[f.org]],[`zentra_us_erp_delta${suffix}`,[f.org,0,25]],[`zentra_us_erp_receipt${suffix}`,[f.org,'synthetic-1']]] as const){
   await expect(result(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) result`,[...args])).rejects.toMatchObject({code:'PU008'});
  }
 });
 it('refuses even an old commit receipt replay and new direct writes after promotion',async()=>{
  const f=await fixture(),receipt=(await sql<{receipt:unknown}>('select receipt from public.zentra_us_erp_receipts where organization_id=$1 and idempotency_key=$2',[f.org,'synthetic-1']))[0].receipt;
  await f.promote();await expect(result('select public.zentra_commit_us_erp($1,0,$2,$3,$4,$5,$6) result',[f.org,{},[],[],receipt,f.actor])).rejects.toMatchObject({code:'PU008'});
  await expect(sql('update public.zentra_us_erp_heads set revision=revision+1 where organization_id=$1',[f.org])).rejects.toMatchObject({code:'PF008'});
  await expect(sql('update public.zentra_workspace_country_configs set revision=revision+1 where organization_id=$1',[f.org])).rejects.toMatchObject({code:'PF008'});
  await expect(sql('update public.zentra_workspaces set revision=revision+1 where organization_id=$1',[f.org])).rejects.toMatchObject({code:'PF008'});
 });
 it.each(core)('retains %s against direct truncate, including cascade',async table=>{
  const f=await fixture();await f.promote();await expect(db.exec(`truncate public.${table} cascade`)).rejects.toMatchObject({code:'PF003'});expect(await f.read()).toEqual(f.book);
 });
 it.each(['repeatable read','serializable'])('refuses whole-table legacy truncate under %s independently of marker visibility',async isolation=>{
  const f=await fixture();await f.promote();
  for(const table of ['zentra_us_erp_records','zentra_us_supplier_documents'])await expect(db.transaction(async tx=>{
   await tx.exec(`set transaction isolation level ${isolation}`);await tx.exec(`truncate public.${table} cascade`);
  })).rejects.toMatchObject({code:'PF003'});
  expect(await f.read()).toEqual(f.book);
 });
 it.each(['anon','authenticated'])('exposes no new table or RPC to %s',async role=>{
  for(const table of ['grants','heads','events','receipts'])await expect(sql(`select * from public.zentra_us_financial_test_${table}`,[],role)).rejects.toMatchObject({code:'42501'});
  const f=await fixture();await expect(sql('select public.zentra_read_us_financial_test_v5($1,$2,1,$3)',[f.org,f.actor,capability],role)).rejects.toMatchObject({code:'42501'});
 });
 it('denies source sidecars before they use old records or reserve work',async()=>{
  const f=await fixture();await f.promote();
  for(const [query,args,code] of [
   ['select public.zentra_us_supplier_scope($1,$2,4)',[f.org,f.actor],'PS006'],['select public.zentra_us_supplier_document_workspace($1)',[f.org],'PS006'],
   ['select public.zentra_us_bank_scope($1,$2,4)',[f.org,f.actor],'PB008'],['select public.zentra_us_sales_order_admit($1,$2,4,false)',[f.org,f.actor],'PO005'],
   ['select public.zentra_lock_us_tax_context($1)',[f.org],'PU008'],['select public.zentra_us_tax_preparation_capability($1,4)',[f.org],'PU008'],
   ['select public.zentra_read_us_tax_operation($1,$2,$3,$4)',[f.org,'key',hash('key'),f.actor],'PU008'],
   ['select public.zentra_us_workspace_sync_heads($1,$2,4,false,false,false,null,null)',[f.org,f.actor],'PW008'],
   ['select public.zentra_read_us_tax_merchant_context($1,$2)',[f.org,f.actor],'PU008'],
   ['select public.zentra_read_us_seller_profile($1)',[f.org],'PU008'],['select public.zentra_put_us_seller_profile($1,$2,0,$3::uuid,$4)',[f.org,f.user,randomUUID(),{}],'PU008'],
   ['select public.zentra_read_us_tax_profile($1)',[f.org],'PU008'],['select public.zentra_put_us_tax_profile($1,$2,0,$3::uuid,$4)',[f.org,f.user,randomUUID(),{}],'PU008'],
   ['select public.zentra_us_sales_order_invoice($1,$2)',[f.org,{}],'PU008'],
   ['select public.zentra_us_supplier_document_projection($1,$2::uuid)',[f.org,randomUUID()],'PU008'],
  ] as const)await expect(sql(query,[...args])).rejects.toMatchObject({code});
 });
 it('rejects unsupported isolation and non-US/cash policy while leaving CH and unpromoted clients intact',async()=>{
  const f=await fixture();await expect(db.transaction(async tx=>{await tx.exec('set transaction isolation level repeatable read');return tx.query('select public.zentra_read_us_financial_test_v5($1,$2,1,$3)',[f.org,f.actor,capability]);})).rejects.toMatchObject({code:'PF009'});
  const cash=await fixture('cash');await expect(cash.read()).rejects.toMatchObject({code:'PF011'});
  await expect(result('select public.zentra_read_us_financial_test_v5($1,$2,1,$3) result',[chOrg,{...f.actor,organizationId:chOrg},capability])).rejects.toMatchObject({code:'PF011'});
  expect(await f.erp.read(f.org)).toEqual(f.baseline);await f.send({type:'save_customer',customer:{...f.baseline.customers[0],name:'Synthetic unpromoted edit'}});
  expect((await db.query('select to_jsonb(w) workspace,to_jsonb(c) config from public.zentra_workspaces w join public.zentra_workspace_country_configs c using(organization_id) where organization_id=$1',[chOrg])).rows).toEqual(chBefore);
  const rows=await db.query<{relrowsecurity:boolean;anon:boolean;authenticated:boolean}>('select c.relrowsecurity,has_table_privilege(\'anon\',c.oid,\'SELECT\') anon,has_table_privilege(\'authenticated\',c.oid,\'SELECT\') authenticated from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=\'public\' and c.relname like \'zentra_us_financial_test_%\' and c.relkind=\'r\'');
  expect(rows.rows).toHaveLength(4);for(const row of rows.rows)expect(row).toEqual({relrowsecurity:true,anon:false,authenticated:false});
 });
 it('keeps every financial foundation function invoker-only and unavailable to browser roles',async()=>{
  const rows=await db.query<{proname:string;prosecdef:boolean;anon:boolean;authenticated:boolean}>("select p.proname,p.prosecdef,has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'zentra_us_financial_test_%' or p.proname in('zentra_read_us_financial_test_v5','zentra_promote_us_financial_test_v5','zentra_append_us_financial_test_v5'))");
  expect(rows.rows.length).toBeGreaterThanOrEqual(16);for(const row of rows.rows)expect(row).toMatchObject({prosecdef:false,anon:false,authenticated:false});
 });
 it.each(['repeatable read','serializable'])('preserves confirmed CH workspace/configuration edits under %s',async isolation=>{
  const rollback=new Error('Intentional synthetic CH transaction rollback');
  await expect(db.transaction(async tx=>{
   await tx.exec(`set transaction isolation level ${isolation};set local role service_role`);
   const row=(await tx.query<{revision:number;config:CompanyConfiguration}>('select revision,config from public.zentra_workspace_country_configs where organization_id=$1',[chOrg])).rows[0];
   const changed={...row.config,invoiceNumberPrefix:'CH-SYNTHETIC-EDIT'};
   await tx.query('select public.zentra_put_workspace_country_config($1,$2,$3,$4::uuid,$5)',[chOrg,chUser,row.revision,randomUUID(),changed]);
   await tx.query('update public.zentra_workspaces set updated_by=updated_by where organization_id=$1',[chOrg]);
   expect((await tx.query<{config:CompanyConfiguration}>('select config from public.zentra_workspace_country_configs where organization_id=$1',[chOrg])).rows[0].config).toEqual(changed);
   throw rollback;
  })).rejects.toBe(rollback);
  expect((await db.query('select to_jsonb(w) workspace,to_jsonb(c) config from public.zentra_workspaces w join public.zentra_workspace_country_configs c using(organization_id) where organization_id=$1',[chOrg])).rows).toEqual(chBefore);
 });
 it.each(['repeatable read','serializable'])('continues denying US and unconfirmed legacy admission under %s',async isolation=>{
  const f=await fixture();
  for(const org of [f.org,randomUUID()])await expect(db.transaction(async tx=>{
   await tx.exec(`set transaction isolation level ${isolation};set local role service_role`);await tx.query('select public.zentra_us_financial_test_require_legacy($1)',[org]);
  })).rejects.toMatchObject({code:'PF009'});
 });
 it('recovers exact book, promotion replay, legacy receipts and freeze after clean NodeFS close/reopen',async()=>{
  const f=await fixture();const promoted=await f.foundation.promote({book:f.book,idempotencyKey:'synthetic-promotion'});
  await db.close();db=new PGlite(dataDir);
  expect(await f.foundation.read()).toEqual(f.book);expect(await f.foundation.promote({book:f.book,idempotencyKey:'synthetic-promotion'})).toEqual({...promoted,replayed:true});
  expect(await f.foundation.receipt('L'.repeat(232))).toMatchObject({origin:'legacy_erp4',actorId:f.user,receipt:{action:'save_customer'}});
  await expect(f.erp.read(f.org)).rejects.toMatchObject({code:'client_upgrade_required'});
  await expect(sql('update public.zentra_us_erp_heads set revision=revision+1 where organization_id=$1',[f.org])).rejects.toMatchObject({code:'PF008'});
 },30000);
});
