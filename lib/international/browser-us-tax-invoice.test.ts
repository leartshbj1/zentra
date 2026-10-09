import { beforeAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UsTaxInvoicePanel } from '../../components/account/us-tax-invoice-panel';
import { browserSalesFixture } from './browser-sales-test-fixture';
import { browserUsTaxEstimateSupported, buildBrowserUsTaxInvoiceChoices } from './browser-us-tax-invoice';
import { browserUsTaxInvoiceCopy } from './browser-us-tax-invoice-copy';
import type { ErpState } from './runtime-types';
import type { Estimate } from './invoicing';
let state: ErpState, estimate: Estimate;
beforeAll(async () => { state = await browserSalesFixture(); estimate = state.estimates.find(item => item.id === 'estimate-2')!; });
const code = { id: 'txcd_10000000', name: 'Fictitious catalogue service', description: 'Fictitious description' }, instant = '2026-10-10T16:00:00.000Z';
const lines = { 'line-1': { code: code.id, checked: code, confirmed: true } };
describe('explicit presentation scope for TEST invoices', () => {
  it('preserves line order and includes only confirmed public choices', () => { expect(buildBrowserUsTaxInvoiceChoices(estimate, lines, instant, 'billing')).toEqual({ taxDateInstant: instant, addressSource: 'billing', classifications: [{ lineId: 'line-1', taxCode: code.id, confirmedService: true }] }); });
  it.each([{ ...lines, 'line-1': { ...lines['line-1'], confirmed: false } }, { ...lines, 'line-1': { ...lines['line-1'], checked: null } }, { ...lines, 'line-1': { ...lines['line-1'], code: 'txcd_99999999' } }, {}])('does not infer applicability from a code or catalogue membership', selections => { expect(() => buildBrowserUsTaxInvoiceChoices(estimate, selections, instant, 'billing')).toThrow(); });
  it.each(['', 'shipping', 'origin'])('does not invent an address for source %s', source => { expect(() => buildBrowserUsTaxInvoiceChoices(estimate, lines, instant, source)).toThrow(); });
  it.each([{ quantityUnits: '15', quantityScale: 1 }, { quantityUnits: '0' }, { taxTreatment: 'exempt' }, { unitPrice: { currency: 'USD', minorUnits: '0' } }])('rejects unsupported lines without rounding or guessing tax', fields => { const altered = { ...estimate, lines: [{ ...estimate.lines[0], ...fields }] } as Estimate; expect(browserUsTaxEstimateSupported(altered)).toBe(false); });
  it('accepts an exactly integral scaled quantity without changing its representation', () => { expect(browserUsTaxEstimateSupported({ ...estimate, lines: [{ ...estimate.lines[0], quantityUnits: '20', quantityScale: 1 }] })).toBe(true); });
  for (const language of ['en', 'fr', 'de', 'it'] as const) for (const role of ['owner', 'admin', 'accountant', 'member', 'read_only'] as const) it(`renders ${language}/${role} with no guessed fiscal defaults`, () => {
    const html = renderToStaticMarkup(createElement(UsTaxInvoicePanel, { organizationId: state.configuration.organizationId, expectedUserId: 'fictitious-owner', role, language, supportedSchemaVersion: 4, state, blocked: false, writeLocked: false, accessEpoch: 0, currentAccessEpoch: () => 0, acquire: async () => state, onBusyChange: () => {}, onPendingChange: () => {}, onAccessDenied: () => {}, onCommitted: () => {}, registerInvalidation: () => {} }));
    if (role === 'member' || role === 'read_only') { expect(html).toBe(''); return; }
    expect(html).toContain(browserUsTaxInvoiceCopy[language].title); expect(html).toContain('America/New York'); expect(html).not.toContain('checked=""'); expect(html).not.toContain('txcd_10000000'); expect(html).not.toContain('value="2026-'); expect(html).not.toContain('type="datetime-local"');
  });
});
