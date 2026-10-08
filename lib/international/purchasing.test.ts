import { describe, expect, it, vi } from 'vitest';
import { createLedger, type FinancialAuthority } from './accounting/ledger';
import { postVendorBill, postVendorPayment } from './accounting/postings';
import { validateErpContact } from './contacts';
import { usStarterChart } from './countries/us/accounting';
import type { Contact } from './invoicing';
import { money } from './money';
import { recordVendorBill, recordVendorPayment, validateRecordedVendorBill, validateRecordedVendorPayment, validateVendor, vendorBillBalance, type BillInput, type PaymentInput, type RecordedVendorBill, type RecordedVendorPayment } from './purchasing';
import type { CompanyConfiguration } from './types';

const organizationId = 'fictitious-purchasing', now = '2026-10-08T12:00:00.000Z';
function configuration(basis: 'cash' | 'accrual' = 'accrual'): CompanyConfiguration {
  return { schemaVersion: 1, organizationId, country: 'US', currency: 'USD', language: 'fr', timeZone: 'America/New_York', address: { country: 'US', line1: '1 Fictitious Workspace Street', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: basis, invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' } };
}
function vendor(): Contact {
  return { id: 'vendor-1', organizationId, kind: 'business', name: 'Fictitious Vendor', billingAddress: configuration().address, shippingAddress: { country: 'CH', line1: '1 Rue Fictive', city: 'Genève', subdivision: 'GE', postalCode: '1201' }, email: 'vendor@example.test', phone: '+41 22 555 01 00', contactName: 'Fictitious Person', paymentTermsDays: 30 };
}
function actor(role: FinancialAuthority['role'] = 'accountant'): FinancialAuthority {
  return { organizationId, userId: 'fictitious-financial-user', role, managementEntitled: true, timestamp: now };
}
function billInput(): BillInput {
  return { id: 'bill-1', vendorId: 'vendor-1', reference: 'VENDOR-2026-1', date: '2026-10-08', accountingDate: '2026-10-09', dueDate: '2026-11-08', periodId: '2026', netMinor: '10000', purchaseTaxMinor: '800', expenseAccountId: 'purchases', sourceReference: 'Fictitious manual source 1' };
}
function paymentInput(): PaymentInput {
  return { id: 'payment-1', billId: 'bill-1', amountMinor: '1000', paymentDate: '2026-10-10', accountingDate: '2026-10-11', periodId: '2026', reference: 'Fictitious bank reference 1' };
}
function bill() { return recordVendorBill(configuration(), vendor(), billInput(), actor(), 5); }
function payment() { return recordVendorPayment(configuration(), bill(), [], paymentInput(), actor(), 6, 'payment-key-1'); }
function assertFailure(task: () => unknown, code: string, status = 422) {
  expect(task).toThrow(expect.objectContaining({ code, status, message: code }));
}
function frozen(value: unknown) {
  if (!value || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const item of Object.values(value)) frozen(item);
}

describe('manual US purchasing with explicit financial authority', () => {
  it.each(['owner','admin','accountant'] as const)('records the real %s identity and timestamp without tax configuration grants', role => {
    const config = configuration(), supplier = vendor(), input = billInput(), original = structuredClone({ config, supplier, input }), recorded = recordVendorBill(config, supplier, input, actor(role), 5);
    expect(recorded).toEqual({ id: 'bill-1', organizationId, vendorId: 'vendor-1', reference: input.reference, date: input.date, accountingDate: input.accountingDate, dueDate: input.dueDate, currency: 'USD', net: money('USD','10000'), tax: money('USD','800'), total: money('USD','10800'), expenseAccountId: 'purchases', validatedBy: 'fictitious-financial-user', vendorSnapshot: supplier, periodId: '2026', approvedAt: now, approvalSource: 'manual_entry', sourceReference: input.sourceReference, recordedRevision: 5 });
    expect({ config, supplier, input }).toEqual(original); expect(config.taxConfiguration.status).toBe('unconfigured'); frozen(recorded);
  });
  it.each(['cash','accrual'] as const)('feeds existing %s posting primitives without inventing US recoverable VAT', basis => {
    const config = configuration(basis), recorded = recordVendorBill(config, vendor(), billInput(), actor(), 5);
    const initial = createLedger({ organizationId, currency: 'USD', basis, accounts: usStarterChart, periods: [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'open' }] });
    const approved = postVendorBill(config, initial, recorded, recorded.periodId, actor());
    expect(approved.entries).toHaveLength(basis === 'cash' ? 0 : 1);
    const paid = recordVendorPayment(config, recorded, [], paymentInput(), actor(), 6, 'pay-1');
    const posted = postVendorPayment(config, approved, recorded, { ...paid, paidBefore: money('USD','0'), cashFlowCategory: 'operating' }, actor());
    expect(posted.entries.at(-1)?.lines).toMatchObject([{ accountId: basis === 'cash' ? 'purchases' : 'payables', debitMinor: '1000', creditMinor: '0' }, { accountId: 'cash', debitMinor: '0', creditMinor: '1000' }]);
    expect(posted.entries.flatMap(entry => entry.lines).some(line => line.accountId === 'tax-receivable')).toBe(false);
    expect(initial.entries).toEqual([]); expect(vendorBillBalance(recorded, [paid])).toEqual(money('USD','9800'));
  });
  it('uses the actual purchases expense account from the unchanged US chart', () => {
    expect(usStarterChart.find(account => account.id === 'purchases')).toMatchObject({ code: '5000', type: 'expense' });
    assertFailure(() => recordVendorBill(configuration(), vendor(), { ...billInput(), expenseAccountId: 'operating-expense' }, actor(), 5), 'purchase_account_required');
  });
  it('preserves vendor snapshots across future supplier edits', () => {
    const supplier = vendor(), recorded = recordVendorBill(configuration(), supplier, billInput(), actor(), 5);
    Object.assign(supplier, { name: 'Later name' }); Object.assign(supplier.billingAddress, { city: 'Later city' });
    expect(recorded.vendorSnapshot.name).toBe('Fictitious Vendor'); expect(recorded.vendorSnapshot.billingAddress.city).toBe('New York'); expect(recorded.vendorSnapshot).not.toBe(supplier); frozen(recorded);
  });
  it.each(['individual','business'] as const)('uses exact existing ERP Contact rules for %s, including explicit foreign addresses', kind => {
    const input = { ...vendor(), kind, billingAddress: vendor().shippingAddress! };
    expect(validateVendor(input, organizationId)).toEqual(validateErpContact(input, organizationId)); frozen(validateVendor(input, organizationId));
  });
  it('supports zero net or zero tax with a positive total and the 36-digit upper bound', () => {
    for (const amounts of [{ netMinor: '0', purchaseTaxMinor: '1' }, { netMinor: '1', purchaseTaxMinor: '0' }, { netMinor: '9'.repeat(36), purchaseTaxMinor: '0' }]) {
      const recorded = recordVendorBill(configuration(), vendor(), { ...billInput(), ...amounts }, actor(), 5);
      expect(recorded.total.minorUnits).toBe((BigInt(amounts.netMinor) + BigInt(amounts.purchaseTaxMinor)).toString());
    }
  });
  it('rejects zero totals and overflow rather than rounding or capping', () => {
    for (const amounts of [{ netMinor: '0', purchaseTaxMinor: '0' }, { netMinor: '9'.repeat(36), purchaseTaxMinor: '1' }]) assertFailure(() => recordVendorBill(configuration(), vendor(), { ...billInput(), ...amounts }, actor(), 5), 'invalid_amount');
  });
  it.each(['member','read_only','invented-owner'] as const)('refuses role %s without financial approval', role => {
    assertFailure(() => recordVendorBill(configuration(), vendor(), billInput(), { ...actor(), role: role as FinancialAuthority['role'] }, 5), 'financial_permission_required', 403);
    assertFailure(() => recordVendorPayment(configuration(), bill(), [], paymentInput(), { ...actor(), role: role as FinancialAuthority['role'] }, 6, 'key'), 'financial_permission_required', 403);
  });
  it('requires Gestion entitlement and the exact actor/workspace identity', () => {
    assertFailure(() => recordVendorBill(configuration(), vendor(), billInput(), { ...actor(), managementEntitled: false }, 5), 'management_entitlement_required', 402);
    assertFailure(() => recordVendorPayment(configuration(), bill(), [], paymentInput(), { ...actor(), organizationId: 'other' }, 6, 'key'), 'tenant_mismatch', 403);
    assertFailure(() => recordVendorBill(configuration(), { ...vendor(), organizationId: 'other' }, billInput(), actor(), 5), 'tenant_mismatch', 403);
    assertFailure(() => recordVendorBill(configuration(), vendor(), { ...billInput(), vendorId: 'other' }, actor(), 5), 'tenant_mismatch', 403);
  });
  it('refuses a Swiss workspace while allowing a Swiss vendor in the US workspace', () => {
    const config: CompanyConfiguration = { schemaVersion: 1, organizationId, country: 'CH', currency: 'CHF', language: 'fr', timeZone: 'Europe/Zurich', address: vendor().shippingAddress! as Extract<Contact['billingAddress'], { country: 'CH' }>, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' } };
    assertFailure(() => recordVendorBill(config, vendor(), billInput(), actor(), 5), 'edition_unavailable', 409);
    expect(recordVendorBill(configuration(), { ...vendor(), billingAddress: vendor().shippingAddress! }, billInput(), actor(), 5).currency).toBe('USD');
  });
});

describe('exact purchase amounts, dates and request fields', () => {
  it.each(['-1','-0','+1','01','1.0','1e3','',' ','1,000','9'.repeat(37),1,null,NaN])('rejects noncanonical minor amount %s', amount => {
    const code = typeof amount === 'number' && !Number.isFinite(amount) ? 'invalid_request' : 'invalid_amount';
    for (const field of ['netMinor','purchaseTaxMinor']) assertFailure(() => recordVendorBill(configuration(), vendor(), { ...billInput(), [field]: amount } as BillInput, actor(), 5), code);
    assertFailure(() => recordVendorPayment(configuration(), bill(), [], { ...paymentInput(), amountMinor: amount } as PaymentInput, actor(), 6, 'key'), code);
  });
  it.each(['total','validatedBy','approvedAt','approvalSource','recordedRevision','organizationId','grant','taxConfiguration'])('refuses injected approval/total field %s', field => {
    assertFailure(() => recordVendorBill(configuration(), vendor(), { ...billInput(), [field]: 'forged' }, actor(), 5), 'invalid_request');
  });
  it.each(['recordedBy','recordedAt','recordedRevision','organizationId','amount','idempotencyKey','grant'])('refuses injected payment authority field %s', field => {
    assertFailure(() => recordVendorPayment(configuration(), bill(), [], { ...paymentInput(), [field]: 'forged' }, actor(), 6, 'key'), 'invalid_request');
  });
  it.each(['2026-02-30','2026-13-01','2026-01-32','2026-1-01','0000-01-01','2026-10-08T00:00:00Z'])('rejects malformed civil date %s', value => {
    for (const field of ['date','accountingDate','dueDate']) assertFailure(() => recordVendorBill(configuration(), vendor(), { ...billInput(), [field]: value }, actor(), 5), 'invalid_date');
    for (const field of ['paymentDate','accountingDate']) assertFailure(() => recordVendorPayment(configuration(), bill(), [], { ...paymentInput(), [field]: value }, actor(), 6, 'key'), 'invalid_date');
  });
  it('keeps transaction and accounting dates distinct and rejects a due date before the bill date', () => {
    expect(bill()).toMatchObject({ date: '2026-10-08', accountingDate: '2026-10-09', dueDate: '2026-11-08' });
    expect(payment()).toMatchObject({ paymentDate: '2026-10-10', accountingDate: '2026-10-11' });
    assertFailure(() => recordVendorBill(configuration(), vendor(), { ...billInput(), dueDate: '2026-10-07' }, actor(), 5), 'invalid_date');
  });
  it.each(['',' ','a'.repeat(501),'source\nline','source\u007f'])('requires a bounded manual sourceReference %s', sourceReference => {
    assertFailure(() => recordVendorBill(configuration(), vendor(), { ...billInput(), sourceReference }, actor(), 5), 'invalid_request');
  });
  it('accepts the source/reference limits exactly and reserves 15 ledger key characters', () => {
    expect(recordVendorBill(configuration(), vendor(), { ...billInput(), sourceReference: 's'.repeat(500), reference: 'r'.repeat(500) }, actor(), 5).sourceReference).toHaveLength(500);
    const recorded = recordVendorPayment(configuration(), bill(), [], { ...paymentInput(), reference: 'r'.repeat(500) }, actor(), 6, 'k'.repeat(225));
    expect(`vendor-payment:${recorded.idempotencyKey}`).toHaveLength(240);
    assertFailure(() => recordVendorPayment(configuration(), bill(), [], paymentInput(), actor(), 6, 'k'.repeat(226)), 'invalid_request');
  });
  it.each(['','bad key','a/b','a\nkey',':prefix'])('rejects invalid payment idempotency key %s', key => {
    assertFailure(() => recordVendorPayment(configuration(), bill(), [], paymentInput(), actor(), 6, key), 'invalid_request');
  });
  it.each([0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER,'5'])('refuses invalid server recordedRevision %s', value => {
    assertFailure(() => recordVendorBill(configuration(), vendor(), billInput(), actor(), value as number), 'invalid_stored_state', 503);
    assertFailure(() => recordVendorPayment(configuration(), bill(), [], paymentInput(), actor(), value as number, 'key'), 'invalid_stored_state', 503);
  });
  it.each(['2026-02-30T12:00:00.000Z','2026-10-08T24:00:00.000Z','2026-10-08T12:00:00','2026-10-08T12:00:00+02:00','2026-10-08T12:00:00.1Z','0000-01-01T00:00:00.000Z'])('rejects invalid ledger-compatible timestamp %s', timestamp => {
    assertFailure(() => recordVendorBill(configuration(), vendor(), billInput(), { ...actor(), timestamp }, 5), 'invalid_stored_state', 503);
  });
});

describe('vendor payment balance and explicit replay', () => {
  it('supports partial then exact final settlement without mutating bill or prior payments', () => {
    const recorded = bill(), first = payment(), before = structuredClone({ recorded, first });
    const last = recordVendorPayment(configuration(), recorded, [first], { ...paymentInput(), id: 'payment-2', amountMinor: '9800' }, actor('admin'), 7, 'payment-key-2');
    expect(vendorBillBalance(recorded, [first,last])).toEqual(money('USD','0')); expect({ recorded, first }).toEqual(before); expect(last).toMatchObject({ recordedBy: actor().userId, recordedAt: now, recordedRevision: 7 }); frozen(last);
  });
  it('rejects zero/overpayments and requires caller receipt recovery for the same ID or key', () => {
    assertFailure(() => recordVendorPayment(configuration(), bill(), [], { ...paymentInput(), amountMinor: '0' }, actor(), 6, 'key'), 'invalid_amount');
    assertFailure(() => recordVendorPayment(configuration(), bill(), [payment()], { ...paymentInput(), id: 'p2', amountMinor: '9801' }, actor(), 7, 'key2'), 'overpayment', 409);
    for (const [id,key] of [['payment-1','different-key'],['different-id','payment-key-1'],['payment-1','payment-key-1']]) assertFailure(() => recordVendorPayment(configuration(), bill(), [payment()], { ...paymentInput(), id }, actor(), 7, key), 'idempotency_conflict', 409);
  });
  it('refuses a payment attached to another bill', () => {
    assertFailure(() => recordVendorPayment(configuration(), bill(), [], { ...paymentInput(), billId: 'other' }, actor(), 6, 'key'), 'tenant_mismatch', 403);
  });
  it.each(['other-bill','other-workspace','duplicate-id','duplicate-key','overpaid','CHF'])('refuses inconsistent prior payment set %s', kind => {
    const first = payment(); let values: RecordedVendorPayment[] = [first];
    if (kind === 'other-bill') values = [{ ...first, billId: 'other' }];
    if (kind === 'other-workspace') values = [{ ...first, organizationId: 'other' }];
    if (kind === 'duplicate-id') values = [first,{ ...first, idempotencyKey: 'other-key' }];
    if (kind === 'duplicate-key') values = [first,{ ...first, id: 'other-id' }];
    if (kind === 'overpaid') values = [{ ...first, amount: money('USD','10801') }];
    if (kind === 'CHF') values = [{ ...first, amount: money('CHF','1000') }];
    assertFailure(() => vendorBillBalance(bill(), values), 'invalid_stored_state', 503);
    assertFailure(() => recordVendorPayment(configuration(), bill(), values, { ...paymentInput(), id: 'new' }, actor(), 7, 'new-key'), 'invalid_stored_state', 503);
  });
});

describe('stored purchasing records and own-data snapshots', () => {
  it('rehydrates exact frozen records with detached nested identities and amounts', () => {
    const b = structuredClone(bill()), p = structuredClone(payment()), rb = validateRecordedVendorBill(b, organizationId), rp = validateRecordedVendorPayment(p, organizationId);
    expect(rb).toEqual(b); expect(rp).toEqual(p); expect(rb).not.toBe(b); expect(rb.vendorSnapshot).not.toBe(b.vendorSnapshot); expect(rp.amount).not.toBe(p.amount); frozen(rb); frozen(rp);
  });
  const badBills: readonly ((value: RecordedVendorBill) => unknown)[] = [
    value => ({ ...value, organizationId: 'other' }), value => ({ ...value, vendorId: 'other' }), value => ({ ...value, vendorSnapshot: { ...value.vendorSnapshot, organizationId: 'other' } }),
    value => ({ ...value, currency: 'CHF' }), value => ({ ...value, net: money('CHF','10000') }), value => ({ ...value, tax: money('USD','-1') }), value => ({ ...value, total: money('USD','10801') }),
    value => ({ ...value, total: money('USD','0') }), value => ({ ...value, approvalSource: 'automatic' }), value => ({ ...value, approvedAt: '2026-02-30T12:00:00.000Z' }),
    value => ({ ...value, validatedBy: '' }), value => ({ ...value, recordedRevision: 0 }), value => ({ ...value, sourceReference: '' }), value => ({ ...value, expenseAccountId: 'inventory' }),
    value => ({ ...value, dueDate: '2026-10-07' }), value => ({ ...value, periodId: '' }), value => ({ ...value, vendorSnapshot: { ...value.vendorSnapshot, billingAddress: { ...value.vendorSnapshot.billingAddress, subdivision: 'ZZ' } } }),
    value => ({ ...value, privateGrant: true }), value => { const { reference: _reference, ...partial } = value; return partial; },
  ];
  it.each(badBills.map((change,index) => ({ change,index })))('rejects malformed stored bill $index with a stable unavailable error', ({ change }) => {
    assertFailure(() => validateRecordedVendorBill(change(bill()), organizationId), 'invalid_stored_state', 503);
  });
  const badPayments: readonly ((value: RecordedVendorPayment) => unknown)[] = [
    value => ({ ...value, organizationId: 'other' }), value => ({ ...value, amount: money('USD','0') }), value => ({ ...value, amount: money('USD','-1') }), value => ({ ...value, amount: money('CHF','1') }),
    value => ({ ...value, billId: '' }), value => ({ ...value, idempotencyKey: 'k'.repeat(226) }), value => ({ ...value, recordedAt: 'yesterday' }), value => ({ ...value, recordedBy: '' }),
    value => ({ ...value, recordedRevision: -1 }), value => ({ ...value, paymentDate: '2026-02-30' }), value => ({ ...value, accountingDate: '2026-02-30' }), value => ({ ...value, periodId: '' }),
    value => ({ ...value, reference: 'r'.repeat(501) }), value => ({ ...value, privateGrant: true }), value => { const { id: _id, ...partial } = value; return partial; },
  ];
  it.each(badPayments.map((change,index) => ({ change,index })))('rejects malformed stored payment $index with a stable unavailable error', ({ change }) => {
    assertFailure(() => validateRecordedVendorPayment(change(payment()), organizationId), 'invalid_stored_state', 503);
  });
  it.each(['config','vendor','bill-input','actor','stored-bill','stored-payment','balance-bill','prior-payment'] as const)('never invokes an accessor at %s', target => {
    const getter = vi.fn(() => { throw new Error('PRIVATE_FICTITIOUS_PURCHASE'); }), poison = <T extends object>(value: T) => { Object.defineProperty(value, 'secret', { enumerable: true, get: getter }); return value; };
    const task = target === 'config' ? () => recordVendorBill(poison(configuration()), vendor(), billInput(), actor(), 5)
      : target === 'vendor' ? () => validateVendor(poison(vendor()), organizationId)
      : target === 'bill-input' ? () => recordVendorBill(configuration(), vendor(), poison(billInput()), actor(), 5)
      : target === 'actor' ? () => recordVendorBill(configuration(), vendor(), billInput(), poison(actor()), 5)
      : target === 'stored-bill' ? () => validateRecordedVendorBill(poison(structuredClone(bill())), organizationId)
      : target === 'stored-payment' ? () => validateRecordedVendorPayment(poison(structuredClone(payment())), organizationId)
      : target === 'balance-bill' ? () => vendorBillBalance(poison(structuredClone(bill())), [])
      : () => recordVendorPayment(configuration(), bill(), [poison(structuredClone(payment()))], { ...paymentInput(), id: 'new' }, actor(), 7, 'new-key');
    expect(task).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
  it('never invokes an organizationId getter when deriving the balance scope', () => {
    const value = structuredClone(bill()), getter = vi.fn(() => { throw new Error('PRIVATE_FICTITIOUS_PURCHASE'); }); Object.defineProperty(value, 'organizationId', { enumerable: true, get: getter });
    assertFailure(() => vendorBillBalance(value, []), 'invalid_stored_state', 503); expect(getter).not.toHaveBeenCalled();
  });
  it.each(['inherited','cycle','symbol','hidden','sparse'] as const)('refuses %s stored JSON without retaining a privileged payload', kind => {
    const value: Record<string, unknown> = structuredClone(bill());
    if (kind === 'inherited') Object.setPrototypeOf(value, { grant: true });
    if (kind === 'cycle') value.private = value;
    if (kind === 'symbol') Object.defineProperty(value, Symbol('private'), { enumerable: true, value: true });
    if (kind === 'hidden') Object.defineProperty(value, 'private', { enumerable: false, value: true });
    if (kind === 'sparse') { const sparse: unknown[] = []; sparse.length = 2; value.private = sparse; }
    assertFailure(() => validateRecordedVendorBill(value, organizationId), 'invalid_stored_state', 503);
  });
});
