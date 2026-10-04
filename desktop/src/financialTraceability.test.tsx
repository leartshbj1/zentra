// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountingScreen, FinancialStatement, JournalLineTable, JournalTable } from './AccountingScreen';
import { VatSalesSourceReview } from './VatSalesSourceReview';
import { VatCenter } from './VatCenter';
import { VatPurchaseReview } from './VatPurchaseReview';
import { VatReceivedPayments } from './VatReceivedPayments';
import { agreedVatSalesSources, journalSourceTarget, recordedDocumentAmounts, vatSourceTarget } from './financialTraceability';
import { desktopApi } from './bridge';
import type { Account, Invoice, JournalEntry, JournalLine, JournalReport, StatementRow, VatReturnPreview, VatSourceClassification, Workspace } from './types';

const period = { dateFrom: '2026-01-01', dateTo: '2026-03-31' };
const previous = { dateFrom: '2025-01-01', dateTo: '2025-03-31' };
const reportCurrency = { baseCurrency: 'CHF', currencies: ['CHF'], singleCurrency: true, exchangeRatesApplied: false };
const account = { id: 'revenue', code: '3200', name: 'Prestations', accountType: 'revenue', reportSection: 'net_revenue', normalBalance: 'credit', active: true } satisfies Account;
function invoice(id: string, netCents: number, vatCents: number, rate = 810): Invoice {
  return { id, number: `F-${id}`, clientId: 'client', projectId: null, quoteId: null, originalInvoiceId: null, title: `Pièce ${id}`, type: 'standard', issueDate: '2026-02-03', dueDate: '2026-03-03', serviceDateFrom: '', serviceDateTo: '', currency: 'CHF', status: 'issued', nativeDocumentState: { status: 'emise', number: `F-${id}` }, lines: [{ id: `line-${id}`, description: `Prestation ${id}`, quantity: 3.14159, unit: 'h', unitPriceCents: 999999, discountBp: 2000, vatRateBp: rate, recordedAmounts: { netCents, vatCents, totalCents: netCents + vatCents } }], notes: '', terms: '', depositPercentageBp: null, depositBasisLines: null, createdAt: '' };
}
const saleA = invoice('A', 10000, 810);
const saleB = invoice('B', 20000, 520, 260);
const credit = { ...invoice('AV', -2500, -203), number: 'AV-001', type: 'credit_note' as const, originalInvoiceId: saleA.id };
const classifications: VatSourceClassification[] = [saleA, saleB, credit].map(row => ({ id: `class-${row.id}`, sourceType: 'invoice_item', sourceId: row.lines[0].id, treatment: 'taxable', note: '', createdAt: '', updatedAt: '' }));
const preview: VatReturnPreview = {
  standard: 'eCH-0217', standardVersion: '2.0.0', currency: 'CHF', dateFrom: period.dateFrom, dateTo: period.dateTo, submissionType: 'initial', exportable: true, blockingIssues: [], warnings: [], unclassifiedSources: [], sourceSha256: 'synthetic-traceability-fixture', sourceCount: 3, adjustmentCount: 0, transmissionWording: 'Synthetic test only',
  profile: { id: 'profile', effectiveFrom: period.dateFrom, effectiveTo: null, reportingMethod: 'effective', formOfReporting: 'agreed', periodicity: 'quarterly', grossOrNet: 'net', tdfnActivityId: null, tdfnRateBp: null, afcAuthorizationConfirmed: true, notes: '', createdAt: '', updatedAt: '' },
  turnoverComputation: { totalConsiderationCents: 27500, suppliesToForeignCountriesCents: 0, suppliesAbroadCents: 0, transferNotificationProcedureCents: 0, suppliesExemptFromTaxCents: 0, reductionOfConsiderationCents: 0, variousDeduction: null, taxableTurnoverCents: 27500 },
  effectiveReportingMethod: { grossOrNet: 'net', grossOrNetCode: 1, optedCents: 0, suppliesPerTaxRate: [{ taxRateBp: 810, turnoverCents: 7500, calculatedTaxCents: 608 }, { taxRateBp: 260, turnoverCents: 20000, calculatedTaxCents: 520 }], acquisitionTax: [], inputTaxMaterialAndServicesCents: 0, inputTaxInvestmentsCents: 0, subsequentInputTaxDeductionCents: 0, inputTaxCorrectionsCents: 0, inputTaxReductionsCents: 0, outputTaxCents: 1128, acquisitionTaxCents: 0 }, simpleTaxRateMethod: null, payableTaxCents: 1128, payableCode: '500', otherFlowsOfFunds: { subsidiesCents: 0, donationsCents: 0 },
};
function workspace(invoices: Invoice[] = [saleA, saleB, credit]): Workspace {
  return { settings: null, workNotesScope: 'company:test', invoices: structuredClone(invoices), payments: [], expenses: [], supplierInvoices: [], supplierInvoicePayments: [], supplierCreditNotes: [], payslips: [], employees: [], projects: [], clients: [] } as unknown as Workspace;
}
function entry(id: string, sourceType: string, sourceId: string, patch: Partial<JournalEntry> = {}): JournalEntry {
  return { id, number: `J-${id}`, entryDate: '2026-02-03', description: `Écriture ${id}`, sourceType, sourceId, sourceEvent: 'issue', status: 'posted', reversalOf: null, hasReversal: false, ...patch };
}
const line: JournalLine = { id: 'jl-A', journalEntryId: 'A', accountId: account.id, accountCode: account.code, accountName: account.name, entryNumber: 'J-A', entryDate: '2026-02-03', debitCents: 0, creditCents: 10000, currency: 'CHF', memo: 'Prestation A', projectId: null, clientId: null, employeeId: null };

let host: HTMLDivElement;
let root: Root;
async function render(element: React.ReactNode) { await act(async () => { root.render(element); }); }
async function click(text: string) {
  const button = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(row => row.getAttribute('aria-label') === text || row.textContent === text);
  expect(button, text).toBeDefined();
  await act(async () => { button!.click(); });
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('facts retained for source traceability', () => {
  it('retains signed stored cents, including zero, and never fills missing/invalid amounts', () => {
    expect(recordedDocumentAmounts({ line_net_cents: -2500, line_vat_cents: -203, line_total_cents: -2703 })).toEqual(credit.lines[0].recordedAmounts);
    expect(recordedDocumentAmounts({ line_net_cents: 0, line_vat_cents: 0, line_total_cents: 0 })).toEqual({ netCents: 0, vatCents: 0, totalCents: 0 });
    for (const bad of [undefined, null, NaN, 10.1, Number.MAX_SAFE_INTEGER + 1, '10000']) expect(recordedDocumentAmounts({ line_net_cents: bad, line_vat_cents: 810, line_total_cents: 10810 })).toBeUndefined();
  });
  it('uses the issued native agreed-period selection and the stored lines at two rates plus an avoir', () => {
    const before = JSON.stringify([saleA, saleB, credit]);
    const excluded = [
      { ...invoice('draft', 10, 1), status: 'draft' as const, nativeDocumentState: { status: 'brouillon', number: 'F-draft' } }, { ...invoice('cancel', 10, 1), status: 'cancelled' as const, nativeDocumentState: { status: 'annulee', number: 'F-cancel' } },
      { ...invoice('old', 10, 1), issueDate: '2025-12-31' }, { ...invoice('later', 10, 1), issueDate: '2026-04-01' },
      { ...invoice('unnumbered', 10, 1), number: '', nativeDocumentState: { status: 'emise', number: null } }, invoice('zero', 0, 0),
    ];
    const sources = agreedVatSalesSources([saleA, saleB, credit, ...excluded], preview, classifications);
    expect(sources.map(row => row.invoice.id)).toEqual(['A', 'AV', 'B']);
    expect(sources.map(row => row.line.recordedAmounts)).toEqual([saleA.lines[0].recordedAmounts, credit.lines[0].recordedAmounts, saleB.lines[0].recordedAmounts]);
    expect(sources.every(row => row.inclusion === 'included')).toBe(true);
    expect(JSON.stringify([saleA, saleB, credit])).toBe(before);
  });
  it('never describes foreign, unclassified, missing or annual-only lines as included, or uses agreed rows for received mode', () => {
    expect(agreedVatSalesSources([{ ...saleA, currency: 'EUR' }], preview, classifications)[0].inclusion).toBe('foreign');
    expect(agreedVatSalesSources([saleA], preview, [])[0].inclusion).toBe('unclassified');
    expect(agreedVatSalesSources([saleA], preview, [{ ...classifications[0], treatment: 'input_materials' }])[0].inclusion).toBe('unclassified');
    expect(agreedVatSalesSources([saleA], preview, null)[0].inclusion).toBe('classification_unavailable');
    const missing = { ...saleA, lines: [{ ...saleA.lines[0], recordedAmounts: undefined }] };
    expect(agreedVatSalesSources([missing], preview, classifications)[0].inclusion).toBe('amounts_unavailable');
    expect(agreedVatSalesSources([saleA], { ...preview, submissionType: 'annual_reconciliation' }, classifications)[0].inclusion).toBe('annual_adjustments_only');
    expect(agreedVatSalesSources([saleA], { ...preview, profile: { ...preview.profile, formOfReporting: 'received' } }, classifications)).toEqual([]);
  });
  it('resolves payments, avoir settlements and reversal ancestry by actual IDs, failing closed on missing or cyclic origins', () => {
    const data = workspace();
    data.payments = [{ id: 'pay-A', invoiceId: 'A' }] as Workspace['payments'];
    data.invoices[0].creditSettlements = [{ id: 'settlement', creditNoteId: 'AV', invoiceId: 'A' }] as Invoice['creditSettlements'];
    expect(journalSourceTarget(entry('pay', 'payment', 'pay-A'), data)?.id).toBe('A');
    expect(journalSourceTarget(entry('refund', 'customer_credit_settlement', 'settlement'), data)?.id).toBe('AV');
    const original = entry('A', 'invoice', 'A');
    const reverse = entry('reverse', 'journal_reversal', 'A', { reversalOf: 'A' });
    expect(journalSourceTarget(reverse, data, [original, reverse])?.id).toBe('A');
    expect(journalSourceTarget(reverse, data, [reverse])).toBeNull();
    expect(journalSourceTarget({ ...reverse, reversalOf: 'reverse' }, data, [{ ...reverse, reversalOf: 'reverse' }])).toBeNull();
    expect(journalSourceTarget(entry('fake', 'payment', 'missing', { sourceEvent: 'invoice:A' }), data)).toBeNull();
    expect(journalSourceTarget(entry('manual', 'manual', 'A'), data)).toBeNull();
  });
});

describe('working source controls', () => {
  it('refreshes the native VAT preview after a source changes and hides stale amounts while the new read is pending', async () => {
    const data = workspace();
    vi.spyOn(desktopApi, 'listVatProfiles').mockResolvedValue([preview.profile]);
    vi.spyOn(desktopApi, 'listVatAdjustments').mockResolvedValue([]);
    vi.spyOn(desktopApi, 'listVatReturnExports').mockResolvedValue([]);
    vi.spyOn(desktopApi, 'listVatSourceClassifications').mockResolvedValue(classifications);
    let complete: (value: VatReturnPreview) => void = () => {};
    const read = vi.spyOn(desktopApi, 'previewVatReturn').mockResolvedValueOnce(preview).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    await render(<VatCenter filter={period} workspace={data} onOpenSource={vi.fn()} />);
    expect(host.textContent).toContain('100.00');
    const changed = workspace([{ ...saleA, lines: [{ ...saleA.lines[0], recordedAmounts: { netCents: 11100, vatCents: 899, totalCents: 11999 } }] }, saleB, credit]);
    await render(<VatCenter filter={period} workspace={changed} onOpenSource={vi.fn()} />);
    expect(read).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain('100.00');
    expect(host.textContent).not.toContain('111.00');
    await act(async () => complete({ ...preview, payableTaxCents: 2222 }));
    expect(host.textContent).toContain('111.00'); expect(host.textContent).toContain('119.99'); expect(host.textContent).toContain('22.22');
  });
  it('restores the annual reconciliation type and carries it with the source navigation context', async () => {
    const data = workspace();
    vi.spyOn(desktopApi, 'listAccounts').mockResolvedValue([account]);
    vi.spyOn(desktopApi, 'getAccountingSettings').mockResolvedValue({ enabled: true } as Awaited<ReturnType<typeof desktopApi.getAccountingSettings>>);
    vi.spyOn(desktopApi, 'listAccountingPeriods').mockResolvedValue([]);
    vi.spyOn(desktopApi, 'getAccountingContinuity').mockResolvedValue({ enabled: true, mappingReady: true } as Awaited<ReturnType<typeof desktopApi.getAccountingContinuity>>);
    vi.spyOn(desktopApi, 'listVatProfiles').mockResolvedValue([preview.profile]);
    vi.spyOn(desktopApi, 'listVatAdjustments').mockResolvedValue([]);
    vi.spyOn(desktopApi, 'listVatReturnExports').mockResolvedValue([]);
    vi.spyOn(desktopApi, 'listVatSourceClassifications').mockResolvedValue(classifications);
    const read = vi.spyOn(desktopApi, 'previewVatReturn').mockImplementation(async input => ({ ...preview, submissionType: input.submissionType }));
    const onOpenSource = vi.fn();
    await render(<AccountingScreen workspace={data} focusEntry={null} onFocusHandled={vi.fn()} onWorkspaceChange={vi.fn()} sourceReturnContext={{ tab: 'vat', filter: period, accountId: account.id, periodId: '', vatSubmissionType: 'annual_reconciliation', workspaceScope: data.workNotesScope }} onOpenSource={onOpenSource} />);
    expect(read).toHaveBeenLastCalledWith({ ...period, submissionType: 'annual_reconciliation' });
    expect(host.textContent).toContain('seuls les ajustements sont déclarés');
    await click('Ouvrir Avoir client · AV-001');
    expect(onOpenSource.mock.calls.at(-1)?.[1]).toMatchObject({ filter: period, tab: 'vat', vatSubmissionType: 'annual_reconciliation' });
  });
  it('opens the exact sales/avoir pieces and its original invoice without recalculating displayed cents', async () => {
    const onOpenSource = vi.fn();
    await render(<VatSalesSourceReview preview={preview} workspace={workspace()} classifications={classifications} busy={false} onOpenSource={onOpenSource} />);
    expect(host.textContent).toContain('100.00'); expect(host.textContent).toContain('-25.00'); expect(host.textContent).toContain('2.03');
    expect(host.textContent).toContain('2,6 %'); expect(host.textContent).toContain('HT'); expect(host.textContent).toContain('TTC');
    expect(host.textContent).not.toContain('999');
    await click('Ouvrir Avoir client · AV-001'); expect(onOpenSource).toHaveBeenLastCalledWith({ kind: 'invoice', id: 'AV', label: 'Avoir client · AV-001' });
    await click('Facture d’origine · F-A'); expect(onOpenSource.mock.calls.at(-1)?.[0].id).toBe('A');
  });
  it('opens purchase and received allocation parents using their explicit IDs, preserving signed allocation cents', async () => {
    const data = workspace(); data.expenses = [{ id: 'expense', reference: 'ACH-01' }] as Workspace['expenses'];
    const purchase = { sourceType: 'expense' as const, sourceId: 'expense', parentId: 'expense', occurrenceDate: '2026-02-03', description: 'Achat réel', amountCents: 5000, vatCents: 405, vatRateBp: 810, treatment: 'input_materials' as const, currency: 'CHF' };
    const onOpen = vi.fn();
    expect(vatSourceTarget({ sourceType: 'invoice_item', parentId: 'missing' }, data)).toBeNull();
    await render(<VatPurchaseReview sources={[purchase]} busy={false} onClassify={vi.fn()} workspace={data} onOpenSource={onOpen} />);
    await click('Ouvrir la pièce'); expect(onOpen.mock.calls[0][0]).toMatchObject({ kind: 'expense', id: 'expense' });
    await render(<VatReceivedPayments allocations={[{ sourceType: 'invoice_item', sourceId: 'line-AV', parentId: 'AV', paymentId: 'refund', description: 'Remboursement', date: '2026-02-03', currency: 'CHF', grossCents: -2703, netCents: -2500, vatCents: -203 }]} workspace={data} onOpenSource={onOpen} />);
    expect(host.textContent).toContain('-27.03'); await click('Ouvrir la pièce'); expect(onOpen.mock.calls.at(-1)?.[0]).toMatchObject({ kind: 'invoice', id: 'AV' });
  });
  it('links statement accounts for current/comparative periods and ledger entries with their own currency', async () => {
    const onOpen = vi.fn();
    const row = { ...account, debitCents: 0, creditCents: 10000, amountCents: 10000, previousDebitCents: 0, previousCreditCents: 6000, previousAmountCents: 6000 } satisfies StatementRow;
    await render(<FinancialStatement title="Résultat" state="Provisoire" rows={[row]} summary={[]} currency="CHF" currentPeriod={period} previousPeriod={previous} onOpenAccount={onOpen} />);
    await click('Voir les mouvements de 3200 · Prestations'); expect(onOpen).toHaveBeenLastCalledWith('revenue', period);
    await click('Voir le comparatif de 3200 · Prestations'); expect(onOpen).toHaveBeenLastCalledWith('revenue', previous);
    await render(<JournalLineTable lines={[{ ...line, currency: 'EUR' }]} onOpenJournal={onOpen} />);
    expect(host.textContent).toContain('€'); expect(host.textContent).not.toContain('CHF'); await click('Voir l’écriture J-A'); expect(onOpen).toHaveBeenLastCalledWith('A');
  });
  it('shows unavailable business sources without inventing a piece, and links reversal originals when outside the report', async () => {
    const onOpen = vi.fn(); const onJournal = vi.fn();
    const report: JournalReport = { entries: [entry('A', 'invoice', 'A'), entry('missing', 'invoice', 'gone'), entry('reverse', 'journal_reversal', 'absent', { reversalOf: 'absent' })], lines: [line], currency: reportCurrency };
    await render(<JournalTable report={report} workspace={workspace()} onOpenSource={onOpen} onOpenJournal={onJournal} onReverse={vi.fn()} disabled={false} />);
    await click('Ouvrir Facture client · F-A'); expect(onOpen.mock.calls[0][0].id).toBe('A');
    expect(host.textContent).toContain('Pièce métier indisponible sur cet appareil');
    await click('Voir l’écriture d’origine'); expect(onJournal).toHaveBeenCalledWith('absent');
  });
  it('keeps the actual statement period through account → ledger → journal → source and restoration', async () => {
    const data = workspace();
    const row = { ...account, debitCents: 0, creditCents: 27500, amountCents: 27500, previousDebitCents: 0, previousCreditCents: 0, previousAmountCents: 0 } satisfies StatementRow;
    const scope = { ...period, previousDateFrom: previous.dateFrom, previousDateTo: previous.dateTo, comparisonLabel: '2025', comparisonSource: 'same_dates_previous_year' as const, previousHasActivity: false };
    vi.spyOn(desktopApi, 'listAccounts').mockResolvedValue([account]);
    vi.spyOn(desktopApi, 'getAccountingSettings').mockResolvedValue({ enabled: true } as Awaited<ReturnType<typeof desktopApi.getAccountingSettings>>);
    vi.spyOn(desktopApi, 'listAccountingPeriods').mockResolvedValue([]);
    vi.spyOn(desktopApi, 'getAccountingContinuity').mockResolvedValue({ enabled: true, mappingReady: true } as Awaited<ReturnType<typeof desktopApi.getAccountingContinuity>>);
    vi.spyOn(desktopApi, 'getIncomeStatement').mockResolvedValue({ rows: [row], revenueCents: 27500, expenseCents: 0, profitCents: 27500, previousRevenueCents: 0, previousExpenseCents: 0, previousProfitCents: 0, sections: {}, previousSections: {}, scope, currency: reportCurrency });
    vi.spyOn(desktopApi, 'getBalanceSheet').mockResolvedValue({ rows: [], scope, currency: reportCurrency, asOf: period.dateTo, exerciseFrom: period.dateFrom, sections: {}, previousSections: {}, assetsCents: 0, liabilitiesCents: 0, equityCents: 0, currentResultCents: 0, unallocatedPriorResultsCents: 0, balanced: true, previousAssetsCents: 0, previousLiabilitiesCents: 0, previousEquityCents: 0, previousCurrentResultCents: 0, previousUnallocatedPriorResultsCents: 0, previousBalanced: true });
    const ledger = vi.spyOn(desktopApi, 'getLedger').mockResolvedValue({ account, lines: [line], currency: reportCurrency, openingDebitBalanceCents: 0, openingCreditBalanceCents: 0, debitCents: 0, creditCents: 10000, closingDebitBalanceCents: 0, closingCreditBalanceCents: 10000 } as Awaited<ReturnType<typeof desktopApi.getLedger>>);
    const journal = vi.spyOn(desktopApi, 'getJournal').mockResolvedValue({ entries: [entry('A', 'invoice', 'A')], lines: [line], currency: reportCurrency });
    const onOpenSource = vi.fn();
    await render(<AccountingScreen workspace={data} focusEntry={null} onFocusHandled={vi.fn()} onWorkspaceChange={vi.fn()} sourceReturnContext={{ tab: 'income', filter: { dateTo: '2026-03-31' }, accountId: account.id, periodId: '', workspaceScope: data.workNotesScope }} onOpenSource={onOpenSource} />);
    await click('Voir les mouvements de 3200 · Prestations');
    expect(ledger.mock.calls.at(-1)?.[0]).toBe(account.id);
    expect(ledger.mock.calls.at(-1)?.[1]).toMatchObject(period);
    await click('Voir l’écriture J-A'); expect(journal.mock.calls.at(-1)?.[0]).toMatchObject(period);
    await click('Ouvrir Facture client · F-A');
    expect(onOpenSource.mock.calls[0][0].id).toBe('A');
    expect(onOpenSource.mock.calls[0][1]).toMatchObject({ tab: 'journal', filter: period, accountId: account.id, workspaceScope: 'company:test' });
    const savedContext = onOpenSource.mock.calls[0][1];
    await render(<AccountingScreen key="restored" workspace={data} focusEntry={null} onFocusHandled={vi.fn()} onWorkspaceChange={vi.fn()} sourceReturnContext={savedContext} onOpenSource={onOpenSource} />);
    expect(journal.mock.calls.at(-1)?.[0]).toMatchObject(period);
    await click('Ouvrir Facture client · F-A');
    expect(onOpenSource.mock.calls.at(-1)?.[1]).toMatchObject({ filter: period, accountId: account.id, tab: 'journal' });
  });
});
