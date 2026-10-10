import { money, multiplyMoney } from './money';
import { canonicalErpJson } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import { validateUsFinancialPilotCommercialRequest, type UsFinancialPilotCommercialCustomer, type UsFinancialPilotCommercialRequest, type UsFinancialPilotCommercialUpdateCustomerCommand } from './us-financial-pilot-commercial';
import { validateUsFinancialPilotCustomerDetail, type UsFinancialPilotCustomerDetail } from './us-financial-pilot-commercial-projection';
import type { UsFinancialPilotParty } from './us-financial-pilot-contract';

export type CustomerEditReview = Readonly<{
  organizationId: string;
  request: UsFinancialPilotCommercialRequest & Readonly<{ command: UsFinancialPilotCommercialUpdateCustomerCommand }>;
  body: string; before: UsFinancialPilotParty; after: UsFinancialPilotParty;
  changedFields: readonly (keyof UsFinancialPilotCommercialCustomer)[];
}>;
const customerFields = ['kind', 'name', 'billingAddress', 'shippingAddress', 'email', 'phone', 'contactName', 'paymentTermsDays'] as const;

/** Pure capture only: ownership and current admission belong to the session/server. */
export function buildCustomerEditReview(input: Readonly<{
  organizationId: string; requestId: string; revision: number;
  source: UsFinancialPilotCustomerDetail; customer: UsFinancialPilotCommercialCustomer;
}>): CustomerEditReview {
  try {
    const captured = snapshotPrivateJson(input) as Record<string, unknown>;
    const fields = ['organizationId', 'requestId', 'revision', 'source', 'customer'];
    if (!captured || Array.isArray(captured) || Reflect.ownKeys(captured).length !== fields.length || fields.some(key => !Object.hasOwn(captured, key)) || typeof captured.organizationId !== 'string' || !captured.organizationId || !Number.isSafeInteger(captured.revision) || (captured.revision as number) < 1) throw new TypeError();
    const organizationId = captured.organizationId, revision = captured.revision as number;
    const source = validateUsFinancialPilotCustomerDetail(captured.source, organizationId, revision);
    const request = validateUsFinancialPilotCommercialRequest({ consumer: 'financial-pilot', schemaVersion: 1, requestId: captured.requestId, expectedRevision: revision,
      command: { type: 'update_customer', customerId: source.customer.id, customer: captured.customer } });
    if (request.command.type !== 'update_customer') throw new TypeError();
    const after = snapshotPrivateJson({ id: source.customer.id, ...request.command.customer }) as UsFinancialPilotParty;
    const changedFields = Object.freeze(customerFields.filter(key => canonicalErpJson(source.customer[key]) !== canonicalErpJson(after[key])));
    return Object.freeze({ organizationId, request: request as CustomerEditReview['request'], body: JSON.stringify(request), before: source.customer, after, changedFields });
  } catch { throw new TypeError('invalid_customer_edit_input'); }
}

/** Decimal UI values remain strings. No exponent, grouping, rounding or Number money conversion. */
export function commercialDecimal(value: string, scale: number): { units: string; scale: number } {
  if (typeof value !== 'string' || value.length > 80 || !new RegExp(`^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,${scale}})?$`).test(value)) throw new TypeError('invalid_commercial_input');
  const [whole, fraction = ''] = value.split('.');
  return { units: BigInt(whole + fraction).toString(), scale: fraction.length };
}
export function commercialQuantity(value: string): { quantityUnits: string; quantityScale: number } {
  const parsed = commercialDecimal(value, 6);
  if (BigInt(parsed.units) === BigInt(0) || parsed.units.length > 36) throw new TypeError('invalid_commercial_input');
  return { quantityUnits: parsed.units, quantityScale: parsed.scale };
}
export function commercialPrice(value: string): string {
  const parsed = commercialDecimal(value, 2);
  const minor = (BigInt(parsed.units) * BigInt(10) ** BigInt(2 - parsed.scale)).toString();
  if (minor.length > 36) throw new TypeError('invalid_commercial_input');
  return minor;
}
export function commercialDiscount(value: string): number {
  const basis = commercialPrice(value);
  if (BigInt(basis) > BigInt(10000)) throw new TypeError('invalid_commercial_input');
  return Number(basis);
}
export function commercialMajor(minor: string): string {
  const units = BigInt(minor);
  return `${units / BigInt(100)}.${(units % BigInt(100)).toString().padStart(2, '0')}`;
}
export function commercialQuantityText(units: string, scale: number): string {
  const digits = units.padStart(scale + 1, '0');
  return scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
}
export function commercialLineNet(quantity: string, price: string, discount: string): string {
  const q = commercialQuantity(quantity), gross = multiplyMoney(money('USD', commercialPrice(price)), q.quantityUnits, (BigInt(10) ** BigInt(q.quantityScale)).toString());
  const deduction = multiplyMoney(gross, String(commercialDiscount(discount)), '10000');
  if (gross.minorUnits.length > 36) throw new TypeError('invalid_commercial_input');
  return (BigInt(gross.minorUnits) - BigInt(deduction.minorUnits)).toString();
}
