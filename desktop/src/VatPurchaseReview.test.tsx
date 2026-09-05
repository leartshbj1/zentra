import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { VatPurchaseReview } from './VatPurchaseReview';
import type { VatReturnPreview } from './types';

it('conserve les contrôles ordinaires et rend les traitements liés aux remboursements consultables sans proposer de reclassification', () => {
  const original = { sourceType: 'expense' as const, sourceId: 'original', parentId: 'original', occurrenceDate: '2026-02-10', description: 'Marchandises', amountCents: 10000, vatCents: 810, vatRateBp: 810, treatment: 'input_materials' as const, currency: 'CHF' };
  const sources: NonNullable<VatReturnPreview['classifiedSources']> = [original, { ...original, sourceType: 'expense_refund', sourceId: 'refund', description: 'Remboursement AV-001', amountCents: -5000, vatCents: -405 }, { ...original, sourceId: 'ordinary', description: 'Autre achat' }];
  const html = renderToStaticMarkup(<VatPurchaseReview sources={sources} busy={false} onClassify={vi.fn()} refundedExpenseIds={new Set(['original'])} />);
  expect(html.match(/Traitement conservé avec le remboursement/g)).toHaveLength(2);
  expect(html.match(/Appliquer au journal/g)).toHaveLength(1);
  expect(html).toContain('Traitement enregistré de Autre achat');
  expect(html).not.toContain('Traitement enregistré de Remboursement AV-001');
  expect(html).not.toContain('Traitement enregistré de Marchandises');
});
