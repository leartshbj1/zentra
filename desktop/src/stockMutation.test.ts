import { describe, expect, it } from 'vitest';
import { stockMovementMutation } from './bridge';

const requestId = '7b63030f-8076-4d70-acd7-6db15d296895';

describe('contrat frontend des mouvements de stock', () => {
  it('conserve le UUID stable et envoie une entrée en snake_case', () => {
    expect(stockMovementMutation('entry', {
      requestId,
      catalogItemId: 'product-1',
      quantityMilli: 1_250,
      reason: '  Livraison fournisseur  ',
      reference: '  BL-42  ',
      date: '2026-09-01',
    })).toEqual({
      command: 'record_stock_entry',
      args: {
        input: {
          request_id: requestId,
          catalog_item_id: 'product-1',
          quantity_milli: 1_250,
          reason: 'Livraison fournisseur',
          reference: 'BL-42',
          date: '2026-09-01',
        },
      },
    });
  });

  it('utilise le delta signé dédié aux corrections et normalise les options vides', () => {
    expect(stockMovementMutation('correction', {
      requestId,
      catalogItemId: 'product-1',
      quantityMilli: -500,
      reason: 'Inventaire',
      reference: '   ',
    })).toEqual({
      command: 'record_stock_correction',
      args: {
        input: {
          request_id: requestId,
          catalog_item_id: 'product-1',
          delta_quantity_milli: -500,
          reason: 'Inventaire',
          reference: null,
          date: null,
        },
      },
    });
  });

  it('garde une quantité positive pour une sortie, le backend appliquant le signe négatif', () => {
    const mutation = stockMovementMutation('exit', {
      requestId,
      catalogItemId: 'product-1',
      quantityMilli: 750,
      reason: 'Consommation atelier',
    });
    expect(mutation.command).toBe('record_stock_exit');
    expect(mutation.args.input).toMatchObject({ quantity_milli: 750 });
    expect(mutation.args.input).not.toHaveProperty('delta_quantity_milli');
  });
});
