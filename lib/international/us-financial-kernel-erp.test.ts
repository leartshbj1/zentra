import { describe, expect, it } from 'vitest';
import { balanceSheet, generalLedger, trialBalance } from './accounting/reports';
import { canonicalErpJson } from './erp-contract';
import { buildTaxRequest } from './invoicing';
import { money } from './money';
import { applyUsFinancialOperationV5, buildUsFinancialCreditCandidateV5, projectUsFinancialBookV5, promoteUsFinancialBookV5, validateUsFinancialBookV5 } from './us-financial-kernel';
import { usFinancialErpEntityIdV5, validateUsFinancialErpOperationV5 } from './us-financial-kernel-erp';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import type { UsFinancialBookV5, UsFinancialCreditInputV5, UsFinancialErpCommandV5, UsFinancialErpFactsV5, UsFinancialErpOperationV5 } from './us-financial-kernel-types';

async function setup(){
  const f=await financialKernelFixture({tax:'0'});let book=await promoteUsFinancialBookV5(f.baseline,f.policy,f.actor),sequence=0;
  const send=async(command:UsFinancialErpCommandV5,facts:UsFinancialErpFactsV5={kind:'none'},actor=f.actor,key=`erp-${++sequence}`)=>{
    const op:UsFinancialErpOperationV5={type:'erp_command',idempotencyKey:key,command,facts};
    const result=await applyUsFinancialOperationV5(book,op,actor,usFinancialErpEntityIdV5(command,f.actor.organizationId));book=result.book;return result;
  };
  const credit=async(invoiceId='invoice-1',lineId='line-1',quantityUnits='1')=>{
    const input:UsFinancialCreditInputV5={type:'customer_credit',idempotencyKey:`credit-${++sequence}`,invoiceId,transactionDate:'2026-10-10',accountingDate:'2026-10-10',periodId:'2026',reason:'Synthetic test credit',selections:[{lineId,quantityUnits}]};
    const candidate=await buildUsFinancialCreditCandidateV5(book,input);
    const result=await applyUsFinancialOperationV5(book,{...input,taxProof:{schemaVersion:1,environment:'test',kind:'historical_zero_tax',invoiceFingerprint:candidate.invoiceFingerprint,allocationSha256:candidate.allocationSha256,verifiedBy:'synthetic-reviewer',verifiedAt:f.actor.timestamp,reference:'Synthetic historical zero-tax review'}},f.actor,`credit-id-${sequence}`);book=result.book;return result;
  };
  const quote=async(id='estimate-2',price='15000')=>{
    await send({type:'save_estimate',id,expectedEstimateRevision:0,customerId:'customer-1',date:'2026-10-10',expiresAt:'2026-11-10',paymentTermsDays:30,notes:'Synthetic second invoice',lines:[{id:'new-line',description:'Synthetic service',quantityUnits:'1',quantityScale:0,unitPrice:money('USD',price),discountBasisPoints:0,taxTreatment:'taxable'}]});
    await send({type:'accept_estimate',estimateId:id,expectedEstimateRevision:1});
  };
  const issue=async(id='invoice-2',estimateId='estimate-2')=>{
    const current=await projectUsFinancialBookV5(book),estimate=current.estimates.find(e=>e.id===estimateId)!;
    const request=buildTaxRequest(current.configuration,estimate,'2026-10-10'),original=f.baseline.invoices[0];
    return send({type:'issue_invoice',id,estimateId,expectedEstimateRevision:estimate.revision,date:'2026-10-10',accountingDate:'2026-10-10',dueDate:'2026-11-09',periodId:'2026'},
      {kind:'invoice_issuance',sellerSnapshot:original.sellerSnapshot,taxAssessment:{...original.taxAssessment,documentId:estimate.id,documentRevision:estimate.revision,fingerprint:request.fingerprint,lines:estimate.lines.map(l=>({id:l.id,taxMinor:'0',jurisdiction:'synthetic-jurisdiction',evidenceReference:'synthetic-proof-not-tax-law'}))}});
  };
  return {...f,send,credit,quote,issue,get book(){return book;}};
}
const erpEvent=(book:UsFinancialBookV5)=>{const event=book.events.at(-1)!;if(!('commit'in event))throw new Error('ERP event expected');return event;};

describe('one internal V5 book advances the existing ERP4 engine',()=>{
  it('creates and issues another invoice after a credit without losing AR, credits or immutable baseline',async()=>{
    const t=await setup(),original=canonicalErpJson(t.baseline);await t.credit();await t.quote();const result=await t.issue();
    expect(result.view.invoices).toHaveLength(2);expect(result.view.estimates).toHaveLength(2);expect(result.view.counters).toMatchObject({invoice:2,estimate:2});
    expect(result.view.credits).toHaveLength(1);expect(result.view.settlements.map(s=>s.outstandingMinor)).toEqual(['20000','15000']);
    expect(generalLedger(result.view.ledger,'receivables',{start:'2026-01-01',end:'2026-12-31'}).closingMinor).toBe('35000');
    expect(canonicalErpJson(t.book.baseline)).toBe(original);expect(result.book.revision).toBe(t.baseline.revision+5);
    const event=erpEvent(result.book);expect(event.effects.postings[0].revision).toBe(3);expect(event.commit.header.ledger.revision).toBe(2);
    expect(event.effects.postings[0].fingerprint).toBe((event.commit.changes.find(c=>c.kind==='journal')!.payload as {fingerprint:string}).fingerprint);
    expect(trialBalance(result.view.ledger,'2026-12-31').balanced).toBe(true);expect(balanceSheet(result.view.ledger,'2026-12-31').balanced).toBe(true);
    expect(await validateUsFinancialBookV5(result.book,t.actor.organizationId,t.policy)).toEqual(result.book);
  });
  it('credits and collects a newly issued invoice and preserves all current shared records afterwards',async()=>{
    const t=await setup();await t.quote();await t.issue();await t.credit('invoice-2','new-line');
    const view=await projectUsFinancialBookV5(t.book);expect(view.settlements[1]).toMatchObject({creditedMinor:'15000',outstandingMinor:'0',status:'credited'});
    await expect(applyUsFinancialOperationV5(t.book,{type:'customer_payment',idempotencyKey:'overpaid',invoiceId:'invoice-2',amountMinor:'1',paymentDate:'2026-10-10',accountingDate:'2026-10-10',periodId:'2026',reference:'Synthetic'},t.actor,'overpaid')).rejects.toMatchObject({code:'payment_exceeds_outstanding'});
    const updated=await t.send({type:'save_customer',customer:{...view.customers[0],name:'New current name'}});expect(updated.view.invoices[1].customer.name).toBe(view.invoices[1].customer.name);expect(updated.view.estimates).toHaveLength(2);expect(updated.view.credits).toHaveLength(1);
  });
  it('records a real payment on a new invoice and retains it through subsequent ERP command replay',async()=>{
    const t=await setup();await t.credit();await t.quote();await t.issue();
    const paid=await applyUsFinancialOperationV5(t.book,{type:'customer_payment',idempotencyKey:'new-invoice-payment',invoiceId:'invoice-2',amountMinor:'5000',paymentDate:'2026-10-10',accountingDate:'2026-10-10',periodId:'2026',reference:'Synthetic new invoice payment'},t.actor,'new-invoice-payment-id');
    const view=paid.view,command:UsFinancialErpCommandV5={type:'save_customer',customer:{...view.customers[0],name:'After payment'}};
    const result=await applyUsFinancialOperationV5(paid.book,{type:'erp_command',idempotencyKey:'after-payment',command,facts:{kind:'none'}},t.actor,'customer-1');
    expect(result.view.settlements.map(s=>s.outstandingMinor)).toEqual(['20000','10000']);expect(result.view.invoices[1].payments[0].amount.minorUnits).toBe('5000');
    expect(generalLedger(result.view.ledger,'receivables',{start:'2026-01-01',end:'2026-12-31'}).closingMinor).toBe('30000');
    expect(await validateUsFinancialBookV5(result.book,t.actor.organizationId)).toEqual(result.book);
  });
  it('issues a genuine zero-total invoice without inventing a journal effect',async()=>{
    const t=await setup();await t.credit();await t.quote('zero-estimate','0');const result=await t.issue('zero-invoice','zero-estimate');
    expect(result.view.invoices[1].total.minorUnits).toBe('0');expect(result.view.settlements[1].outstandingMinor).toBe('0');
    expect(erpEvent(result.book).effects).toEqual({postings:[],audit:[]});expect(result.view.ledger.entries).toHaveLength(2);
    expect(await validateUsFinancialBookV5(result.book,t.actor.organizationId)).toEqual(result.book);
  });
  it('records vendors, bills and payments after credit at global book revisions while US purchase tax remains cost',async()=>{
    const t=await setup();await t.credit();const vendor={...t.baseline.customers[0],id:'vendor-1',name:'Synthetic Vendor'};await t.send({type:'save_vendor',vendor});
    const bill=await t.send({type:'record_vendor_bill',id:'bill-1',vendorId:vendor.id,reference:'SUP-001',date:'2026-10-10',accountingDate:'2026-10-10',dueDate:'2026-11-09',periodId:'2026',netMinor:'1000',purchaseTaxMinor:'80',expenseAccountId:'purchases',sourceReference:'Synthetic manual bill'});
    expect(bill.view.vendorBills[0].recordedRevision).toBe(bill.book.revision);expect(bill.view.vendorBills[0].total.minorUnits).toBe('1080');
    const paid=await t.send({type:'record_vendor_payment',id:'vendor-payment-1',billId:'bill-1',amountMinor:'1080',paymentDate:'2026-10-10',accountingDate:'2026-10-10',periodId:'2026',reference:'Synthetic bank payment'});
    expect(paid.view.vendorPayments[0].recordedRevision).toBe(paid.book.revision);expect(paid.view.credits).toHaveLength(1);
    expect(generalLedger(paid.view.ledger,'payables',{start:'2026-01-01',end:'2026-12-31'}).closingMinor).toBe('0');
    expect(generalLedger(paid.view.ledger,'purchases',{start:'2026-01-01',end:'2026-12-31'}).closingMinor).toBe('1080');
    expect(await validateUsFinancialBookV5(paid.book,t.actor.organizationId)).toEqual(paid.book);
  });
  it('keeps projects and their history in the shared book, including genuine updates to the same entity id',async()=>{
    const t=await setup();await t.credit();const project={id:'project-1',expectedProjectRevision:0,customerId:'customer-1',name:'Synthetic Project',status:'active' as const,notes:'',startDate:null,targetDate:null,budgetMinor:'50000',vendorBillIds:[]};
    await t.send({type:'save_projects',projects:[project]});const result=await t.send({type:'save_projects',projects:[{...project,expectedProjectRevision:1,name:'Updated Project'}]});
    expect(result.view.projects[0]).toMatchObject({revision:2,number:'PRJ-000001',name:'Updated Project'});expect(result.view.counters.project).toBe(1);expect(erpEvent(result.book).id).toBe(project.id);expect(result.view.credits).toHaveLength(1);
  });
  it('posts and reverses manual journals against the real ledger without touching operational credit accounts',async()=>{
    const t=await setup();await t.credit();const result=await t.send({type:'post_manual_journal',id:'manual-1',transactionDate:'2026-10-10',accountingDate:'2026-10-10',periodId:'2026',description:'Synthetic equity financing',sourceReference:'SYNTHETIC-ONLY',cashFlowCategory:'financing',lines:[{accountId:'cash',debitMinor:'1000',creditMinor:'0'},{accountId:'equity',debitMinor:'0',creditMinor:'1000'}]});
    expect(erpEvent(result.book).effects.postings[0].revision).toBe(3);
    const reversed=await t.send({type:'reverse_manual_journal',id:'reversal-1',entryId:'manual-1',transactionDate:'2026-10-10',accountingDate:'2026-10-10',periodId:'2026',reason:'Synthetic correction'});
    expect(erpEvent(reversed.book).effects.postings[0].reversesEntryId).toBe('manual-1');expect(reversed.view.credits).toHaveLength(1);
    expect(generalLedger(reversed.view.ledger,'cash',{start:'2026-01-01',end:'2026-12-31'}).closingMinor).toBe('0');
  });
  it('rejects a manual entry colliding with a credit that the private ERP4 projection cannot see',async()=>{
    const t=await setup();await t.credit();const before=canonicalErpJson(t.book);
    await expect(t.send({type:'post_manual_journal',id:'entry:credit:credit-1',transactionDate:'2026-10-10',accountingDate:'2026-10-10',periodId:'2026',description:'Synthetic collision attempt',sourceReference:'SYNTHETIC',cashFlowCategory:'financing',lines:[{accountId:'cash',debitMinor:'1',creditMinor:'0'},{accountId:'equity',debitMinor:'0',creditMinor:'1'}]})).rejects.toMatchObject({code:'ENTRY_ID_CONFLICT'});
    expect(canonicalErpJson(t.book)).toBe(before);
  });
  it('historically replays original issuance facts after expiry without consulting a new provider',async()=>{
    const t=await setup();await t.quote();await t.issue();await t.send({type:'save_customer',customer:{...t.baseline.customers[0],name:'Later account update'}},{kind:'none'},{...t.actor,timestamp:'2026-10-10T14:00:00.000Z'});
    expect(await validateUsFinancialBookV5(t.book,t.actor.organizationId)).toEqual(t.book);expect((await projectUsFinancialBookV5(t.book)).invoices).toHaveLength(2);
  });
  it('closes and opens real periods after credits, and rejects a later credit in the closed period',async()=>{
    const t=await setup();await t.credit();const closed=await t.send({type:'close_period',periodId:'2026'});expect(erpEvent(closed.book).effects).toMatchObject({postings:[],audit:[{revision:3,action:'period_closed'}]});
    const opened=await t.send({type:'open_period',id:'2027',start:'2027-01-01',end:'2027-12-31'});expect(opened.view.ledger.periods.map(p=>p.status)).toEqual(['closed','open']);
    expect(erpEvent(opened.book).effects.audit[0].revision).toBe(4);await expect(t.credit()).rejects.toMatchObject({code:'accounting_period_not_open'});
    expect(await validateUsFinancialBookV5(t.book,t.actor.organizationId)).toEqual(t.book);
  });
  it.each(['initialize','upgrade_accounting','refresh_configuration','record_payment'])('blocks the incompatible legacy command %s',async type=>{
    const t=await setup();await expect(applyUsFinancialOperationV5(t.book,{type:'erp_command',idempotencyKey:'blocked',command:{type},facts:{kind:'none'}} as unknown as UsFinancialErpOperationV5,t.actor,'any')).rejects.toThrow();
  });
  it('allows members to maintain customer and quote records while retaining financial authorization',async()=>{
    const t=await setup(),member={...t.actor,role:'member' as const};const result=await t.send({type:'save_customer',customer:{...t.baseline.customers[0],name:'Member update'}},{kind:'none'},member);
    expect(result.view.customers[0].name).toBe('Member update');expect(await validateUsFinancialBookV5(t.book,t.actor.organizationId)).toEqual(t.book);
    await expect(t.send({type:'close_period',periodId:'2026'},{kind:'none'},member)).rejects.toMatchObject({code:'financial_permission_required'});
  });
  it('replays exact generic idempotency without advancing book or ledger and refuses changed content',async()=>{
    const t=await setup(),command={type:'save_customer' as const,customer:{...t.baseline.customers[0],name:'Updated'}};const result=await t.send(command,{kind:'none'},t.actor,'exact-erp');
    const operation:UsFinancialErpOperationV5={type:'erp_command',idempotencyKey:'exact-erp',command,facts:{kind:'none'}};
    expect(await applyUsFinancialOperationV5(t.book,operation,t.actor,command.customer.id)).toEqual(result);
    await expect(applyUsFinancialOperationV5(t.book,{...operation,command:{...command,customer:{...command.customer,name:'Changed'}}},t.actor,command.customer.id)).rejects.toMatchObject({code:'idempotency_conflict'});
  });
  it('does not let a downgraded same user replay an earlier financial ERP command',async()=>{
    const t=await setup(),command:UsFinancialErpCommandV5={type:'close_period',periodId:'2026'};await t.send(command,{kind:'none'},t.actor,'financial-retry');
    await expect(applyUsFinancialOperationV5(t.book,{type:'erp_command',idempotencyKey:'financial-retry',command,facts:{kind:'none'}},{...t.actor,role:'member'},'2026')).rejects.toMatchObject({code:'financial_permission_required'});
  });
  it('bounds generic keys to the same 200 characters as the private runtime receipt contract',async()=>{
    const t=await setup(),command:UsFinancialErpCommandV5={type:'save_customer',customer:{...t.baseline.customers[0],name:'Long key'}};
    await t.send(command,{kind:'none'},t.actor,'k'.repeat(200));
    await expect(t.send(command,{kind:'none'},t.actor,'k'.repeat(201))).rejects.toMatchObject({code:'invalid_financial_erp_command'});
  });
  it('shares key reservations across ERP commands and credit operations',async()=>{
    const t=await setup();await t.send({type:'save_customer',customer:{...t.baseline.customers[0],name:'Updated'}},{kind:'none'},t.actor,'same-key');
    await expect(applyUsFinancialOperationV5(t.book,{type:'customer_payment',idempotencyKey:'same-key',invoiceId:'invoice-1',amountMinor:'1',paymentDate:'2026-10-10',accountingDate:'2026-10-10',periodId:'2026',reference:'Synthetic'},t.actor,'payment-conflict')).rejects.toMatchObject({code:'idempotency_conflict'});
  });
  it.each(['commit','effects','command','actor'] as const)('rejects altered canonical %s during replay',async field=>{
    const t=await setup();await t.credit();await t.quote();await t.issue();const changed=structuredClone(t.book),event=changed.events.at(-1)!;
    if(!('commit'in event))throw new Error('Expected ERP event');
    if(field==='commit')(event.commit.receipt as {entityId:string}).entityId='forged';
    if(field==='effects')(event.effects.postings[0] as {revision:number}).revision=99;
    if(field==='command')(event.operation.command as {dueDate:string}).dueDate='2026-12-09';
    if(field==='actor')(event.actor as {userId:string}).userId='forged-issuer';
    await expect(validateUsFinancialBookV5(changed,t.actor.organizationId)).rejects.toThrow();
  });
  it('rejects missing, mismatched and raw extra issuance facts',async()=>{
    const t=await setup();await t.quote();const command:UsFinancialErpCommandV5={type:'issue_invoice',id:'invoice-2',estimateId:'estimate-2',expectedEstimateRevision:2,date:'2026-10-10',accountingDate:'2026-10-10',dueDate:'2026-11-09',periodId:'2026'};
    await expect(t.send(command)).rejects.toThrow();
    const result=await t.issue(),event=erpEvent(result.book),op=event.operation;
    if(op.facts.kind!=='invoice_issuance')throw new Error('Facts expected');
    const facts=op.facts;
    expect(()=>validateUsFinancialErpOperationV5({...op,facts:{...facts,taxAssessment:{...facts.taxAssessment,secret:'unallowed'}}},t.actor.organizationId)).toThrow();
    const changed=structuredClone(result.book),last=erpEvent(changed);if(last.operation.facts.kind!=='invoice_issuance')throw new Error('Facts expected');
    (last.operation.facts.taxAssessment as {fingerprint:string}).fingerprint='stale';await expect(validateUsFinancialBookV5(changed,t.actor.organizationId)).rejects.toThrow();
  });
  it.each([null,1,'invalid',{}, {lines:null},{lines:{}},{lines:[null]}])('returns a stable domain error for malformed private tax facts %o',async taxAssessment=>{
    const t=await setup();await t.quote();const command:UsFinancialErpCommandV5={type:'issue_invoice',id:'invoice-2',estimateId:'estimate-2',expectedEstimateRevision:2,date:'2026-10-10',accountingDate:'2026-10-10',dueDate:'2026-11-09',periodId:'2026'};
    await expect(t.send(command,{kind:'invoice_issuance',sellerSnapshot:t.baseline.invoices[0].sellerSnapshot,taxAssessment} as UsFinancialErpFactsV5)).rejects.toMatchObject({name:'ErpError',code:'invalid_financial_issuance_facts'});
  });
  it('does not expose a compatibility projection as stored authority',async()=>{
    const t=await setup();await t.credit();await t.quote();await t.issue();expect(Object.keys(t.book).sort()).toEqual(['baseline','events','policy','promotion','revision','schemaVersion']);
    const view=await projectUsFinancialBookV5(t.book);expect(view.ledger.entries.filter(e=>e.source.type==='customer_credit')).toHaveLength(1);expect(Object.hasOwn(view,'compatibility')).toBe(false);
  });
});
