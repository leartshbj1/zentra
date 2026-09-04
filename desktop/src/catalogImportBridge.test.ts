import { describe, expect, it } from 'vitest';
import { importCatalogItemsMutation } from './bridge';

describe('contrat frontend de l’import catalogue', () => {
  it('convertit toutes les colonnes contrôlées vers le payload Rust', () => {
    expect(
      importCatalogItemsMutation(
        [
          {
            rowNumber: 12,
            sku: 'FOUR-17',
            name: 'Robinet chromé',
            description: 'Modèle mural',
            unit: 'pièce',
            purchaseCostCents: 8_240,
            salesPriceCents: 12_990,
            vatBp: 810,
            kind: 'product',
            errors: [],
          },
        ],
        'update',
      ),
    ).toEqual({
      command: 'import_catalog_items',
      args: {
        input: {
          conflict_policy: 'update',
          rows: [
            {
              row_number: 12,
              sku: 'FOUR-17',
              name: 'Robinet chromé',
              description: 'Modèle mural',
              unit: 'pièce',
              purchase_cost_cents: 8_240,
              sales_price_cents: 12_990,
              vat_bp: 810,
              kind: 'product',
            },
          ],
        },
      },
    });
  });
});
