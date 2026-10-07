import { nationalAdapter } from './countries/adapters';
import { addMoney, compareMoney, money, multiplyMoney, subtractMoney } from './money';
import { minorInteger, validDate, LedgerError } from './accounting/ledger';
import { validateAddress } from './addresses';
import type { CompanyAddress, CompanyConfiguration, CountryCode, Currency, Money } from './types';
import { validateCompanyConfiguration } from './country-config';
import { parseInstant } from './localization';

export type SalesLine=Readonly<{id:string;description:string;quantityUnits:string;quantityScale:number;unitPrice:Money;discountBasisPoints:number;taxTreatment:'taxable'|'non_taxable'|'exempt'}>;
export type Contact=Readonly<{id:string;organizationId:string;kind:'individual'|'business';name:string;billingAddress:CompanyAddress;shippingAddress?:CompanyAddress;email?:string;phone?:string;contactName?:string;paymentTermsDays:number}>;
export type Estimate=Readonly<{id:string;organizationId:string;revision:number;currency:Currency;number:string;customer:Contact;projectId?:string;date:string;expiresAt:string;paymentTermsDays:number;lines:readonly SalesLine[];notes:string;status:'draft'|'accepted'|'declined'}>;
export type TaxRequest=Readonly<{organizationId:string;country:CountryCode;currency:Currency;documentId:string;documentRevision:number;fingerprint:string;transactionDate:string;customer:Contact;lines:readonly {id:string;netMinor:string;taxTreatment:SalesLine['taxTreatment']}[]}>;
export type TaxAssessment=Readonly<{organizationId:string;country:CountryCode;currency:Currency;documentId:string;documentRevision:number;fingerprint:string;source:'swiss-vat'|'external-provider'|'documented-exemption';providerReference:string;determinedAt:string;validUntil:string;lines:readonly {id:string;taxMinor:string;jurisdiction:string;evidenceReference:string}[]}>;
/** Provider handles nexus/registrations/product rules. This core contains no US rate table. */
export interface TaxCalculationProvider { readonly id:string; calculate(request:TaxRequest):Promise<TaxAssessment>; }
/** Public identity copied at issuance. Never include private company fields or credentials. */
export type PublicSellerSnapshot = Readonly<{
  organizationId: string;
  displayName: string;
  contactEmail?: string;
  contactPhone?: string;
  /** Metadata only until a trusted resolver verifies an immutable, company-scoped archived asset. No URLs. */
  logoRef?: Readonly<{ assetId: string; contentSha256: string }>;
}>;
export type IssuedInvoice=Readonly<{id:string;organizationId:string;currency:Currency;companyConfiguration:CompanyConfiguration;sellerSnapshot:PublicSellerSnapshot;number:string;sourceEstimateId:string;sourceEstimateRevision:number;customer:Contact;projectId?:string;date:string;accountingDate:string;dueDate:string;lines:readonly SalesLine[];notes:string;subtotal:Money;discount:Money;tax:Money;total:Money;taxAssessment:TaxAssessment;payments:readonly CustomerPayment[];issuedAt:string;issuedBy:string}>;
export type CustomerPayment=Readonly<{id:string;idempotencyKey:string;organizationId:string;invoiceId:string;amount:Money;paymentDate:string;accountingDate:string;reference:string;recordedBy:string}>;
/** Server/native supplies this context; never trust roles from submitted JSON. */
export type InvoicingAuthority=Readonly<{organizationId:string;userId:string;canIssue:boolean;managementEntitled:boolean;timestamp:string}>;
function text(value:string,code:string,limit=160) { if (typeof value!=='string' || !value.trim() || value.length>limit || value.includes(String.fromCharCode(0))) throw new LedgerError(code); }
function scope(configuration:CompanyConfiguration,organizationId:string) { if (configuration.organizationId!==organizationId) throw new LedgerError('TENANT_MISMATCH'); }
/** Structural validation is not storage authorization. The server must supply an authorized public company projection. */
export function validatePublicSellerSnapshot(input: unknown, organizationId: string): PublicSellerSnapshot {
  const invalid = (): never => { throw new LedgerError('INVALID_SELLER_SNAPSHOT'); };
  const object = (value: unknown, allowed: readonly string[]): Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalid();
    const copied: Record<string, unknown> = Object.create(null);
    for (const property of Reflect.ownKeys(value)) {
      if (typeof property !== 'string' || !allowed.includes(property)) return invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, property);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return invalid();
      copied[property] = descriptor.value;
    }
    return copied;
  };
  const publicValue = (value: unknown, maximum: number): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > maximum || Array.from(value).some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127)) return invalid();
    return value.trim();
  };
  const seller = object(input, ['organizationId', 'displayName', 'contactEmail', 'contactPhone', 'logoRef']);
  if (typeof seller.organizationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(seller.organizationId)) return invalid();
  if (seller.organizationId !== organizationId) throw new LedgerError('TENANT_MISMATCH');
  const displayName = publicValue(seller.displayName, 256);
  const contactEmail = seller.contactEmail === undefined ? undefined : publicValue(seller.contactEmail, 254);
  if (contactEmail !== undefined && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(contactEmail)) return invalid();
  const contactPhone = seller.contactPhone === undefined ? undefined : publicValue(seller.contactPhone, 80);
  let logoRef: PublicSellerSnapshot['logoRef'];
  if (seller.logoRef !== undefined) {
    const logo = object(seller.logoRef, ['assetId', 'contentSha256']);
    if (typeof logo.assetId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(logo.assetId) ||
        typeof logo.contentSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(logo.contentSha256)) return invalid();
    logoRef = Object.freeze({ assetId: logo.assetId, contentSha256: logo.contentSha256 });
  }
  return Object.freeze({
    organizationId: seller.organizationId,
    displayName,
    ...(contactEmail === undefined ? {} : { contactEmail }),
    ...(contactPhone === undefined ? {} : { contactPhone }),
    ...(logoRef === undefined ? {} : { logoRef }),
  });
}
function authority(configuration:CompanyConfiguration,actor:InvoicingAuthority) {
  scope(configuration,actor.organizationId);
  if (actor.managementEntitled !== true) throw new LedgerError('MANAGEMENT_ENTITLEMENT_REQUIRED');
  if (actor.canIssue !== true) throw new LedgerError('INVOICE_PERMISSION_REQUIRED');
  text(actor.userId,'ACTOR_REQUIRED');
  try {parseInstant(actor.timestamp);} catch {throw new LedgerError('INVALID_AUDIT_TIMESTAMP');}
}
export function lineTotals(line:SalesLine,currency:Currency) {
  text(line.id,'LINE_ID_REQUIRED'); text(line.description,'LINE_DESCRIPTION_REQUIRED',4000);
  if (!Number.isInteger(line.quantityScale) || line.quantityScale<0 || line.quantityScale>6 || minorInteger(line.quantityUnits)===BigInt(0)) throw new LedgerError('INVALID_QUANTITY');
  if (line.unitPrice.currency!==currency || minorInteger(line.unitPrice.minorUnits)<BigInt(0)) throw new LedgerError('INVALID_UNIT_PRICE');
  if (!Number.isInteger(line.discountBasisPoints) || line.discountBasisPoints<0 || line.discountBasisPoints>10000 || !['taxable','non_taxable','exempt'].includes(line.taxTreatment)) throw new LedgerError('INVALID_LINE');
  const gross=multiplyMoney(line.unitPrice,line.quantityUnits,(BigInt(10)**BigInt(line.quantityScale)).toString());
  const discount=multiplyMoney(gross,String(line.discountBasisPoints),'10000');
  return {gross,discount,net:subtractMoney(gross,discount)};
}
export function estimateTotals(estimate:Estimate) {
  let subtotal=money(estimate.currency,'0'),discount=money(estimate.currency,'0'); const ids=new Set<string>();
  if (!estimate.lines.length || estimate.lines.length>1000) throw new LedgerError('DOCUMENT_LINES_REQUIRED');
  for (const line of estimate.lines) { if (ids.has(line.id)) throw new LedgerError('DUPLICATE_LINE'); ids.add(line.id); const total=lineTotals(line,estimate.currency); subtotal=addMoney(subtotal,total.gross); discount=addMoney(discount,total.discount); }
  return {subtotal,discount,net:subtractMoney(subtotal,discount)};
}
export function validateEstimate(configuration:CompanyConfiguration,estimate:Estimate):Estimate {
  scope(configuration,estimate.organizationId); scope(configuration,estimate.customer.organizationId);
  if (configuration.currency!==estimate.currency) throw new LedgerError('DOCUMENT_CONFIGURATION_MISMATCH');
  validateAddress(estimate.customer.billingAddress,estimate.customer.billingAddress.country);
  if (estimate.customer.shippingAddress) validateAddress(estimate.customer.shippingAddress,estimate.customer.shippingAddress.country);
  text(estimate.id,'DOCUMENT_ID_REQUIRED'); text(estimate.number,'DOCUMENT_NUMBER_REQUIRED'); text(estimate.customer.id,'CUSTOMER_REQUIRED'); text(estimate.customer.name,'CUSTOMER_REQUIRED');
  if (!Number.isSafeInteger(estimate.revision) || estimate.revision<1 || !validDate(estimate.date) || !validDate(estimate.expiresAt) || estimate.expiresAt<estimate.date || !['draft','accepted','declined'].includes(estimate.status)) throw new LedgerError('INVALID_ESTIMATE');
  if (!Number.isInteger(estimate.paymentTermsDays) || estimate.paymentTermsDays<0 || estimate.paymentTermsDays>365) throw new LedgerError('INVALID_PAYMENT_TERMS');
  if (typeof estimate.notes!=='string' || estimate.notes.length>20000) throw new LedgerError('INVALID_NOTES');
  estimateTotals(estimate);
  return estimate;
}
export function buildTaxRequest(configuration:CompanyConfiguration,estimate:Estimate,transactionDate=estimate.date):TaxRequest {
  validateEstimate(configuration,estimate);
  if (!validDate(transactionDate)) throw new LedgerError('INVALID_DATE');
  const lines=estimate.lines.map(line=>({id:line.id,netMinor:lineTotals(line,estimate.currency).net.minorUnits,taxTreatment:line.taxTreatment}));
  // Includes location and every monetary/tax input. A new revision invalidates old determinations.
  const fingerprint=JSON.stringify([configuration.organizationId,configuration.country,configuration.currency,configuration.address,estimate.id,estimate.revision,transactionDate,estimate.customer.billingAddress,estimate.customer.shippingAddress??null,lines]);
  return Object.freeze({organizationId:configuration.organizationId,country:configuration.country,currency:configuration.currency,documentId:estimate.id,documentRevision:estimate.revision,fingerprint,transactionDate,customer:estimate.customer,lines:Object.freeze(lines)});
}
export function validateTaxAssessment(request:TaxRequest,assessment:TaxAssessment,now:string):Money {
  if (assessment.organizationId!==request.organizationId) throw new LedgerError('TENANT_MISMATCH');
  if (assessment.country!==request.country || assessment.currency!==request.currency || assessment.documentId!==request.documentId || assessment.documentRevision!==request.documentRevision || assessment.fingerprint!==request.fingerprint) throw new LedgerError('STALE_TAX_ASSESSMENT');
  if (!nationalAdapter(request.country).acceptedTaxSources.includes(assessment.source)) throw new LedgerError('INVALID_TAX_SYSTEM');
  text(assessment.providerReference,'TAX_EVIDENCE_REQUIRED',500);
  try {parseInstant(now);parseInstant(assessment.determinedAt);parseInstant(assessment.validUntil);} catch {throw new LedgerError('TAX_ASSESSMENT_EXPIRED');}
  if (Date.parse(assessment.determinedAt)>Date.parse(now) || Date.parse(assessment.validUntil)<Date.parse(now)) throw new LedgerError('TAX_ASSESSMENT_EXPIRED');
  if (assessment.lines.length!==request.lines.length) throw new LedgerError('TAX_LINES_MISMATCH');
  let tax=money(request.currency,'0'); const ids=new Set<string>();
  for (const line of assessment.lines) {
    const input=request.lines.find(candidate=>candidate.id===line.id);
    if (!input || ids.has(line.id)) throw new LedgerError('TAX_LINES_MISMATCH'); ids.add(line.id);
    const amount=minorInteger(line.taxMinor); text(line.jurisdiction,'TAX_JURISDICTION_REQUIRED'); text(line.evidenceReference,'TAX_EVIDENCE_REQUIRED',500);
    if ((input.taxTreatment!=='taxable' || assessment.source==='documented-exemption') && amount!==BigInt(0)) throw new LedgerError('INVALID_TAX_ASSESSMENT');
    tax=addMoney(tax,money(request.currency,amount.toString()));
  }
  return tax;
}
export async function determineTax(configuration:CompanyConfiguration,estimate:Estimate,provider:TaxCalculationProvider|null):Promise<TaxAssessment> {
  if (!provider || configuration.taxConfiguration.status!=='configured') throw new LedgerError('TAX_CONFIGURATION_REQUIRED');
  text(provider.id,'TAX_PROVIDER_REQUIRED');
  return provider.calculate(buildTaxRequest(configuration,estimate));
}
/** Keep only the evidence contract, never raw provider responses or debug/credential fields. */
export function taxAssessmentProof(assessment: TaxAssessment): TaxAssessment {
  return Object.freeze({
    organizationId: assessment.organizationId, country: assessment.country, currency: assessment.currency,
    documentId: assessment.documentId, documentRevision: assessment.documentRevision, fingerprint: assessment.fingerprint,
    source: assessment.source, providerReference: assessment.providerReference,
    determinedAt: assessment.determinedAt, validUntil: assessment.validUntil,
    lines: Object.freeze(assessment.lines.map(line => Object.freeze({
      id: line.id, taxMinor: line.taxMinor, jurisdiction: line.jurisdiction, evidenceReference: line.evidenceReference,
    }))),
  });
}
export function invoiceFromEstimate(configuration:CompanyConfiguration,estimate:Estimate,input:{id:string;number:string;date:string;accountingDate:string;dueDate:string},assessment:TaxAssessment|null,actor:InvoicingAuthority,seller:PublicSellerSnapshot):IssuedInvoice {
  authority(configuration,actor); validateEstimate(configuration,estimate);
  if (estimate.status!=='accepted') throw new LedgerError('ESTIMATE_ACCEPTANCE_REQUIRED');
  if (!assessment || configuration.taxConfiguration.status!=='configured') throw new LedgerError('TAX_CONFIGURATION_REQUIRED');
  if (!validDate(input.date) || !validDate(input.accountingDate) || !validDate(input.dueDate) || input.dueDate<input.date) throw new LedgerError('INVALID_DATE');
  text(input.id,'DOCUMENT_ID_REQUIRED'); text(input.number,'DOCUMENT_NUMBER_REQUIRED');
  // Tax must be assessed for the invoice's transaction date, not a stale estimate date.
  const request=buildTaxRequest(configuration,estimate,input.date);
  const tax=validateTaxAssessment(request,assessment,actor.timestamp); const totals=estimateTotals(estimate);
  const sellerSnapshot = validatePublicSellerSnapshot(seller, configuration.organizationId);
  const immutableAssessment=taxAssessmentProof(assessment);
  return Object.freeze({...input,organizationId:configuration.organizationId,currency:configuration.currency,companyConfiguration:validateCompanyConfiguration(configuration),sellerSnapshot,sourceEstimateId:estimate.id,sourceEstimateRevision:estimate.revision,customer:Object.freeze({...estimate.customer,billingAddress:Object.freeze({...estimate.customer.billingAddress}),...(estimate.customer.shippingAddress?{shippingAddress:Object.freeze({...estimate.customer.shippingAddress})}:{})}),projectId:estimate.projectId,lines:Object.freeze(estimate.lines.map(line=>Object.freeze({...line,unitPrice:Object.freeze({...line.unitPrice})}))),notes:estimate.notes,subtotal:totals.subtotal,discount:totals.discount,tax,total:addMoney(totals.net,tax),taxAssessment:immutableAssessment,payments:Object.freeze([]),issuedAt:actor.timestamp,issuedBy:actor.userId});
}
export function invoiceBalance(invoice:IssuedInvoice):Money { return invoice.payments.reduce((remaining,payment)=>subtractMoney(remaining,payment.amount),invoice.total); }
export function recordCustomerPayment(configuration:CompanyConfiguration,invoice:IssuedInvoice,input:Omit<CustomerPayment,'recordedBy'>,actor:InvoicingAuthority):IssuedInvoice {
  authority(configuration,actor); scope(configuration,invoice.organizationId); scope(configuration,input.organizationId);
  if (input.invoiceId!==invoice.id || invoice.currency!==configuration.currency || input.amount.currency!==invoice.currency) throw new LedgerError('PAYMENT_INVOICE_MISMATCH');
  text(input.id,'PAYMENT_ID_REQUIRED'); text(input.idempotencyKey,'IDEMPOTENCY_KEY_REQUIRED',240); text(input.reference,'PAYMENT_REFERENCE_REQUIRED',500);
  if (!validDate(input.paymentDate) || !validDate(input.accountingDate) || minorInteger(input.amount.minorUnits)===BigInt(0)) throw new LedgerError('INVALID_PAYMENT');
  const previous=invoice.payments.find(payment=>payment.idempotencyKey===input.idempotencyKey);
  if (previous) {
    const identity=(p:Omit<CustomerPayment,'recordedBy'>)=>JSON.stringify([p.id,p.idempotencyKey,p.organizationId,p.invoiceId,p.amount.currency,p.amount.minorUnits,p.paymentDate,p.accountingDate,p.reference]);
    if (identity(previous)!==identity(input)) throw new LedgerError('IDEMPOTENCY_CONFLICT'); return invoice;
  }
  if (invoice.payments.some(payment=>payment.id===input.id)) throw new LedgerError('PAYMENT_ID_CONFLICT');
  if (compareMoney(input.amount,invoiceBalance(invoice))>0) throw new LedgerError('PAYMENT_EXCEEDS_BALANCE');
  return Object.freeze({...invoice,payments:Object.freeze([...invoice.payments,Object.freeze({...input,amount:Object.freeze({...input.amount}),recordedBy:actor.userId})])});
}
