import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { canUseBrowserPurchasing, UsErpWorkbench, UsPurchasingRecords } from '../../components/account/us-erp-workbench';
import { browserPurchasingCopy } from './browser-purchasing-copy';
import { browserWorkbenchCopy } from './browser-workbench-copy';
import { browserPurchaseAmount, browserPurchaseTotal, buildBrowserVendorBillCommand, buildBrowserVendorCommand, buildBrowserVendorPaymentCommand, emptyBrowserVendor, emptyBrowserVendorBill, emptyBrowserVendorPayment, type BrowserVendorBillDraft, type BrowserVendorDraft, type BrowserVendorPaymentDraft } from './browser-purchasing';
import { recordVendorBill, recordVendorPayment } from './purchasing';
import { formatDateOnly } from './localization';
import { money } from './money';
import { createLedger } from './accounting/ledger';
import type { AccountRole } from '../account-security';
import { SITE_LANGUAGES } from '../site-language';
import type { ErpState } from './runtime-types';
import type { CompanyConfiguration } from './types';

// Fictitious pure presentation fixtures. Real engine/browser coverage is separate;
// these tests do not establish PostgreSQL durability, bank payment or provider tax.
const org = 'fictitious-us-purchases';
const vendor: BrowserVendorDraft = { ...emptyBrowserVendor(), name: 'Fixture Supplier', line1: '1 Example Street', city: 'Brooklyn', subdivision: 'NY', postalCode: '11201', paymentTermsDays: '30' };
const bill: BrowserVendorBillDraft = { ...emptyBrowserVendorBill(), vendorId: 'vendor-1', reference: 'BILL-42', sourceReference: 'Fixture document 42', date: '2026-10-08', accountingDate: '2026-10-09', dueDate: '2026-11-08', periodId: 'period-1', net: '100.00', purchaseTax: '8.25' };
const payment: BrowserVendorPaymentDraft = { ...emptyBrowserVendorPayment(), billId: 'bill-1', amount: '50.00', paymentDate: '2026-10-10', accountingDate: '2026-10-11', periodId: 'period-1', reference: 'Fixture paid reference' };
const configuration: CompanyConfiguration = { schemaVersion: 1, organizationId: org, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '1 Example Street', city: 'Brooklyn', subdivision: 'NY', postalCode: '11201' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' } };
function state(): ErpState {
  const supplier = buildBrowserVendorCommand(org, vendor, 'vendor-1').vendor;
  return { schemaVersion: 2, revision: 2, counters: { estimate: 0, invoice: 0 }, configuration, customers: [], estimates: [], invoices: [], vendors: [supplier], vendorBills: [], vendorPayments: [], ledger: createLedger({ organizationId: org, currency: 'USD', basis: 'accrual', accounts: [], periods: [{ id: 'period-1', start: '2026-01-01', end: '2026-12-31', status: 'open' }] }) };
}
function recorded(): ErpState {
  const before = state(), { type: _type, ...input } = buildBrowserVendorBillCommand(org, before, bill, 'bill-1');
  const actor = { organizationId: org, userId: 'fixture-accountant', role: 'accountant' as const, managementEntitled: true, timestamp: '2026-10-11T12:00:00.000Z' };
  const storedBill = recordVendorBill(configuration, before.vendors![0], input, actor, 3);
  const { type: _paymentType, ...paymentInput } = buildBrowserVendorPaymentCommand(org, { ...before, vendorBills: [storedBill] }, payment, 'payment-1');
  const storedPayment = recordVendorPayment(configuration, storedBill, [], paymentInput, actor, 4, 'fixture-payment-key');
  return { ...before, revision: 4, vendorBills: [storedBill], vendorPayments: [storedPayment] };
}

describe('manual US purchases browser builders', () => {
  it('preserves exact cents beyond Number precision and never infers blank tax as zero', () => {
    expect(browserPurchaseAmount('90071992547409.93')).toEqual(money('USD', '9007199254740993'));
    expect(browserPurchaseTotal({ net: '90071992547409.93', purchaseTax: '0.07' }).minorUnits).toBe('9007199254741000');
    expect(() => browserPurchaseTotal({ net: '10', purchaseTax: '' })).toThrow();
    expect(() => browserPurchaseTotal({ net: '0', purchaseTax: '0' })).toThrow();
    expect(() => browserPurchaseTotal({ net: '9999999999999999999999999999999999.99', purchaseTax: '0.01' })).toThrow();
  });
  it.each(['-1', '1e3', '1,000.00', '1.005', '', 'NaN', 'Infinity', ' 2 ', '.25', '99999999999999999999999999999999999.99'])('rejects ambiguous or out-of-bounds amount %s', value => {
    expect(() => browserPurchaseAmount(value)).toThrow();
  });
  it('builds a scoped supplier with optional blanks omitted and no authority metadata', () => {
    expect(buildBrowserVendorCommand(org, { ...vendor, name: ' Fixture Supplier ', email: ' ', phone: '', contactName: '' }, 'vendor-1')).toEqual({ type: 'save_vendor', vendor: { id: 'vendor-1', organizationId: org, kind: 'business', name: 'Fixture Supplier', billingAddress: { country: 'US', line1: '1 Example Street', city: 'Brooklyn', subdivision: 'NY', postalCode: '11201' }, paymentTermsDays: 30 } });
    expect(buildBrowserVendorCommand(org, { ...vendor, country: 'CH', city: 'Genève', subdivision: 'GE', postalCode: '1201' }, 'vendor-ch').vendor.billingAddress.country).toBe('CH');
    expect(JSON.stringify(buildBrowserVendorCommand(org, vendor, 'vendor-1'))).not.toMatch(/role|authority|approved|entitle|evidence|CHF/);
  });
  it.each([{ name: '' }, { name: 'x'.repeat(161) }, { name: 'bad\nname' }, { email: 'not-email' }, { paymentTermsDays: '366' }, { subdivision: 'GE' }, { postalCode: '1201' }])('rejects invalid supplier %j before POST', fields => {
    expect(() => buildBrowserVendorCommand(org, { ...vendor, ...fields }, 'vendor-1')).toThrow();
  });
  it('submits only manually entered bill facts, with no server approval or accounting fields', () => {
    const command = buildBrowserVendorBillCommand(org, state(), bill, 'bill-1');
    expect(command).toEqual({ type: 'record_vendor_bill', id: 'bill-1', vendorId: 'vendor-1', reference: 'BILL-42', sourceReference: 'Fixture document 42', date: '2026-10-08', accountingDate: '2026-10-09', dueDate: '2026-11-08', periodId: 'period-1', netMinor: '10000', purchaseTaxMinor: '825', expenseAccountId: 'purchases' });
    expect(JSON.stringify(command)).not.toMatch(/approvedAt|validatedBy|recordedRevision|vendorSnapshot|approvalSource|journal|authority/);
  });
  it.each([{ vendorId: 'missing' }, { reference: '' }, { sourceReference: '' }, { sourceReference: 'x'.repeat(501) }, { date: '2026-02-30' }, { date: '0000-10-08' }, { accountingDate: '2027-01-01' }, { dueDate: '2026-10-07' }, { periodId: 'missing' }, { purchaseTax: '' }])('rejects invalid bill %j before approval', fields => {
    expect(() => buildBrowserVendorBillCommand(org, state(), { ...bill, ...fields }, 'bill-1')).toThrow();
  });
  it('refuses a foreign vendor, duplicate source bill and closed period', () => {
    const current = state();
    expect(() => buildBrowserVendorBillCommand(org, { ...current, vendors: [{ ...current.vendors![0], organizationId: 'foreign' }] }, bill, 'bill-1')).toThrow();
    expect(() => buildBrowserVendorBillCommand(org, recorded(), bill, 'second-bill')).toThrow();
    expect(() => buildBrowserVendorBillCommand(org, { ...current, ledger: { ...current.ledger, periods: current.ledger.periods.map(item => ({ ...item, status: 'closed' as const })) } }, bill, 'bill-1')).toThrow();
  });
  it('supports exact partial payments and checks the current recorded balance', () => {
    const current = recorded();
    const command = buildBrowserVendorPaymentCommand(org, current, { ...payment, amount: '58.25' }, 'payment-2');
    expect(command).toEqual({ type: 'record_vendor_payment', id: 'payment-2', billId: 'bill-1', amountMinor: '5825', paymentDate: '2026-10-10', accountingDate: '2026-10-11', periodId: 'period-1', reference: 'Fixture paid reference' });
    expect(JSON.stringify(command)).not.toMatch(/recordedBy|recordedAt|recordedRevision|idempotencyKey|journal|role/);
    expect(() => buildBrowserVendorPaymentCommand(org, current, { ...payment, amount: '58.26' }, 'payment-2')).toThrow();
  });
  it.each([{ billId: 'missing' }, { amount: '0' }, { amount: '-1' }, { reference: '' }, { paymentDate: '2026-02-30' }, { periodId: 'missing' }, { accountingDate: '2027-01-01' }])('rejects invalid payment %j before POST', fields => {
    expect(() => buildBrowserVendorPaymentCommand(org, recorded(), { ...payment, ...fields }, 'payment-2')).toThrow();
  });
});

describe('purchasing presentation and capability', () => {
  it.each(['owner', 'admin', 'accountant', 'member', 'read_only'] as const)('requires explicit capability2 and financial role for %s actions', role => {
    expect(canUseBrowserPurchasing(role, 1)).toBe(false);
    expect(canUseBrowserPurchasing(role, 2)).toBe(['owner', 'admin', 'accountant'].includes(role));
  });
  it.each(SITE_LANGUAGES)('keeps the default1 %s shell and advertises purchases only for explicit2', language => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const props = { organizationId: org, expectedUserId: 'fixture-user', role: 'owner' as AccountRole, language };
      const old = renderToStaticMarkup(createElement(UsErpWorkbench, props));
      expect(old).toContain(browserWorkbenchCopy[language].introduction); expect(old).not.toContain(browserPurchasingCopy[language].title);
      const next = renderToStaticMarkup(createElement(UsErpWorkbench, { ...props, supportedSchemaVersion: 2 }));
      expect(next).toContain(browserPurchasingCopy[language].introduction); expect(next).not.toContain('Fixture Supplier');
      expect(fetcher).not.toHaveBeenCalled();
    } finally { fetcher.mockRestore(); }
  });
  it.each(SITE_LANGUAGES)('renders only persisted %s supplier records, civil dates and exact balances without private IDs', language => {
    const current = recorded(), copy = browserPurchasingCopy[language];
    const html = renderToStaticMarkup(createElement(UsPurchasingRecords, { state: current, language }));
    expect(html).toContain('Fixture Supplier'); expect(html).toContain('BILL-42'); expect(html).toContain(copy.approved); expect(html).toContain(copy.balance);
    expect(html).toContain(formatDateOnly('2026-10-08', `${language}-US`)); expect(html).toContain('58'); expect(html).toContain('Fixture paid reference');
    expect(html).not.toMatch(/fixture-accountant|fixture-payment-key|approvedAt|authority|binding|proof|taxOrigin|<button/);
  });
  it('escapes supplier text and never replaces the bill snapshot with later supplier edits', () => {
    const current = recorded();
    const html = renderToStaticMarkup(createElement(UsPurchasingRecords, { state: { ...current, vendors: [{ ...current.vendors![0], name: '<script>later()</script>' }] }, language: 'en' }));
    expect(html).toContain('&lt;script&gt;later()&lt;/script&gt;'); expect(html).not.toContain('<script>'); expect(html).toContain('Fixture Supplier');
  });
  it('keeps all four languages complete and describes recording rather than executing bank payments', () => {
    for (const language of SITE_LANGUAGES) {
      const copy = browserPurchasingCopy[language];
      expect(Object.keys(copy).sort()).toEqual(Object.keys(browserPurchasingCopy.en).sort());
      expect(Object.values(copy).every(value => value.trim().length > 0)).toBe(true);
      expect(copy.paymentHelp).toMatch(/does not send money|aucun argent|kein Geld|non viene inviato denaro/);
      expect(copy.help).not.toMatch(/0%|0\.00|tax exempt/);
    }
  });
});
