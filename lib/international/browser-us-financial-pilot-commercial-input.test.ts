import { describe, expect, it } from 'vitest';
import { buildCustomerEditReview, commercialDiscount, commercialLineNet, commercialPrice, commercialQuantity } from './browser-us-financial-pilot-commercial-input';
import type { UsFinancialPilotCustomerDetail } from './us-financial-pilot-commercial-projection';

describe('commercial browser decimal input', () => {
  it('retains cents above the safe integer range and exact fractional quantities', () => {
    expect(commercialPrice('9007199254740993.01')).toBe('900719925474099301');
    expect(commercialQuantity('0.000001')).toEqual({ quantityUnits: '1', quantityScale: 6 });
    expect(commercialLineNet('0.5', '0.01', '0')).toBe('1');
    expect(commercialLineNet('3', '12.35', '10.25')).toBe('3325');
  });
  it('rejects ambiguous amounts, excessive precision and invalid quantities', () => {
    for (const value of ['1e3', '1,00', '-1', '+1', '01', ' 1', '1.001', '1.']) expect(() => commercialPrice(value)).toThrow();
    for (const value of ['0', '0.000000', '0.0000001']) expect(() => commercialQuantity(value)).toThrow();
    expect(() => commercialDiscount('100.01')).toThrow();
    expect(commercialDiscount('100.00')).toBe(10000);
  });
});

const organizationId = '11111111-1111-4111-8111-111111111111', requestId = '33333333-3333-4333-8333-333333333333';
function editInput() {
  const customer = { kind: 'business' as const, name: 'Synthetic Genève 🌍', billingAddress: { country: 'US' as const, line1: '1 Synthetic Street', line2: 'Suite 2', city: 'New York', subdivision: 'NY', postalCode: '10001' },
    shippingAddress: null, email: 'synthetic@example.test', phone: '+1 555 0100', contactName: 'Synthetic Contact', paymentTermsDays: 30 };
  const source: UsFinancialPilotCustomerDetail = { consumer: 'financial-pilot', schemaVersion: 1, organizationId, revision: 7, ledgerRevision: 5, customer: { id: 'customer-1', ...customer } };
  return { organizationId, requestId, revision: 7, source, customer: structuredClone(customer) };
}

describe('pure customer-edit review capture', () => {
  it('captures an exact update body and complete before/after without replacing the customer ID', () => {
    const input = editInput(); input.customer.name = 'Corrected Synthetic Customer'; input.customer.paymentTermsDays = 45;
    const review = buildCustomerEditReview(input);
    expect(review.request).toEqual({ consumer: 'financial-pilot', schemaVersion: 1, requestId, expectedRevision: 7, command: { type: 'update_customer', customerId: 'customer-1', customer: input.customer } });
    expect(review.body).toBe(JSON.stringify(review.request)); expect(review.before).toEqual(input.source.customer);
    expect(review.after).toEqual({ id: 'customer-1', ...input.customer }); expect(review.changedFields).toEqual(['name', 'paymentTermsDays']);
    expect(Reflect.ownKeys(review)).toEqual(['organizationId', 'request', 'body', 'before', 'after', 'changedFields']);
    expect(Object.isFrozen(review.request.command.customer.billingAddress)).toBe(true); expect(Object.isFrozen(review.before.billingAddress)).toBe(true); expect(Object.isFrozen(review.after)).toBe(true); expect(Object.isFrozen(review.changedFields)).toBe(true);
  });
  it('detaches nested source and draft values before returning', () => {
    const input = editInput(), review = buildCustomerEditReview(input), body = review.body;
    input.customer.billingAddress.line1 = 'Changed afterwards'; (input.source.customer.billingAddress as { line1: string }).line1 = 'Source changed afterwards'; input.customer.name = 'Different';
    expect(review.body).toBe(body); expect(review.after.billingAddress.line1).toBe('1 Synthetic Street'); expect(review.before.billingAddress.line1).toBe('1 Synthetic Street');
    expect(review.request.command.customer.name).toBe('Synthetic Genève 🌍');
  });
  it('preserves absent optional values as explicit nulls and distinguishes intentional clearing', () => {
    const input = editInput();
    const review = buildCustomerEditReview({ ...input, customer: { ...input.customer, email: null, phone: null, contactName: null, shippingAddress: null } });
    expect(review.changedFields).toEqual(['email', 'phone', 'contactName']); expect(review.after.email).toBeNull(); expect(review.before.email).toBe('synthetic@example.test');
    expect(Object.hasOwn(review.request.command.customer, 'shippingAddress')).toBe(true);
  });
  it('orders all changed fields consistently and preserves exact Unicode/address data', () => {
    const input = editInput(), review = buildCustomerEditReview({ ...input, customer: { kind: 'individual', name: 'Synthetic Neue Kundin 🌍', billingAddress: { country: 'CH', line1: 'Rue fictive 2', city: 'Genève', postalCode: '1201', subdivision: 'GE' },
      shippingAddress: input.customer.billingAddress, email: null, phone: null, contactName: null, paymentTermsDays: 0 } });
    expect(review.changedFields).toEqual(['kind', 'name', 'billingAddress', 'shippingAddress', 'email', 'phone', 'contactName', 'paymentTermsDays']);
    expect(review.after.billingAddress.city).toBe('Genève');
  });
  it('reports a no-op independently of address property ordering', () => {
    const input = editInput(); input.customer.billingAddress = { postalCode: '10001', country: 'US', subdivision: 'NY', city: 'New York', line2: 'Suite 2', line1: '1 Synthetic Street' };
    expect(buildCustomerEditReview(input).changedFields).toEqual([]);
  });
  it.each(['tenant', 'revision', 'uuid', 'source-extra', 'customer-extra', 'missing-null', 'overflow', 'controls', 'huge'] as const)('rejects %s without producing a review', kind => {
    const input = structuredClone(editInput()) as unknown as Record<string, unknown>, source = input.source as Record<string, unknown>, customer = input.customer as Record<string, unknown>;
    if (kind === 'tenant') input.organizationId = '22222222-2222-4222-8222-222222222222';
    if (kind === 'revision') input.revision = 8;
    if (kind === 'uuid') input.requestId = 'not-an-id';
    if (kind === 'source-extra') source.privateProof = 'not-public';
    if (kind === 'customer-extra') customer.id = 'injected';
    if (kind === 'missing-null') delete customer.shippingAddress;
    if (kind === 'overflow') input.revision = Number.MAX_SAFE_INTEGER;
    if (kind === 'controls') customer.name = 'Two\nlines';
    if (kind === 'huge') customer.name = '🌍'.repeat(140000);
    expect(() => buildCustomerEditReview(input as unknown as Parameters<typeof buildCustomerEditReview>[0])).toThrow('invalid_customer_edit_input');
  });
  it('refuses getters, symbols and custom prototypes without reading accessors', () => {
    let getterRead = false;
    const input = editInput(); Object.defineProperty(input.customer, 'name', { enumerable: true, get: () => { getterRead = true; return 'Injected'; } });
    expect(() => buildCustomerEditReview(input)).toThrow('invalid_customer_edit_input'); expect(getterRead).toBe(false);
    const symbolic = editInput(); Object.defineProperty(symbolic, Symbol('private'), { value: 'hidden', enumerable: true });
    expect(() => buildCustomerEditReview(symbolic)).toThrow('invalid_customer_edit_input');
    const inherited = editInput(); Object.setPrototypeOf(inherited.customer, { private: true });
    expect(() => buildCustomerEditReview(inherited)).toThrow('invalid_customer_edit_input');
  });
});
