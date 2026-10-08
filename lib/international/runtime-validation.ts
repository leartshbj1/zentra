import { validateCompanyConfiguration } from './country-config';
import { createLedger,closePeriod,type Ledger } from './accounting/ledger';
import { postCustomerInvoice,postCustomerPayment,postVendorBill,postVendorPayment } from './accounting/postings';
import { validateVendor,validateRecordedVendorBill,validateRecordedVendorPayment,vendorBillBalance } from './purchasing';
import { money } from './money';
import { reconstructHistoricalInvoiceFromEstimate,recordCustomerPayment,validateEstimate } from './invoicing';
import { ErpError,canonicalErpJson } from './erp-contract';
import { validateErpRequest } from './erp-request';
import { nationalAdapter } from './countries/adapters';
import type { ErpState } from './runtime-types';
import { validateStoredProject } from './projects';
const same = (a:unknown,b:unknown) => canonicalErpJson(a) === canonicalErpJson(b);
function exactKeys(value:unknown,keys:readonly string[]):boolean{return !!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).every(k=>typeof k==='string'&&keys.includes(k));}
function unavailable(): never { throw new ErpError('invalid_stored_state',503); }
/** Validate stored calculations without applying today's tax expiry to historical invoices. */
export function validateStoredErp(value: unknown, organizationId: string): ErpState {
  try {
    const s = value as ErpState;
    const commonFields=['schemaVersion','revision','configuration','counters','ledger','customers','estimates','invoices'];
    if (!exactKeys(s,s.schemaVersion===3?[...commonFields,'vendors','vendorBills','vendorPayments','projects']:s.schemaVersion===2?[...commonFields,'vendors','vendorBills','vendorPayments']:commonFields) || ![1,2,3].includes(s.schemaVersion) || !Number.isSafeInteger(s.revision) || s.revision < 1 || s.configuration.organizationId !== organizationId) return unavailable();
    if(s.schemaVersion>=2&&![s.vendors,s.vendorBills,s.vendorPayments].every(Array.isArray))return unavailable();
    if(s.schemaVersion===3&&!Array.isArray(s.projects))return unavailable();
    const config = validateCompanyConfiguration(s.configuration);
    if (config.country !== 'US' || !exactKeys(s.ledger,['organizationId','currency','basis','revision','accounts','periods','entries','audit']) || s.ledger.organizationId !== organizationId || s.ledger.currency !== config.currency || s.ledger.basis !== config.accountingBasis || !same(s.ledger.accounts,nationalAdapter(config.country).starterChart)) return unavailable();
    if (!exactKeys(s.counters,s.schemaVersion===3?['estimate','invoice','project']:['estimate','invoice']) || !Number.isSafeInteger(s.counters.invoice) || s.counters.invoice < 0 || !Number.isSafeInteger(s.counters.estimate) || s.counters.estimate < 0 || (s.schemaVersion===3&&(!Number.isSafeInteger(s.counters.project)||(s.counters.project??-1)<0||s.counters.project!==s.projects?.length))) return unavailable();
    if (![s.customers,s.estimates,s.invoices,s.ledger.entries,s.ledger.audit].every(Array.isArray)) return unavailable();
    if(s.counters.invoice!==s.invoices.length||s.counters.estimate!==s.estimates.length)return unavailable();
    for (const rows of [s.customers,s.estimates,s.invoices,s.ledger.entries,s.vendors??[],s.vendorBills??[],s.vendorPayments??[],s.projects??[]]) {
      const ids = new Set<string>(); for (const row of rows) { if (row.organizationId !== organizationId || !row.id || ids.has(row.id)) return unavailable(); ids.add(row.id); }
    }
    for(const customer of s.customers){
      const parsed=validateErpRequest({idempotencyKey:'stored-validation',expectedRevision:0,command:{type:'save_customer',customer}},organizationId);
      if(parsed.command.type!=='save_customer'||!same(parsed.command.customer,customer))return unavailable();
    }
    for(const vendor of s.vendors??[])if(!same(validateVendor(vendor,organizationId),vendor))return unavailable();
    const purchaseRevisions=new Set<number>(),billReferences=new Set<string>(),vendorPaymentKeys=new Set<string>();
    for(const bill of s.vendorBills??[]){
      if(!same(validateRecordedVendorBill(bill,organizationId),bill)||!s.vendors?.some(v=>v.id===bill.vendorId)||bill.recordedRevision>s.revision||purchaseRevisions.has(bill.recordedRevision))return unavailable();
      const reference=canonicalErpJson([bill.vendorId,bill.reference,bill.date]);
      if(billReferences.has(reference))return unavailable();billReferences.add(reference);purchaseRevisions.add(bill.recordedRevision);
      const p=s.ledger.periods.find(p=>p.id===bill.periodId);if(!p||bill.accountingDate<p.start||bill.accountingDate>p.end)return unavailable();
    }
    let paymentRevision=0;
    for(const payment of s.vendorPayments??[]){
      const bill=s.vendorBills?.find(b=>b.id===payment.billId);
      if(!same(validateRecordedVendorPayment(payment,organizationId),payment)||!bill||payment.recordedRevision<=bill.recordedRevision||payment.recordedRevision<=paymentRevision||payment.recordedRevision>s.revision||purchaseRevisions.has(payment.recordedRevision)||vendorPaymentKeys.has(payment.idempotencyKey))return unavailable();
      paymentRevision=payment.recordedRevision;purchaseRevisions.add(payment.recordedRevision);vendorPaymentKeys.add(payment.idempotencyKey);
      const p=s.ledger.periods.find(p=>p.id===payment.periodId);if(!p||payment.accountingDate<p.start||payment.accountingDate>p.end)return unavailable();
    }
    for(const bill of s.vendorBills??[])vendorBillBalance(bill,(s.vendorPayments??[]).filter(p=>p.billId===bill.id));
    const projectNumbers=new Set<string>(),projectBills=new Set<string>();
    for(const project of s.projects??[]){
      if(!same(validateStoredProject(project,config),project)||project.revision>s.revision||BigInt(project.number.slice(4))>BigInt(s.counters.project??0)||!s.customers.some(c=>c.id===project.customerId)||projectNumbers.has(project.number))return unavailable();projectNumbers.add(project.number);
      for(const billId of project.vendorBillIds){if(!s.vendorBills?.some(b=>b.id===billId)||projectBills.has(billId))return unavailable();projectBills.add(billId);}
    }
    if(s.schemaVersion===3)for(const document of [...s.estimates,...s.invoices])if(document.projectId&&!s.projects?.some(p=>p.id===document.projectId&&p.customerId===document.customer.id))return unavailable();
    for (const estimate of s.estimates) {
      if(Reflect.ownKeys(estimate).some(key=>typeof key!=='string'||!['id','organizationId','revision','currency','number','customer','projectId','date','expiresAt','paymentTermsDays','lines','notes','status'].includes(key)))return unavailable();
      const parsed=validateErpRequest({idempotencyKey:'stored-validation',expectedRevision:0,command:{type:'save_customer',customer:estimate.customer}},organizationId);
      if(parsed.command.type!=='save_customer'||!same(parsed.command.customer,estimate.customer))return unavailable();
      const request=validateErpRequest({idempotencyKey:'stored-validation',expectedRevision:0,command:{type:'save_estimate',id:estimate.id,expectedEstimateRevision:estimate.revision,customerId:estimate.customer.id,...(estimate.projectId?{projectId:estimate.projectId}:{}),date:estimate.date,expiresAt:estimate.expiresAt,paymentTermsDays:estimate.paymentTermsDays,lines:estimate.lines,notes:estimate.notes}},organizationId);
      if(request.command.type!=='save_estimate'||!same(request.command.lines,estimate.lines))return unavailable();
      validateEstimate(config,estimate);
    }
    const numbers = new Set<string>();
    for (const invoice of s.invoices) {
      if (numbers.has(invoice.number) || invoice.companyConfiguration.organizationId !== organizationId) return unavailable(); numbers.add(invoice.number);
      const estimate = s.estimates.find(q=>q.id===invoice.sourceEstimateId && q.revision===invoice.sourceEstimateRevision);
      if (!estimate) return unavailable();
      const snapshotConfig = validateCompanyConfiguration(invoice.companyConfiguration);
      let reconstructed = reconstructHistoricalInvoiceFromEstimate(snapshotConfig,estimate,{id:invoice.id,number:invoice.number,date:invoice.date,accountingDate:invoice.accountingDate,dueDate:invoice.dueDate},invoice.taxAssessment,{organizationId,userId:invoice.issuedBy,canIssue:true,managementEntitled:true,timestamp:invoice.issuedAt},invoice.sellerSnapshot);
      for (const payment of invoice.payments) reconstructed=recordCustomerPayment(snapshotConfig,reconstructed,payment,{organizationId,userId:payment.recordedBy,canIssue:true,managementEntitled:true,timestamp:invoice.issuedAt});
      if (!same(reconstructed,invoice)) return unavailable();
    }
    // Rebuild from the invoice/payment sources. Balanced fabricated entries are still invalid.
    let replay:Ledger=createLedger({organizationId,currency:config.currency,basis:config.accountingBasis,accounts:s.ledger.accounts,periods:s.ledger.periods.map(p=>({...p,status:'open'}))});
    const paidBefore = new Map<string, typeof s.invoices[number]>();
    const postedInvoices = new Set<string>();
    const postedBills = new Set<string>(),postedVendorPayments = new Set<string>();
    const paidVendors = new Map<string,bigint>();
    for (const event of s.ledger.audit) {
      const actor={organizationId,userId:event.actorId,role:'owner' as const,managementEntitled:true,timestamp:event.timestamp};
      if (event.action==='posted') {
        const entry=s.ledger.entries.find(e=>e.id===event.entityId); if (!entry) return unavailable();
        if (entry.source.type==='customer_invoice') {
          const invoice=s.invoices.find(i=>i.id===entry.source.id);if(!invoice)return unavailable();const snapshot=invoice.companyConfiguration;
          if(postedInvoices.has(invoice.id)||snapshot.accountingBasis!=='accrual'||event.actorId!==invoice.issuedBy||event.timestamp!==invoice.issuedAt)return unavailable();
          replay=postCustomerInvoice(snapshot,replay,invoice,entry.periodId,actor);postedInvoices.add(invoice.id);
        } else if (entry.source.type==='customer_payment') {
          const invoice=s.invoices.find(i=>i.id===entry.source.id);if(!invoice)return unavailable();const snapshot=invoice.companyConfiguration;
          const payment=invoice.payments.find(p=>entry.idempotencyKey===`payment:${p.idempotencyKey}`);
          if(!payment||payment.recordedBy!==event.actorId)return unavailable();
          const before=paidBefore.get(invoice.id)??{...invoice,payments:[]};
          if(invoice.payments[before.payments.length]?.id!==payment.id)return unavailable();
          replay=postCustomerPayment(snapshot,replay,before,payment,entry.periodId,actor);
          paidBefore.set(invoice.id,{...before,payments:[...before.payments,payment]});
        } else if(entry.source.type==='vendor_bill'){
          const bill=s.vendorBills?.find(b=>b.id===entry.source.id);
          if(!bill||postedBills.has(bill.id)||config.accountingBasis!=='accrual'||event.actorId!==bill.validatedBy||event.timestamp!==bill.approvedAt||entry.periodId!==bill.periodId)return unavailable();
          replay=postVendorBill(config,replay,bill,bill.periodId,actor);postedBills.add(bill.id);
        } else if(entry.source.type==='vendor_payment'){
          const bill=s.vendorBills?.find(b=>b.id===entry.source.id);
          const payment=s.vendorPayments?.find(p=>p.billId===bill?.id&&entry.idempotencyKey===`vendor-payment:${p.idempotencyKey}`);
          if(!bill||!payment||postedVendorPayments.has(payment.id)||event.actorId!==payment.recordedBy||event.timestamp!==payment.recordedAt||entry.periodId!==payment.periodId)return unavailable();
          const prior=paidVendors.get(bill.id)??BigInt(0);
          const preceding=(s.vendorPayments??[]).filter(p=>p.billId===bill.id&&p.recordedRevision<payment.recordedRevision).reduce((n,p)=>n+BigInt(p.amount.minorUnits),BigInt(0));
          if(prior!==preceding)return unavailable();
          replay=postVendorPayment(config,replay,bill,{id:payment.id,idempotencyKey:payment.idempotencyKey,paymentDate:payment.paymentDate,accountingDate:payment.accountingDate,periodId:payment.periodId,amount:payment.amount,paidBefore:money(config.currency,prior.toString()),cashFlowCategory:'operating'},actor);
          postedVendorPayments.add(payment.id);paidVendors.set(bill.id,prior+BigInt(payment.amount.minorUnits));
        } else return unavailable();
        const result=replay.entries[replay.entries.length-1];
        if (!same(result,entry)) return unavailable();
      } else if (event.action==='period_closed') replay=closePeriod(replay,event.entityId,actor,replay.revision);
      else return unavailable();
    }
    for (const invoice of s.invoices) {
      if(invoice.companyConfiguration.accountingBasis==='accrual' && invoice.total.minorUnits!=='0' && !postedInvoices.has(invoice.id))return unavailable();
      if(!same(paidBefore.get(invoice.id)?.payments??[],invoice.payments))return unavailable();
    }
    for(const bill of s.vendorBills??[])if(config.accountingBasis==='accrual'&&!postedBills.has(bill.id))return unavailable();
    if(postedVendorPayments.size!==(s.vendorPayments??[]).length)return unavailable();
    if (!same(replay,s.ledger)) return unavailable();
    return s;
  } catch (error) { if (error instanceof ErpError) throw error; return unavailable(); }
}
