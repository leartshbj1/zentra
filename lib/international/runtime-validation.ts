import { validateCompanyConfiguration } from './country-config';
import { createLedger,closePeriod,type Ledger } from './accounting/ledger';
import { postCustomerInvoice,postCustomerPayment } from './accounting/postings';
import { reconstructHistoricalInvoiceFromEstimate,recordCustomerPayment,validateEstimate } from './invoicing';
import { ErpError,canonicalErpJson } from './erp-contract';
import { validateErpRequest } from './erp-request';
import { nationalAdapter } from './countries/adapters';
import type { ErpState } from './runtime-types';
const same = (a:unknown,b:unknown) => canonicalErpJson(a) === canonicalErpJson(b);
function exactKeys(value:unknown,keys:readonly string[]):boolean{return !!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).every(k=>typeof k==='string'&&keys.includes(k));}
function unavailable(): never { throw new ErpError('invalid_stored_state',503); }
/** Validate stored calculations without applying today's tax expiry to historical invoices. */
export function validateStoredErp(value: unknown, organizationId: string): ErpState {
  try {
    const s = value as ErpState;
    if (!exactKeys(s,['schemaVersion','revision','configuration','counters','ledger','customers','estimates','invoices']) || s.schemaVersion !== 1 || !Number.isSafeInteger(s.revision) || s.revision < 1 || s.configuration.organizationId !== organizationId) return unavailable();
    const config = validateCompanyConfiguration(s.configuration);
    if (config.country !== 'US' || !exactKeys(s.ledger,['organizationId','currency','basis','revision','accounts','periods','entries','audit']) || s.ledger.organizationId !== organizationId || s.ledger.currency !== config.currency || s.ledger.basis !== config.accountingBasis || !same(s.ledger.accounts,nationalAdapter(config.country).starterChart)) return unavailable();
    if (!exactKeys(s.counters,['estimate','invoice']) || !Number.isSafeInteger(s.counters.invoice) || s.counters.invoice < 0 || !Number.isSafeInteger(s.counters.estimate) || s.counters.estimate < 0) return unavailable();
    if (![s.customers,s.estimates,s.invoices,s.ledger.entries,s.ledger.audit].every(Array.isArray)) return unavailable();
    if(s.counters.invoice!==s.invoices.length||s.counters.estimate!==s.estimates.length)return unavailable();
    for (const rows of [s.customers,s.estimates,s.invoices,s.ledger.entries]) {
      const ids = new Set<string>(); for (const row of rows) { if (row.organizationId !== organizationId || !row.id || ids.has(row.id)) return unavailable(); ids.add(row.id); }
    }
    for(const customer of s.customers){
      const parsed=validateErpRequest({idempotencyKey:'stored-validation',expectedRevision:0,command:{type:'save_customer',customer}},organizationId);
      if(parsed.command.type!=='save_customer'||!same(parsed.command.customer,customer))return unavailable();
    }
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
    for (const event of s.ledger.audit) {
      const actor={organizationId,userId:event.actorId,role:'owner' as const,managementEntitled:true,timestamp:event.timestamp};
      if (event.action==='posted') {
        const entry=s.ledger.entries.find(e=>e.id===event.entityId); if (!entry) return unavailable();
        const invoice=s.invoices.find(i=>i.id===entry.source.id); if (!invoice) return unavailable();
        const snapshot=invoice.companyConfiguration;
        if (entry.source.type==='customer_invoice') {
          if(postedInvoices.has(invoice.id)||snapshot.accountingBasis!=='accrual'||event.actorId!==invoice.issuedBy||event.timestamp!==invoice.issuedAt)return unavailable();
          replay=postCustomerInvoice(snapshot,replay,invoice,entry.periodId,actor);postedInvoices.add(invoice.id);
        } else if (entry.source.type==='customer_payment') {
          const payment=invoice.payments.find(p=>entry.idempotencyKey===`payment:${p.idempotencyKey}`);
          if(!payment||payment.recordedBy!==event.actorId)return unavailable();
          const before=paidBefore.get(invoice.id)??{...invoice,payments:[]};
          if(invoice.payments[before.payments.length]?.id!==payment.id)return unavailable();
          replay=postCustomerPayment(snapshot,replay,before,payment,entry.periodId,actor);
          paidBefore.set(invoice.id,{...before,payments:[...before.payments,payment]});
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
    if (!same(replay,s.ledger)) return unavailable();
    return s;
  } catch (error) { if (error instanceof ErpError) throw error; return unavailable(); }
}
