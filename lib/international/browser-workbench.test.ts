import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { browserSalesLine, buildBrowserCustomerCommand, buildBrowserEstimateCommand, buildBrowserInitializeCommand, UsErpRecords, UsErpWorkbench, type BrowserCustomerDraft, type BrowserEstimateDraft } from '../../components/account/us-erp-workbench';
import { browserWorkbenchCopy } from './browser-workbench-copy';
import { lineTotals } from './invoicing';
import { formatDateOnly } from './localization';
import { SITE_LANGUAGES } from '../site-language';
import type { ErpState } from './runtime-types';

const organizationId = 'fictitious-us-workbench';
const customerDraft: BrowserCustomerDraft = { kind: 'business', name: 'Fictitious customer', line1: '1 Example Street', line2: '', city: 'Brooklyn', subdivision: 'NY', postalCode: '11201', email: 'customer@example.test', phone: '', contactName: '', paymentTermsDays: '30' };
const estimateDraft: BrowserEstimateDraft = { customerId: 'customer-1', date: '2026-10-08', expiresAt: '2026-11-08', paymentTermsDays: '30', notes: 'Fixture only', lines: [{ id: 'line-1', description: 'Fictitious service', quantity: '0.125000', unitPrice: '90071992547409.93' }] };
function state(): ErpState {
  const command = buildBrowserCustomerCommand(organizationId, customerDraft, 'customer-1');
  if (command.type !== 'save_customer') throw new Error('Unexpected fixture');
  const address = command.customer.billingAddress;
  if (address.country !== 'US') throw new Error('Unexpected fixture country');
  return { schemaVersion: 1, revision: 3, counters: { estimate: 1, invoice: 0 },
    configuration: { schemaVersion: 1, organizationId, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' } },
    ledger: { organizationId, currency: 'USD', basis: 'accrual', revision: 0, accounts: [], periods: [], entries: [], audit: [] }, customers: [command.customer], invoices: [],
    estimates: [{ id: 'estimate-1', organizationId, revision: 1, currency: 'USD', number: 'EST-000001', customer: command.customer, date: estimateDraft.date, expiresAt: estimateDraft.expiresAt, paymentTermsDays: 30, lines: estimateDraft.lines.map(browserSalesLine), notes: 'Fixture only', status: 'draft' }],
  };
}

describe('US browser workbench commands and presentation', () => {
  it('keeps exact decimal quantities and amounts above Number precision without tax exemption', () => {
    const line = browserSalesLine(estimateDraft.lines[0]);
    expect(line).toMatchObject({ quantityUnits: '125000', quantityScale: 6, unitPrice: { currency: 'USD', minorUnits: '9007199254740993' }, taxTreatment: 'taxable', discountBasisPoints: 0 });
    expect(lineTotals(line, 'USD').net.minorUnits).toBe('1125899906842624');
  });
  it.each(['0', '-1', '1e3', '1,5', '1.0000001', '', 'Infinity'])('rejects unusable quantity %s', quantity => {
    expect(() => browserSalesLine({ ...estimateDraft.lines[0], quantity })).toThrow();
  });
  it.each(['-1', '1e3', '1,000.00', '1.005', '', 'NaN'])('rejects unusable USD price %s instead of silently changing it', unitPrice => {
    expect(() => browserSalesLine({ ...estimateDraft.lines[0], unitPrice })).toThrow();
  });
  it.each(['business', 'individual'] as const)('constructs a scoped %s customer with full US address', kind => {
    const command = buildBrowserCustomerCommand(organizationId, { ...customerDraft, kind }, 'customer-1');
    expect(command).toEqual({ type: 'save_customer', customer: { id: 'customer-1', organizationId, kind, name: 'Fictitious customer', billingAddress: { country: 'US', line1: '1 Example Street', city: 'Brooklyn', subdivision: 'NY', postalCode: '11201' }, email: 'customer@example.test', paymentTermsDays: 30 } });
    expect(JSON.stringify(command)).not.toMatch(/authority|subscription|role|seller|evidence/);
  });
  it.each([{ subdivision: 'GE' }, { postalCode: '1201' }, { line1: '' }, { city: '' }, { email: 'not-email' }, { paymentTermsDays: '366' }])('rejects incomplete or invalid customer fields %j', fields => {
    expect(() => buildBrowserCustomerCommand(organizationId, { ...customerDraft, ...fields }, 'customer-1')).toThrow();
  });
  it('builds a new estimate without server-owned number, state, total, tax or authority', () => {
    const command = buildBrowserEstimateCommand(organizationId, estimateDraft, 'estimate-1');
    expect(command.type).toBe('save_estimate');
    expect(Object.keys(command).sort()).toEqual(['type', 'id', 'expectedEstimateRevision', 'customerId', 'date', 'expiresAt', 'paymentTermsDays', 'notes', 'lines'].sort());
    expect(command).toMatchObject({ expectedEstimateRevision: 0, customerId: 'customer-1', date: '2026-10-08', expiresAt: '2026-11-08' });
  });
  it('rejects a line or cumulative subtotal outside the persisted money bounds before sending', () => {
    const tooLarge = { ...estimateDraft.lines[0], quantity: '999999999999999999999999999999', unitPrice: '999999999999999999999999999999' };
    expect(() => browserSalesLine(tooLarge)).toThrow();
    const large = { ...estimateDraft.lines[0], quantity: '10000', unitPrice: '999999999999999999999999999999.99' };
    expect(() => browserSalesLine(large)).not.toThrow();
    expect(() => buildBrowserEstimateCommand(organizationId, { ...estimateDraft, lines: [large, { ...large, id: 'line-2' }] }, 'estimate-1')).toThrow();
  });
  it.each([{ expiresAt: '2026-10-07' }, { date: '2026-02-30' }, { customerId: '' }, { paymentTermsDays: '' }, { lines: [] }, { lines: [estimateDraft.lines[0], estimateDraft.lines[0]] }])('rejects invalid estimate %j', fields => {
    expect(() => buildBrowserEstimateCommand(organizationId, { ...estimateDraft, ...fields }, 'estimate-1')).toThrow();
  });
  it('initializes only the explicitly chosen open period', () => {
    expect(buildBrowserInitializeCommand(organizationId, '2027-04-01', '2028-03-31', 'chosen-period')).toEqual({ type: 'initialize', periods: [{ id: 'chosen-period', start: '2027-04-01', end: '2028-03-31', status: 'open' }] });
    expect(() => buildBrowserInitializeCommand(organizationId, '', '', 'period')).toThrow();
    expect(() => buildBrowserInitializeCommand(organizationId, '2027-04-01', '2027-03-31', 'period')).toThrow();
  });
  it.each(SITE_LANGUAGES)('renders initial %s view without requesting or mutating ERP on the server', language => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const html = renderToStaticMarkup(createElement(UsErpWorkbench, { organizationId, expectedUserId: 'fictitious-auth-user', role: 'owner', language }));
      expect(html).toContain('us-erp-workbench'); expect(html).toContain(browserWorkbenchCopy[language].title);
      expect(html).toContain(browserWorkbenchCopy[language].loading); expect(html).not.toContain('Fictitious customer');
      expect(html).not.toContain(browserWorkbenchCopy[language].initialize); expect(fetcher).not.toHaveBeenCalled();
    } finally { fetcher.mockRestore(); }
  });
  it.each(SITE_LANGUAGES)('presents persisted %s data with subtotal, civil dates and internal acceptance only', language => {
    const c = browserWorkbenchCopy[language], saved = state();
    const html = renderToStaticMarkup(createElement(UsErpRecords, { state: saved, language, canWrite: true, disabled: false, onAccept: () => {} }));
    expect(html).toContain('EST-000001'); expect(html).toContain('Fictitious customer'); expect(html).toContain(c.subtotal);
    expect(html).toContain(c.taxPending); expect(html).toContain(c.accept); expect(html).toContain(formatDateOnly('2026-10-08', `${language}-US`));
    expect(html).not.toMatch(/Total payable|Issue invoice|CHF|taxMinor|authority_json|subscription_id/);
  });
  it('hides mutation actions for read-only and accepted estimates', () => {
    const saved = state(), options = { state: saved, language: 'en' as const, disabled: false, onAccept: () => {} };
    expect(renderToStaticMarkup(createElement(UsErpRecords, { ...options, canWrite: false }))).not.toContain('<button');
    expect(renderToStaticMarkup(createElement(UsErpRecords, { ...options, canWrite: true, state: { ...saved, estimates: saved.estimates.map(estimate => ({ ...estimate, status: 'accepted' as const })) } }))).not.toContain('<button');
  });
  it('escapes stored user text instead of rendering HTML', () => {
    const saved = state();
    const html = renderToStaticMarkup(createElement(UsErpRecords, { state: { ...saved, customers: [{ ...saved.customers[0], name: '<script>unsafe()</script>' }] }, language: 'en', canWrite: false, disabled: false, onAccept: () => {} }));
    expect(html).toContain('&lt;script&gt;unsafe()&lt;/script&gt;'); expect(html).not.toContain('<script>');
  });
  it('provides complete copy keys and no customer-signature or zero-tax promise in every language', () => {
    for (const language of SITE_LANGUAGES) {
      const c = browserWorkbenchCopy[language]; expect(Object.keys(c).sort()).toEqual(Object.keys(browserWorkbenchCopy.en).sort());
      expect(Object.values(c).every(value => value.trim().length > 0)).toBe(true);
      expect(c.acceptanceHelp).toMatch(/signature|Unterschrift|firma/);
      expect(c.limitation).not.toMatch(/0%|0 USD|0\.00/);
    }
  });
});
