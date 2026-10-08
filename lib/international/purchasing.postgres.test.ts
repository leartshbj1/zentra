import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import { validateCompanyConfiguration } from './country-config';
import { executeErp, erpHeader, type ErpExecutionDependencies } from './runtime';
import { createSupabaseErpStore } from './runtime-store';
import { createSupabaseErpSyncStore } from './runtime-sync-store';
import { applyErpDelta } from './runtime-sync';
import { vendorBillBalance } from './purchasing';
import { trialBalance, profitAndLoss } from './accounting/reports';
import type { FinancialAuthority } from './accounting/ledger';
import type { Contact } from './invoicing';
import type { ErpCommand, ErpCommit, ErpRequest } from './runtime-types';
import { executeUsTaxInvoiceTest } from './us-tax-invoice';
import { createSupabaseUsTaxOperationStore } from './us-tax-operation-store';
import { STRIPE_TAX_API_VERSION, type ResolvedStripeTaxRequest, type StripeTaxTestBinding } from './stripe-tax-resolved-request';
import type { StripeTaxCalculationObservation } from './stripe-tax-calculation';

// Actual engine/store/RPC against the full local PostgreSQL migration chain.
// One serialized RAM PGlite connection; Auth/D1 are trusted synthetic ports.
// No hosted Auth, Stripe call, two-connection concurrency, crash durability,
// production admission or general purchasing/tax compliance proof.
const moduleDirectory = process.env.PGLITE_MODULE_DIR;
const enabled = Boolean(moduleDirectory && isAbsolute(moduleDirectory));
type Sql = { exec(sql: string): Promise<unknown>; query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> };
type Database = Sql & { transaction<T>(task: (sql: Sql) => Promise<T>): Promise<T>; close(): Promise<void> };
type MutableCommit = { -readonly [K in keyof ErpCommit]: ErpCommit[K] };
let db: Database;
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const serviceSql = <T = Record<string, unknown>>(query: string, values: unknown[] = []) => db.transaction(async tx => {
  await tx.exec('set local role service_role'); return (await tx.query<T>(query, values)).rows;
});
const result = async <T = unknown>(query: string, values: unknown[]) => (await serviceSql<{ result: T }>(query, values))[0].result;
const commitSql = 'select public.zentra_commit_us_erp($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb) result';
const commitValues = (c: ErpCommit) => [c.organizationId,c.expectedRevision,JSON.stringify(c.header),JSON.stringify(c.changes),JSON.stringify(c.ledgerAudit),JSON.stringify(c.receipt),JSON.stringify(c.actor)];
const rpcQueries: Record<string, { sql: string; keys: string[] }> = {
  zentra_read_us_erp: { sql: 'select public.zentra_read_us_erp($1) result', keys: ['p_organization'] },
  zentra_read_us_erp_v2: { sql: 'select public.zentra_read_us_erp_v2($1) result', keys: ['p_organization'] },
  zentra_us_erp_receipt: { sql: 'select public.zentra_us_erp_receipt($1,$2) result', keys: ['p_organization','p_idempotency_key'] },
  zentra_us_erp_receipt_v2: { sql: 'select public.zentra_us_erp_receipt_v2($1,$2) result', keys: ['p_organization','p_idempotency_key'] },
  zentra_commit_us_erp: { sql: commitSql, keys: ['p_organization','p_expected_revision','p_header','p_changes','p_ledger_audit','p_receipt','p_actor'] },
  zentra_us_erp_revision: { sql: 'select public.zentra_us_erp_revision($1) result', keys: ['p_organization'] },
  zentra_us_erp_revision_v2: { sql: 'select public.zentra_us_erp_revision_v2($1) result', keys: ['p_organization'] },
  zentra_us_erp_delta: { sql: 'select public.zentra_us_erp_delta($1,$2,$3) result', keys: ['p_organization','p_after_revision','p_limit'] },
  zentra_us_erp_delta_v2: { sql: 'select public.zentra_us_erp_delta_v2($1,$2,$3) result', keys: ['p_organization','p_after_revision','p_limit'] },
  zentra_read_us_tax_operation: { sql: 'select public.zentra_read_us_tax_operation($1,$2,$3,$4::jsonb) result', keys: ['p_organization','p_erp_idempotency_key','p_command_hash','p_actor'] },
  zentra_reserve_us_tax_operation: { sql: 'select public.zentra_reserve_us_tax_operation($1,$2::jsonb,$3::uuid,$4,$5,$6,$7,$8) result', keys: ['p_organization','p_actor','p_operation_id','p_resolved_body','p_resolved_sha256','p_params_body','p_params_sha256','p_provider_idempotency_key'] },
  zentra_record_us_tax_calculation: { sql: 'select public.zentra_record_us_tax_calculation($1,$2::uuid,$3::jsonb,$4,$5,$6::jsonb) result', keys: ['p_organization','p_operation_id','p_actor','p_proof_body','p_proof_sha256','p_assessment'] },
  zentra_commit_us_tax_invoice_test: { sql: 'select public.zentra_commit_us_tax_invoice_test($1,$2::uuid,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb) result', keys: ['p_organization','p_operation_id','p_expected_revision','p_header','p_changes','p_ledger_audit','p_receipt','p_actor'] },
};
function localClient() {
  const calls: string[] = [], hooks: { loseCommit?: boolean; rollbackCommit?: boolean } = {};
  const rpc: SupabaseServerClient['rpc'] = async <T>(name: string, params: Record<string, unknown>): Promise<T> => {
    calls.push(name); const query = rpcQueries[name]; if (!query) throw new Error('Unexpected local RPC');
    try {
      const returned = await db.transaction(async tx => {
        await tx.exec('set local role service_role');
        const values = query.keys.map(key => typeof params[key] === 'object' ? JSON.stringify(params[key]) : params[key]);
        const rows = await tx.query<{ result: T }>(query.sql,values);
        if (name === 'zentra_commit_us_erp' && hooks.rollbackCommit) { hooks.rollbackCommit=false;throw new Error('Synthetic transaction rollback'); }
        return rows.rows[0].result;
      });
      if (name === 'zentra_commit_us_erp' && hooks.loseCommit) { hooks.loseCommit=false;throw new SupabaseServerError(503,'synthetic_result_lost'); }
      return returned;
    } catch (error) {
      if (error instanceof SupabaseServerError) throw error;
      throw new SupabaseServerError(400,error && typeof error==='object' && 'code' in error && typeof error.code==='string' ? error.code : 'synthetic_sql_failure');
    }
  };
  return { client: { rpc }, calls, hooks };
}
async function fixture(basis: 'cash'|'accrual'='accrual', capability: 1|2=2) {
  const org=randomUUID(),user=randomUUID(), now='2026-10-08T08:00:00.000Z';
  const actor: FinancialAuthority={organizationId:org,userId:user,role:'owner',managementEntitled:true,timestamp:now};
  const configuration=validateCompanyConfiguration({schemaVersion:1,organizationId:org,country:'US',currency:'USD',language:'en',timeZone:'America/New_York',address:{country:'US',line1:'1 Local Fixture Street',city:'New York',subdivision:'NY',postalCode:'10001'},accountingBasis:basis,invoiceNumberPrefix:'INV',taxConfiguration:{status:'unconfigured'}});
  await result('select public.zentra_admit_new_us_workspace_v1($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::jsonb,$6) result',[org,randomUUID(),user,randomUUID(),JSON.stringify(configuration),digest(org)]);
  const ports=localClient(),store=createSupabaseErpStore(ports.client,{supportedSchemaVersion:capability});
  const revalidate=vi.fn(async()=>actor),taxProvider=vi.fn(async()=>null);
  const dependencies={store,configuration,actor,revalidate:revalidate as ErpExecutionDependencies['revalidate'],taxProvider};
  const vendor:Contact={id:'vendor',organizationId:org,kind:'business',name:'Swiss vendor fixture',billingAddress:{country:'CH',line1:'1 Rue du Test',postalCode:'1201',city:'Geneva',subdivision:'GE'},email:'vendor@example.invalid',paymentTermsDays:30};
  const bill:ErpCommand={type:'record_vendor_bill',id:'bill',vendorId:'vendor',reference:'SUP-2026-1',date:'2026-10-08',accountingDate:'2026-10-08',dueDate:'2026-11-07',periodId:'current',netMinor:'10000',purchaseTaxMinor:'825',expenseAccountId:'purchases',sourceReference:'Manual local fixture'};
  const payment:ErpCommand={type:'record_vendor_payment',id:'payment',billId:'bill',amountMinor:'5000',paymentDate:'2026-10-08',accountingDate:'2026-10-08',periodId:'current',reference:'Manual payment fixture'};
  const request=async(command:ErpCommand,key:string=randomUUID()):Promise<ErpRequest>=>({idempotencyKey:key,expectedRevision:(await store.read(org))?.revision??0,command});
  const send=async(command:ErpCommand,key?:string)=>executeErp(dependencies,await request(command,key));
  await send({type:'initialize',periods:[{id:'current',start:'2026-01-01',end:'2026-12-31',status:'open'}]});
  const prepare=async(command:ErpCommand):Promise<MutableCommit>=>{
    let captured:MutableCommit|undefined;const stopped=new Error('Local draft capture');
    const req=await request(command);
    try {await executeErp({...dependencies,store:{...store,commit:async input=>{captured=clone(input);throw stopped;}}},req);} catch(error){if(error!==stopped)throw error;}
    if(!captured)throw new Error('No computed commit');return captured;
  };
  const snapshot=async()=>serviceSql('select (select row_to_json(h)::text from public.zentra_us_erp_heads h where organization_id=$1) head,(select coalesce(jsonb_agg(row_to_json(r) order by kind,id),\'[]\'::jsonb)::text from public.zentra_us_erp_records r where organization_id=$1) records,(select count(*)::int from public.zentra_us_erp_receipts where organization_id=$1) receipts,(select count(*)::int from public.zentra_us_erp_events where organization_id=$1) events,(select count(*)::int from public.zentra_us_erp_ledger_audit where organization_id=$1) audit',[org]);
  return {org,user,now,actor,configuration,vendor,bill,payment,store,dependencies,...ports,request,send,prepare,snapshot};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
// Explicit synthetic TEST provider observations and financial context. The
// private facts/binding are actually persisted and rechecked by the real RPCs.
// This port neither verifies a provider nor exercises hosted Auth/D1.
function fixtureObservation(resolved: ResolvedStripeTaxRequest, now: string): StripeTaxCalculationObservation {
  const amount = resolved.params.line_items[0].amount, tax = 160;
  const state = { country: 'US', state: 'NY', level: 'state', display_name: 'Fictitious state jurisdiction' };
  return {
    accountId: resolved.binding.accountId, mode: 'test', apiVersion: STRIPE_TAX_API_VERSION, evidenceKind: 'test_fixture', observedAt: now,
    calculation: {
      id: 'taxcalc_FictitiousVertical', object: 'tax.calculation', amount_total: amount + tax, currency: 'usd', customer: null,
      customer_details: { address: { ...resolved.params.customer_details.address, line2: null }, address_source: resolved.params.customer_details.address_source, ip_address: null, tax_ids: [], taxability_override: 'none' },
      expires_at: Math.floor(Date.parse(now) / 1000) + 1800, tax_date: resolved.params.tax_date, livemode: false, shipping_cost: null, ship_from_details: null, tax_amount_exclusive: tax, tax_amount_inclusive: 0,
      line_items: { object: 'list', has_more: false, url: '/v1/tax/calculations/taxcalc_FictitiousVertical/line_items', data: [{ id: 'tax_li_FictitiousVertical', object: 'tax.calculation_line_item', amount, amount_tax: tax, quantity: resolved.params.line_items[0].quantity, reference: 'line', tax_code: 'txcd_99999999', tax_behavior: 'exclusive', livemode: false, product: null,
        tax_breakdown: [
          { amount: tax, taxable_amount: amount, taxability_reason: 'standard_rated', sourcing: 'destination', jurisdiction: state, tax_rate_details: { tax_type: 'sales_tax', display_name: 'Fictitious sales tax', percentage_decimal: '8.0' } },
          { amount: 0, taxable_amount: 0, taxability_reason: 'not_subject_to_tax', sourcing: 'destination', jurisdiction: { ...state, level: 'county', display_name: 'Fictitious county jurisdiction' }, tax_rate_details: null },
        ] } ] },
      tax_breakdown: [{ amount: tax, taxable_amount: amount, taxability_reason: 'standard_rated', inclusive: false, tax_rate_details: { country: 'US', state: 'NY', tax_type: 'sales_tax', percentage_decimal: '8.0', rate_type: 'percentage', flat_amount: null } }],
    },
  };
}
async function issueTestInvoice(f:Fixture) {
  const now=new Date().toISOString(),day=now.slice(0,10),configuration=validateCompanyConfiguration({...f.configuration,taxConfiguration:{status:'configured'}});
  const actor:FinancialAuthority={...f.actor,timestamp:now};f.dependencies.actor=actor;f.dependencies.revalidate=async()=>actor;f.dependencies.configuration=configuration;
  await result('select public.zentra_put_workspace_country_config($1,$2,1,$3::uuid,$4::jsonb) result',[f.org,f.user,randomUUID(),JSON.stringify(configuration)]);
  await f.send({type:'refresh_configuration'});
  const seller={displayName:'Explicit TEST seller',contactEmail:'seller@example.invalid'},facts={schemaVersion:1 as const,legalName:'PRIVATE TEST LEGAL',taxOrigin:configuration.address as Extract<typeof configuration.address,{country:'US'}>,timeZone:'America/New_York'};
  const binding:StripeTaxTestBinding={organizationId:f.org,accountId:'acct_FictitiousPurchasing',mode:'test',apiVersion:STRIPE_TAX_API_VERSION,revision:1,settingsSha256:digest('TEST SETTINGS'),registrationsSha256:digest('TEST REGISTRATIONS'),observedAt:new Date(Date.parse(now)-1000).toISOString(),validUntil:new Date(Date.parse(now)+3600000).toISOString(),evidenceKind:'test_fixture',scope:'erp_invoice_tax'};
  await result('select public.zentra_put_us_seller_profile($1,$2,0,$3::uuid,$4::jsonb) result',[f.org,f.user,randomUUID(),JSON.stringify(seller)]);
  await result('select public.zentra_put_us_tax_profile($1,$2,0,$3::uuid,$4::jsonb) result',[f.org,f.user,randomUUID(),JSON.stringify(facts)]);
  await result('select public.zentra_put_us_tax_provider_binding($1,$2,0,$3::uuid,$4::jsonb) result',[f.org,f.user,randomUUID(),JSON.stringify(binding)]);
  await f.send({type:'save_customer',customer:{...f.vendor,id:'tax-customer',billingAddress:configuration.address}});
  await f.send({type:'save_estimate',id:'tax-estimate',expectedEstimateRevision:0,customerId:'tax-customer',date:day,expiresAt:'2026-12-31',paymentTermsDays:30,lines:[{id:'line',description:'Explicit TEST service',quantityUnits:'2',quantityScale:0,unitPrice:{currency:'USD',minorUnits:'1000'},discountBasisPoints:0,taxTreatment:'taxable'}],notes:'Synthetic TEST only'});
  await f.send({type:'accept_estimate',estimateId:'tax-estimate',expectedEstimateRevision:1});
  const calculate=vi.fn(async(resolved:ResolvedStripeTaxRequest)=>fixtureObservation(resolved,now)),verify=vi.fn(async()=>undefined);
  const request=await f.request({type:'issue_invoice',id:'tax-invoice',estimateId:'tax-estimate',expectedEstimateRevision:2,date:day,accountingDate:day,dueDate:day,periodId:'current'},'tax-invoice');
  const dependencies={erp:{store:f.store,configuration,actor,revalidate:async()=>actor},contexts:{read:async()=>({organizationId:f.org,actor,recordedAt:now,countryRevision:2,configuration,sellerRevision:1,seller,taxFactsRevision:1,taxFacts:facts,binding})},operations:createSupabaseUsTaxOperationStore(f.client),gateway:{verify,calculate},classifications:async()=>[{lineId:'line',taxCode:'txcd_99999999',kind:'service' as const,taxBehavior:'exclusive' as const,revision:1,evidenceReference:'Synthetic TEST classification'}],transactionLocation:async()=>({taxDateInstant:day+'T12:00:00Z',addressSource:'billing' as const}),operationId:()=>randomUUID(),now:()=>now,allowTestFixtures:true};
  const response=await executeUsTaxInvoiceTest(dependencies,request);return {response,dependencies,request,calculate};
}
let historical:Fixture, historicalBytes:unknown, chOrg:string, chBefore:unknown;
const history=async(org:string)=>serviceSql('select (select header::text from public.zentra_us_erp_heads where organization_id=$1) head,(select jsonb_agg(receipt order by revision)::text from public.zentra_us_erp_receipts where organization_id=$1) receipts,(select jsonb_agg(event order by revision)::text from public.zentra_us_erp_events where organization_id=$1) events,(select jsonb_agg(row_to_json(r) order by kind,id)::text from public.zentra_us_erp_records r where organization_id=$1) records,(select jsonb_agg(row_to_json(a) order by revision)::text from public.zentra_us_erp_ledger_audit a where organization_id=$1) audit,(select jsonb_agg(row_to_json(o) order by operation_id)::text from public.zentra_us_tax_operations o where organization_id=$1) tax_operations,(select jsonb_agg(row_to_json(l) order by invoice_id)::text from public.zentra_us_tax_invoice_links l where organization_id=$1) tax_links',[org]);

describe.runIf(enabled)('purchasing capability2 real PostgreSQL',()=>{
  beforeAll(async()=>{
    expect(JSON.parse(await readFile(join(moduleDirectory!,'package.json'),'utf8')).name).toBe('@electric-sql/pglite');
    const {PGlite}=createRequire(import.meta.url)(join(moduleDirectory!,'dist/index.cjs')) as {PGlite:new()=>Database};db=new PGlite();
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);grant usage on schema public to service_role;');
    for(const name of ['202609140100_company_profiles','202609140200_company_collaboration','202609200300_company_content','20261007194528_international_workspace_country_config','20261007222349_international_us_erp_persistence','20261007224820_international_us_erp_delta_stream','20261007225725_international_us_erp_seller_snapshot','20261008001726_new_us_workspace_admission','20261008013200_international_tax_proof_allowlist','20261008034422_international_us_seller_profile','20261008044402_international_us_tax_profile','20261008060826_international_us_tax_operations'])await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`,import.meta.url),'utf8'));
    historical=await fixture('accrual',1);
    await historical.send({type:'save_customer',customer:{...historical.vendor,id:'historic-customer'}});
    await issueTestInvoice(historical);
    historicalBytes=await history(historical.org);
    chOrg=randomUUID();await db.query('insert into public.zentra_workspaces(organization_id,revision,updated_by,number_floors) values($1,7,$2,\'[7]\'::jsonb)',[chOrg,'CH-OWNER-SENTINEL']);
    chBefore=(await db.query('select row_to_json(w)::text from public.zentra_workspaces w where organization_id=$1',[chOrg])).rows;
    await db.exec(await readFile(new URL('../../supabase/migrations/20261008081825_international_us_purchasing_v2.sql',import.meta.url),'utf8'));
  },30_000);
  afterAll(async()=>{await db?.close();});

  it('preserves pre-migration v1 head, five-field receipts and immutable events byte-for-byte',async()=>{
    expect(await history(historical.org)).toEqual(historicalBytes);
    const legacy=await historical.store.read(historical.org);
    expect(legacy?.schemaVersion).toBe(1);expect(legacy).not.toHaveProperty('vendors');
    expect(await createSupabaseErpStore(historical.client,{supportedSchemaVersion:2}).read(historical.org)).toEqual(legacy);
    expect(legacy?.invoices).toHaveLength(1);expect(legacy?.ledger.entries).toHaveLength(1);
    expect(await result('select public.zentra_us_erp_revision($1) result',[historical.org])).toMatchObject({schemaVersion:1,revision:7});
    expect(await result('select public.zentra_us_erp_revision_v2($1) result',[historical.org])).toMatchObject({schemaVersion:2,revision:7});
    expect((await db.query('select row_to_json(w)::text from public.zentra_workspaces w where organization_id=$1',[chOrg])).rows).toEqual(chBefore);
  });
  it.each(['cash','accrual'] as const)('runs vendor → bill → partial/final payments with exact %s cost and durable balance',async basis=>{
    const f=await fixture(basis),initial=(await f.store.read(f.org))!;
    expect(initial.schemaVersion).toBe(1);expect(initial).not.toHaveProperty('vendors');
    await f.send({type:'save_vendor',vendor:f.vendor});await f.send(f.bill);
    const billState=(await f.store.read(f.org))!;
    expect(billState.schemaVersion).toBe(2);expect(billState.vendorBills?.[0]).toMatchObject({vendorSnapshot:f.vendor,approvalSource:'manual_entry',validatedBy:f.user,approvedAt:f.now,recordedRevision:3,total:{currency:'USD',minorUnits:'10825'}});
    expect(billState.ledger.entries).toHaveLength(basis==='accrual'?1:0);
    if(basis==='accrual')expect(billState.ledger.entries[0].lines).toEqual([{accountId:'purchases',debitMinor:'10825',creditMinor:'0'},{accountId:'payables',debitMinor:'0',creditMinor:'10825'}]);
    await f.send(f.payment,'partial-payment');await f.send({...f.payment,id:'final-payment',amountMinor:'5825'},'final-payment');
    const state=(await f.store.read(f.org))!;
    expect(vendorBillBalance(state.vendorBills![0],state.vendorPayments!)).toEqual({currency:'USD',minorUnits:'0'});
    expect(state.vendorPayments?.map(p=>p.recordedRevision)).toEqual([4,5]); // Chronology is independent of entity id ordering.
    expect(state.counters).toEqual({estimate:0,invoice:0});
    expect(state.ledger.entries.at(-1)?.lines).toEqual([{accountId:basis==='accrual'?'payables':'purchases',debitMinor:'5825',creditMinor:'0'},{accountId:'cash',debitMinor:'0',creditMinor:'5825',description:'final-payment'}]);
    expect(state.ledger.entries.flatMap(e=>e.lines).some(l=>l.accountId==='tax-receivable')).toBe(false);
    expect(profitAndLoss(state.ledger,{start:'2026-01-01',end:'2026-12-31'}).expenseMinor).toBe('10825');expect(trialBalance(state.ledger,'2026-12-31').balanced).toBe(true);
    expect(f.dependencies.taxProvider).not.toHaveBeenCalled();
    const delta=(await createSupabaseErpSyncStore(f.client,{supportedSchemaVersion:2}).changes(f.org,1,100))!;
    expect(delta.schemaVersion).toBe(2);expect(delta.events.map(e=>e.schemaVersion)).toEqual([2,2,2,2]);
    expect(applyErpDelta(initial,delta,f.org,2)).toEqual(state);
    expect(await f.snapshot()).toMatchObject([{receipts:5,events:5,audit:basis==='accrual'?3:2}]);
  });
  it('applies historical events1 followed by promotion event2 without rewriting archived headers',async()=>{
    const f=await fixture(),init=(await f.store.read(f.org))!;await f.send({type:'save_customer',customer:{...f.vendor,id:'customer'}});
    const old=await history(f.org);await f.send({type:'save_vendor',vendor:f.vendor});
    const delta=(await createSupabaseErpSyncStore(f.client,{supportedSchemaVersion:2}).changes(f.org,1,100))!;
    expect(delta.events.map(e=>e.schemaVersion)).toEqual([1,2]);expect(delta.events[0].header.schemaVersion).toBe(1);
    expect(applyErpDelta(init,delta,f.org,2)).toEqual(await f.store.read(f.org));
    expect((await serviceSql('select jsonb_agg(event order by revision)::text events from public.zentra_us_erp_events where organization_id=$1 and revision<=2',[f.org]))[0].events).toBe((old[0] as {events:string}).events);
  });
  it('blocks all old getters and old commit replay after promotion, but v2 retains the original receipt',async()=>{
    const f=await fixture(),legacyStore=createSupabaseErpStore(f.client),req=await f.request({type:'save_customer',customer:{...f.vendor,id:'old-customer'}});
    const receipt=(await executeErp(f.dependencies,req)).receipt;await f.send({type:'save_vendor',vendor:f.vendor});
    for(const rpc of ['zentra_read_us_erp','zentra_us_erp_receipt','zentra_us_erp_revision','zentra_us_erp_delta']){
      const query=rpcQueries[rpc];const values=query.keys.map(k=>k==='p_organization'?f.org:k==='p_idempotency_key'?req.idempotencyKey:k==='p_after_revision'?0:50);
      await expect(result(query.sql,values)).rejects.toMatchObject({code:'PU008'});
    }
    await expect(legacyStore.read(f.org)).rejects.toMatchObject({code:'client_upgrade_required',status:409});
    expect(await f.store.receipt(f.org,req.idempotencyKey)).toEqual(receipt);
    expect(await executeErp(f.dependencies,req)).toEqual({receipt,replayed:true});
    const state=(await f.store.read(f.org))!;
    const replay:MutableCommit={organizationId:f.org,expectedRevision:1,header:{schemaVersion:1,revision:2,configuration:f.configuration,counters:state.counters,ledger:{...state.ledger,entries:undefined,audit:undefined} as unknown as ErpCommit['header']['ledger']},changes:[],ledgerAudit:[],receipt,actor:f.actor};
    await expect(result(commitSql,commitValues(replay))).rejects.toMatchObject({code:'PU008'});
    replay.header={...replay.header,schemaVersion:2};expect(await result(commitSql,commitValues(replay))).toEqual(receipt);
  });
  it.each(['lost_response','outer_rollback'] as const)('retries %s with the exact key and no duplicate bill, journal, receipt or event',async failure=>{
    const f=await fixture();await f.send({type:'save_vendor',vendor:f.vendor});const req=await f.request(f.bill);
    if(failure==='lost_response')f.hooks.loseCommit=true;else f.hooks.rollbackCommit=true;
    await expect(executeErp(f.dependencies,req)).rejects.toMatchObject({status:503});
    const before=(await f.store.read(f.org))!;expect(before.vendorBills).toHaveLength(failure==='lost_response'?1:0);
    const response=await executeErp(f.dependencies,req);expect(response.replayed).toBe(failure==='lost_response');
    expect(await f.snapshot()).toMatchObject([{receipts:3,events:3,audit:1}]);
    const state=(await f.store.read(f.org))!;expect(state.vendorBills).toHaveLength(1);expect(state.ledger.entries).toHaveLength(1);
    await f.send({type:'save_vendor',vendor:{...f.vendor,name:'Later vendor name'}});
    expect(await executeErp(f.dependencies,req)).toEqual({receipt:response.receipt,replayed:true});
    expect((await f.store.read(f.org))?.vendorBills?.[0].vendorSnapshot.name).toBe(f.vendor.name);
  });
  it.each(['owner','admin','accountant'] as const)('admits purchasing with trusted financial role %s',async role=>{
    const f=await fixture();const actor={...f.actor,role};f.dependencies.actor=actor;f.dependencies.revalidate=async()=>actor;
    await f.send({type:'save_vendor',vendor:f.vendor});await f.send(f.bill);await f.send(f.payment);
    expect((await f.store.read(f.org))?.vendorPayments).toHaveLength(1);
  });
  it.each(['member','read_only'] as const)('rejects %s at the engine and SQL operation gates without writes',async role=>{
    const f=await fixture();await f.send({type:'save_vendor',vendor:f.vendor});const draft=await f.prepare(f.bill),before=await f.snapshot();
    f.dependencies.actor={...f.actor,role};f.dependencies.revalidate=async()=>f.dependencies.actor;
    await expect(f.send(f.bill)).rejects.toMatchObject({status:403});draft.actor={...draft.actor,role};
    await expect(result(commitSql,commitValues(draft))).rejects.toMatchObject({code:'PU004'});expect(await f.snapshot()).toEqual(before);
  });
  it.each(['bill_id','journal_lines','vendor_snapshot','actor','revision','approval','audit','extra_record','period','counter','tax_currency','extra_field'] as const)('rolls back malformed bill effect %s including head/counters/history',async kind=>{
    const f=await fixture();await f.send({type:'save_vendor',vendor:f.vendor});const draft=await f.prepare(f.bill),before=await f.snapshot();
    const bill=draft.changes.find(c=>c.kind==='vendor_bill')!.payload as Record<string,unknown>,journal=draft.changes.find(c=>c.kind==='journal')!.payload as Record<string,unknown>;
    if(kind==='bill_id')bill.id='different';if(kind==='journal_lines')journal.lines=[{accountId:'purchases',debitMinor:'10824',creditMinor:'0'},{accountId:'payables',debitMinor:'0',creditMinor:'10824'}];
    if(kind==='vendor_snapshot')bill.vendorSnapshot={...f.vendor,name:'Not the admitted snapshot'};if(kind==='actor')bill.validatedBy='different';if(kind==='revision')bill.recordedRevision=2;if(kind==='approval')bill.approvalSource='provider_verified';
    if(kind==='audit')draft.ledgerAudit=[];if(kind==='extra_record')draft.changes=[...draft.changes,{kind:'customer',id:'smuggled',payload:{...f.vendor,id:'smuggled'}}];
    if(kind==='period')bill.periodId='missing';if(kind==='counter')draft.header={...draft.header,counters:{...draft.header.counters,invoice:1}};
    if(kind==='tax_currency')bill.tax={currency:'CHF',minorUnits:'825'};if(kind==='extra_field')bill.providerGrant=true;
    await expect(result(commitSql,commitValues(draft))).rejects.toBeDefined();expect(await f.snapshot()).toEqual(before);
  });
  it('enforces immutable supplier bills/payments even direct service_role, plus no downgrade or orphan rows',async()=>{
    const f=await fixture();await f.send({type:'save_vendor',vendor:f.vendor});await f.send(f.bill);await f.send(f.payment);const before=await f.snapshot();
    for(const kind of ['vendor_bill','vendor_payment'])await expect(serviceSql('update public.zentra_us_erp_records set payload=payload||\'{"reference":"changed"}\'::jsonb,state_revision=state_revision+1 where organization_id=$1 and kind=$2',[f.org,kind])).rejects.toBeDefined();
    await expect(serviceSql('update public.zentra_us_erp_heads set revision=revision+1,header=jsonb_set(jsonb_set(header,\'{schemaVersion}\',\'1\'::jsonb),\'{revision}\',to_jsonb(revision+1)) where organization_id=$1',[f.org])).rejects.toMatchObject({code:'PU008'});
    await expect(serviceSql('insert into public.zentra_us_erp_records values($1,\'vendor\',\'orphan\',$2::jsonb,4)',[f.org,JSON.stringify({...f.vendor,id:'orphan'})])).rejects.toMatchObject({code:'PU004'});
    expect(await f.snapshot()).toEqual(before);
  });
  it.each(['approvalSource','expenseAccountId','currency','approvedAt'] as const)('rejects JSON null %s before committing an unreadable bill',async field=>{
    const f=await fixture();await f.send({type:'save_vendor',vendor:f.vendor});const draft=await f.prepare(f.bill),before=await f.snapshot();
    (draft.changes.find(c=>c.kind==='vendor_bill')!.payload as Record<string,unknown>)[field]=null;
    await expect(result(commitSql,commitValues(draft))).rejects.toMatchObject({code:'PU004'});expect(await f.snapshot()).toEqual(before);
  });
  it.each(['\u00a0','\ufeff'] as const)('keeps PostgreSQL and browser Contact email validation aligned for whitespace %j',async whitespace=>{
    const f=await fixture(),draft=await f.prepare({type:'save_vendor',vendor:f.vendor}),before=await f.snapshot(),email='a@b'+whitespace+'.co';
    (draft.changes[0].payload as Record<string,unknown>).email=email;
    await expect(result(commitSql,commitValues(draft))).rejects.toMatchObject({code:'PU004'});expect(await f.snapshot()).toEqual(before);
    const request={idempotencyKey:'invalid-email',expectedRevision:1,command:{type:'save_vendor' as const,vendor:{...f.vendor,email}}};
    const calls=f.calls.length;await expect(executeErp(f.dependencies,request)).rejects.toMatchObject({code:'invalid_email',status:422});expect(f.calls).toHaveLength(calls);
  });
  it.each(['receipt','audit'] as const)('rejects injected private fields in purchasing %s rather than capturing them in public events',async field=>{
    const f=await fixture();await f.send({type:'save_vendor',vendor:f.vendor});const draft=await f.prepare(f.bill),before=await f.snapshot();
    if(field==='receipt')draft.receipt={...draft.receipt,privateProviderData:'not allowed'} as ErpCommit['receipt'];
    else draft.ledgerAudit=draft.ledgerAudit.map(a=>({...a,privateProviderData:'not allowed'}));
    await expect(result(commitSql,commitValues(draft))).rejects.toMatchObject({code:'PU004'});expect(await f.snapshot()).toEqual(before);
  });
  it.each(['2026-10-08T08:00:00.1Z','2026-10-08T08:00:00.123456Z','2026-02-30T08:00:00.000Z'] as const)('refuses purchase stamp %s instead of persisting unreadable privileged data',async stamp=>{
    const f=await fixture();await f.send({type:'save_vendor',vendor:f.vendor});const draft=await f.prepare(f.bill),before=await f.snapshot();
    draft.actor={...draft.actor,timestamp:stamp};(draft.changes.find(c=>c.kind==='vendor_bill')!.payload as Record<string,unknown>).approvedAt=stamp;
    (draft.changes.find(c=>c.kind==='journal')!.payload as Record<string,unknown>).postedAt=stamp;draft.ledgerAudit=draft.ledgerAudit.map(a=>({...a,timestamp:stamp}));
    await expect(result(commitSql,commitValues(draft))).rejects.toMatchObject({code:'PU004'});expect(await f.snapshot()).toEqual(before);
  });
  it('captures the last fresh authority timestamp, while valid whole-second and millisecond stamps remain readable',async()=>{
    const f=await fixture();await f.send({type:'save_vendor',vendor:f.vendor});let tick=0;
    f.dependencies.revalidate=async()=>({...f.actor,timestamp:new Date(Date.parse(f.now)+ ++tick).toISOString()});
    await f.send(f.bill);const state=(await f.store.read(f.org))!;
    expect(state.vendorBills?.[0].approvedAt).toBe(state.ledger.entries[0].postedAt);expect(state.ledger.audit[0].timestamp).toBe(state.ledger.entries[0].postedAt);
    const draft=await f.prepare({...f.payment,id:'whole-second'});draft.actor={...draft.actor,timestamp:'2026-10-08T08:00:01Z'};
    (draft.changes.find(c=>c.kind==='vendor_payment')!.payload as Record<string,unknown>).recordedAt=draft.actor.timestamp;
    (draft.changes.find(c=>c.kind==='journal')!.payload as Record<string,unknown>).postedAt=draft.actor.timestamp;draft.ledgerAudit=draft.ledgerAudit.map(a=>({...a,timestamp:draft.actor.timestamp}));
    await result(commitSql,commitValues(draft));expect((await f.store.read(f.org))?.vendorPayments?.[0].recordedAt).toBe('2026-10-08T08:00:01Z');
    const delta=(await createSupabaseErpSyncStore(f.client,{supportedSchemaVersion:2}).changes(f.org,state.revision,100))!;
    expect(delta.events[0].occurredAt).toBe('2026-10-08T08:00:01.000Z');expect(applyErpDelta(state,delta,f.org,2)).toEqual(await f.store.read(f.org));
  });
  it.each(['save_customer','close_period'] as const)('rolls back direct privileged orphan bill plus unrelated %s receipt',async action=>{
    const f=await fixture();await f.send({type:'save_vendor',vendor:f.vendor});const draft=await f.prepare(f.bill),before=await f.snapshot();
    const payload=draft.changes.find(c=>c.kind==='vendor_bill')!.payload as Record<string,unknown>;
    payload.vendorId='orphan-vendor';payload.vendorSnapshot={...f.vendor,id:'orphan-vendor'};
    const receipt={...draft.receipt,action};
    await expect(db.transaction(async tx=>{
      await tx.exec('set local role service_role');
      await tx.query('update public.zentra_us_erp_heads set revision=$2,header=$3::jsonb where organization_id=$1',[f.org,draft.header.revision,JSON.stringify(draft.header)]);
      for(const c of draft.changes)await tx.query('insert into public.zentra_us_erp_records values($1,$2,$3,$4::jsonb,$5)',[f.org,c.kind,c.id,JSON.stringify(c.payload),draft.header.revision]);
      await tx.query('insert into public.zentra_us_erp_receipts values($1,$2,$3,$4,$5::jsonb,$6,now())',[f.org,receipt.idempotencyKey,receipt.commandHash,receipt.revision,JSON.stringify(receipt),f.user]);
    })).rejects.toMatchObject({code:'PU004'});expect(await f.snapshot()).toEqual(before);
  });
  it.each(['audit_actor','audit_entity','audit_private_field','receipt_private_field','counter','ledger_gap'] as const)('rolls back privileged same-action purchasing completion with %s corruption',async kind=>{
    const f=await fixture();await f.send({type:'save_vendor',vendor:f.vendor});const draft=await f.prepare(f.bill),before=await f.snapshot();
    if(kind==='audit_actor')draft.ledgerAudit=draft.ledgerAudit.map(a=>({...a,actorId:'wrong-actor'}));
    if(kind==='audit_entity')draft.ledgerAudit=draft.ledgerAudit.map(a=>({...a,entityId:'wrong-journal'}));
    if(kind==='audit_private_field')draft.ledgerAudit=draft.ledgerAudit.map(a=>({...a,privateFacts:'not allowed'}));
    if(kind==='receipt_private_field')draft.receipt={...draft.receipt,privateFacts:'not allowed'} as ErpCommit['receipt'];
    if(kind==='counter')draft.header={...draft.header,counters:{estimate:0,invoice:1}};
    if(kind==='ledger_gap'){
      draft.header={...draft.header,ledger:{...draft.header.ledger,revision:2}};
      (draft.changes.find(c=>c.kind==='journal')!.payload as Record<string,unknown>).revision=2;draft.ledgerAudit=draft.ledgerAudit.map(a=>({...a,revision:2}));
    }
    await expect(db.transaction(async tx=>{
      await tx.exec('set local role service_role');
      await tx.query('update public.zentra_us_erp_heads set revision=$2,header=$3::jsonb where organization_id=$1',[f.org,draft.header.revision,JSON.stringify(draft.header)]);
      for(const c of draft.changes)await tx.query('insert into public.zentra_us_erp_records values($1,$2,$3,$4::jsonb,$5)',[f.org,c.kind,c.id,JSON.stringify(c.payload),draft.header.revision]);
      for(const a of draft.ledgerAudit)await tx.query('insert into public.zentra_us_erp_ledger_audit values($1,$2,$3::jsonb,$4)',[f.org,a.revision,JSON.stringify(a),draft.header.revision]);
      await tx.query('insert into public.zentra_us_erp_receipts values($1,$2,$3,$4,$5::jsonb,$6,$7::timestamptz)',[f.org,draft.receipt.idempotencyKey,draft.receipt.commandHash,draft.receipt.revision,JSON.stringify(draft.receipt),f.user,draft.actor.timestamp]);
    })).rejects.toMatchObject({code:'PU004'});expect(await f.snapshot()).toEqual(before);
  });
  it.each(['bill','payment'] as const)('rejects direct complete %s transaction whose event instant differs from financial approval',async kind=>{
    const f=await fixture(kind==='bill'?'cash':'accrual');await f.send({type:'save_vendor',vendor:f.vendor});if(kind==='payment')await f.send(f.bill);
    const draft=await f.prepare(kind==='bill'?f.bill:f.payment),before=await f.snapshot();
    await expect(db.transaction(async tx=>{
      await tx.exec('set local role service_role');
      await tx.query('update public.zentra_us_erp_heads set revision=$2,header=$3::jsonb where organization_id=$1',[f.org,draft.header.revision,JSON.stringify(draft.header)]);
      for(const c of draft.changes)await tx.query('insert into public.zentra_us_erp_records values($1,$2,$3,$4::jsonb,$5)',[f.org,c.kind,c.id,JSON.stringify(c.payload),draft.header.revision]);
      for(const a of draft.ledgerAudit)await tx.query('insert into public.zentra_us_erp_ledger_audit values($1,$2,$3::jsonb,$4)',[f.org,a.revision,JSON.stringify(a),draft.header.revision]);
      await tx.query('insert into public.zentra_us_erp_receipts values($1,$2,$3,$4,$5::jsonb,$6,$7::timestamptz)',[f.org,draft.receipt.idempotencyKey,draft.receipt.commandHash,draft.receipt.revision,JSON.stringify(draft.receipt),f.user,new Date(Date.parse(draft.actor.timestamp)+1000).toISOString()]);
    })).rejects.toMatchObject({code:'PU004'});expect(await f.snapshot()).toEqual(before);
  });
  it('rejects an orphan purchase journal inserted alone at the current schema2 revision',async()=>{
    const f=await fixture();await f.send({type:'save_vendor',vendor:f.vendor});await f.send(f.bill);const before=await f.snapshot();
    const journal={...(await f.store.read(f.org))!.ledger.entries[0],id:'entry:vendor-bill:orphan',idempotencyKey:'vendor-bill:orphan',source:{type:'vendor_bill',id:'orphan'}};
    await expect(serviceSql('insert into public.zentra_us_erp_records values($1,\'journal\',$2,$3::jsonb,3)',[f.org,journal.id,JSON.stringify(journal)])).rejects.toMatchObject({code:'PU004'});expect(await f.snapshot()).toEqual(before);
  });
  it('refuses direct initial head2 even if a matching initialize receipt/event is supplied',async()=>{
    const f=await fixture(),org=randomUUID(),config={...f.configuration,organizationId:org};
    await result('select public.zentra_admit_new_us_workspace_v1($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::jsonb,$6) result',[org,randomUUID(),f.user,randomUUID(),JSON.stringify(config),digest(org)]);
    const old=erpHeader((await f.store.read(f.org))!),header={...old,schemaVersion:2,configuration:config,ledger:{...old.ledger,organizationId:org}};
    const receipt={idempotencyKey:'initial-head2',commandHash:digest('initial-head2'),revision:1,entityId:org,action:'initialize'};
    await expect(db.transaction(async tx=>{
      await tx.exec('set local role service_role');await tx.query('insert into public.zentra_us_erp_heads values($1,1,$2::jsonb,$3,now())',[org,JSON.stringify(header),f.user]);
      await tx.query('insert into public.zentra_us_erp_receipts values($1,$2,$3,1,$4::jsonb,$5,now())',[org,receipt.idempotencyKey,receipt.commandHash,JSON.stringify(receipt),f.user]);
    })).rejects.toMatchObject({code:'PU004'});
    expect(await result('select public.zentra_read_us_erp_v2($1) result',[org])).toBeNull();
  });
  it('blocks duplicate vendor/reference/date while allowing the exact reference on a different date',async()=>{
    const f=await fixture();await f.send({type:'save_vendor',vendor:f.vendor});await f.send(f.bill);const before=await f.snapshot();
    await expect(f.send({...f.bill,id:'duplicate'})).rejects.toMatchObject({code:'vendor_bill_already_recorded',status:409});expect(await f.snapshot()).toEqual(before);
    await f.send({...f.bill,id:'different-date',date:'2026-10-09',accountingDate:'2026-10-09'});expect((await f.store.read(f.org))?.vendorBills).toHaveLength(2);
  });
  it('enforces the duplicate bill tuple in PostgreSQL even when bypassing the engine precheck',async()=>{
    const f=await fixture();await f.send({type:'save_vendor',vendor:f.vendor});await f.send(f.bill);
    const draft=await f.prepare({...f.bill,id:'sql-duplicate',date:'2026-10-09',accountingDate:'2026-10-09'}),before=await f.snapshot();
    const bill=draft.changes.find(c=>c.kind==='vendor_bill')!.payload as Record<string,unknown>,journal=draft.changes.find(c=>c.kind==='journal')!.payload as Record<string,unknown>;
    bill.date='2026-10-08';journal.transactionDate='2026-10-08';const fingerprint=JSON.parse(journal.fingerprint as string) as unknown[];fingerprint[3]='2026-10-08';journal.fingerprint=JSON.stringify(fingerprint);
    await expect(result(commitSql,commitValues(draft))).rejects.toMatchObject({code:'23505',constraint:'zentra_us_erp_vendor_bill_reference'});expect(await f.snapshot()).toEqual(before);
  });
  it('keeps minor units exact above the JavaScript safe-integer range in cost, cash and durable balance',async()=>{
    const f=await fixture(),total='999999999999999999999999999999999999',paid='9007199254740993';
    await f.send({type:'save_vendor',vendor:f.vendor});await f.send({...f.bill,netMinor:total,purchaseTaxMinor:'0'});await f.send({...f.payment,amountMinor:paid});
    const state=(await f.store.read(f.org))!;expect(state.ledger.entries[0].lines[0].debitMinor).toBe(total);expect(state.ledger.entries[1].lines[1].creditMinor).toBe(paid);
    expect(vendorBillBalance(state.vendorBills![0],state.vendorPayments!).minorUnits).toBe((BigInt(total)-BigInt(paid)).toString());expect(trialBalance(state.ledger,'2026-12-31').balanced).toBe(true);
  });
  it('checks overpayment against durable records in SQL, not a client supplied paidBefore',async()=>{
    const f=await fixture();await f.send({type:'save_vendor',vendor:f.vendor});await f.send(f.bill);const draft=await f.prepare(f.payment);
    await f.send({...f.payment,id:'first',amountMinor:'7000'},'first');const before=await f.snapshot();
    draft.expectedRevision=4;draft.header={...draft.header,revision:5,ledger:{...draft.header.ledger,revision:3}};draft.receipt={...draft.receipt,revision:5};
    for(const c of draft.changes){const p=c.payload as Record<string,unknown>;if(c.kind==='vendor_payment')p.recordedRevision=5;if(c.kind==='journal')p.revision=3;}
    draft.ledgerAudit=draft.ledgerAudit.map(a=>({...a,revision:3}));
    await expect(result(commitSql,commitValues(draft))).rejects.toMatchObject({code:'PU004'});expect(await f.snapshot()).toEqual(before);
  });
  it('preserves actual TEST sales proof/link/receipt guards and replays the same invoice across later supplier writes',async()=>{
    const f=await fixture();await f.send({type:'save_vendor',vendor:f.vendor});await f.send(f.bill);const issued=await issueTestInvoice(f);
    const state=(await f.store.read(f.org))!;expect(state.schemaVersion).toBe(2);expect(state.invoices[0]).toMatchObject({id:'tax-invoice',total:{minorUnits:'2160'},sellerSnapshot:{displayName:'Explicit TEST seller'}});
    const privateHistory=await serviceSql('select resolved_body,proof_body,receipt::text from public.zentra_us_tax_operations where organization_id=$1',[f.org]);
    expect(await serviceSql('select count(*)::int links from public.zentra_us_tax_invoice_links where organization_id=$1',[f.org])).toEqual([{links:1}]);
    await f.send(f.payment);const before=await f.snapshot();
    expect(await executeUsTaxInvoiceTest(issued.dependencies,issued.request)).toEqual({receipt:issued.response.receipt,replayed:true});expect(issued.calculate).toHaveBeenCalledTimes(1);expect(await f.snapshot()).toEqual(before);
    expect(await serviceSql('select resolved_body,proof_body,receipt::text from public.zentra_us_tax_operations where organization_id=$1',[f.org])).toEqual(privateHistory);
    const raw=(await serviceSql<{payload:unknown}>('select payload from public.zentra_us_erp_records where organization_id=$1 and kind=\'invoice\'',[f.org]))[0].payload;
    await expect(serviceSql('insert into public.zentra_us_erp_records values($1,\'invoice\',\'forged\',$2::jsonb,$3)',[f.org,JSON.stringify({...raw as object,id:'forged'}),(await f.store.read(f.org))!.revision])).rejects.toMatchObject({code:'PX005'});
  });
  it('preserves isolation and closed periods across real CAS and stale retries',async()=>{
    const f=await fixture(),other=await fixture();await f.send({type:'save_vendor',vendor:f.vendor});await f.send(f.bill);
    const payment=await f.prepare(f.payment);const before=await f.snapshot();payment.actor={...payment.actor,organizationId:other.org};
    await expect(result(commitSql,commitValues(payment))).rejects.toMatchObject({code:'PU004'});expect(await f.snapshot()).toEqual(before);
    payment.actor=f.actor;await f.send({type:'close_period',periodId:'current'});
    await expect(result(commitSql,commitValues(payment))).rejects.toMatchObject({code:'PU001'});
    await expect(f.send(f.payment)).rejects.toMatchObject({code:'accounting_period_not_open',status:409});expect((await other.store.read(other.org))?.schemaVersion).toBe(1);
    expect((await db.query('select row_to_json(w)::text from public.zentra_workspaces w where organization_id=$1',[chOrg])).rows).toEqual(chBefore);
  });
  it.each(['anon','authenticated'] as const)('denies %s SQL/RPC visibility and mutation; new functions use INVOKER and empty search_path',async role=>{
    const f=await fixture();await f.send({type:'save_vendor',vendor:f.vendor});
    for(const fn of ['zentra_read_us_erp_v2','zentra_us_erp_receipt_v2','zentra_us_erp_revision_v2','zentra_us_erp_delta_v2']){
      const q=rpcQueries[fn];await expect(db.transaction(async tx=>{await tx.exec(`set local role ${role}`);return tx.query(q.sql,q.keys.map(k=>k==='p_organization'?f.org:k==='p_idempotency_key'?'missing':k==='p_after_revision'?0:50));})).rejects.toMatchObject({code:'42501'});
    }
    await expect(db.transaction(async tx=>{await tx.exec(`set local role ${role}`);return tx.query('select payload from public.zentra_us_erp_records where organization_id=$1',[f.org]);})).rejects.toMatchObject({code:'42501'});
    const functions=(await db.query<{prosecdef:boolean;proconfig:string[]}>('select prosecdef,proconfig from pg_proc where proname in (\'zentra_read_us_erp_v2\',\'zentra_commit_us_erp\',\'zentra_us_erp_assert_purchase\')')).rows;
    expect(functions).toHaveLength(3);for(const fn of functions){expect(fn.prosecdef).toBe(false);expect(fn.proconfig).toContain('search_path=""');}
  });
});
