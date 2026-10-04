// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: invokeMock }));
import { desktopApi, prepareDocumentSaveInput } from './bridge';
import { agreedVatSalesSources, journalSourceTarget } from './financialTraceability';
import { VatSalesSourceReview } from './VatSalesSourceReview';
import { JournalTable } from './AccountingScreen';
import type { JournalEntry, VatReturnPreview, VatSourceClassification, Workspace } from './types';

const preview = {
  dateFrom: '2026-01-01', dateTo: '2026-03-31', submissionType: 'initial',
  profile: { formOfReporting: 'agreed', reportingMethod: 'effective', grossOrNet: 'net' },
} as VatReturnPreview;
const overdueRaw = { id: 'overdue', number: 'F-OVERDUE', title: 'Facture en retard', type: 'standard', status: 'en_retard', issue_date: '2026-02-03', currency: 'CHF' };
const persistedLine = { id: 'item', invoice_id: 'overdue', description: 'Montants enregistrés', quantity: 1, unit_price_cents: 999999, vat_bp: 810, line_net_cents: 12345, line_vat_cents: 1000, line_total_cents: 13345 };
const classifications = [{ sourceType: 'invoice_item', sourceId: 'item', treatment: 'taxable' }] as VatSourceClassification[];
const entry: JournalEntry = { id: 'entry', number: 'J-7', entryDate: '2026-02-03', description: 'Reclassement de charge', sourceType: 'supplier_expense_reclassification', sourceId: 'reclass', sourceEvent: 'create', status: 'posted', reversalOf: null, hasReversal: false };
const supplierRaw = {
  supplier_invoices: [{ id: 'supplier-invoice', reference: 'SUP-7', supplier_name: 'Fournisseur réel', status: 'validated', currency: 'CHF' }],
  supplier_expense_reclassifications: [{ id: 'reclass', supplier_invoice_id: 'supplier-invoice', journal_entry_id: 'entry' }],
};
const mounted: { host: HTMLDivElement; root: ReturnType<typeof createRoot> }[] = [];

async function load(raw: Record<string, unknown>) {
  invokeMock.mockImplementation(async command => {
    if (command === 'get_app_state') return { onboarding_completed: true };
    if (command === 'get_workspace') return raw;
    throw Error(`Unexpected native read: ${command}`);
  });
  return desktopApi.loadWorkspace();
}
async function render(element: React.ReactNode) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); mounted.push({ host, root });
  await act(async () => root.render(element));
  return host;
}
afterEach(async () => {
  for (const { host, root } of mounted.splice(0)) { await act(async () => root.unmount()); host.remove(); }
  invokeMock.mockReset();
});

it('preserves en_retard as a native read fact and excludes its real projected row from the agreed return list', async () => {
  const data = await load({ invoices: [overdueRaw], invoice_items: [persistedLine] });
  expect(data.invoices[0]).toMatchObject({ status: 'issued', nativeDocumentState: { status: 'en_retard', number: 'F-OVERDUE' } });
  expect(data.invoices[0].lines[0].recordedAmounts).toEqual({ netCents: 12345, vatCents: 1000, totalCents: 13345 });
  expect(agreedVatSalesSources(data.invoices, preview, classifications)).toEqual([]);
  const host = await render(<VatSalesSourceReview preview={preview} workspace={data} classifications={classifications} busy={false} />);
  expect(host.textContent).toContain('Aucune ligne de vente émise disponible pour cette période.');
  expect(host.textContent).not.toContain('Classée pour ce décompte');
  expect(host.textContent).not.toContain('F-OVERDUE');
  expect(host.textContent).not.toContain('123.45');
});

it('matches the exact native statuses, inclusive period and IS NOT NULL number selection without a normalized-status fallback', async () => {
  // SQL is read as a contract; this test does not execute Rust or SQLite.
  const native = readFileSync('src-tauri/src/vat_reporting.rs', 'utf8');
  expect(native.match(/invoice.status IN \(([^)]+)\)/)?.[1]).toBe("'emise','partiellement_payee','payee'");
  expect(native).toContain('invoice.number IS NOT NULL');
  const rows = ['emise', 'partiellement_payee', 'payee', 'en_retard', 'annulee', 'brouillon', 'unknown'].map(status => ({ ...overdueRaw, id: status, number: `F-${status}`, status }));
  rows.push({ ...overdueRaw, id: 'first-day', status: 'emise', issue_date: preview.dateFrom });
  rows.push({ ...overdueRaw, id: 'last-day', status: 'emise', issue_date: preview.dateTo });
  rows.push({ ...overdueRaw, id: 'before', status: 'emise', issue_date: '2025-12-31' });
  rows.push({ ...overdueRaw, id: 'after', status: 'emise', issue_date: '2026-04-01' });
  rows.push({ ...overdueRaw, id: 'empty-number', status: 'emise', number: '' });
  const data = await load({
    invoices: [...rows, { ...overdueRaw, id: 'null-number', status: 'emise', number: null }],
    invoice_items: [...rows.map(row => ({ ...persistedLine, id: `item-${row.id}`, invoice_id: row.id })), { ...persistedLine, id: 'item-null-number', invoice_id: 'null-number' }],
  });
  const sources = agreedVatSalesSources(data.invoices, preview, []);
  expect(sources.map(source => source.invoice.id).sort()).toEqual(['emise', 'partiellement_payee', 'payee', 'first-day', 'last-day', 'empty-number'].sort());
  for (const row of rows) expect(data.invoices.find(invoice => invoice.id === row.id)?.nativeDocumentState).toEqual({ status: row.status, number: row.number });
  expect(data.invoices.find(invoice => invoice.id === 'null-number')?.nativeDocumentState?.number).toBeNull();
  const projected = data.invoices.find(invoice => invoice.id === 'emise')!;
  expect(agreedVatSalesSources([{ ...projected, nativeDocumentState: undefined }], preview, [])).toEqual([]);
});

it('keeps read-only native document facts out of save data while preserving the previous status and line payloads', async () => {
  const data = await load({ invoices: [overdueRaw], invoice_items: [persistedLine] });
  const invoice = data.invoices[0];
  const { nativeDocumentState, ...existingWriteData } = invoice;
  const beforePayload = prepareDocumentSaveInput('invoices', { ...existingWriteData, depositBasisLines: invoice.lines }, invoice.lines, invoice);
  const afterPayload = prepareDocumentSaveInput('invoices', { ...invoice, depositBasisLines: invoice.lines }, invoice.lines, invoice);
  expect(nativeDocumentState?.status).toBe('en_retard');
  expect(afterPayload).toEqual(beforePayload);
  expect(JSON.stringify(afterPayload)).not.toContain('native_document_state');
  expect(JSON.stringify(afterPayload)).not.toContain('en_retard');
  expect(JSON.stringify(afterPayload.items)).not.toContain('recordedAmounts');
  expect(JSON.stringify(afterPayload.data.deposit_basis_json)).not.toContain('recordedAmounts');
});

it('opens the loaded supplier invoice through the actual reclassification ID, including a reversal of that entry', async () => {
  const data = await load(supplierRaw);
  const expected = { kind: 'supplierInvoice', id: 'supplier-invoice', label: 'Facture fournisseur · SUP-7' };
  expect(data.supplierExpenseReclassifications[0]).toMatchObject({ id: 'reclass', supplierInvoiceId: 'supplier-invoice', journalEntryId: 'entry' });
  expect(journalSourceTarget(entry, data)).toEqual(expected);
  const reverse = { ...entry, id: 'reverse', sourceType: 'journal_reversal', sourceId: entry.id, reversalOf: entry.id };
  expect(journalSourceTarget(reverse, data, [entry, reverse])).toEqual(expected);
  const onOpenSource = vi.fn();
  const host = await render(<JournalTable report={{ entries: [entry], lines: [], currency: { baseCurrency: 'CHF', currencies: ['CHF'], singleCurrency: true, exchangeRatesApplied: false } }} workspace={data} onOpenSource={onOpenSource} onOpenJournal={vi.fn()} onReverse={vi.fn()} disabled={false} />);
  const button = host.querySelector<HTMLButtonElement>('button[aria-label="Ouvrir Facture fournisseur · SUP-7"]');
  expect(button).not.toBeNull();
  await act(async () => button!.click());
  expect(onOpenSource).toHaveBeenCalledExactlyOnceWith(expected);
  expect(host.textContent).not.toContain('Pièce métier indisponible sur cet appareil');
});

it('does not invent a supplier piece when either the loaded relation or its invoice is missing', async () => {
  const data = await load(supplierRaw);
  expect(journalSourceTarget(entry, { ...data, supplierExpenseReclassifications: [] })).toBeNull();
  expect(journalSourceTarget(entry, { ...data, supplierInvoices: [] })).toBeNull();
  expect(journalSourceTarget({ ...entry, sourceId: 'SUP-7', description: 'supplier-invoice' }, data)).toBeNull();
  const host = await render(<JournalTable report={{ entries: [entry], lines: [], currency: { baseCurrency: 'CHF', currencies: ['CHF'], singleCurrency: true, exchangeRatesApplied: false } }} workspace={{ ...data, supplierInvoices: [] } as Workspace} onOpenSource={vi.fn()} onOpenJournal={vi.fn()} onReverse={vi.fn()} disabled={false} />);
  expect(host.textContent).toContain('Pièce métier indisponible sur cet appareil');
});
