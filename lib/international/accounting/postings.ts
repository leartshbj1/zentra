import { addMoney, money, multiplyMoney, subtractMoney } from '../money';
import type { CompanyConfiguration, Money } from '../types';
import { invoiceBalance, type CustomerPayment, type IssuedInvoice } from '../invoicing';
import { assertFinancialAuthority, LedgerError, minorInteger, postJournal, validDate, type FinancialAuthority, type JournalInput, type JournalLine, type Ledger } from './ledger';

function nonzeroLines(lines:readonly JournalLine[]) {return lines.filter(line=>BigInt(line.debitMinor)!==BigInt(0)||BigInt(line.creditMinor)!==BigInt(0));}
function compatible(configuration:CompanyConfiguration,ledger:Ledger,organizationId:string) {
  if (configuration.organizationId!==organizationId || ledger.organizationId!==organizationId) throw new LedgerError('TENANT_MISMATCH');
  if (configuration.currency!==ledger.currency || configuration.accountingBasis!==ledger.basis) throw new LedgerError('ACCOUNTING_CONFIGURATION_MISMATCH');
}
function common(ledger:Ledger,source:JournalInput['source'],date:string,accountingDate:string,periodId:string,idempotencyKey:string):Omit<JournalInput,'description'|'lines'> {return {id:`entry:${idempotencyKey}`,idempotencyKey,organizationId:ledger.organizationId,currency:ledger.currency,basis:ledger.basis,transactionDate:date,accountingDate,periodId,source};}
function paymentCashMovement(ledger:Ledger,type:string,id:string,sign:1|-1):bigint {
  const relevant=new Set(ledger.entries.filter(entry=>entry.source.type===type && entry.source.id===id).map(entry=>entry.id));
  return ledger.entries.filter(entry=>relevant.has(entry.id) || (entry.reversesEntryId && relevant.has(entry.reversesEntryId))).reduce((sum,entry)=>sum+entry.lines.filter(line=>line.accountId==='cash').reduce((net,line)=>net+BigInt(sign)*(BigInt(line.debitMinor)-BigInt(line.creditMinor)),BigInt(0)),BigInt(0));
}
function activePosting(ledger:Ledger,type:string,id:string):boolean {return ledger.entries.some(entry=>entry.source.type===type && entry.source.id===id && !ledger.entries.some(correction=>correction.reversesEntryId===entry.id));}
/** Cash-basis invoices remain operational receivables; revenue is recognized on payment. */
export function postCustomerInvoice(configuration:CompanyConfiguration,ledger:Ledger,invoice:IssuedInvoice,periodId:string,actor:FinancialAuthority):Ledger {
  compatible(configuration,ledger,invoice.organizationId);
  assertFinancialAuthority(ledger,actor);
  if (invoice.currency!==ledger.currency) throw new LedgerError('CURRENCY_MISMATCH');
  if (ledger.basis==='cash') return ledger;
  const net=subtractMoney(invoice.total,invoice.tax);
  if (minorInteger(invoice.total.minorUnits)===BigInt(0)) return ledger;
  return postJournal(ledger,{...common(ledger,{type:'customer_invoice',id:invoice.id},invoice.date,invoice.accountingDate,periodId,`invoice:${invoice.id}`),description:`Invoice ${invoice.number}`,lines:nonzeroLines([{accountId:'receivables',debitMinor:invoice.total.minorUnits,creditMinor:'0'},{accountId:'sales',debitMinor:'0',creditMinor:net.minorUnits},{accountId:'tax-payable',debitMinor:'0',creditMinor:invoice.tax.minorUnits}])},actor,ledger.revision);
}
export function postCustomerPayment(configuration:CompanyConfiguration,ledger:Ledger,invoiceBeforePayment:IssuedInvoice,payment:CustomerPayment,periodId:string,actor:FinancialAuthority):Ledger {
  compatible(configuration,ledger,invoiceBeforePayment.organizationId);
  assertFinancialAuthority(ledger,actor);
  if (invoiceBeforePayment.currency!==ledger.currency || [invoiceBeforePayment.total,invoiceBeforePayment.tax].some(amount=>amount.currency!==ledger.currency)) throw new LedgerError('CURRENCY_MISMATCH');
  if (payment.organizationId!==ledger.organizationId || payment.invoiceId!==invoiceBeforePayment.id) throw new LedgerError('PAYMENT_INVOICE_MISMATCH');
  if (payment.amount.currency!==ledger.currency || BigInt(payment.amount.minorUnits)<=BigInt(0) || BigInt(payment.amount.minorUnits)>BigInt(invoiceBalance(invoiceBeforePayment).minorUnits)) throw new LedgerError('INVALID_PAYMENT');
  if (invoiceBeforePayment.payments.some(existing=>existing.idempotencyKey===payment.idempotencyKey)) throw new LedgerError('PAYMENT_STATE_ALREADY_APPLIED');
  let creditLines:JournalLine[];
  if (ledger.basis==='accrual') {
    if (!activePosting(ledger,'customer_invoice',invoiceBeforePayment.id)) throw new LedgerError('INVOICE_POSTING_REQUIRED');
    creditLines=[{accountId:'receivables',debitMinor:'0',creditMinor:payment.amount.minorUnits}];
  } else {
    // Cumulative allocation avoids accumulating a rounding error on partial payments.
    const previousGross=invoiceBeforePayment.payments.reduce((sum,p)=>addMoney(sum,p.amount),money(ledger.currency,'0'));
    const net=subtractMoney(invoiceBeforePayment.total,invoiceBeforePayment.tax);
    const oldNet=multiplyMoney(net,previousGross.minorUnits,invoiceBeforePayment.total.minorUnits);
    const newNet=multiplyMoney(net,addMoney(previousGross,payment.amount).minorUnits,invoiceBeforePayment.total.minorUnits);
    const recognizedNet=subtractMoney(newNet,oldNet),tax=subtractMoney(payment.amount,recognizedNet);
    creditLines=[{accountId:'sales',debitMinor:'0',creditMinor:recognizedNet.minorUnits},{accountId:'tax-payable',debitMinor:'0',creditMinor:tax.minorUnits}];
  }
  const existingPaid=paymentCashMovement(ledger,'customer_payment',invoiceBeforePayment.id,1);
  const exactReplay=ledger.entries.find(entry=>entry.idempotencyKey===`payment:${payment.idempotencyKey}`);
  const invoicePaid=invoiceBeforePayment.payments.reduce((sum,p)=>sum+BigInt(p.amount.minorUnits),BigInt(0));
  if (!exactReplay && existingPaid!==invoicePaid) throw new LedgerError('PAYMENT_STATE_CONFLICT');
  if (!payment.id.trim() || !payment.reference.trim() || payment.id.length>160 || payment.reference.length>500) throw new LedgerError('INVALID_PAYMENT');
  return postJournal(ledger,{...common(ledger,{type:'customer_payment',id:invoiceBeforePayment.id},payment.paymentDate,payment.accountingDate,periodId,`payment:${payment.idempotencyKey}`),paymentDate:payment.paymentDate,cashFlowCategory:'operating',description:`Payment ${invoiceBeforePayment.number}`,lines:nonzeroLines([{accountId:'cash',debitMinor:payment.amount.minorUnits,creditMinor:'0',description:JSON.stringify([payment.id,payment.reference])},...creditLines])},actor,ledger.revision);
}
export type VendorBill=Readonly<{id:string;organizationId:string;vendorId:string;reference:string;date:string;accountingDate:string;dueDate:string;currency:Money['currency'];net:Money;tax:Money;total:Money;expenseAccountId:string;validatedBy:string}>;
function validateVendorBill(ledger:Ledger,bill:VendorBill) {
  if (bill.organizationId!==ledger.organizationId) throw new LedgerError('TENANT_MISMATCH');
  if (bill.currency!==ledger.currency || [bill.net,bill.tax,bill.total].some(amount=>amount.currency!==ledger.currency)) throw new LedgerError('CURRENCY_MISMATCH');
  if (!bill.vendorId.trim() || !bill.reference.trim() || !bill.validatedBy.trim() || !validDate(bill.date) || !validDate(bill.accountingDate) || !validDate(bill.dueDate) || bill.dueDate<bill.date) throw new LedgerError('INVALID_VENDOR_BILL');
  [bill.net,bill.tax,bill.total].forEach(amount=>minorInteger(amount.minorUnits));
  if (addMoney(bill.net,bill.tax).minorUnits!==bill.total.minorUnits || BigInt(bill.total.minorUnits)<=BigInt(0)) throw new LedgerError('VENDOR_BILL_TOTAL_MISMATCH');
  const account=ledger.accounts.find(candidate=>candidate.id===bill.expenseAccountId);
  if (!account || !['expense','asset'].includes(account.type) || account.cash) throw new LedgerError('PURCHASE_ACCOUNT_REQUIRED');
}
export function postVendorBill(configuration:CompanyConfiguration,ledger:Ledger,bill:VendorBill,periodId:string,actor:FinancialAuthority):Ledger {
  compatible(configuration,ledger,bill.organizationId); validateVendorBill(ledger,bill);
  assertFinancialAuthority(ledger,actor);
  if (ledger.basis==='cash') return ledger;
  // US purchase sales tax is included in cost; this code never invents a VAT credit.
  // Swiss input-tax recovery deliberately remains in the existing native VAT engine.
  return postJournal(ledger,{...common(ledger,{type:'vendor_bill',id:bill.id},bill.date,bill.accountingDate,periodId,`vendor-bill:${bill.id}`),description:`Vendor bill ${bill.reference}`,lines:[{accountId:bill.expenseAccountId,debitMinor:bill.total.minorUnits,creditMinor:'0'},{accountId:'payables',debitMinor:'0',creditMinor:bill.total.minorUnits}]},actor,ledger.revision);
}
export function postVendorPayment(configuration:CompanyConfiguration,ledger:Ledger,bill:VendorBill,input:{id:string;idempotencyKey:string;paymentDate:string;accountingDate:string;periodId:string;amount:Money;paidBefore:Money;cashFlowCategory:'operating'|'investing'},actor:FinancialAuthority):Ledger {
  compatible(configuration,ledger,bill.organizationId); validateVendorBill(ledger,bill);
  assertFinancialAuthority(ledger,actor);
  if (!input.id.trim() || input.id.length>160) throw new LedgerError('INVALID_VENDOR_PAYMENT');
  if (input.amount.currency!==ledger.currency || input.paidBefore.currency!==ledger.currency) throw new LedgerError('CURRENCY_MISMATCH');
  minorInteger(input.amount.minorUnits);minorInteger(input.paidBefore.minorUnits);
  if (BigInt(input.amount.minorUnits)<=BigInt(0) || BigInt(addMoney(input.amount,input.paidBefore).minorUnits)>BigInt(bill.total.minorUnits)) throw new LedgerError('INVALID_VENDOR_PAYMENT');
  if (ledger.basis==='accrual' && !activePosting(ledger,'vendor_bill',bill.id)) throw new LedgerError('VENDOR_BILL_POSTING_REQUIRED');
  const paid=paymentCashMovement(ledger,'vendor_payment',bill.id,-1);
  if (!ledger.entries.some(entry=>entry.idempotencyKey===`vendor-payment:${input.idempotencyKey}`) && paid!==BigInt(input.paidBefore.minorUnits)) throw new LedgerError('PAYMENT_STATE_CONFLICT');
  return postJournal(ledger,{...common(ledger,{type:'vendor_payment',id:bill.id},input.paymentDate,input.accountingDate,input.periodId,`vendor-payment:${input.idempotencyKey}`),paymentDate:input.paymentDate,cashFlowCategory:input.cashFlowCategory,description:`Payment ${bill.reference}`,lines:[{accountId:ledger.basis==='accrual'?'payables':bill.expenseAccountId,debitMinor:input.amount.minorUnits,creditMinor:'0'},{accountId:'cash',debitMinor:'0',creditMinor:input.amount.minorUnits,description:input.id}]},actor,ledger.revision);
}
