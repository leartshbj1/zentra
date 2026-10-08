import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import { validateCompanyConfiguration } from './country-config';
import { executeErp, type ErpExecutionDependencies } from './runtime';
import { createSupabaseErpStore } from './runtime-store';
import { createSupabaseErpSyncStore } from './runtime-sync-store';
import { applyErpDelta } from './runtime-sync';
import { vendorBillBalance } from './purchasing';
import type { ProjectInput } from './projects';
import { trialBalance, profitAndLoss } from './accounting/reports';
import type { FinancialAuthority } from './accounting/ledger';
import type { Contact } from './invoicing';
import type { ErpCommand, ErpCommit, ErpRequest } from './runtime-types';
import { executeUsTaxInvoiceTest } from './us-tax-invoice';
import { createSupabaseUsTaxOperationStore } from './us-tax-operation-store';
import { STRIPE_TAX_API_VERSION, type ResolvedStripeTaxRequest, type StripeTaxTestBinding } from './stripe-tax-resolved-request';
import type { StripeTaxCalculationObservation } from './stripe-tax-calculation';

// Projects: actual engine/store/RPC against the full local PostgreSQL migration chain.
// One serialized RAM PGlite connection; Auth/D1 are trusted synthetic ports.
// No hosted Auth, Stripe call, two-connection concurrency, crash durability,
// production admission or general purchasing/tax compliance proof.
const moduleDirectory = process.env.PGLITE_MODULE_DIR;
const enabled = Boolean(moduleDirectory && isAbsolute(moduleDirectory));
type Sql = { exec(sql: string): Promise<unknown>; query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> };
type Database = Sql & { transaction<T>(task: (sql: Sql) => Promise<T>): Promise<T>; close(): Promise<void> };
type MutableCommit = { -readonly [K in keyof ErpCommit]: ErpCommit[K] };
let db!: Database;
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const serviceSql = <T = Record<string, unknown>>(query: string, values: unknown[] = []) => db.transaction(async tx => {
  await tx.exec('set local role service_role'); return (await tx.query<T>(query, values)).rows;
});
const result = async <T = unknown>(query: string, values: unknown[]) => (await serviceSql<{ result: T }>(query, values))[0].result;
const commitSql = 'select public.zentra_commit_us_erp($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb) result';
const commitValues = (c: ErpCommit) => [c.organizationId,c.expectedRevision,JSON.stringify(c.header),JSON.stringify(c.changes),JSON.stringify(c.ledgerAudit),JSON.stringify(c.receipt),JSON.stringify(c.actor)];
const rpcQueries: Record<string, { sql: string; keys: string[] }> = {
  zentra_read_us_erp_v3: { sql: 'select public.zentra_read_us_erp_v3($1) result', keys: ['p_organization'] },
  zentra_us_erp_receipt_v3: { sql: 'select public.zentra_us_erp_receipt_v3($1,$2) result', keys: ['p_organization','p_idempotency_key'] },
  zentra_us_erp_revision_v3: { sql: 'select public.zentra_us_erp_revision_v3($1) result', keys: ['p_organization'] },
  zentra_us_erp_delta_v3: { sql: 'select public.zentra_us_erp_delta_v3($1,$2,$3) result', keys: ['p_organization','p_after_revision','p_limit'] },
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
async function fixture(basis: 'cash'|'accrual'='accrual', capability: 1|2|3=3) {
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

const project=(id='project',customerId='customer',overrides:Partial<ProjectInput>={}):ProjectInput=>({id,customerId,expectedProjectRevision:0,name:'Approved TEST dossier',status:'active',notes:'Local TEST only',startDate:null,targetDate:null,budgetMinor:'100000',vendorBillIds:[],...overrides});
async function customer(f:Fixture,id='customer'){await f.send({type:'save_customer',customer:{...f.vendor,id}});}
const estimate=(id='estimate',customerId='customer',projectId='project'):ErpCommand=>({type:'save_estimate',id,expectedEstimateRevision:0,customerId,projectId,date:'2026-10-08',expiresAt:'2026-12-31',paymentTermsDays:30,lines:[{id:'line',description:'TEST service',quantityUnits:'1',quantityScale:0,unitPrice:{currency:'USD',minorUnits:'1000'},discountBasisPoints:0,taxTreatment:'taxable'}],notes:''});
const history=async(org:string)=>serviceSql('select (select header::text from public.zentra_us_erp_heads where organization_id=$1) head,(select jsonb_agg(receipt order by revision)::text from public.zentra_us_erp_receipts where organization_id=$1) receipts,(select jsonb_agg(event order by revision)::text from public.zentra_us_erp_events where organization_id=$1) events,(select jsonb_agg(row_to_json(r) order by kind,id)::text from public.zentra_us_erp_records r where organization_id=$1) records,(select jsonb_agg(row_to_json(a) order by revision)::text from public.zentra_us_erp_ledger_audit a where organization_id=$1) audit,(select jsonb_agg(row_to_json(o) order by operation_id)::text from public.zentra_us_tax_operations o where organization_id=$1) tax_operations,(select jsonb_agg(row_to_json(l) order by invoice_id)::text from public.zentra_us_tax_invoice_links l where organization_id=$1) tax_links',[org]);
let v1:Fixture,v2:Fixture,bytes1:unknown,bytes2:unknown,chOrg:string,chBytes:unknown;
describe.runIf(enabled)('project capability3 real PostgreSQL',()=>{
  beforeAll(async()=>{
    expect(JSON.parse(await readFile(join(moduleDirectory!,'package.json'),'utf8')).name).toBe('@electric-sql/pglite');
    const {PGlite}=createRequire(import.meta.url)(join(moduleDirectory!,'dist/index.cjs')) as {PGlite:new()=>Database};db=new PGlite();
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);grant usage on schema public to service_role;');
    for(const name of ['202609140100_company_profiles','202609140200_company_collaboration','202609200300_company_content','20261007194528_international_workspace_country_config','20261007222349_international_us_erp_persistence','20261007224820_international_us_erp_delta_stream','20261007225725_international_us_erp_seller_snapshot','20261008001726_new_us_workspace_admission','20261008013200_international_tax_proof_allowlist','20261008034422_international_us_seller_profile','20261008044402_international_us_tax_profile','20261008060826_international_us_tax_operations','20261008081825_international_us_purchasing_v2'])await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`,import.meta.url),'utf8'));
    v1=await fixture('accrual',1);await customer(v1);await issueTestInvoice(v1);bytes1=await history(v1.org);
    v2=await fixture('accrual',2);await customer(v2);await v2.send({type:'save_vendor',vendor:v2.vendor});await v2.send(v2.bill);bytes2=await history(v2.org);
    chOrg=randomUUID();await db.query('insert into public.zentra_workspaces(organization_id,revision,updated_by,number_floors) values($1,7,$2,\'[7]\'::jsonb)',[chOrg,'CH-OWNER-SENTINEL']);chBytes=(await db.query('select row_to_json(w)::text from public.zentra_workspaces w where organization_id=$1',[chOrg])).rows;
    await db.exec(await readFile(new URL('../../supabase/migrations/20261008105120_international_us_projects_v3.sql',import.meta.url),'utf8'));
  },30_000);
  afterAll(async()=>{await db?.close();});
  it('preserves v1/v2 heads, historical receipts/events/proofs and CH byte-for-byte',async()=>{
    expect(await history(v1.org)).toEqual(bytes1);expect(await history(v2.org)).toEqual(bytes2);
    const cap3=createSupabaseErpStore(v1.client,{supportedSchemaVersion:3});expect(await cap3.read(v1.org)).toEqual(await v1.store.read(v1.org));
    const old2=await createSupabaseErpStore(v2.client,{supportedSchemaVersion:3}).read(v2.org);expect(old2?.schemaVersion).toBe(2);expect(old2).not.toHaveProperty('projects');
    expect((await db.query('select row_to_json(w)::text from public.zentra_workspaces w where organization_id=$1',[chOrg])).rows).toEqual(chBytes);
  });
  it.each([1,2] as const)('promotes version%s only with an explicit batch and keeps all financial values',async version=>{
    const f=await fixture('accrual',version);await customer(f);if(version===2)await f.send({type:'save_vendor',vendor:f.vendor});
    const before=(await f.store.read(f.org))!,store=createSupabaseErpStore(f.client,{supportedSchemaVersion:3});
    const response=await executeErp({...f.dependencies,store},{idempotencyKey:'promote',expectedRevision:before.revision,command:{type:'save_projects',projects:[project('first'),project('second')]}});
    const state=(await store.read(f.org))!;expect(state.schemaVersion).toBe(3);expect(state.revision).toBe(before.revision+1);expect(state.counters).toEqual({...before.counters,project:2});expect(state.ledger).toEqual(before.ledger);expect(response.receipt.entityId).toBe('first');expect(state.projects?.map(p=>p.number).sort()).toEqual(['PRJ-000001','PRJ-000002']);
    const delta=await createSupabaseErpSyncStore(f.client,{supportedSchemaVersion:3}).changes(f.org,0,100);expect(applyErpDelta(null,delta,f.org,3)).toEqual(state);
    expect(delta?.schemaVersion).toBe(3);expect(delta?.events[0].schemaVersion).toBe(1);
  });
  it('retries a lost committed response and returns the exact old receipt after a later edit',async()=>{
    const f=await fixture();await customer(f);const request=await f.request({type:'save_projects',projects:[project()]},'lost-project');f.hooks.loseCommit=true;
    await expect(executeErp(f.dependencies,request)).rejects.toMatchObject({code:'service_unavailable'});const old=(await f.store.receipt(f.org,request.idempotencyKey))!;
    await f.send({type:'save_projects',projects:[project('project','customer',{expectedProjectRevision:1,name:'Later approved name'})]});
    expect(await executeErp(f.dependencies,request)).toEqual({receipt:old,replayed:true});expect((await f.store.read(f.org))?.projects?.[0].name).toBe('Later approved name');
    expect((await serviceSql<{count:number}>('select count(*)::int count from public.zentra_us_erp_receipts where organization_id=$1 and idempotency_key=$2',[f.org,request.idempotencyKey]))[0].count).toBe(1);
  });
  it('requires ALL legacy links to be reviewed without deleting or inventing a reference',async()=>{
    const f=await fixture('accrual',1);await customer(f);const oldDependencies={...f.dependencies,projectExists:async()=>true};
    await executeErp(oldDependencies,await f.request(estimate('one','customer','legacy-one')));await executeErp(oldDependencies,await f.request(estimate('two','customer','legacy-two')));
    const before=await f.snapshot(),store=createSupabaseErpStore(f.client,{supportedSchemaVersion:3});
    await expect(executeErp({...f.dependencies,store},{idempotencyKey:'partial-review',expectedRevision:4,command:{type:'save_projects',projects:[project('legacy-one')]}})).rejects.toMatchObject({code:'legacy_project_review_required',status:409});expect(await f.snapshot()).toEqual(before);
    await executeErp({...f.dependencies,store},{idempotencyKey:'complete-review',expectedRevision:4,command:{type:'save_projects',projects:[project('legacy-one'),project('legacy-two')]}});
    expect((await store.read(f.org))?.estimates.map(q=>q.projectId).sort()).toEqual(['legacy-one','legacy-two']);
  });
  it.each(['member','read_only'] as const)('denies project writes for %s without SQL mutation',async role=>{
    const f=await fixture();await customer(f);const before=await f.snapshot();const actor={...f.actor,role};
    await expect(executeErp({...f.dependencies,actor,revalidate:async()=>actor},await f.request({type:'save_projects',projects:[project()]}))).rejects.toMatchObject({code:'financial_permission_required',status:403});expect(await f.snapshot()).toEqual(before);
  });
  it('locks client identity once a quote links the project; archive preserves acceptance',async()=>{
    const f=await fixture();await customer(f);await customer(f,'other');await f.send({type:'save_projects',projects:[project()]});await f.send(estimate());
    const before=await f.snapshot();await expect(f.send({type:'save_projects',projects:[project('project','other',{expectedProjectRevision:1})]})).rejects.toMatchObject({code:'project_customer_locked'});expect(await f.snapshot()).toEqual(before);
    await f.send({type:'save_projects',projects:[project('project','customer',{expectedProjectRevision:1,status:'archived'})]});await f.send({type:'accept_estimate',estimateId:'estimate',expectedEstimateRevision:1});
    await expect(f.send(estimate('new'))).rejects.toMatchObject({code:'project_archived'});expect((await f.store.read(f.org))?.estimates[0].status).toBe('accepted');
  });
  it.each(['cash','accrual'] as const)('keeps purchases, journal and exact payment balances protected on schema3 (%s)',async basis=>{
    const f=await fixture(basis);await customer(f);await f.send({type:'save_projects',projects:[project()]});await f.send({type:'save_vendor',vendor:f.vendor});await f.send(f.bill);await f.send(f.payment);
    const state=(await f.store.read(f.org))!;expect(vendorBillBalance(state.vendorBills![0],state.vendorPayments!).minorUnits).toBe('5825');expect(state.counters.project).toBe(1);expect(trialBalance(state.ledger,'2026-12-31').balanced).toBe(true);expect(profitAndLoss(state.ledger,{start:'2026-01-01',end:'2026-12-31'}).expenseMinor).toBe(basis==='cash'?'5000':'10825');
    await f.send({type:'save_projects',projects:[project('project','customer',{expectedProjectRevision:1,vendorBillIds:['bill']})]});const before=await f.snapshot();await expect(f.send({type:'save_projects',projects:[project('another','customer',{vendorBillIds:['bill']})]})).rejects.toMatchObject({code:'vendor_bill_project_conflict'});expect(await f.snapshot()).toEqual(before);
    const delta=await createSupabaseErpSyncStore(f.client,{supportedSchemaVersion:3}).changes(f.org,0,100);expect(applyErpDelta(null,delta,f.org,3)).toEqual(await f.store.read(f.org));
  });
  it('composes the private TEST issuer after schema3 and preserves its committed historical replay',async()=>{
    const f=await fixture();await customer(f);await f.send({type:'save_projects',projects:[project()]});const issued=await issueTestInvoice(f);
    expect((await f.store.read(f.org))?.schemaVersion).toBe(3);expect(issued.response.replayed).toBe(false);
    await f.send({type:'save_projects',projects:[project('project','customer',{expectedProjectRevision:1,name:'Edited after invoice'})]});expect(await executeUsTaxInvoiceTest(issued.dependencies,issued.request)).toEqual({...issued.response,replayed:true});expect(issued.calculate).toHaveBeenCalledTimes(1);
  });
  it.each(['zentra_read_us_erp','zentra_us_erp_receipt','zentra_us_erp_revision','zentra_us_erp_delta','zentra_read_us_erp_v2','zentra_us_erp_receipt_v2','zentra_us_erp_revision_v2','zentra_us_erp_delta_v2'])('fences old RPC %s before disclosure',async name=>{
    const f=await fixture();await customer(f);const receipt=await f.send({type:'save_projects',projects:[project()]});const query=rpcQueries[name];const params:Record<string,unknown>={p_organization:f.org,p_idempotency_key:receipt.receipt.idempotencyKey,p_after_revision:0,p_limit:100};await expect(f.client.rpc(name,Object.fromEntries(query.keys.map(key=>[key,params[key]])))).rejects.toMatchObject({code:'PU008'});
  });
  it.each([1,2] as const)('refuses generic commit header%s BEFORE historical replay on head3',async schemaVersion=>{
    const f=await fixture();await customer(f);const commit=await f.prepare({type:'save_projects',projects:[project()]});await result(commitSql,commitValues(commit));
    const old={...commit,header:{...commit.header,schemaVersion}};await expect(result(commitSql,commitValues(old))).rejects.toMatchObject({code:'PU008'});
  });
  it.each([null,'3',4] as const)('does not replay a committed receipt through a malformed schema capability %j',async schemaVersion=>{
    const f=await fixture();await customer(f);const c=await f.prepare({type:'save_projects',projects:[project()]});await result(commitSql,commitValues(c));const forged=clone(c) as unknown as {header:Record<string,unknown>};forged.header.schemaVersion=schemaVersion;
    await expect(result(commitSql,commitValues(forged as unknown as ErpCommit))).rejects.toMatchObject({code:'PU008'});
  });
  it.each(['timestamp','number','counter','foreign_customer','extra','ledger'] as const)('rolls back a direct forged project commit (%s)',async kind=>{
    const f=await fixture();await customer(f);const commit=await f.prepare({type:'save_projects',projects:[project()]}),before=await f.snapshot();const forged=clone(commit) as unknown as {header:Record<string,unknown>;changes:{payload:Record<string,unknown>}[]};
    if(kind==='timestamp')forged.changes[0].payload.updatedAt='2026-10-08T09:00:00Z';if(kind==='number')forged.changes[0].payload.number='PRJ-000002';if(kind==='counter')(forged.header.counters as Record<string,unknown>).project=2;if(kind==='foreign_customer')forged.changes[0].payload.customerId='foreign';if(kind==='extra')forged.changes[0].payload.role='owner';if(kind==='ledger')(forged.header.ledger as Record<string,unknown>).revision=1;
    await expect(result(commitSql,commitValues(forged as unknown as ErpCommit))).rejects.toMatchObject({code:'PU004'});expect(await f.snapshot()).toEqual(before);
  });
  it('blocks direct service-role record updates without a matching event and immutable receipt',async()=>{
    const f=await fixture();await customer(f);await f.send({type:'save_projects',projects:[project()]});const before=await f.snapshot();
    await expect(serviceSql("update public.zentra_us_erp_records set state_revision=state_revision+1,payload=jsonb_set(jsonb_set(payload,'{name}','\"Forged\"'::jsonb),'{revision}','2'::jsonb) where organization_id=$1 and kind='project'",[f.org])).rejects.toMatchObject({code:'PU004'});expect(await f.snapshot()).toEqual(before);
  });
  it('revokes public execution and preserves existing RLS on the shared private tables',async()=>{
    for(const role of ['anon','authenticated'])for(const name of ['zentra_read_us_erp_v3(text)','zentra_us_erp_receipt_v3(text,text)','zentra_us_erp_revision_v3(text)','zentra_us_erp_delta_v3(text,bigint,integer)','zentra_us_project_valid(jsonb,text)'])expect((await db.query<{allowed:boolean}>('select has_function_privilege($1,$2,\'execute\') allowed',[role,'public.'+name])).rows[0].allowed).toBe(false);
    expect((await db.query<{relrowsecurity:boolean}>("select relrowsecurity from pg_class where oid='public.zentra_us_erp_records'::regclass")).rows[0].relrowsecurity).toBe(true);
  });
  it('commits the maximum 1000-project batch in one CAS, one receipt and one event',async()=>{
    const f=await fixture();await customer(f);const projects=Array.from({length:1000},(_,i)=>project(`project-${String(i).padStart(4,'0')}`));
    const response=await f.send({type:'save_projects',projects},'maximum-batch'),state=(await f.store.read(f.org))!;
    expect(state.projects).toHaveLength(1000);expect(state.counters.project).toBe(1000);expect(state.revision).toBe(3);expect(response.receipt.entityId).toBe(projects[0].id);expect(state.ledger.revision).toBe(0);
    const event=await createSupabaseErpSyncStore(f.client,{supportedSchemaVersion:3}).changes(f.org,2,1);expect(event?.events).toHaveLength(1);expect(event?.events[0].changes).toHaveLength(1000);
    const before=await f.snapshot();await expect(f.send({type:'save_projects',projects:[...projects,project('1001')]})).rejects.toMatchObject({code:'invalid_request'});expect(await f.snapshot()).toEqual(before);
  },30_000);
  it.each(['timestamp','missing_change','extra_audit'] as const)('rejects a complete direct head/record/receipt transaction with forged %s',async kind=>{
    const f=await fixture();await customer(f);const c=await f.prepare({type:'save_projects',projects:[project()]}),before=await f.snapshot();
    await expect(db.transaction(async tx=>{
      await tx.exec('set local role service_role');
      await tx.query('update public.zentra_us_erp_heads set revision=$2,header=$3::jsonb,updated_by=$4 where organization_id=$1',[f.org,c.receipt.revision,JSON.stringify(c.header),f.user]);
      if(kind!=='missing_change')await tx.query('insert into public.zentra_us_erp_records values($1,$2,$3,$4::jsonb,$5)',[f.org,'project',c.changes[0].id,JSON.stringify(c.changes[0].payload),c.receipt.revision]);
      if(kind==='extra_audit')await tx.query('insert into public.zentra_us_erp_ledger_audit values($1,1,$2::jsonb,$3)',[f.org,JSON.stringify({revision:1,action:'posted',actorId:f.user,timestamp:f.now,entityId:'forged-journal'}),c.receipt.revision]);
      await tx.query('insert into public.zentra_us_erp_receipts values($1,$2,$3,$4,$5::jsonb,$6,$7::timestamptz)',[f.org,c.receipt.idempotencyKey,c.receipt.commandHash,c.receipt.revision,JSON.stringify(c.receipt),f.user,kind==='timestamp'?'2026-10-08T09:00:00Z':f.now]);
    })).rejects.toMatchObject({code:'PU004'});expect(await f.snapshot()).toEqual(before);
  });
  it('rejects an orphaned legacy link at the SQL promotion boundary, not only in the JS engine',async()=>{
    const f=await fixture('accrual',1);await customer(f);await executeErp({...f.dependencies,projectExists:async()=>true},await f.request(estimate('legacy','customer','missing-project')));
    const store=createSupabaseErpStore(f.client,{supportedSchemaVersion:3});let c:ErpCommit|undefined;
    await expect(executeErp({...f.dependencies,store:{...store,read:async()=>({...((await store.read(f.org))!),estimates:[]}),commit:async input=>{c=input;throw new Error('capture');}}},{idempotencyKey:'forged-promotion',expectedRevision:3,command:{type:'save_projects',projects:[project('unrelated')]}})).rejects.toThrow('capture');
    const before=await f.snapshot();await expect(result(commitSql,commitValues(c!))).rejects.toMatchObject({code:'PU009'});expect(await f.snapshot()).toEqual(before);
  });
  it.each(['2026-10-08T08:00:01Z','2026-10-08T08:00:01.000Z'])('uses the final server instant %s and preserves UTC-equivalent delta replay',async timestamp=>{
    const f=await fixture();await customer(f);f.dependencies.revalidate=async()=>({...f.actor,timestamp});await f.send({type:'save_projects',projects:[project()]});const state=(await f.store.read(f.org))!;
    expect(state.projects![0].createdAt).toBe(timestamp);expect(state.projects![0].updatedAt).toBe(timestamp);
    const delta=await createSupabaseErpSyncStore(f.client,{supportedSchemaVersion:3}).changes(f.org,0,100);expect(delta?.events.at(-1)?.occurredAt).toBe('2026-10-08T08:00:01.000Z');expect(applyErpDelta(null,delta,f.org,3)).toEqual(state);
  });
});
