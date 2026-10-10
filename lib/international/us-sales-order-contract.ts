import type { FinancialAuthority } from './accounting/ledger';
import { validDate } from './accounting/ledger';
import { validateCompanyConfiguration } from './country-config';
import { ErpError, canonicalErpJson } from './erp-contract';
import { validateErpRequest } from './erp-request';
import { validateErpContact } from './contacts';
import { estimateTotals, validateEstimate, validatePublicSellerSnapshot, type Estimate, type PublicSellerSnapshot } from './invoicing';
import { parseInstant } from './localization';
import { snapshotPrivateJson } from './private-json';
import type { CompanyConfiguration, Money } from './types';

export type UsSalesOrderState = 'draft' | 'confirmed' | 'cancelled';
export type UsSalesOrderCommand =
  | Readonly<{ type: 'create_from_estimate'; estimateId: string; expectedEstimateRevision: number; orderDate: string; customerReference: string | null }>
  | Readonly<{ type: 'confirm'; reference: string }>
  | Readonly<{ type: 'cancel'; reason: string }>;
export interface UsSalesOrderRequest {
  readonly schemaVersion: 1; readonly idempotencyKey: string; readonly orderId: string;
  readonly expectedErpRevision: number; readonly expectedHeadRevision: number; readonly expectedOrderRevision: number | null;
  readonly command: UsSalesOrderCommand;
}
export interface UsSalesOrder {
  readonly schemaVersion: 1; readonly organizationId: string; readonly id: string; readonly sequence: number;
  readonly number: string; readonly revision: number; readonly state: UsSalesOrderState;
  readonly sourceErpRevision: number; readonly sourceEstimate: Estimate;
  /** Public frozen configuration only. An EIN is never admitted in this record. */
  readonly companyConfiguration: CompanyConfiguration; readonly sellerSnapshot: PublicSellerSnapshot;
  readonly orderDate: string; readonly customerReference: string | null; readonly createdBy: string; readonly createdAt: string;
  readonly confirmation: Readonly<{ reference: string; confirmedBy: string; confirmedAt: string }> | null;
  readonly cancellation: Readonly<{ reason: string; cancelledBy: string; cancelledAt: string }> | null;
}
export interface UsSalesOrderInvoiceLink { readonly id: string; readonly number: string; readonly sourceEstimateRevision: number; readonly issuedAt: string }
export interface UsSalesOrderRecord { readonly order: UsSalesOrder; readonly invoice: UsSalesOrderInvoiceLink | null }
export interface UsSalesOrderSummary {
  readonly id: string; readonly sequence: number; readonly number: string; readonly revision: number; readonly state: UsSalesOrderState;
  readonly sourceEstimateId: string; readonly sourceEstimateRevision: number; readonly sourceEstimateNumber: string;
  readonly orderDate: string; readonly customerName: string; readonly customerReference: string | null; readonly net: Money;
  readonly confirmationReference: string | null; readonly invoice: UsSalesOrderInvoiceLink | null;
}
export interface UsSalesOrderPage {
  readonly schemaVersion: 1; readonly organizationId: string; readonly headRevision: number; readonly erpRevision: number;
  readonly total: number; readonly orders: readonly UsSalesOrderSummary[]; readonly nextBeforeSequence: number | null;
}
export interface UsSalesOrderReceipt {
  readonly schemaVersion: 1; readonly organizationId: string; readonly idempotencyKey: string; readonly commandHash: string; readonly actorId: string;
  readonly orderId: string; readonly action: UsSalesOrderCommand['type']; readonly revision: number; readonly headRevision: number; readonly erpRevision: number; readonly sequence: number;
}
export interface UsSalesOrderResult { readonly receipt: UsSalesOrderReceipt; readonly replayed: boolean }
export interface UsSalesOrderHead { readonly schemaVersion: 1; readonly organizationId: string; readonly headRevision: number; readonly erpRevision: number }
export interface UsSalesOrderSource {
  readonly schemaVersion:1;readonly organizationId:string;readonly erpRevision:number;readonly estimateId:string;
  readonly estimateRevision:number|null;readonly activeOrderId:string|null;readonly invoiceId:string|null;
  readonly status:'accepted'|'draft'|'declined'|'missing';
}
export interface UsSalesOrderStore {
  head(this:void,actor: FinancialAuthority): Promise<UsSalesOrderHead>;
  source(this:void,actor:FinancialAuthority,estimateId:string):Promise<UsSalesOrderSource>;
  list(this:void,actor: FinancialAuthority, beforeSequence?: number | null): Promise<UsSalesOrderPage>;
  read(this:void,actor: FinancialAuthority, orderId: string): Promise<UsSalesOrderRecord | null>;
  receipt(this:void,actor: FinancialAuthority, idempotencyKey: string): Promise<UsSalesOrderReceipt | null>;
  execute(this:void,actor: FinancialAuthority, request: UsSalesOrderRequest, commandHash: string): Promise<UsSalesOrderResult>;
}
export const US_SALES_ORDER_PAGE_SIZE = 25;
export const US_SALES_ORDER_SOURCE_BYTES = 512 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
const fail = (code = 'invalid_sales_order_request', status = 422): never => { throw new ErpError(code, status); };
const object = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return fail();
  return value as Record<string, unknown>;
};
export function salesOrderInteger(value: unknown, minimum = 0): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value >= Number.MAX_SAFE_INTEGER - 1) return fail(); return value; }
const text = (value: unknown, maximum = 160): string => { if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > maximum || Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return fail(); return value; };
const instant = (value: unknown): string => { const result = text(value, 40); parseInstant(result); return result; };
const date = (value: unknown): string => { if (typeof value !== 'string' || value.startsWith('0000-') || !validDate(value)) return fail(); return value; };
const detached = (value: unknown): unknown => { try { return snapshotPrivateJson(value); } catch { return fail(); } };
export function validateUsSalesOrderRequest(input: unknown, organizationId: string): UsSalesOrderRequest {
  if (!uuid.test(organizationId)) return fail();
  const value = object(detached(input), ['schemaVersion','idempotencyKey','orderId','expectedErpRevision','expectedHeadRevision','expectedOrderRevision','command']);
  if (value.schemaVersion !== 1 || typeof value.idempotencyKey !== 'string' || !keyPattern.test(value.idempotencyKey) || typeof value.orderId !== 'string' || !uuid.test(value.orderId)) return fail();
  const raw = value.command as Record<string, unknown>; let command: UsSalesOrderCommand;
  if (raw?.type === 'create_from_estimate') {
    object(raw, ['type','estimateId','expectedEstimateRevision','orderDate','customerReference']);
    if (value.expectedOrderRevision !== null) return fail();
    command = { type: raw.type, estimateId: text(raw.estimateId), expectedEstimateRevision: salesOrderInteger(raw.expectedEstimateRevision, 1), orderDate: date(raw.orderDate), customerReference: raw.customerReference === null ? null : text(raw.customerReference, 500) };
  } else if (raw?.type === 'confirm') { object(raw, ['type','reference']); command = { type: raw.type, reference: text(raw.reference, 500) }; }
  else if (raw?.type === 'cancel') { object(raw, ['type','reason']); command = { type: raw.type, reason: text(raw.reason, 500) }; }
  else return fail();
  if (command.type !== 'create_from_estimate') salesOrderInteger(value.expectedOrderRevision, 1);
  return Object.freeze({ schemaVersion: 1, idempotencyKey: value.idempotencyKey, orderId: value.orderId, expectedErpRevision: salesOrderInteger(value.expectedErpRevision, 1), expectedHeadRevision: salesOrderInteger(value.expectedHeadRevision), expectedOrderRevision: value.expectedOrderRevision as number | null, command: Object.freeze(command) });
}
function invoice(input: unknown, expectedRevision?: number): UsSalesOrderInvoiceLink | null {
  if (input === null) return null;
  const v = object(input, ['id','number','sourceEstimateRevision','issuedAt']);
  const revision = salesOrderInteger(v.sourceEstimateRevision, 1); if (expectedRevision !== undefined && revision !== expectedRevision) return fail();
  return Object.freeze({ id: text(v.id), number: text(v.number), sourceEstimateRevision: revision, issuedAt: instant(v.issuedAt) });
}
export function validateUsSalesOrderRecord(input: unknown, organizationId: string): UsSalesOrderRecord {
  try {
    const record = object(detached(input), ['order','invoice']), v = object(record.order, ['schemaVersion','organizationId','id','sequence','number','revision','state','sourceErpRevision','sourceEstimate','companyConfiguration','sellerSnapshot','orderDate','customerReference','createdBy','createdAt','confirmation','cancellation']);
    if (!uuid.test(organizationId) || v.organizationId !== organizationId || v.schemaVersion !== 1 || typeof v.id !== 'string' || !uuid.test(v.id) || !['draft','confirmed','cancelled'].includes(String(v.state))) return fail();
    const configuration = validateCompanyConfiguration(v.companyConfiguration as CompanyConfiguration);
    if (configuration.country !== 'US' || configuration.currency !== 'USD' || configuration.organizationId !== organizationId || Object.hasOwn(configuration, 'ein')) return fail();
    const source = v.sourceEstimate as Estimate;
    if (!source || Reflect.ownKeys(source).some(k => typeof k !== 'string' || !['id','organizationId','revision','currency','number','customer','projectId','date','expiresAt','paymentTermsDays','lines','notes','status'].includes(k)) || source.status !== 'accepted' || canonicalErpJson(validateErpContact(source.customer, organizationId)) !== canonicalErpJson(source.customer)) return fail();
    validateEstimate(configuration, source);
    validateErpRequest({idempotencyKey:'sales-order-source-validation',expectedRevision:0,command:{type:'save_estimate',id:source.id,expectedEstimateRevision:source.revision,customerId:source.customer.id,...(source.projectId===undefined?{}:{projectId:source.projectId}),date:source.date,expiresAt:source.expiresAt,paymentTermsDays:source.paymentTermsDays,lines:source.lines,notes:source.notes}},organizationId);
    if (new TextEncoder().encode(canonicalErpJson(source)).byteLength > US_SALES_ORDER_SOURCE_BYTES || source.revision > salesOrderInteger(v.sourceErpRevision, 1)) return fail();
    const sequence = salesOrderInteger(v.sequence, 1), number = `SO-${String(sequence).padStart(6,'0')}`;
    if (v.number !== number) return fail();
    let confirmation: UsSalesOrder['confirmation'] = null, cancellation: UsSalesOrder['cancellation'] = null;
    if (v.confirmation !== null) { const c = object(v.confirmation, ['reference','confirmedBy','confirmedAt']); confirmation = Object.freeze({ reference: text(c.reference, 500), confirmedBy: text(c.confirmedBy, 256), confirmedAt: instant(c.confirmedAt) }); }
    if (v.cancellation !== null) { const c = object(v.cancellation, ['reason','cancelledBy','cancelledAt']); cancellation = Object.freeze({ reason: text(c.reason, 500), cancelledBy: text(c.cancelledBy, 256), cancelledAt: instant(c.cancelledAt) }); }
    if (v.state === 'draft' && (confirmation !== null || cancellation !== null) || v.state === 'confirmed' && (confirmation === null || cancellation !== null) || v.state === 'cancelled' && cancellation === null) return fail();
    const createdAt = instant(v.createdAt), revision = salesOrderInteger(v.revision, 1);
    if (confirmation && Date.parse(confirmation.confirmedAt) < Date.parse(createdAt) || cancellation && Date.parse(cancellation.cancelledAt) < Date.parse(confirmation?.confirmedAt ?? createdAt) || revision !== (v.state === 'draft' ? 1 : v.state === 'confirmed' || !confirmation ? 2 : 3)) return fail();
    const linked = invoice(record.invoice, source.revision); if (linked && (v.state !== 'confirmed' || !confirmation || Date.parse(linked.issuedAt) < Date.parse(confirmation.confirmedAt))) return fail();
    const order: UsSalesOrder = { schemaVersion: 1, organizationId, id: v.id, sequence, number, revision, state: v.state as UsSalesOrderState, sourceErpRevision: v.sourceErpRevision as number, sourceEstimate: source, companyConfiguration: configuration, sellerSnapshot: validatePublicSellerSnapshot(v.sellerSnapshot, organizationId), orderDate: date(v.orderDate), customerReference: v.customerReference === null ? null : text(v.customerReference, 500), createdBy: text(v.createdBy, 256), createdAt, confirmation, cancellation };
    return deepFreeze({ order, invoice: linked });
  } catch { return fail('invalid_sales_order_record', 503); }
}
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); } return value; }
export function validateUsSalesOrderHead(input: unknown, organizationId: string): UsSalesOrderHead {
  try { const v=object(detached(input),['schemaVersion','organizationId','headRevision','erpRevision']);if(v.schemaVersion!==1||v.organizationId!==organizationId||!uuid.test(organizationId))return fail();return Object.freeze({schemaVersion:1,organizationId,headRevision:salesOrderInteger(v.headRevision),erpRevision:salesOrderInteger(v.erpRevision,1)}); }catch{return fail('invalid_sales_order_record',503);}
}
export function validateUsSalesOrderSource(input:unknown,organizationId:string):UsSalesOrderSource{
  try{
    const v=object(detached(input),['schemaVersion','organizationId','erpRevision','estimateId','estimateRevision','activeOrderId','invoiceId','status']);
    if(v.schemaVersion!==1||v.organizationId!==organizationId||!uuid.test(organizationId)||!['accepted','draft','declined','missing'].includes(String(v.status)))return fail();
    const estimateId=text(v.estimateId),erpRevision=salesOrderInteger(v.erpRevision,1),estimateRevision=v.estimateRevision===null?null:salesOrderInteger(v.estimateRevision,1),activeOrderId=v.activeOrderId===null?null:text(v.activeOrderId),invoiceId=v.invoiceId===null?null:text(v.invoiceId);
    if(activeOrderId!==null&&!uuid.test(activeOrderId)||estimateRevision!==null&&estimateRevision>erpRevision||v.status==='missing'&&(estimateRevision!==null||activeOrderId!==null||invoiceId!==null)||v.status!=='missing'&&estimateRevision===null||activeOrderId!==null&&v.status!=='accepted')return fail();
    return Object.freeze({schemaVersion:1,organizationId,erpRevision,estimateId,estimateRevision,activeOrderId,invoiceId,status:v.status as UsSalesOrderSource['status']});
  }catch{return fail('invalid_sales_order_record',503);}
}
export function summarizeUsSalesOrder(record: UsSalesOrderRecord): UsSalesOrderSummary {
  const o = record.order; return deepFreeze({ id: o.id, sequence: o.sequence, number: o.number, revision: o.revision, state: o.state, sourceEstimateId: o.sourceEstimate.id, sourceEstimateRevision: o.sourceEstimate.revision, sourceEstimateNumber: o.sourceEstimate.number, orderDate: o.orderDate, customerName: o.sourceEstimate.customer.name, customerReference: o.customerReference, net: estimateTotals(o.sourceEstimate).net, confirmationReference: o.confirmation?.reference ?? null, invoice: record.invoice });
}
export function validateUsSalesOrderPage(input: unknown, organizationId: string): UsSalesOrderPage {
  try {
    const v = object(detached(input), ['schemaVersion','organizationId','headRevision','erpRevision','total','orders','nextBeforeSequence']);
    if (v.schemaVersion !== 1 || v.organizationId !== organizationId || !uuid.test(organizationId) || !Array.isArray(v.orders) || v.orders.length > US_SALES_ORDER_PAGE_SIZE) return fail();
    const headRevision = salesOrderInteger(v.headRevision), erpRevision = salesOrderInteger(v.erpRevision, 1), total = salesOrderInteger(v.total);
    const orders = v.orders.map(item => {
      const s = object(item, ['id','sequence','number','revision','state','sourceEstimateId','sourceEstimateRevision','sourceEstimateNumber','orderDate','customerName','customerReference','net','confirmationReference','invoice']);
      const sequence = salesOrderInteger(s.sequence, 1); if (typeof s.id !== 'string' || !uuid.test(s.id) || s.number !== `SO-${String(sequence).padStart(6,'0')}` || !['draft','confirmed','cancelled'].includes(String(s.state))) return fail();
      const orderRevision=salesOrderInteger(s.revision,1);if(s.state==='draft'&&orderRevision!==1||s.state==='confirmed'&&orderRevision!==2||s.state==='cancelled'&&![2,3].includes(orderRevision))return fail();
      const n = object(s.net, ['currency','minorUnits']); if (n.currency !== 'USD' || typeof n.minorUnits !== 'string' || !/^(0|[1-9][0-9]{0,35})$/.test(n.minorUnits)) return fail();
      const sourceRevision = salesOrderInteger(s.sourceEstimateRevision, 1), confirmationReference = s.confirmationReference === null ? null : text(s.confirmationReference, 500), linked = invoice(s.invoice, sourceRevision);
      if (linked && s.state !== 'confirmed' || s.state === 'draft' && confirmationReference !== null || s.state === 'confirmed' && confirmationReference === null) return fail();
      return { id: s.id, sequence, number: s.number as string, revision: salesOrderInteger(s.revision, 1), state: s.state as UsSalesOrderState, sourceEstimateId: text(s.sourceEstimateId), sourceEstimateRevision: sourceRevision, sourceEstimateNumber: text(s.sourceEstimateNumber), orderDate: date(s.orderDate), customerName: text(s.customerName, 256), customerReference: s.customerReference === null ? null : text(s.customerReference, 500), net: { currency: 'USD' as const, minorUnits: n.minorUnits }, confirmationReference, invoice: linked };
    });
    if (orders.length > total || new Set(orders.map(o=>o.id)).size !== orders.length || orders.some((o,i)=>i>0 && orders[i-1].sequence <= o.sequence)) return fail();
    const next = v.nextBeforeSequence === null ? null : salesOrderInteger(v.nextBeforeSequence, 1);
    if (next !== null && (orders.length !== US_SALES_ORDER_PAGE_SIZE || next !== orders.at(-1)?.sequence)) return fail();
    return deepFreeze({ schemaVersion: 1, organizationId, headRevision, erpRevision, total, orders, nextBeforeSequence: next });
  } catch { return fail('invalid_sales_order_record', 503); }
}
export function validateUsSalesOrderReceipt(input: unknown, organizationId: string): UsSalesOrderReceipt {
  try {
    const v = object(detached(input), ['schemaVersion','organizationId','idempotencyKey','commandHash','actorId','orderId','action','revision','headRevision','erpRevision','sequence']);
    if (v.schemaVersion !== 1 || v.organizationId !== organizationId || !uuid.test(organizationId) || typeof v.orderId !== 'string' || !uuid.test(v.orderId) || typeof v.idempotencyKey !== 'string' || !keyPattern.test(v.idempotencyKey) || typeof v.commandHash !== 'string' || !/^[a-f0-9]{64}$/.test(v.commandHash) || !['create_from_estimate','confirm','cancel'].includes(String(v.action))) return fail();
    return deepFreeze({ schemaVersion: 1, organizationId, idempotencyKey: v.idempotencyKey, commandHash: v.commandHash, actorId: text(v.actorId, 256), orderId: v.orderId, action: v.action as UsSalesOrderCommand['type'], revision: salesOrderInteger(v.revision, 1), headRevision: salesOrderInteger(v.headRevision, 1), erpRevision: salesOrderInteger(v.erpRevision, 1), sequence: salesOrderInteger(v.sequence, 1) });
  } catch { return fail('invalid_sales_order_record', 503); }
}
