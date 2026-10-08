import { validateAddress } from './addresses';
import { ErpError } from './erp-contract';
import type { Contact } from './invoicing';

// Shared customer/vendor shape. Keeping these rules unchanged preserves old
// contact records; a vendor's address does not determine the workspace country.
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new ErpError('invalid_request');
  const result = value as Record<string, unknown>;
  if (Reflect.ownKeys(result).some(key => typeof key !== 'string' || !keys.includes(key))) throw new ErpError('invalid_request');
  return result;
}
function required(value: unknown, maximum = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new ErpError('invalid_request');
  return value;
}
function days(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= Number.MAX_SAFE_INTEGER) throw new ErpError('invalid_request');
  if ((value as number) > 365) throw new ErpError('invalid_payment_terms');
  return value as number;
}
export function validateErpContact(value: unknown, organizationId: string): Contact {
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
