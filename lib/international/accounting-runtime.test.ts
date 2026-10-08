import { describe, expect, it, vi } from 'vitest';
import { executeErp, canonicalErpJson, type ErpExecutionDependencies } from './runtime';
import { ErpError } from './erp-contract';
import { validateErpRequest } from './erp-request';
import { erpClientSchemaVersion, requireErpClientSchema, type ErpSchemaVersion } from './erp-schema-capability';
import { applyErpDelta, validateErpRevision, type ErpDelta, type ErpEvent } from './runtime-sync';
import { validateStoredErp } from './runtime-validation';
import { balanceSheet, generalLedger } from './accounting/reports';
import type { FinancialAuthority } from './accounting/ledger';
import type { ErpCommand, ErpCommit, ErpReceipt, ErpRequest, ErpState, ErpStore } from './runtime-types';
import type { CompanyConfiguration } from './types';
import type { TaxCalculationProvider } from './invoicing';

const organizationId='accounting-runtime-test';
const configuration:CompanyConfiguration={schemaVersion:1,organizationId,country:'US',currency:'USD',language:'en',timeZone:'America/New_York',address:{country:'US',line1:'1 Test Street',city:'New York',postalCode:'10001',subdivision:'NY'},accountingBasis:'accrual',invoiceNumberPrefix:'INV',taxConfiguration:{status:'unconfigured'}};
const actor:FinancialAuthority={organizationId,userId:'test-owner',role:'owner',managementEntitled:true,timestamp:'2026-10-08T12:00:00Z'};
const initialPeriod={id:'2026',start:'2026-01-01',end:'2026-12-31',status:'open' as const};
const manual:Extract<ErpCommand,{type:'post_manual_journal'}>={type:'post_manual_journal',id:'capital',transactionDate:'2026-10-08',accountingDate:'2026-10-08',periodId:'2026',description:'Human approved opening capital',sourceReference:'approval-source-1',cashFlowCategory:'financing',lines:[{accountId:'cash',debitMinor:'9007199254740993',creditMinor:'0',description:'Exact capital'},{accountId:'equity',debitMinor:'0',creditMinor:'9007199254740993'}]};
function page(from:number,events:readonly ErpEvent[],head=from+events.length,schemaVersion:ErpSchemaVersion=events.at(-1)?.schemaVersion??4):ErpDelta{return {schemaVersion,organizationId,fromRevision:from,toRevision:from+events.length,headRevision:head,hasMore:from+events.length<head,resetRequired:false,events};}
/** DI engine/sync fixture, not PostgreSQL, D1, hosted Auth or production proof. */
class Store implements ErpStore {
  state:ErpState|null=null; events:ErpEvent[]=[]; commits:ErpCommit[]=[]; receipts=new Map<string,ErpReceipt>();
  loseResponse=false;failBeforeCommit=false;
  constructor(public supportedSchemaVersion:ErpSchemaVersion=4){}
  async read(){return this.state;}
  async receipt(_organizationId:string,key:string){return this.receipts.get(key)??null;}
  async commit(input:ErpCommit){
    if(this.failBeforeCommit)throw new ErpError('service_unavailable',503);
    if((this.state?.revision??0)!==input.expectedRevision)throw new ErpError('revision_conflict',409);
    const event:ErpEvent={schemaVersion:input.header.schemaVersion,organizationId,revision:input.header.revision,header:input.header,changes:input.changes,ledgerAudit:input.ledgerAudit,receipt:input.receipt,actorId:input.actor.userId,occurredAt:new Date(input.actor.timestamp).toISOString()};
    const candidate=applyErpDelta(this.state,page(input.expectedRevision,[event]),organizationId,this.supportedSchemaVersion);
    this.state=candidate;this.events.push(event);this.commits.push(input);this.receipts.set(input.receipt.idempotencyKey,input.receipt);
    if(this.loseResponse){this.loseResponse=false;throw new ErpError('service_unavailable',503);}
    return input.receipt;
  }
}
function fixture(capability:ErpSchemaVersion=4,basis:'cash'|'accrual'='accrual',provider:TaxCalculationProvider|null=null){
  const store=new Store(capability),taxProvider=vi.fn(async()=>provider);
  const dependencies={store,configuration:{...configuration,accountingBasis:basis,...(provider?{taxConfiguration:{status:'configured' as const}}:{})},actor,revalidate:async()=>actor,taxProvider,seller:async()=>({organizationId,displayName:'Explicit TEST seller'})} satisfies ErpExecutionDependencies;
  let key=0;
  const send=(command:ErpCommand,extra:Partial<ErpRequest>={})=>executeErp(dependencies,{idempotencyKey:`accounting-${++key}`,expectedRevision:store.state?.revision??0,command,...extra});
  const initialize=(periods=[initialPeriod])=>send({type:'initialize',periods});
  const promote3=async()=>{await send({type:'save_customer',customer:{id:'customer',organizationId,kind:'business',name:'Real fixture customer',billingAddress:configuration.address,paymentTermsDays:30}});await send({type:'save_projects',projects:[{id:'project',expectedProjectRevision:0,customerId:'customer',name:'Explicit reviewed project',status:'active',notes:'',startDate:null,targetDate:null,budgetMinor:null,vendorBillIds:[]}]});};
  return {store,dependencies,send,initialize,promote3,taxProvider};
}

describe('schema4 US accounting vertical through executor and delta',()=>{
  it.each(['cash','accrual'] as const)('initializes, posts, opens, reverses, closes and reports exactly (%s)',async basis=>{
    const t=fixture(4,basis);await t.initialize();expect(t.store.state).toMatchObject({schemaVersion:4,counters:{estimate:0,invoice:0,project:0},vendors:[],projects:[]});
    const posted=await t.send(manual);await t.send({type:'open_period',id:'2027',start:'2027-01-01',end:'2027-12-31'});await t.send({type:'close_period',periodId:'2026'});
    await t.send({type:'reverse_manual_journal',id:'reverse-capital',entryId:'capital',transactionDate:'2027-01-03',accountingDate:'2027-01-03',periodId:'2027',reason:'Reviewed correction'});await t.send({type:'close_period',periodId:'2027'});
    const state=t.store.state!;expect(state.revision).toBe(6);expect(state.ledger.revision).toBe(5);expect(state.counters).toEqual({estimate:0,invoice:0,project:0});expect(state.ledger.audit.map(a=>a.action)).toEqual(['posted','period_opened','period_closed','posted','period_closed']);expect(balanceSheet(state.ledger,'2027-12-31').assetsMinor).toBe('0');expect(generalLedger(state.ledger,'cash',{start:'2026-01-01',end:'2027-12-31'}).closingMinor).toBe('0');expect(t.taxProvider).not.toHaveBeenCalled();
    expect(canonicalErpJson(applyErpDelta(null,page(0,t.store.events),organizationId,4))).toBe(canonicalErpJson(state));expect(validateStoredErp(state,organizationId)).toBe(state);
    const replay=await t.send(manual,{idempotencyKey:posted.receipt.idempotencyKey,expectedRevision:1});expect(replay).toEqual({...posted,replayed:true});expect(t.store.commits).toHaveLength(6);
  });
  it('promotes an actual schema3 book without changing historical records or ledger',async()=>{
    const t=fixture(3);await t.initialize();await t.promote3();const before=t.store.state!,historical=canonicalErpJson(t.store.events),ledger=canonicalErpJson(before.ledger);t.store.supportedSchemaVersion=4;
    const receipt=await t.send({type:'upgrade_accounting'});expect(t.store.state?.schemaVersion).toBe(4);expect(canonicalErpJson(t.store.state?.ledger)).toBe(ledger);expect(t.store.state?.counters).toEqual(before.counters);expect(t.store.commits.at(-1)?.changes).toEqual([]);expect(t.store.commits.at(-1)?.ledgerAudit).toEqual([]);expect(receipt.receipt.entityId).toBe(organizationId);expect(canonicalErpJson(t.store.events.slice(0,-1))).toBe(historical);
    const newEvent=t.store.events.at(-1)!;expect(applyErpDelta(before,page(before.revision,[newEvent]),organizationId,4)).toEqual(t.store.state);await t.send(manual);expect(canonicalErpJson(applyErpDelta(null,page(0,t.store.events),organizationId,4))).toBe(canonicalErpJson(t.store.state));
    await expect(t.send({type:'upgrade_accounting'})).rejects.toMatchObject({code:'accounting_already_upgraded',status:409});
  });
  it('preserves legitimate old closure order while enforcing new v4 closure order',async()=>{
    const t=fixture(3);await t.initialize([initialPeriod,{id:'2027',start:'2027-01-01',end:'2027-12-31',status:'open'}]);await t.send({type:'close_period',periodId:'2027'});await t.promote3();const history=canonicalErpJson(t.store.state!.ledger);t.store.supportedSchemaVersion=4;await t.send({type:'upgrade_accounting'});expect(canonicalErpJson(validateStoredErp(t.store.state,organizationId).ledger)).toBe(history);
    await t.send({type:'open_period',id:'2028',start:'2028-01-01',end:'2028-12-31'});await expect(t.send({type:'close_period',periodId:'2028'})).rejects.toMatchObject({code:'accounting_period_order_conflict'});await t.send({type:'close_period',periodId:'2026'});expect(t.store.state!.ledger.periods[0].status).toBe('closed');
  });
  it.each([1,2] as const)('does not invent projects or promote a legacy schema%s book',async version=>{
    const t=fixture(3);await t.initialize();if(version===2)await t.send({type:'save_vendor',vendor:{id:'vendor',organizationId,kind:'business',name:'Vendor',billingAddress:configuration.address,paymentTermsDays:30}});t.store.supportedSchemaVersion=4;const before=canonicalErpJson(t.store.state);
    await expect(t.send({type:'upgrade_accounting'})).rejects.toMatchObject({code:'accounting_upgrade_required'});await expect(t.send(manual)).rejects.toMatchObject({code:'accounting_upgrade_required'});expect(canonicalErpJson(t.store.state)).toBe(before);expect(t.store.state?.projects).toBeUndefined();
  });
  it.each([1,2,3] as const)('keeps initialization and default reads exact for capability%s',async capability=>{
    const t=fixture(capability);await t.initialize();expect(t.store.state?.schemaVersion).toBe(1);expect(t.store.state?.vendors).toBeUndefined();expect(t.store.state?.projects).toBeUndefined();await expect(t.send(manual)).rejects.toMatchObject({code:'accounting_unavailable'});expect(()=>validateErpRevision({schemaVersion:4,organizationId,revision:1},organizationId,capability)).toThrow('client_upgrade_required');
  });
  it('keeps schema4 when existing project commands update their registry',async()=>{
    const t=fixture();await t.initialize();await t.promote3();expect(t.store.state?.schemaVersion).toBe(4);await expect(t.send({type:'save_projects',projects:[{...t.store.state!.projects![0],expectedProjectRevision:1,budgetMinor:null} as unknown as Extract<ErpCommand,{type:'save_projects'}>['projects'][number]]})).rejects.toMatchObject({code:'invalid_request'});
    // Use the exact public input; stored number/actor metadata is never accepted.
    await t.send({type:'save_projects',projects:[{id:'project',expectedProjectRevision:1,customerId:'customer',name:'Reviewed update',status:'active',notes:'',startDate:null,targetDate:null,budgetMinor:null,vendorBillIds:[]}]});expect(t.store.state?.schemaVersion).toBe(4);expect(t.store.state?.projects?.[0].revision).toBe(2);
  });
  it.each(['member','read_only'] as const)('rejects %s writes before receipt/store/PG effects',async role=>{
    const t=fixture();await t.initialize();const read=vi.spyOn(t.store,'read'),receipt=vi.spyOn(t.store,'receipt'),before=t.store.commits.length;t.dependencies.actor={...actor,role};await expect(t.send(manual)).rejects.toMatchObject({code:'financial_permission_required',status:403});expect(read).not.toHaveBeenCalled();expect(receipt).not.toHaveBeenCalled();expect(t.store.commits).toHaveLength(before);
  });
  it('requires owner for upgrade and fresh financial authority before committing',async()=>{
    const t=fixture(3);await t.initialize();await t.promote3();t.store.supportedSchemaVersion=4;t.dependencies.actor={...actor,role:'accountant'};await expect(t.send({type:'upgrade_accounting'})).rejects.toMatchObject({code:'owner_required'});t.dependencies.actor=actor;await t.send({type:'upgrade_accounting'});const before=canonicalErpJson(t.store.state);t.dependencies.revalidate=async()=>({...actor,managementEntitled:false});await expect(t.send(manual)).rejects.toMatchObject({code:'management_entitlement_required'});expect(canonicalErpJson(t.store.state)).toBe(before);
  });
  it('uses the final fresh actor time for the journal/audit even when Auth advances',async()=>{
    const t=fixture();await t.initialize();const fresh={...actor,timestamp:'2026-10-08T12:00:02.123Z'};t.dependencies.revalidate=async()=>fresh;await t.send(manual);expect(t.store.state?.ledger.entries[0].postedAt).toBe(fresh.timestamp);expect(t.store.state?.ledger.audit[0].timestamp).toBe(fresh.timestamp);expect(t.store.commits.at(-1)?.actor.timestamp).toBe(fresh.timestamp);
  });
  it.each(['cash','accrual'] as const)('keeps sales/payment schema4 journals tied to final admission (%s)',async basis=>{
    const provider:TaxCalculationProvider={id:'explicit-synthetic-test-only',async calculate(request){return {...request,source:'external-provider',providerReference:'SYNTHETIC-NOT-A-TAX-GRANT',determinedAt:actor.timestamp,validUntil:'2026-10-08T13:00:00Z',lines:request.lines.map(line=>({id:line.id,taxMinor:'0',jurisdiction:'SYNTHETIC',evidenceReference:'TEST-only'}))};}};
    const t=fixture(4,basis,provider);await t.initialize();await t.send({type:'save_customer',customer:{id:'customer',organizationId,kind:'business',name:'TEST customer',billingAddress:configuration.address,paymentTermsDays:30}});await t.send({type:'save_estimate',id:'estimate',expectedEstimateRevision:0,customerId:'customer',date:'2026-10-08',expiresAt:'2026-11-08',paymentTermsDays:30,lines:[{id:'line',description:'TEST service',quantityUnits:'1',quantityScale:0,unitPrice:{currency:'USD',minorUnits:'10000'},discountBasisPoints:0,taxTreatment:'taxable'}],notes:'Synthetic engine provider only'});await t.send({type:'accept_estimate',estimateId:'estimate',expectedEstimateRevision:1});
    let clock=0;t.dependencies.revalidate=async()=>({...actor,timestamp:`2026-10-08T12:00:0${++clock}.000Z`});await t.send({type:'issue_invoice',id:'invoice',estimateId:'estimate',expectedEstimateRevision:2,date:'2026-10-08',accountingDate:'2026-10-08',dueDate:'2026-11-08',periodId:'2026'});const invoiceStamp=t.store.commits.at(-1)!.actor.timestamp;expect(t.store.state!.invoices[0].issuedAt).toBe(invoiceStamp);if(basis==='accrual')expect(t.store.state!.ledger.entries[0].postedAt).toBe(invoiceStamp);
    await t.send({type:'record_payment',id:'payment',invoiceId:'invoice',amountMinor:'5000',paymentDate:'2026-10-08',accountingDate:'2026-10-08',periodId:'2026',reference:'TEST reference'});expect(t.store.state!.ledger.entries.at(-1)?.postedAt).toBe(t.store.commits.at(-1)?.actor.timestamp);expect(validateStoredErp(t.store.state,organizationId).schemaVersion).toBe(4);
  });
  it('recovers a committed lost response with the same key after a later write',async()=>{
    const t=fixture();await t.initialize();const request={idempotencyKey:'lost-response',expectedRevision:1,command:manual};t.store.loseResponse=true;await expect(executeErp(t.dependencies,request)).rejects.toMatchObject({code:'service_unavailable'});await t.send({type:'open_period',id:'2027',start:'2027-01-01',end:'2027-12-31'});const result=await executeErp(t.dependencies,request);expect(result.replayed).toBe(true);expect(result.receipt.revision).toBe(2);expect(t.store.state?.ledger.entries).toHaveLength(1);expect(t.store.commits).toHaveLength(3);
    t.dependencies.revalidate=async()=>({...actor,userId:'other-user'});await expect(executeErp(t.dependencies,request)).rejects.toMatchObject({code:'session_changed',status:401});expect(t.store.commits).toHaveLength(3);
  });
  it('rejects changed request reuse, stale CAS and cross-company authority',async()=>{
    const t=fixture();await t.initialize();const request={idempotencyKey:'stable-request',expectedRevision:1,command:manual};await executeErp(t.dependencies,request);await expect(executeErp(t.dependencies,{...request,command:{...manual,description:'Changed'}})).rejects.toMatchObject({code:'idempotency_conflict'});await expect(t.send({type:'open_period',id:'2027',start:'2027-01-01',end:'2027-12-31'},{expectedRevision:1})).rejects.toMatchObject({code:'revision_conflict'});await expect(executeErp({...t.dependencies,actor:{...actor,organizationId:'foreign'}},{...request,idempotencyKey:'foreign'})).rejects.toMatchObject({code:'tenant_mismatch'});expect(t.store.commits).toHaveLength(2);
  });
  it('does not let caller mutation during awaits alter the captured journal/key',async()=>{
    const t=fixture();await t.initialize();const mutable={...manual,lines:manual.lines.map(l=>({...l}))},promise=t.send(mutable,{idempotencyKey:'captured-request'});mutable.lines[0].debitMinor='1';mutable.sourceReference='mutated';await promise;expect(t.store.state?.ledger.entries[0].source.id).toBe('approval-source-1');expect(t.store.state?.ledger.entries[0].lines[0].debitMinor).toBe('9007199254740993');
  });
  it('keeps the state/counters/receipt untouched on an injected precommit failure',async()=>{
    const t=fixture();await t.initialize();const before=canonicalErpJson(t.store.state);t.store.failBeforeCommit=true;await expect(t.send(manual,{idempotencyKey:'failed'})).rejects.toMatchObject({code:'service_unavailable'});expect(canonicalErpJson(t.store.state)).toBe(before);expect(t.store.receipts.has('failed')).toBe(false);expect(t.store.events).toHaveLength(1);
  });
  it('refuses CHF configuration rather than importing or changing its book',async()=>{
    const t=fixture(),{ein:_ein,...fields}=configuration;const before=t.store.commits.length;await expect(executeErp({...t.dependencies,configuration:{...fields,country:'CH',currency:'CHF',timeZone:'Europe/Zurich',address:{country:'CH',line1:'Test',city:'Genève',postalCode:'1201',subdivision:'GE'}}},{idempotencyKey:'ch-write',expectedRevision:0,command:{type:'initialize',periods:[initialPeriod]}})).rejects.toMatchObject({code:'edition_unavailable'});expect(t.store.commits).toHaveLength(before);expect(t.store.state).toBeNull();
  });
  it.each(['role','organizationId','postedAt','source','total','reversesEntryId'])('rejects injected %s at the request boundary',field=>{expect(()=>validateErpRequest({idempotencyKey:'request',expectedRevision:0,command:{...manual,[field]:'forged'}},organizationId)).toThrow('invalid_request');});
  it('negotiates capability4 explicitly without making the header a grant',()=>{expect(erpClientSchemaVersion(new Request('https://example.test'))).toBe(1);expect(erpClientSchemaVersion(new Request('https://example.test',{headers:{'X-Zentra-Erp-Schema-Version':'4'}}))).toBe(4);expect(()=>requireErpClientSchema(4,3)).toThrow('client_upgrade_required');});
  it('rejects tampered new operation deltas without changing the prior cached book',async()=>{
    const t=fixture();await t.initialize();const before=t.store.state!,saved=canonicalErpJson(before);await t.send(manual);const event=t.store.events[1];
    const variants=[{...event,ledgerAudit:[{...event.ledgerAudit[0],timestamp:'2026-10-08T12:00:01Z'}]},{...event,actorId:'forged-actor'},{...event,receipt:{...event.receipt,action:'open_period' as const}},{...event,changes:[...event.changes,{kind:'customer' as const,id:'customer',payload:{id:'customer',organizationId}}]},{...event,changes:event.changes.map(c=>({...c,payload:{...(c.payload as object),idempotencyKey:'forged-key'}}))}];
    for(const altered of variants)expect(()=>applyErpDelta(before,page(1,[altered]),organizationId,4)).toThrow('invalid_sync_state');expect(canonicalErpJson(before)).toBe(saved);
  });
  it('reconstructs period opening before posting and refuses reordered or duplicate opening history',async()=>{
    const t=fixture();await t.initialize();await t.send({type:'open_period',id:'2027',start:'2027-01-01',end:'2027-12-31'});await t.send({...manual,id:'future-capital',periodId:'2027',transactionDate:'2027-01-01',accountingDate:'2027-01-01'});const state=t.store.state!;
    const reordered={...state,ledger:{...state.ledger,audit:[{...state.ledger.audit[1],revision:1},{...state.ledger.audit[0],revision:2}]}};expect(()=>validateStoredErp(reordered,organizationId)).toThrow('invalid_stored_state');
    const duplicate={...state,ledger:{...state.ledger,audit:[...state.ledger.audit,{...state.ledger.audit[0],revision:3}]}};expect(()=>validateStoredErp(duplicate,organizationId)).toThrow('invalid_stored_state');expect(validateStoredErp(state,organizationId)).toBe(state);
  });
  it.each(['manual_journal','manual_reversal'] as const)('rejects %s mislabeled as an existing customer command in delta',async source=>{
    const t=fixture();await t.initialize();if(source==='manual_reversal')await t.send(manual);
    const before=t.store.state!,saved=canonicalErpJson(before);
    await t.send(source==='manual_journal'?manual:{type:'reverse_manual_journal',id:'reversal',entryId:'capital',transactionDate:'2026-10-08',accountingDate:'2026-10-08',periodId:'2026',reason:'Explicit reviewed reversal'});
    const event=t.store.events.at(-1)!,altered={...event,receipt:{...event.receipt,action:'save_customer' as const}};
    expect(()=>applyErpDelta(before,page(before.revision,[altered]),organizationId,4)).toThrow('invalid_sync_state');expect(canonicalErpJson(before)).toBe(saved);
  });
  it('rejects impossible new initialization dates and reversed/oversized initial period sets',async()=>{
    const t=fixture();await expect(t.initialize([{id:'zero',start:'0000-01-01',end:'0000-12-31',status:'open'}])).rejects.toMatchObject({code:'invalid_date'});await expect(t.initialize([{id:'reverse',start:'2026-12-31',end:'2026-01-01',status:'open'}])).rejects.toMatchObject({code:'invalid_period'});expect(t.store.commits).toHaveLength(0);
    await t.initialize();expect(()=>validateStoredErp({...t.store.state,ledger:{...t.store.state!.ledger,periods:[{id:'zero',start:'0000-01-01',end:'0000-12-31',status:'open'}]}},organizationId)).toThrow('invalid_stored_state');
  });
});
