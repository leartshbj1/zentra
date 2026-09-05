import { describe, expect, it, vi } from 'vitest';
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: invokeMock }));
import { desktopApi } from './bridge';

describe('détail des achats classés dans le décompte TVA', () => {
  const input = { dateFrom: '2026-01-01', dateTo: '2026-03-31', submissionType: 'initial' as const };
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
    expect(preview.sourceSha256).toBe('historical-export');
  });
  it('conserve la réduction signée d’un avoir fournisseur', async () => {
    invokeMock.mockResolvedValueOnce({ classified_sources: [{ source_type: 'supplier_credit_note_item', source_id: 'credit-line', parent_id: 'credit', amount_cents: -5000, vat_cents: -405, treatment: 'input_materials', currency: 'CHF' }] });
    const preview = await desktopApi.previewVatReturn(input);
    expect(preview.classifiedSources?.[0]).toMatchObject({ sourceType: 'supplier_credit_note_item', amountCents: -5000, vatCents: -405, treatment: 'input_materials' });
  });
});
