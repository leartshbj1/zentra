import { describe, expect, it } from 'vitest';
import {
  suggestedVatBusinessReference,
  treatmentsForVatSource,
  vatGrossOrNetForMethod,
  vatProfileRequiresAfcConfirmation,
  vatSubmissionLabel,
} from './vatCenterLogic';

describe('assistant TVA', () => {
  it('sépare les traitements des ventes et de l’impôt préalable', () => {
    expect(treatmentsForVatSource('invoice_item')).toContain('taxable');
    expect(treatmentsForVatSource('invoice_item')).not.toContain('input_materials');
    expect(treatmentsForVatSource('supplier_invoice_item')).toEqual([
      'input_materials',
      'input_investments',
      'non_deductible',
    ]);
    expect(treatmentsForVatSource('expense')).toEqual(
      treatmentsForVatSource('supplier_invoice_item'),
    );
  });

  it('propose une référence métier courte, stable et sans séparateur de date', () => {
    expect(
      suggestedVatBusinessReference(
        '2026-01-01',
        '2026-03-31',
        'correction',
      ),
    ).toBe('ELYKO-20260101-20260331-RECT');
  });

  it('explique que la concordance contient uniquement les différences', () => {
    expect(vatSubmissionLabel('annual_reconciliation')).toContain(
      'différences uniquement',
    );
  });

  it('force la présentation brute exigée par le backend pour TDFN/TaF', () => {
    expect(vatGrossOrNetForMethod('simple_tax_rate', 'net')).toBe('gross');
    expect(vatGrossOrNetForMethod('effective', 'net')).toBe('net');
    expect(vatGrossOrNetForMethod('effective', 'gross')).toBe('gross');
  });

  it('demande une confirmation explicite pour les choix soumis à autorisation', () => {
    expect(
      vatProfileRequiresAfcConfirmation({
        method: 'effective',
        basis: 'agreed',
        periodicity: 'quarterly',
      }),
    ).toBe(false);
    expect(
      vatProfileRequiresAfcConfirmation({
        method: 'simple_tax_rate',
        basis: 'agreed',
        periodicity: 'semiannual',
      }),
    ).toBe(true);
    expect(
      vatProfileRequiresAfcConfirmation({
        method: 'effective',
        basis: 'received',
        periodicity: 'quarterly',
      }),
    ).toBe(true);
  });
});
