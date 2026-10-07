import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import { createSupabaseErpStore } from './runtime-store';
import { executeErp } from './runtime';
import { createErpHandlers } from './runtime-server';
import { applyErpDelta, validateErpDelta, type ErpDelta, type ErpRevision } from './runtime-sync';
import { invoiceBalance, type TaxCalculationProvider } from './invoicing';
import { trialBalance, profitAndLoss } from './accounting/reports';
import type { CompanyConfiguration } from './types';
import type { FinancialAuthority } from './accounting/ledger';
import type { ErpCommand, ErpRequest, ErpState, ErpCommit } from './runtime-types';

// Explicit opt-in local engine: no production key, URL or persistent directory.
const moduleDirectory = process.env.PGLITE_MODULE_DIR;
const enabled = !!moduleDirectory && isAbsolute(moduleDirectory);
type Sql = {exec(sql:string):Promise<unknown>;query<T=Record<string,unknown>>(sql:string,values?:unknown[]):Promise<{rows:T[]}>};
type TestDatabase = Sql & {transaction<T>(task:(sql:Sql)=>Promise<T>):Promise<T>;close():Promise<void>};
const databases: TestDatabase[] = [];
afterEach(async()=>{await Promise.all(databases.splice(0).map(db=>db.close()));});
const org='runtime-sql-us-fixture';
const configuration={schemaVersion:1,organizationId:org,country:'US',currency:'USD',language:'en',timeZone:'America/New_York',address:{country:'US',line1:'1 Example Street',city:'Brooklyn',postalCode:'11201',subdivision:'NY'},accountingBasis:'accrual',invoiceNumberPrefix:'INV',taxConfiguration:{status:'configured'}} satisfies CompanyConfiguration;
const actor:FinancialAuthority={organizationId:org,userId:'synthetic-owner',role:'owner',managementEntitled:true,timestamp:'2026-10-08T12:00:00.000Z'};
const seller={organizationId:org,displayName:'Fictitious Seller',contactEmail:'seller@example.test'};
const provider:TaxCalculationProvider={id:'synthetic-test-provider',async calculate(request){return {...request,source:'external-provider',providerReference:'not-a-real-tax-determination',determinedAt:'2026-10-08T11:00:00.000Z',validUntil:'2026-10-08T13:00:00.000Z',lines:request.lines.map(line=>({id:line.id,taxMinor:'825',jurisdiction:'synthetic',evidenceReference:'fixture-only'}))};}};
const rpcQueries:Record<string,{sql:string;keys:string[]}>= {
  zentra_read_us_erp:{sql:'select public.zentra_read_us_erp($1) result',keys:['p_organization']},
  zentra_us_erp_receipt:{sql:'select public.zentra_us_erp_receipt($1,$2) result',keys:['p_organization','p_idempotency_key']},
  zentra_commit_us_erp:{sql:'select public.zentra_commit_us_erp($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb) result',keys:['p_organization','p_expected_revision','p_header','p_changes','p_ledger_audit','p_receipt','p_actor']},
  zentra_us_erp_revision:{sql:'select public.zentra_us_erp_revision($1) result',keys:['p_organization']},
  zentra_us_erp_delta:{sql:'select public.zentra_us_erp_delta($1,$2,$3) result',keys:['p_organization','p_after_revision','p_limit']},
};
const deltaMigration=new URL('../../supabase/migrations/20261007224820_international_us_erp_delta_stream.sql',import.meta.url);
const sellerMigration=new URL('../../supabase/migrations/20261007225725_international_us_erp_seller_snapshot.sql',import.meta.url);
async function fixture(basis:'cash'|'accrual'='accrual',taxStatus:'unconfigured'|'configured'='configured',withDelta=true,withSeller=true){
  const packageJson=JSON.parse(await readFile(join(moduleDirectory!,'package.json'),'utf8'));
  expect(packageJson.name).toBe('@electric-sql/pglite');
  const {PGlite}=createRequire(import.meta.url)(join(moduleDirectory!,'dist/index.cjs')) as {PGlite:new()=>TestDatabase};
  const db=new PGlite();databases.push(db);
  await db.exec(`create role anon;create role authenticated;create role service_role;
    create table public.zentra_workspaces(organization_id text primary key,revision bigint not null default 0,snapshot_id uuid,number_floors jsonb not null default '[]',updated_by text not null default 'fixture');
    grant usage on schema public to service_role;grant select,update on public.zentra_workspaces to service_role;
    insert into public.zentra_workspaces(organization_id,revision) values('${org}',11),('runtime-sql-foreign',9);`);
  await db.exec(await readFile(new URL('../../supabase/migrations/20261007194528_international_workspace_country_config.sql',import.meta.url),'utf8'));
  const config:CompanyConfiguration={...configuration,accountingBasis:basis,taxConfiguration:{status:taxStatus}};
  await db.query('select public.zentra_put_workspace_country_config($1,$2,0,$3::uuid,$4::jsonb)',[org,actor.userId,'10000000-0000-4000-8000-000000000001',JSON.stringify(config)]);
  await db.exec(await readFile(new URL('../../supabase/migrations/20261007222349_international_us_erp_persistence.sql',import.meta.url),'utf8'));
  if(withDelta)await db.exec(await readFile(deltaMigration,'utf8'));
  if(withSeller)await db.exec(await readFile(sellerMigration,'utf8'));
  let loseCommitResponse=false;
  const commits:Record<string,unknown>[]=[];
  const client:Pick<SupabaseServerClient,'rpc'>={async rpc<T>(name:string,parameters:Record<string,unknown>):Promise<T>{
    const query=rpcQueries[name];if(!query)throw new Error('Unexpected local RPC');
    try {
      const result=await db.transaction(async tx=>{await tx.exec('set local role service_role');const values=query.keys.map(key=>typeof parameters[key]==='object'?JSON.stringify(parameters[key]):parameters[key]);return (await tx.query<{result:T}>(query.sql,values)).rows[0].result;});
      if(name==='zentra_commit_us_erp'){commits.push(parameters);if(loseCommitResponse){loseCommitResponse=false;throw new SupabaseServerError(503,'synthetic_lost_response');}}
      return result;
    }catch(error){if(error instanceof SupabaseServerError)throw error;throw new SupabaseServerError(400,(error as {code?:string}).code??'unknown_sql');}
  }};
  const store=createSupabaseErpStore(client);
  const dependencies={store,configuration:config,actor,revalidate:async()=>({...actor,timestamp:'2026-10-08T12:00:01.000Z'}),taxProvider:async()=>provider as TaxCalculationProvider|null,seller:async()=>seller};
  let key=0;
  const send=async(command:ErpCommand,overrides:Partial<ErpRequest>={})=>executeErp(dependencies,{idempotencyKey:`request-${++key}`,expectedRevision:(await store.read(org))?.revision??0,command,...overrides});
  const customer={id:'customer-1',organizationId:org,kind:'business' as const,name:'Synthetic Customer',billingAddress:config.address,paymentTermsDays:30};
  const estimate:ErpCommand={type:'save_estimate',id:'estimate-1',expectedEstimateRevision:0,customerId:customer.id,date:'2026-10-08',expiresAt:'2026-11-08',paymentTermsDays:30,lines:[{id:'line-1',description:'Fictitious service',quantityUnits:'1',quantityScale:0,unitPrice:{currency:'USD',minorUnits:'10000'},discountBasisPoints:0,taxTreatment:'taxable'}],notes:'Synthetic document\nNo real transaction'};
  const initialize=async()=>{await send({type:'initialize',periods:[{id:'2026',start:'2026-01-01',end:'2026-12-31',status:'open'}]});await send({type:'save_customer',customer});await send(estimate);await send({type:'accept_estimate',estimateId:'estimate-1',expectedEstimateRevision:1});};
  const issueCommand:ErpCommand={type:'issue_invoice',id:'invoice-1',estimateId:'estimate-1',expectedEstimateRevision:2,date:'2026-10-08',accountingDate:'2026-10-09',dueDate:'2026-11-07',periodId:'2026'};
  let configRevision=1;
  const configure=async(next:Extract<CompanyConfiguration,{country:'US'}>)=>{await db.query('select public.zentra_put_workspace_country_config($1,$2,$3,$4::uuid,$5::jsonb)',[org,actor.userId,configRevision,`10000000-0000-4000-8000-${String(++configRevision).padStart(12,'0')}`,JSON.stringify(next)]);dependencies.configuration=next;};
  const changes=(after:number,limit=50,organizationId=org)=>client.rpc<ErpDelta|null>('zentra_us_erp_delta',{p_organization:organizationId,p_after_revision:after,p_limit:limit});
  const revision=(organizationId=org)=>client.rpc<ErpRevision|null>('zentra_us_erp_revision',{p_organization:organizationId});
  return {db,client,store,dependencies,send,initialize,customer,estimate,issueCommand,commits,configure,changes,revision,loseNextResponse(){loseCommitResponse=true;}};
}

// A privileged synthetic payload stresses bytes at the SQL boundary. It is not
// an admissible public HTTP customer request (the HTTP schema/256 KiB cap apply).
async function rawPaddedCustomer(f:Awaited<ReturnType<typeof fixture>>,paddingBytes:number){
  const state=await f.client.rpc<ErpState>('zentra_read_us_erp',{p_organization:org});
  const {customers:_customers,estimates:_estimates,invoices:_invoices,ledger,...base}=state;
  const {entries:_entries,audit:_audit,...book}=ledger;const revision=state.revision+1;
  return f.client.rpc('zentra_commit_us_erp',{p_organization:org,p_expected_revision:state.revision,p_header:{...base,revision,ledger:book},p_changes:[{kind:'customer',id:f.customer.id,payload:{...f.customer,name:`Synthetic transport revision ${revision}`,fixturePadding:'x'.repeat(paddingBytes)}}],p_ledger_audit:[],p_receipt:{idempotencyKey:`transport-${revision}`,commandHash:'c'.repeat(64),revision,entityId:f.customer.id,action:'save_customer'},p_actor:actor});
}
const parameters=(input:ErpCommit)=>({p_organization:input.organizationId,p_expected_revision:input.expectedRevision,p_header:input.header,p_changes:input.changes,p_ledger_audit:input.ledgerAudit,p_receipt:input.receipt,p_actor:input.actor});
async function captureIssue(f:Awaited<ReturnType<typeof fixture>>){
  let input:ErpCommit|undefined;
  await expect(executeErp({...f.dependencies,store:{...f.store,commit:async value=>{input=value;throw new Error('synthetic_capture_before_commit');}}},{idempotencyKey:'captured-issue',expectedRevision:4,command:f.issueCommand})).rejects.toThrow('synthetic_capture_before_commit');
  if(!input)throw new Error('Expected synthetic commit');return input;
}

describe.skipIf(!enabled)('US ERP runtime and HTTP boundary on real PostgreSQL WASM',()=>{
  it.each(['cash','accrual'] as const)('persists actual engine outputs and reconstructs exact reports (%s)',async basis=>{
    const f=await fixture(basis);await f.initialize();await f.send(f.issueCommand);
    expect((await f.store.read(org))!.ledger.entries).toHaveLength(basis==='cash'?0:1);
    for(const [id,amount] of [['p1','3608'],['p2','3608'],['p3','3609']])await f.send({type:'record_payment',id,invoiceId:'invoice-1',amountMinor:amount,paymentDate:'2026-10-10',accountingDate:'2026-10-11',periodId:'2026',reference:`synthetic:${id}`});
    const state=(await f.store.read(org))!;
    expect(invoiceBalance(state.invoices[0]).minorUnits).toBe('0');expect(state.invoices[0].number).toBe('INV-000001');expect(state.invoices[0].tax.minorUnits).toBe('825');
    expect(trialBalance(state.ledger,'2026-12-31').balanced).toBe(true);expect(profitAndLoss(state.ledger,{start:'2026-01-01',end:'2026-12-31'}).incomeMinor).toBe('10000');
    expect((f.commits[4].p_changes as {kind:string}[]).map(change=>change.kind)).toEqual(basis==='cash'?['invoice']:['invoice','journal']);
    expect(f.commits[4].p_header).not.toHaveProperty('ledger.entries');expect(f.commits[4].p_header).not.toHaveProperty('invoices');
    expect(await f.store.read('runtime-sql-foreign')).toBeNull();expect(Number((await f.db.query<{revision:string}>('select revision from public.zentra_workspaces where organization_id=$1',[org])).rows[0].revision)).toBe(11);
    await f.send({type:'close_period',periodId:'2026'});expect((await f.store.read(org))!.ledger.periods[0].status).toBe('closed');
  },15000);
  it('recovers a response lost after SQL commit using the original request',async()=>{
    const f=await fixture();await f.initialize();f.loseNextResponse();const request={idempotencyKey:'stable-issue',expectedRevision:4,command:f.issueCommand};
    await expect(executeErp(f.dependencies,request)).rejects.toThrow('service_unavailable');
    expect((await f.store.read(org))!.invoices).toHaveLength(1);const result=await executeErp(f.dependencies,request);expect(result.replayed).toBe(true);expect(result.receipt.revision).toBe(5);
    expect((await f.store.read(org))!.ledger.entries).toHaveLength(1);expect(f.commits).toHaveLength(5);expect((await f.changes(0))!.events).toHaveLength(5);
  },15000);
  it('serializes conflicting real SQL commits without losing a customer edit',async()=>{
    const f=await fixture();await f.initialize();const commands=['A','B'].map(name=>executeErp(f.dependencies,{idempotencyKey:`concurrent-${name}`,expectedRevision:4,command:{type:'save_customer',customer:{...f.customer,name}}}));
    const results=await Promise.allSettled(commands);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);expect((await f.store.read(org))!.revision).toBe(5);
    // PGlite is one queued connection. This covers CAS SQL execution, not networked multi-connection contention.
  },15000);
  it('does not consume an invoice number while tax provider is absent',async()=>{
    const f=await fixture();await f.initialize();f.dependencies.taxProvider=async()=>null;
    await expect(f.send(f.issueCommand)).rejects.toThrow('TAX_CONFIGURATION_REQUIRED');const state=(await f.store.read(org))!;expect(state.revision).toBe(4);expect(state.counters.invoice).toBe(0);expect(state.invoices).toHaveLength(0);
  },15000);
  it('initializes before tax setup and explicitly refreshes once an owner completes it',async()=>{
    const f=await fixture('accrual','unconfigured');await f.initialize();await expect(f.send(f.issueCommand)).rejects.toThrow('TAX_CONFIGURATION_REQUIRED');
    await f.configure({...f.dependencies.configuration,taxConfiguration:{status:'configured'}});
    await expect(executeErp({...f.dependencies,actor:{...actor,role:'member'}},{idempotencyKey:'member-refresh',expectedRevision:4,command:{type:'refresh_configuration'}})).rejects.toThrow('owner_required');
    expect((await f.store.read(org))!.configuration.taxConfiguration.status).toBe('unconfigured');
    await f.send({type:'refresh_configuration'});await f.send(f.issueCommand);
    const state=(await f.store.read(org))!;expect(state.revision).toBe(6);expect(state.configuration.taxConfiguration.status).toBe('configured');expect(state.invoices[0].number).toBe('INV-000001');expect(state.counters.invoice).toBe(1);
  },15000);
  it('refreshes metadata without rewriting issued snapshots, and numbers future invoices from the new prefix',async()=>{
    const f=await fixture();await f.initialize();await f.send(f.issueCommand);const original=(await f.store.read(org))!.invoices[0];
    await f.configure({...f.dependencies.configuration,language:'fr',timeZone:'America/Los_Angeles',ein:'12-3456789',invoiceNumberPrefix:'US'});
    await f.send({type:'refresh_configuration'});await f.send({type:'record_payment',id:'p-after-refresh',invoiceId:'invoice-1',amountMinor:'10825',paymentDate:'2026-10-10',accountingDate:'2026-10-11',periodId:'2026',reference:'Synthetic reference after refresh'});
    if(f.estimate.type!=='save_estimate'||f.issueCommand.type!=='issue_invoice')throw new Error('Unexpected fixture command');
    await f.send({...f.estimate,id:'estimate-2'});await f.send({type:'accept_estimate',estimateId:'estimate-2',expectedEstimateRevision:1});await f.send({...f.issueCommand,id:'invoice-2',estimateId:'estimate-2'});
    const state=(await f.store.read(org))!;expect(state.configuration.language).toBe('fr');expect(state.invoices[0].companyConfiguration).toEqual(original.companyConfiguration);expect(state.invoices[0].number).toBe('INV-000001');expect(invoiceBalance(state.invoices[0]).minorUnits).toBe('0');expect(state.invoices[1].number).toBe('US-000002');expect(state.invoices[1].companyConfiguration.language).toBe('fr');expect(state.ledger.entries).toHaveLength(3);
  },15000);
  it('keeps financial strings exact above the JavaScript safe-integer range',async()=>{
    const f=await fixture();await f.initialize();const amount='900719925474099300';
    if(f.estimate.type!=='save_estimate')throw new Error('Unexpected fixture command');
    await f.send({...f.estimate,expectedEstimateRevision:2,lines:f.estimate.lines.map(line=>({...line,unitPrice:{currency:'USD',minorUnits:amount}}))});
    await f.send({type:'accept_estimate',estimateId:'estimate-1',expectedEstimateRevision:3});
    if(f.issueCommand.type!=='issue_invoice')throw new Error('Unexpected fixture command');
    await f.send({...f.issueCommand,expectedEstimateRevision:4});
    const state=(await f.store.read(org))!;expect(state.invoices[0].subtotal.minorUnits).toBe(amount);expect(state.invoices[0].total.minorUnits).toBe((BigInt(amount)+BigInt(825)).toString());
    expect(state.ledger.entries[0].lines[0].debitMinor).toBe((BigInt(amount)+BigInt(825)).toString());
  },15000);
  it('routes real HTTP → engine → store → SQL and reads through a fresh store adapter',async()=>{
    const f=await fixture();let currentActor={...actor};const diagnostics:unknown[]=[];
    const handlers=createErpHandlers({enabled:()=>true,authority:async()=>({mode:'browser' as const,actor:currentActor}),configuration:async()=>f.dependencies.configuration,store:()=>f.store,taxProvider:async()=>provider,seller:async()=>seller,rateLimit:async()=>{},diagnostic:event=>diagnostics.push(event)});
    const origin='https://zentraapp.ch';const url=origin+`/api/international/workspaces/${org}/erp`;
    const post=(body:unknown)=>handlers.POST(new Request(url,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)}),org);
    expect((await post({idempotencyKey:'http-init',expectedRevision:0,command:{type:'initialize',periods:[{id:'2026',start:'2026-01-01',end:'2026-12-31',status:'open'}]}})).status).toBe(200);
    expect((await post({idempotencyKey:'http-customer',expectedRevision:1,command:{type:'save_customer',customer:f.customer}})).status).toBe(200);
    const response=await handlers.GET(new Request(url),org);expect(response.status).toBe(200);const body=await response.json() as {state:ErpState};expect(body.state.customers[0].id).toBe('customer-1');
    expect((await createSupabaseErpStore(f.client).read(org))!.customers[0].id).toBe('customer-1');
    currentActor={...actor,managementEntitled:false};expect((await post({idempotencyKey:'blocked',expectedRevision:2,command:{type:'save_customer',customer:f.customer}})).status).toBe(402);expect((await f.store.read(org))!.revision).toBe(2);expect(diagnostics).toContainEqual({operation:'write',code:'management_entitlement_required',status:402});
  },15000);
  it('resumes ordered SQL deltas and applies only changed records to the exact persisted state',async()=>{
    const f=await fixture();await f.initialize();await f.send(f.issueCommand);await f.send({type:'record_payment',id:'delta-payment',invoiceId:'invoice-1',amountMinor:'4000',paymentDate:'2026-10-10',accountingDate:'2026-10-11',periodId:'2026',reference:'Synthetic delta payment'});await f.send({type:'close_period',periodId:'2026'});
    expect(await f.revision()).toEqual({schemaVersion:1,organizationId:org,revision:7});
    let replica:ErpState|null=null;let cursor=0;const revisions:number[]=[];
    do{const page=(await f.changes(cursor,2))!;validateErpDelta(page,org,cursor,2);revisions.push(...page.events.map(event=>event.revision));replica=applyErpDelta(replica,page,org);cursor=page.toRevision;if(!page.hasMore)break;}while(cursor<7);
    expect(revisions).toEqual([1,2,3,4,5,6,7]);expect(replica).toEqual(await f.store.read(org));
    const issued=(await f.changes(4,1))!.events[0];expect(issued.changes.map(change=>change.kind)).toEqual(['invoice','journal']);expect(issued.header).not.toHaveProperty('ledger.entries');expect(issued.receipt.revision).toBe(issued.revision);
    const closed=(await f.changes(6,1))!.events[0];expect(closed.changes).toEqual([]);expect(closed.ledgerAudit).toHaveLength(1);
    expect(await f.changes(7)).toEqual({schemaVersion:1,organizationId:org,fromRevision:7,toRevision:7,headRevision:7,hasMore:false,resetRequired:false,events:[]});
  },15000);
  it('marks pre-stream cursors for a full snapshot without inventing historical events',async()=>{
    const f=await fixture('accrual','configured',false);await f.initialize();await f.db.exec(await readFile(deltaMigration,'utf8'));
    const reset=(await f.changes(0))!;expect(reset).toMatchObject({fromRevision:0,toRevision:0,headRevision:4,resetRequired:true,events:[]});expect(()=>applyErpDelta(null,reset,org)).toThrow('sync_reset_required');
    expect((await f.changes(4))!.resetRequired).toBe(false);await f.send(f.issueCommand);const page=(await f.changes(4))!;expect(page.events.map(event=>event.revision)).toEqual([5]);expect(page.events[0].changes.map(change=>change.kind)).toEqual(['invoice','journal']);
  },15000);
  it('keeps a cursor gap explicit and never returns a partially applicable page',async()=>{
    const f=await fixture();await f.initialize();
    // Deliberate corruption inside this disposable synthetic DB only. Original
    // financial records/receipts remain; normal service roles cannot delete events.
    await f.db.exec(`alter table public.zentra_us_erp_events disable trigger zentra_us_erp_event_immutable;delete from public.zentra_us_erp_events where organization_id='${org}' and revision=3;alter table public.zentra_us_erp_events enable trigger zentra_us_erp_event_immutable;`);
    expect(await f.changes(2)).toMatchObject({fromRevision:2,toRevision:2,headRevision:4,resetRequired:true,events:[]});expect((await f.store.read(org))!.estimates[0].revision).toBe(2);
  },15000);
  it('bounds cursor/page arguments and denies untrusted roles access to financial deltas',async()=>{
    const f=await fixture();await f.initialize();for(const [after,limit] of [[-1,10],[5,10],[0,0],[0,101]])await expect(f.changes(after,limit)).rejects.toMatchObject({code:'PU004'});
    expect(await f.changes(0,1,'runtime-sql-foreign')).toBeNull();expect(await f.revision('runtime-sql-foreign')).toBeNull();
    for(const role of ['anon','authenticated'])await expect(f.db.transaction(async tx=>{await tx.exec(`set local role ${role}`);await tx.query('select public.zentra_us_erp_delta($1,0,1)',[org]);})).rejects.toMatchObject({code:'42501'});
    expect(Number((await f.db.query<{count:number}>("select count(*)::integer count from pg_publication_tables where tablename in ('zentra_us_erp_events','zentra_us_erp_records','zentra_us_erp_ledger_audit','zentra_us_erp_wakeups')")).rows[0].count)).toBe(0);
  },15000);
  it('isolates two real streams even when customer IDs are identical',async()=>{
    const f=await fixture();await f.initialize();const foreignOrg='runtime-sql-foreign';const foreignConfig={...configuration,organizationId:foreignOrg};const foreignActor={...actor,organizationId:foreignOrg,userId:'synthetic-foreign-owner'};
    await f.db.query('select public.zentra_put_workspace_country_config($1,$2,0,$3::uuid,$4::jsonb)',[foreignOrg,foreignActor.userId,'10000000-0000-4000-8000-000000000042',JSON.stringify(foreignConfig)]);
    const dependencies={...f.dependencies,configuration:foreignConfig,actor:foreignActor,revalidate:async()=>foreignActor};
    await executeErp(dependencies,{idempotencyKey:'foreign-init',expectedRevision:0,command:{type:'initialize',periods:[{id:'2026',start:'2026-01-01',end:'2026-12-31',status:'open'}]}});
    await executeErp(dependencies,{idempotencyKey:'foreign-customer',expectedRevision:1,command:{type:'save_customer',customer:{...f.customer,organizationId:foreignOrg,name:'Synthetic foreign customer'}}});
    const local=(await f.changes(0))!,foreign=(await f.changes(0,50,foreignOrg))!;expect(local.events).toHaveLength(4);expect(foreign.events).toHaveLength(2);expect(local.events.every(event=>event.organizationId===org)).toBe(true);expect(foreign.events.every(event=>event.organizationId===foreignOrg)).toBe(true);expect(JSON.stringify(local)).not.toContain('Synthetic foreign customer');
  },15000);
  it('rolls back the entire business commit when durable event insertion is unavailable',async()=>{
    const f=await fixture();await f.initialize();await f.db.exec('revoke insert on public.zentra_us_erp_events from service_role');
    const request={idempotencyKey:'atomic-outbox',expectedRevision:4,command:{type:'save_customer' as const,customer:{...f.customer,name:'After durable outbox'}}};
    await expect(executeErp(f.dependencies,request)).rejects.toThrow('service_unavailable');expect((await f.store.read(org))!.revision).toBe(4);expect(await f.store.receipt(org,'atomic-outbox')).toBeNull();expect((await f.changes(0))!.events).toHaveLength(4);
    await f.db.exec('grant insert on public.zentra_us_erp_events to service_role');await executeErp(f.dependencies,request);await executeErp(f.dependencies,request);expect((await f.changes(4))!.events).toHaveLength(1);expect((await f.store.read(org))!.customers[0].name).toBe('After durable outbox');
  },15000);
  it('bounds wire pages by bytes, continues the cursor, and rejects a single oversized event atomically',async()=>{
    const f=await fixture();await f.initialize();for(let i=0;i<3;i++)await rawPaddedCustomer(f,1500000);
    const first=(await f.changes(4,100))!;expect(first.events).toHaveLength(2);expect(first.hasMore).toBe(true);expect(first.resetRequired).toBe(false);expect(first.toRevision).toBe(6);expect(Buffer.byteLength(JSON.stringify(first),'utf8')).toBeLessThanOrEqual(4*1024*1024);
    const rest=(await f.changes(first.toRevision,100))!;expect(rest.events).toHaveLength(1);expect(rest.toRevision).toBe(7);expect(rest.hasMore).toBe(false);
    await expect(rawPaddedCustomer(f,2200000)).rejects.toMatchObject({code:'PU007'});expect((await f.revision())!.revision).toBe(7);expect((await f.changes(7))!.events).toEqual([]);expect(await f.store.receipt(org,'transport-8')).toBeNull();
  },20000);
  it('requires a scoped public seller archive and refuses secrets or remote logo URLs in SQL',async()=>{
    const f=await fixture();await f.initialize();const input=await captureIssue(f);
    for(const archive of [undefined,{...seller,organizationId:'runtime-sql-foreign'},{...seller,smtpPassword:'synthetic secret that must not persist'},{...seller,logoRef:{url:'https://example.test/logo.png'}},{...seller,logoRef:{assetId:'not-a-uuid',contentSha256:'a'.repeat(64)}}]){
      const bad=structuredClone(input);const invoice=bad.changes.find(change=>change.kind==='invoice')!.payload as Record<string,unknown>;if(archive===undefined)delete invoice.sellerSnapshot;else invoice.sellerSnapshot=archive;
      await expect(f.client.rpc('zentra_commit_us_erp',parameters(bad))).rejects.toMatchObject({code:'23514'});expect((await f.revision())!.revision).toBe(4);expect((await f.changes(4))!.events).toEqual([]);
    }
    await f.store.commit(input);expect((await f.store.read(org))!.invoices[0].sellerSnapshot).toEqual(seller);
    await expect(f.db.transaction(async tx=>{await tx.exec('set local role service_role');await tx.query("update public.zentra_us_erp_records set payload=jsonb_set(payload,'{sellerSnapshot,displayName}','\"Changed seller\"'),state_revision=6 where organization_id=$1 and kind='invoice'",[org]);})).rejects.toMatchObject({code:'PU003'});
  },15000);
  it('keeps actual legacy invoices untouched and requires explicit review instead of inventing seller identity',async()=>{
    const f=await fixture('accrual','configured',true,false);await f.initialize();const input=structuredClone(await captureIssue(f));delete (input.changes.find(change=>change.kind==='invoice')!.payload as Record<string,unknown>).sellerSnapshot;await f.client.rpc('zentra_commit_us_erp',parameters(input));
    await f.db.exec(await readFile(sellerMigration,'utf8'));const raw=await f.client.rpc<ErpState>('zentra_read_us_erp',{p_organization:org});expect(raw.invoices[0]).not.toHaveProperty('sellerSnapshot');expect(raw.invoices[0].number).toBe('INV-000001');expect(raw.counters.invoice).toBe(1);
    expect((await f.db.query<{convalidated:boolean}>("select convalidated from pg_constraint where conname='zentra_us_erp_invoice_seller_archive'")).rows[0].convalidated).toBe(false);await expect(f.store.read(org)).rejects.toThrow('invalid_stored_state');
  },15000);
  it('rejects header edits that would silently change accounting meaning or numbering',async()=>{
    const f=await fixture();await f.initialize();const captured=await captureIssue(f);
    const modifications:[string,(header:Record<string,unknown>)=>void,string][]=[
      ['unknown header',header=>{header.unannounced='unsupported';},'PU004'],
      ['unknown ledger',header=>{(header.ledger as Record<string,unknown>).unannounced='unsupported';},'PU004'],
      ['unknown counter',header=>{(header.counters as Record<string,unknown>).unannounced=1;},'PU004'],
      ['counter jump',header=>{(header.counters as Record<string,unknown>).invoice=999;},'PU004'],
      ['sales category',header=>{const ledger=header.ledger as {accounts:{id:string;type:string}[]};ledger.accounts.find(account=>account.id==='sales')!.type='asset';},'PU004'],
      ['period dates',header=>{const ledger=header.ledger as {periods:{start:string}[]};ledger.periods[0].start='2026-01-02';},'PU003'],
    ];
    for(const [label,modify,code] of modifications){const bad=structuredClone(captured);modify(bad.header as unknown as Record<string,unknown>);await expect(f.client.rpc('zentra_commit_us_erp',parameters(bad)),label).rejects.toMatchObject({code});expect((await f.revision())!.revision).toBe(4);expect((await f.changes(4))!.events).toEqual([]);}
  },15000);
});
