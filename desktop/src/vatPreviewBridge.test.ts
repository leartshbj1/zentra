import { describe, expect, it, vi } from 'vitest';
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: invokeMock }));
import { desktopApi } from './bridge';

describe('détail des achats classés dans le décompte TVA', () => {
  const input = { dateFrom: '2026-01-01', dateTo: '2026-03-31', submissionType: 'initial' as const };
  it('conserve les signes et la preuve de l’extourne avec sa pièce liée', async () => {
    invokeMock.mockResolvedValueOnce({ received_allocations: [{ source_type: 'supplier_invoice_item', source_id: 'line', parent_id: 'invoice', description: 'FA · Marchandises', currency: 'CHF', payment_id: 'reversal', date: '2026-03-31', gross_cents: -1026, net_cents: -949, vat_cents: -77, settlement: { kind: 'credit_reversal', counterpart_id: 'credit', counterpart_reference: 'AV-2026-001', reverses_allocation_id: 'initial-application' } }] });
    const preview = await desktopApi.previewVatReturn(input);
    expect(preview.receivedAllocations?.[0]).toMatchObject({ grossCents: -1026, netCents: -949, vatCents: -77, settlement: { kind: 'credit_reversal', counterpartId: 'credit', counterpartReference: 'AV-2026-001', reversesAllocationId: 'initial-application' } });
  });
  it('conserve l’identité, la devise et les montants signés des sources natives', async () => {
    invokeMock.mockResolvedValueOnce({ classified_sources: [{ source_type: 'supplier_invoice_item', source_id: 'line-1', parent_id: 'purchase-1', occurrence_date: '2026-02-10', description: 'Achat', amount_cents: 10000, vat_cents: 810, vat_rate_bp: 810, treatment: 'non_deductible', currency: 'EUR' }] });
    const preview = await desktopApi.previewVatReturn(input);
    expect(preview.classifiedSources).toEqual([{ sourceType: 'supplier_invoice_item', sourceId: 'line-1', parentId: 'purchase-1', occurrenceDate: '2026-02-10', description: 'Achat', amountCents: 10000, vatCents: 810, vatRateBp: 810, treatment: 'non_deductible', currency: 'EUR' }]);
    expect(invokeMock).toHaveBeenLastCalledWith('preview_vat_return', { input: { date_from: input.dateFrom, date_to: input.dateTo, submission_type: 'initial', profile_id: null } });
  });
  it('accepte les anciens aperçus dépourvus de liste de contrôle', async () => {
    invokeMock.mockResolvedValueOnce({ source_sha256: 'historical-export' });
    const preview = await desktopApi.previewVatReturn(input);
    expect(preview.classifiedSources).toEqual([]);
    expect(preview.receivedAllocations).toEqual([]);
    expect(preview.preClosingSources).toEqual([]);
    expect(preview.sourceSha256).toBe('historical-export');
  });
  it('conserve la ventilation datée de chaque paiement et sa devise', async () => {
    invokeMock.mockResolvedValueOnce({ received_allocations: [{ source_type: 'invoice_item', source_id: 'line', parent_id: 'invoice', description: 'F-26 · Conseil', currency: 'CHF', payment_id: 'payment', date: '2026-03-31', gross_cents: 5000, net_cents: 4625, vat_cents: 375 }] });
    const preview = await desktopApi.previewVatReturn(input);
    expect(preview.receivedAllocations).toEqual([{ sourceType: 'invoice_item', sourceId: 'line', parentId: 'invoice', description: 'F-26 · Conseil', currency: 'CHF', paymentId: 'payment', date: '2026-03-31', grossCents: 5000, netCents: 4625, vatCents: 375 }]);
  });
  it('sépare les documents à classer avant clôture des montants reçus', async () => {
    invokeMock.mockResolvedValueOnce({ pre_closing_sources: [{ source_type: 'supplier_invoice_item', source_id: 'unpaid-line', parent_id: 'unpaid', occurrence_date: '2026-02-01', description: 'Machine à classer', currency: 'EUR', amount_cents: 10000, vat_cents: 810, vat_rate_bp: 810 }], payable_tax_cents: 0 });
    const preview = await desktopApi.previewVatReturn(input);
    expect(preview.preClosingSources?.[0]).toMatchObject({ sourceType: 'supplier_invoice_item', sourceId: 'unpaid-line', currency: 'EUR', amountCents: 10000, vatCents: 810 });
    expect(preview.unclassifiedSources).toEqual([]);
    expect(preview.payableTaxCents).toBe(0);
  });
  it('conserve la réduction signée d’un avoir fournisseur', async () => {
    invokeMock.mockResolvedValueOnce({ classified_sources: [{ source_type: 'supplier_credit_note_item', source_id: 'credit-line', parent_id: 'credit', amount_cents: -5000, vat_cents: -405, treatment: 'input_materials', currency: 'CHF' }] });
    const preview = await desktopApi.previewVatReturn(input);
    expect(preview.classifiedSources?.[0]).toMatchObject({ sourceType: 'supplier_credit_note_item', amountCents: -5000, vatCents: -405, treatment: 'input_materials' });
  });
});
