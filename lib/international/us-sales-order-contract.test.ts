import { describe, expect, it } from 'vitest';
import { validateUsSalesOrderHead, validateUsSalesOrderPage, validateUsSalesOrderReceipt, validateUsSalesOrderRecord, validateUsSalesOrderRequest, validateUsSalesOrderSource, summarizeUsSalesOrder } from './us-sales-order-contract';
import type { UsSalesOrderRecord, UsSalesOrderRequest } from './us-sales-order-contract';

const org='10000000-0000-4000-8000-000000000001',orderId='20000000-0000-4000-8000-000000000001';
const request=():UsSalesOrderRequest=>({schemaVersion:1,idempotencyKey:'order-test',orderId,expectedErpRevision:10,expectedHeadRevision:0,expectedOrderRevision:null,command:{type:'create_from_estimate',estimateId:'quote',expectedEstimateRevision:2,orderDate:'2026-10-10',customerReference:null}});
function record():UsSalesOrderRecord{
 const address={country:'US' as const,line1:'1 Fictitious Street',city:'New York',subdivision:'NY',postalCode:'10001'};
 return {order:{schemaVersion:1,organizationId:org,id:orderId,sequence:1,number:'SO-000001',revision:1,state:'draft',sourceErpRevision:10,
  companyConfiguration:{schemaVersion:1,organizationId:org,country:'US',currency:'USD',language:'en',timeZone:'America/New_York',address,accountingBasis:'accrual',invoiceNumberPrefix:'INV',taxConfiguration:{status:'unconfigured'}},sellerSnapshot:{organizationId:org,displayName:'Fictitious Seller'},
  sourceEstimate:{id:'quote',organizationId:org,revision:2,currency:'USD',number:'EST-000001',customer:{id:'customer',organizationId:org,kind:'business',name:'Fictitious Customer',billingAddress:address,paymentTermsDays:30},date:'2026-10-10',expiresAt:'2026-11-10',paymentTermsDays:30,lines:[{id:'line',description:'Fictitious service',quantityUnits:'3',quantityScale:0,unitPrice:{currency:'USD',minorUnits:'12345'},discountBasisPoints:1000,taxTreatment:'taxable'}],notes:'First line\nSecond line',status:'accepted'},
  orderDate:'2026-10-10',customerReference:null,createdBy:'actor',createdAt:'2026-10-10T06:00:00.000Z',confirmation:null,cancellation:null},invoice:null};
}
describe('US sales order exact public contract',()=>{
 it('accepts detached exact create/confirm/cancel envelopes',()=>{
  expect(validateUsSalesOrderRequest(request(),org)).toEqual(request());
  for(const command of [{type:'confirm',reference:'Internal approval'} as const,{type:'cancel',reason:'Duplicate'} as const])expect(validateUsSalesOrderRequest({...request(),expectedOrderRevision:1,command},org).command).toEqual(command);
 });
 it.each([null,{},[],{...request(),authority:'owner'},{...request(),orderId:'not-uuid'},{...request(),expectedHeadRevision:-1},{...request(),expectedOrderRevision:0},{...request(),command:{type:'confirm',reference:''}},{...request(),command:{type:'confirm',reference:'\nSecret'}},{...request(),command:{type:'create_from_estimate',estimateId:'quote',expectedEstimateRevision:2,orderDate:'2026-02-30',customerReference:null}},{...request(),command:{...request().command,number:'SO-forged'}}])('rejects malformed or authority-smuggling request %j',input=>expect(()=>validateUsSalesOrderRequest(input,org)).toThrow());
 it('does not invoke getters or retain writable input references',()=>{
  let invoked=false;const r=request();Object.defineProperty(r,'command',{enumerable:true,get(){invoked=true;return{};}});expect(()=>validateUsSalesOrderRequest(r,org)).toThrow();expect(invoked).toBe(false);
  const source=record(),parsed=validateUsSalesOrderRecord(source,org);expect(parsed).toEqual(source);expect(parsed).not.toBe(source);expect(Object.isFrozen(parsed.order.sourceEstimate.lines[0])).toBe(true);
 });
 it('validates real commercial amounts without inventing tax and creates compact summaries',()=>{
  const source=record(),summary=summarizeUsSalesOrder(validateUsSalesOrderRecord(source,org));expect(summary.net).toEqual({currency:'USD',minorUnits:'33331'});expect(summary).not.toHaveProperty('tax');expect(summary).not.toHaveProperty('sourceEstimate');expect(summary.confirmationReference).toBeNull();
 });
 it.each(['ein','foreignCustomer','lineSecret','number','sourceRevision','invoiceDraft','confirmationDraft','cancelMissing'] as const)('rejects inconsistent/secret record %s',caseName=>{
  const source=structuredClone(record()) as unknown as {order:Record<string,unknown>;invoice:unknown};const o=source.order;
  if(caseName==='ein')(o.companyConfiguration as Record<string,unknown>).ein='12-3456789';
  if(caseName==='foreignCustomer')((o.sourceEstimate as Record<string,unknown>).customer as Record<string,unknown>).organizationId='other';
  if(caseName==='lineSecret')((o.sourceEstimate as {lines:Record<string,unknown>[]}).lines[0]).apiKey='secret';
  if(caseName==='number')o.number='SO-999999';
  if(caseName==='sourceRevision')o.sourceErpRevision=1;
  if(caseName==='invoiceDraft')source.invoice={id:'invoice',number:'INV-1',sourceEstimateRevision:2,issuedAt:'2026-10-10T06:00:00.000Z'};
  if(caseName==='confirmationDraft')o.confirmation={reference:'Internal',confirmedBy:'actor',confirmedAt:'2026-10-10T06:00:00.000Z'};
  if(caseName==='cancelMissing')o.state='cancelled';
  expect(()=>validateUsSalesOrderRecord(source,org)).toThrow();
 });
 it('allows invoiced only with exact confirmed source and ordered timestamps',()=>{
  const source=record();const confirmed={...source,order:{...source.order,state:'confirmed' as const,revision:2,confirmation:{reference:'Internal reference',confirmedBy:'actor',confirmedAt:'2026-10-10T06:01:00.000Z'}},invoice:{id:'invoice',number:'INV-1',sourceEstimateRevision:2,issuedAt:'2026-10-10T06:02:00.000Z'}};
  expect(validateUsSalesOrderRecord(confirmed,org)).toEqual(confirmed);
  expect(()=>validateUsSalesOrderRecord({...confirmed,invoice:{...confirmed.invoice,sourceEstimateRevision:3}},org)).toThrow();
  expect(()=>validateUsSalesOrderRecord({...confirmed,invoice:{...confirmed.invoice,issuedAt:'2026-10-10T06:00:00.000Z'}},org)).toThrow();
 });
 it('keeps order revisions independent of ERP revisions',()=>{
  const head={schemaVersion:1,organizationId:org,headRevision:400,erpRevision:10};expect(validateUsSalesOrderHead(head,org)).toEqual(head);
  const summary=summarizeUsSalesOrder(record()),page={...head,total:1,orders:[summary],nextBeforeSequence:null};expect(validateUsSalesOrderPage(page,org)).toEqual(page);
  expect(()=>validateUsSalesOrderPage({...page,orders:[summary,summary]},org)).toThrow();expect(()=>validateUsSalesOrderPage({...page,nextBeforeSequence:1},org)).toThrow();
 });
 it('requires strict actor-bound receipts with exact identifiers',()=>{
  const receipt={schemaVersion:1,organizationId:org,idempotencyKey:'order-test',commandHash:'a'.repeat(64),actorId:'actor',orderId,action:'create_from_estimate',revision:1,headRevision:1,erpRevision:10,sequence:1};expect(validateUsSalesOrderReceipt(receipt,org)).toEqual(receipt);
  for(const changed of [{...receipt,commandHash:'secret'},{...receipt,organizationId:'other'},{...receipt,role:'owner'},{...receipt,revision:0}])expect(()=>validateUsSalesOrderReceipt(changed,org)).toThrow();
 });
 it('validates a compact exact source lookup including missing and declined states without private fields',()=>{
  const source={schemaVersion:1,organizationId:org,erpRevision:10,estimateId:'quote',estimateRevision:2,activeOrderId:orderId,invoiceId:null,status:'accepted'};
  expect(validateUsSalesOrderSource(source,org)).toEqual(source);
  expect(validateUsSalesOrderSource({...source,activeOrderId:null,status:'declined'},org).status).toBe('declined');
  expect(validateUsSalesOrderSource({...source,activeOrderId:null,estimateRevision:null,status:'missing'},org).status).toBe('missing');
  for(const invalid of [{...source,status:'missing'},{...source,status:'draft'},{...source,estimateRevision:11},{...source,activeOrderId:'foreign'},{...source,ein:'secret'},{...source,organizationId:'foreign'}])expect(()=>validateUsSalesOrderSource(invalid,org)).toThrow();
 });
});
