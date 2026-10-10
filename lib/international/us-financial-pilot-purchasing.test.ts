import { describe, expect, it, vi } from 'vitest';
import { canonicalErpJson } from './erp-contract';
import { validateUsFinancialRequestV5 } from './us-financial-kernel-runtime';
import { buildUsFinancialPilotPurchasingRequest, usFinancialPilotPurchasingEntityId, validateUsFinancialPilotPurchasingReceipt, validateUsFinancialPilotPurchasingRequest,
  type UsFinancialPilotPurchasingCommand } from './us-financial-pilot-purchasing';

const requestId = 'a1000000-0000-4000-8000-000000000001';
const address = { country: 'US', line1: '1 Synthetic Street', city: 'Brooklyn', subdivision: 'NY', postalCode: '11201' } as const;
const vendor = { kind: 'business', name: 'Synthetic vendor — Genève 🌍', billingAddress: address, shippingAddress: null, email: null, phone: null, contactName: null, paymentTermsDays: 30 } as const;
const save = () => ({ type: 'save_vendor', vendorId: null, vendor }) as const;
const bill = () => ({ type: 'record_vendor_bill', vendorId: 'vendor', reference: 'Synthetic bill reference', date: '2026-10-10', accountingDate: '2026-10-11', dueDate: '2026-11-10', periodId: '2026', netMinor: '9007199254740993', purchaseTaxMinor: '825', sourceReference: 'Manual source reference' }) as const;
const payment = () => ({ type: 'record_vendor_payment', billId: 'bill', amountMinor: '9007199254740993', paymentDate: '2026-10-09', accountingDate: '2026-10-11', periodId: '2026', reference: 'Synthetic recorded payment' }) as const;
const request = (command: unknown = bill()) => ({ consumer: 'financial-pilot', schemaVersion: 1, requestId, expectedRevision: 9, command });
const bad = (value: unknown) => expect(() => validateUsFinancialPilotPurchasingRequest(value)).toThrow(expect.objectContaining({ code: 'invalid_financial_pilot_request', status: 422 }));

describe('financial-pilot closed manual purchasing contract', () => {
  it('creates and edits contacts using server organization and deterministic creation identity', () => {
    const created = buildUsFinancialPilotPurchasingRequest(request(save()), 'workspace');
    expect(created).toEqual({ idempotencyKey: `pilot:purchasing:${requestId}`, expectedRevision: 9, command: { type: 'erp_command', request: { type: 'save_vendor', vendor: {
      id: `pilot-vendor:${requestId}`, organizationId: 'workspace', kind: vendor.kind, name: vendor.name, billingAddress: address, paymentTermsDays: 30 } } } });
    expect(validateUsFinancialRequestV5(created, 'workspace')).toEqual(created);
    const edited = buildUsFinancialPilotPurchasingRequest(request({ ...save(), vendorId: 'existing-vendor', vendor: { ...vendor, email: 'vendor@example.test', phone: '+1 555 0100', contactName: 'Vendor contact', shippingAddress: address } }), 'workspace');
    expect(edited.command).toMatchObject({ request: { vendor: { id: 'existing-vendor', organizationId: 'workspace', email: 'vendor@example.test', shippingAddress: address } } });
  });
  it('fixes purchases and IDs while retaining exact net, explicit tax, references and independent dates', () => {
    const built = buildUsFinancialPilotPurchasingRequest(request(), 'workspace');
    expect(built.command).toEqual({ type: 'erp_command', request: { ...bill(), id: `pilot-vendor-bill:${requestId}`, expenseAccountId: 'purchases' } });
    expect(validateUsFinancialRequestV5(built, 'workspace')).toEqual(built);
    const recorded = buildUsFinancialPilotPurchasingRequest(request(payment()), 'workspace');
    expect(recorded.command).toEqual({ type: 'erp_command', request: { ...payment(), id: `pilot-vendor-payment:${requestId}` } });
    expect(validateUsFinancialRequestV5(recorded, 'workspace')).toEqual(recorded);
    expect(validateUsFinancialPilotPurchasingRequest(request({ ...bill(), netMinor: '0', purchaseTaxMinor: '1' })).command).toMatchObject({ netMinor: '0', purchaseTaxMinor: '1' });
    expect(validateUsFinancialPilotPurchasingRequest(request({ ...bill(), purchaseTaxMinor: '0' })).command).toMatchObject({ purchaseTaxMinor: '0' });
  });
  it('detaches contacts and hashes explicit tax/source/reference without normalizing business text', () => {
    const input = structuredClone(request({ ...save(), vendor: { ...vendor, name: 'Synthetic\u0080 supplier' } })), checked = validateUsFinancialPilotPurchasingRequest(input), built = buildUsFinancialPilotPurchasingRequest(input, 'workspace');
    const original = canonicalErpJson(built);
    (input as unknown as { command: { vendor: { billingAddress: { city: string } } } }).command.vendor.billingAddress.city = 'Changed';
    expect(checked.command.type === 'save_vendor' && checked.command.vendor.billingAddress.city).toBe('Brooklyn'); expect(canonicalErpJson(built)).toBe(original);
    for (const patch of [{ purchaseTaxMinor: '826' }, { sourceReference: 'Different manual source' }, { reference: 'Different bill reference' }]) {
      expect(canonicalErpJson(buildUsFinancialPilotPurchasingRequest(request({ ...bill(), ...patch }), 'workspace'))).not.toBe(canonicalErpJson(buildUsFinancialPilotPurchasingRequest(request(), 'workspace')));
    }
    expect(Object.isFrozen(checked.command)).toBe(true); expect(Object.isFrozen(checked.command.type === 'save_vendor' && checked.command.vendor.billingAddress)).toBe(true);
  });
  it.each([
    ['private envelope', () => ({ ...request(), policy: 'private' })], ['wrong consumer', () => ({ ...request(), consumer: 'erp5' })],
    ['wrong version', () => ({ ...request(), schemaVersion: 5 })], ['uppercase UUID', () => ({ ...request(), requestId: requestId.toUpperCase() })],
    ['revision zero', () => ({ ...request(), expectedRevision: 0 })], ['unsafe revision', () => ({ ...request(), expectedRevision: Number.MAX_SAFE_INTEGER })],
    ['unsupported command', () => request({ type: 'issue_invoice' })], ['generated bill ID', () => request({ ...bill(), id: 'caller' })],
    ['organization', () => request({ ...bill(), organizationId: 'other' })], ['expense account', () => request({ ...bill(), expenseAccountId: 'cash' })],
    ['currency', () => request({ ...bill(), currency: 'CHF' })], ['approval', () => request({ ...bill(), approvedBy: 'owner' })],
    ['total', () => request({ ...bill(), totalMinor: '10' })], ['blank tax', () => request({ ...bill(), purchaseTaxMinor: '' })],
    ['null tax', () => request({ ...bill(), purchaseTaxMinor: null })], ['omitted tax', () => { const { purchaseTaxMinor: _tax, ...c } = bill(); return request(c); }],
    ['leading zero', () => request({ ...bill(), netMinor: '01' })], ['negative tax', () => request({ ...bill(), purchaseTaxMinor: '-1' })],
    ['numeric amount', () => request({ ...bill(), netMinor: 100 })], ['exponent amount', () => request({ ...bill(), netMinor: '1e3' })],
    ['zero bill', () => request({ ...bill(), netMinor: '0', purchaseTaxMinor: '0' })], ['oversize amount', () => request({ ...bill(), netMinor: '1'.repeat(37) })],
    ['total overflow', () => request({ ...bill(), netMinor: '9'.repeat(36), purchaseTaxMinor: '1' })], ['zero payment', () => request({ ...payment(), amountMinor: '0' })],
    ['invalid date', () => request({ ...bill(), date: '2026-02-30' })], ['year zero', () => request({ ...payment(), paymentDate: '0000-01-01' })],
    ['early due date', () => request({ ...bill(), dueDate: '2026-10-09' })], ['empty reference', () => request({ ...bill(), reference: ' ' })],
    ['long reference', () => request({ ...bill(), reference: 'x'.repeat(501) })], ['long source', () => request({ ...bill(), sourceReference: 'x'.repeat(501) })],
    ['control reference', () => request({ ...payment(), reference: 'One\nTwo' })], ['long selected ID', () => request({ ...payment(), billId: 'x'.repeat(161) })],
    ['vendor private fields', () => request({ ...save(), vendor: { ...vendor, organizationId: 'other' } })],
    ['vendor email', () => request({ ...save(), vendor: { ...vendor, email: 'invalid' } })],
    ['vendor unsupported address', () => request({ ...save(), vendor: { ...vendor, billingAddress: { ...address, country: 'GB' } } })],
    ['vendor missing nullable fields', () => { const { phone: _phone, ...c } = vendor; return request({ ...save(), vendor: c }); }],
  ] as const)('rejects %s', (_label, input) => bad(input()));
  it('keeps the existing US and CH address rules and 500-character references', () => {
    expect(validateUsFinancialPilotPurchasingRequest(request({ ...save(), vendor: { ...vendor, billingAddress: { country: 'CH', line1: '1 Rue synthétique', city: 'Genève', subdivision: 'GE', postalCode: '1201' } } })).command.type).toBe('save_vendor');
    expect(validateUsFinancialPilotPurchasingRequest(request({ ...bill(), reference: 'x'.repeat(500), sourceReference: 'y'.repeat(500) })).command).toMatchObject({ reference: 'x'.repeat(500) });
  });
  it('rejects accessors, inherited data, symbols and invalid Unicode without evaluating getters', () => {
    const getter = vi.fn(() => 'private'); bad(Object.defineProperty(request(), 'grant', { enumerable: true, get: getter })); expect(getter).not.toHaveBeenCalled();
    bad(Object.assign(Object.create({ role: 'owner' }) as object, request())); bad({ ...request(), [Symbol('private')]: true });
    bad(request({ ...bill(), sourceReference: '\ud800' })); bad(Object.defineProperty(request(), 'requestId', { enumerable: true, get: getter })); expect(getter).not.toHaveBeenCalled();
  });
  it.each([save(), { ...save(), vendorId: 'existing' }, bill(), payment()] as UsFinancialPilotPurchasingCommand[])('binds a $type receipt to exact request/action/entity/revision', command => {
    const expected = validateUsFinancialPilotPurchasingRequest(request(command)), receipt = { consumer: 'financial-pilot', schemaVersion: 1, organizationId: 'workspace', revision: 10, entityId: usFinancialPilotPurchasingEntityId(expected), action: command.type, requestId };
    expect(validateUsFinancialPilotPurchasingReceipt(receipt, 'workspace', expected)).toEqual(receipt);
    for (const patch of [{ requestId: 'a1000000-0000-4000-8000-000000000002' }, { entityId: 'other' }, { revision: 11 }, { organizationId: 'other' }, { action: 'erp_command' }, { private: true }]) {
      expect(() => validateUsFinancialPilotPurchasingReceipt({ ...receipt, ...patch }, 'workspace', expected)).toThrow(expect.objectContaining({ code: 'invalid_financial_pilot_response', status: 503 }));
    }
    const getter = vi.fn(() => true); expect(() => validateUsFinancialPilotPurchasingReceipt(Object.defineProperty({ ...receipt }, 'private', { enumerable: true, get: getter }), 'workspace', expected)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
});
