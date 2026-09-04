import { describe, expect, it } from 'vitest';
import { documentLineToBackend } from './bridge';

describe('contrat frontend des lignes de devis et facture', () => {
  it('sérialise explicitement un taux TVA de 0 % sans le confondre avec une absence', () => {
    expect(
      documentLineToBackend(
        {
          id: 'line-zero-vat',
          catalogItemId: 'catalog-zero-vat',
          description: 'Opération hors TVA',
          quantity: 2,
          unit: 'forfait',
          unitPriceCents: 12_500,
          discountBp: 500,
          vatRateBp: 0,
        },
        true,
      ),
    ).toEqual({
      id: 'line-zero-vat',
      catalog_item_id: 'catalog-zero-vat',
      description: 'Opération hors TVA',
      quantity: 2,
      unit: 'forfait',
      unit_price_cents: 12_500,
      discount_bp: 500,
      vat_bp: 0,
    });
  });
});
