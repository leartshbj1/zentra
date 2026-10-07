import { validateAddress } from './addresses';
import { validDate } from './accounting/ledger';
import { ErpError } from './erp-contract';
import type { Contact,SalesLine } from './invoicing';
import type { ErpCommand,ErpRequest } from './runtime-types';
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new ErpError('invalid_request');
  const result = value as Record<string, unknown>;
  if (Reflect.ownKeys(result).some(key => typeof key !== 'string' || !keys.includes(key))) throw new ErpError('invalid_request');
  return result;
}
function required(value: unknown, maximum = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || Array.from(value).some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127)) throw new ErpError('invalid_request');
  return value;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= Number.MAX_SAFE_INTEGER) throw new ErpError('invalid_request');
  return value as number;
}
function date(value: unknown): string { if (typeof value !== 'string' || !validDate(value)) throw new ErpError('invalid_date'); return value; }
function days(value: unknown): number { const n = integer(value); if (n > 365) throw new ErpError('invalid_payment_terms'); return n; }
function contact(value: unknown, organizationId: string): Contact {
  const c = object(value, ['id','organizationId','kind','name','billingAddress','shippingAddress','email','phone','contactName','paymentTermsDays']);
  if (c.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
  if (c.kind !== 'individual' && c.kind !== 'business') throw new ErpError('invalid_customer');
  const address = c.billingAddress as Contact['billingAddress'];
  const billingAddress = validateAddress(address, address?.country);
  const shippingAddress = c.shippingAddress === undefined ? undefined : validateAddress(c.shippingAddress, (c.shippingAddress as Contact['billingAddress'])?.country);
  if (c.email !== undefined && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(required(c.email, 254))) throw new ErpError('invalid_email');
  return { id: required(c.id), organizationId, kind: c.kind, name: required(c.name), billingAddress,
    ...(shippingAddress ? { shippingAddress } : {}), ...(c.email === undefined ? {} : { email: c.email as string }),
    ...(c.phone === undefined ? {} : { phone: required(c.phone, 80) }), ...(c.contactName === undefined ? {} : { contactName: required(c.contactName) }), paymentTermsDays: days(c.paymentTermsDays) };
}
const commandFields = {
  initialize: ['type','periods'], refresh_configuration: ['type'], save_customer: ['type','customer'],
  save_estimate: ['type','id','expectedEstimateRevision','customerId','projectId','date','expiresAt','paymentTermsDays','lines','notes'],
  accept_estimate: ['type','estimateId','expectedEstimateRevision'],
  issue_invoice: ['type','id','estimateId','expectedEstimateRevision','date','accountingDate','dueDate','periodId'],
  record_payment: ['type','id','invoiceId','amountMinor','paymentDate','accountingDate','periodId','reference'],
  close_period: ['type','periodId'],
} as const;
/** Financial input never includes a role, a tax amount, a total, a journal or an invoice number. */
export function validateErpRequest(value: unknown, organizationId: string): ErpRequest {
  const envelope = object(value, ['idempotencyKey','expectedRevision','command']);
  // The ledger derives payment:<key>; reserve its eight characters within the 240-char ledger limit.
  const idempotencyKey = required(envelope.idempotencyKey, 232);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(idempotencyKey)) throw new ErpError('invalid_request');
  const raw = object(envelope.command, [...new Set(Object.values(commandFields).flat())]);
  if (typeof raw.type !== 'string' || !Object.hasOwn(commandFields, raw.type)) throw new ErpError('invalid_request');
  const type = raw.type as ErpCommand['type']; object(raw, commandFields[type]);
  let command: ErpCommand;
  switch (type) {
    case 'refresh_configuration': command = {type}; break;
    case 'initialize': {
      if (!Array.isArray(raw.periods) || raw.periods.length < 1 || raw.periods.length > 100) throw new ErpError('invalid_period');
      command = {type, periods: raw.periods.map(value => { const p = object(value, ['id','start','end','status']); if (p.status !== 'open') throw new ErpError('invalid_period'); return {id: required(p.id),start: date(p.start),end: date(p.end),status:'open'}; })}; break;
    }
    case 'save_customer': command = { type, customer: contact(raw.customer, organizationId) }; break;
    case 'save_estimate': {
      if (!Array.isArray(raw.lines) || !raw.lines.length || raw.lines.length > 1000 || typeof raw.notes !== 'string' || raw.notes.length > 20000 || raw.notes.includes('\u0000')) throw new ErpError('invalid_estimate');
      const lines = raw.lines.map(value => { const l = object(value,['id','description','quantityUnits','quantityScale','unitPrice','discountBasisPoints','taxTreatment']); object(l.unitPrice,['currency','minorUnits']); return l as unknown as SalesLine; });
      // Exact quantity, amount and discount checks are repeated with workspace currency during transition.
      command = {type,id:required(raw.id),expectedEstimateRevision:integer(raw.expectedEstimateRevision),customerId:required(raw.customerId),...(raw.projectId === undefined ? {} : {projectId:required(raw.projectId)}),date:date(raw.date),expiresAt:date(raw.expiresAt),paymentTermsDays:days(raw.paymentTermsDays),lines,notes:raw.notes}; break;
    }
    case 'accept_estimate': command = {type,estimateId:required(raw.estimateId),expectedEstimateRevision:integer(raw.expectedEstimateRevision)}; break;
    case 'issue_invoice': command = {type,id:required(raw.id),estimateId:required(raw.estimateId),expectedEstimateRevision:integer(raw.expectedEstimateRevision),date:date(raw.date),accountingDate:date(raw.accountingDate),dueDate:date(raw.dueDate),periodId:required(raw.periodId)}; break;
    case 'record_payment': {
      if (typeof raw.amountMinor !== 'string' || !/^[1-9][0-9]{0,35}$/.test(raw.amountMinor)) throw new ErpError('invalid_amount');
      command = {type,id:required(raw.id),invoiceId:required(raw.invoiceId),amountMinor:raw.amountMinor,paymentDate:date(raw.paymentDate),accountingDate:date(raw.accountingDate),periodId:required(raw.periodId),reference:required(raw.reference,500)}; break;
    }
    case 'close_period': command = {type,periodId:required(raw.periodId)}; break;
  }
  return {idempotencyKey,expectedRevision:integer(envelope.expectedRevision),command};
}
