import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UsSalesRecords, UsErpWorkbench } from '../../components/account/us-erp-workbench';
import { UsExportReportTable } from '../../components/account/us-erp-reports';
import { browserSalesFixture } from './browser-sales-test-fixture';
import { browserSalesCopy } from './browser-sales-copy';
import { buildBrowserCustomerPaymentCommand, buildBrowserInvoiceCommand, canUseBrowserSales, emptyBrowserCustomerPayment, emptyBrowserInvoice } from './browser-sales';
import { buildUsExportSnapshot } from './export-snapshot';
import { exportCopy } from './export-copy';
import { SITE_LANGUAGES } from '../site-language';
import type { AccountRole } from '../account-security';
import { createBrowserErpSession } from './browser-erp-session';
const org = 'fictitious-sales-company';
const payment = { invoiceId: 'invoice-1', amount: '50.00', paymentDate: '2026-10-10', accountingDate: '2026-10-11', periodId: 'period-2026', reference: 'RECEIVED-1' };
const invoice = { estimateId: 'estimate-2', date: '2026-10-10', accountingDate: '2026-10-11', dueDate: '2026-11-10', periodId: 'period-2026' };
describe('US sales browser commands and presentation', () => {
  it('never enables issuance from configuration alone or supplies financial authority from the form', async () => {
    const state = await browserSalesFixture(); expect(() => buildBrowserInvoiceCommand(org, state, invoice, 'invoice-2', false)).toThrow();
    const command = buildBrowserInvoiceCommand(org, state, invoice, 'invoice-2', true); expect(command).toEqual({ type: 'issue_invoice', id: 'invoice-2', estimateId: 'estimate-2', expectedEstimateRevision: 2, date: invoice.date, accountingDate: invoice.accountingDate, dueDate: invoice.dueDate, periodId: invoice.periodId });
    expect(JSON.stringify(command)).not.toMatch(/tax|seller|number|role|currency|authority|entitlement/);
  });
  it.each([{ estimateId: 'missing' }, { estimateId: 'estimate-1' }, { date: '2026-02-30' }, { date: '0000-10-08' }, { dueDate: '2026-10-01' }, { accountingDate: '2027-01-01' }, { periodId: 'missing' }])('rejects invalid invoice preparation %j', async change => { expect(() => buildBrowserInvoiceCommand(org, awaitState, { ...invoice, ...change }, 'invoice-2', true)).toThrow(); });
  it('binds exact received cents and separate dates to the recorded invoice', async () => { const state = await browserSalesFixture(); expect(buildBrowserCustomerPaymentCommand(org, state, payment, 'p1')).toEqual({ type: 'record_payment', id: 'p1', invoiceId: 'invoice-1', amountMinor: '5000', paymentDate: payment.paymentDate, accountingDate: payment.accountingDate, periodId: payment.periodId, reference: payment.reference }); });
  it.each(['0', '-1', '108.26', 'NaN', 'Infinity', '', '1e2', '50,00', ' 50 ', '0.001', '.25', '9'.repeat(37)])('rejects unsafe/overpaid amount %s', async amount => { const state = await browserSalesFixture(); expect(() => buildBrowserCustomerPaymentCommand(org, state, { ...payment, amount }, 'p1')).toThrow(); });
  it.each([{ invoiceId: 'missing' }, { paymentDate: '2026-02-30' }, { accountingDate: '2027-01-01' }, { reference: '' }, { reference: 'bad\nreference' }, { periodId: 'missing' }])('rejects invalid received payment %j', async change => { const state = await browserSalesFixture(); expect(() => buildBrowserCustomerPaymentCommand(org, state, { ...payment, ...change }, 'p1')).toThrow(); });
  it('rejects a different company and closed period; starts both drafts without guesses', async () => { const state = await browserSalesFixture(); expect(() => buildBrowserCustomerPaymentCommand('other', state, payment, 'p1')).toThrow(); expect(() => buildBrowserInvoiceCommand(org, { ...state, ledger: { ...state.ledger, periods: state.ledger.periods.map(p => ({ ...p, status: 'closed' as const })) } }, invoice, 'i2', true)).toThrow(); expect(Object.values(emptyBrowserInvoice()).every(v => v === '')).toBe(true); expect(Object.values(emptyBrowserCustomerPayment()).every(v => v === '')).toBe(true); });
  it.each(['owner', 'admin', 'accountant', 'member', 'read_only'] as AccountRole[])('shows financial actions only for the 3 financial roles: %s', role => { expect(canUseBrowserSales(role)).toBe(['owner', 'admin', 'accountant'].includes(role)); });
  it.each(SITE_LANGUAGES)('displays persisted invoice balances and all report labels in %s', async language => {
    const state = await browserSalesFixture(), c = browserSalesCopy[language]; const html = renderToStaticMarkup(createElement(UsSalesRecords, { state, language })); expect(html).toContain(c.invoices); expect(html).toContain(c.outstanding); expect(html).toContain(c.balance); expect(html).toContain('INV-000001'); expect(html).not.toContain('CHF');
    for (const reportType of ['trial_balance', 'profit_loss', 'balance_sheet', 'cash_flow', 'general_ledger'] as const) {
      const selector = reportType === 'trial_balance' || reportType === 'balance_sheet' ? { kind: 'report' as const, reportType, asOf: '2026-12-31' } : reportType === 'general_ledger' ? { kind: 'report' as const, reportType, start: '2026-01-01', end: '2026-12-31', accountId: 'cash' } : { kind: 'report' as const, reportType, start: '2026-01-01', end: '2026-12-31' };
      const snapshot = buildUsExportSnapshot(state, { organizationId: org, displayName: 'Fictitious seller' }, selector, language), table = renderToStaticMarkup(createElement(UsExportReportTable, { snapshot, language })); expect(table).toContain(exportCopy[language][reportType]); expect(table).toContain('Fictitious seller'); expect(table).toContain(exportCopy[language].company); expect(table).not.toMatch(/taxAssessment|ein|TEST-ONLY/);
      const typeIndex = snapshot.columns.findIndex(column => column.label === 'accountType');
      if (typeIndex >= 0) { for (const type of new Set(snapshot.rows.map(row => row[typeIndex]))) expect(table).toContain(exportCopy[language][type === 'asset' ? 'assets' : type === 'liability' ? 'liabilities' : type as 'income' | 'expense' | 'equity']); if (language !== 'en') expect(table).not.toMatch(/>asset<|>liability<|>income<|>expense<|>equity</); }
    }
  });
  it('keeps sales opt-in and the historical default surface unchanged', () => { const html = renderToStaticMarkup(createElement(UsErpWorkbench, { organizationId: org, expectedUserId: 'fictitious-owner', role: 'owner', language: 'en' })); expect(html).not.toContain('us-erp-sales'); expect(html).not.toContain('us-erp-reports'); });
  it('preserves the exact payment envelope after quota429 and recovers without a replacement action', async () => {
    const state = await browserSalesFixture(), command = buildBrowserCustomerPaymentCommand(org, state, payment, 'p1'), bodies: string[] = [];
    const session = createBrowserErpSession({ organizationId: org, expectedUserId: 'fictitious-owner', newId: () => 'stable-payment-key', fetch: async (_url, init) => {
      if (init?.method === 'GET') return Response.json({ status: 'ready', state });
      if (typeof init?.body !== 'string') throw new Error('Expected the exact JSON request body');
      bodies.push(init.body); if (bodies.length === 1) return Response.json({ error: 'rate_limited' }, { status: 429 });
      return Response.json({ receipt: { idempotencyKey: 'stable-payment-key', commandHash: 'a'.repeat(64), revision: state.revision + 1, entityId: 'p1', action: 'record_payment' }, replayed: false });
    } });
    await session.load(); await expect(session.submit(command, state.revision)).rejects.toMatchObject({ code: 'rate_limited', status: 429, outcome: 'uncertain' }); expect(session.hasPending()).toBe(true);
    await session.retry(); expect(bodies).toHaveLength(2); expect(bodies[1]).toBe(bodies[0]); expect(session.hasPending()).toBe(false); session.dispose();
  });
});
// Avoid N copies of the costly real-engine fixture for invariant-only cases.
const awaitState = await browserSalesFixture();
