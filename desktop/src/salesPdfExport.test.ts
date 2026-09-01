import { describe, expect, it } from 'vitest';

import {
  pdfDestinationPath,
  salesPdfInvokeInput,
  salesPdfSuggestedFileName,
} from './salesPdfExport';

describe('export PDF natif des ventes', () => {
  it('ajoute uniquement l’extension PDF manquante', () => {
    expect(pdfDestinationPath('C:\\Exports\\Facture-1')).toBe(
      'C:\\Exports\\Facture-1.pdf',
    );
    expect(pdfDestinationPath('C:\\Exports\\Facture-1.PDF')).toBe(
      'C:\\Exports\\Facture-1.PDF',
    );
  });

  it('construit exclusivement les arguments attendus par la commande Rust', () => {
    expect(
      salesPdfInvokeInput(
        'invoices',
        'invoice-1',
        'C:\\Exports\\Facture.pdf',
      ),
    ).toEqual({
      input: {
        entity: 'invoices',
        document_id: 'invoice-1',
        destination_path: 'C:\\Exports\\Facture.pdf',
      },
    });
  });

  it('produit des noms sûrs et distingue devis, facture et avoir', () => {
    expect(salesPdfSuggestedFileName('quotes', 'D/2026 001')).toBe(
      'Devis_D-2026-001.pdf',
    );
    expect(salesPdfSuggestedFileName('invoices', 'F-42')).toBe(
      'Facture_F-42.pdf',
    );
    expect(salesPdfSuggestedFileName('invoices', 'A-7', true)).toBe(
      'Avoir_A-7.pdf',
    );
  });
});
