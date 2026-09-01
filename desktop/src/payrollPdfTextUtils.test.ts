import { describe, expect, it } from 'vitest';
import { normalizePayrollPdfTextItems, payrollTextForPageBatch } from './payrollPdfTextUtils';

describe('couche texte PDF de paie par page', () => {
  it('conserve les fins de ligne utiles et nettoie les caractères parasites', () => {
    expect(normalizePayrollPdfTextItems([
      { str: 'Salaire\u00a0mensuel', hasEOL: false },
      { str: '5 000.00', hasEOL: true },
      { str: '\u0000AVS', hasEOL: false },
      { str: '265.00', hasEOL: true },
      { str: 123, hasEOL: true },
    ])).toBe('Salaire mensuel 5 000.00\nAVS 265.00');
  });

  it('n’envoie à un lot que le texte de ses pages avec leurs numéros absolus', () => {
    const pages = ['identité', 'brut', 'retenues', 'net'];
    expect(payrollTextForPageBatch(pages, 2, 3)).toBe('[PAGE 2]\nbrut\n\n[PAGE 3]\nretenues');
    expect(payrollTextForPageBatch(pages, 4, 4)).toBe('[PAGE 4]\nnet');
    expect(payrollTextForPageBatch(pages, 0, 3)).toBe('');
  });

  it('ignore les pages sans couche texte au lieu de fabriquer du contenu', () => {
    expect(payrollTextForPageBatch(['', '  ', 'net 4 500'], 1, 3)).toBe('[PAGE 3]\nnet 4 500');
  });
});
