import { describe, expect, it } from 'vitest';
import { applyPriceList, clientPriceList, listUnitPrice, parseDiscountPercent, priceListsFromRaw } from './priceLists';
import type { DocumentLine } from './types';
import { documentLineTotals } from './utils';

const line = (catalogItemId: string | null): DocumentLine => ({ id: 'l1', catalogItemId, description: 'Pose', quantity: 2, unit: 'h', unitPriceCents: 9_500, discountBp: 0, vatRateBp: 810 });
const lists = priceListsFromRaw(
  [{ id: 'p1', name: 'Revendeurs', discount_bp: 1_000, archived_at: null }, { id: 'p2', name: 'Ancienne', discount_bp: 2_000, archived_at: '2026-01-01' }],
  [{ price_list_id: 'p1', catalog_item_id: 'fixed', unit_price_cents: 8_000 }],
  [{ client_id: 'c1', price_list_id: 'p1' }, { client_id: 'c2', price_list_id: 'p2' }],
);

describe('price lists', () => {
  it('reads the lists with their prices and clients', () => {
    expect(lists[0]).toEqual({ id: 'p1', name: 'Revendeurs', discountBp: 1_000, archivedAt: null, items: [{ catalogItemId: 'fixed', unitPriceCents: 8_000 }], clientIds: ['c1'] });
  });

  it('finds only the active list of a client', () => {
    expect(clientPriceList(lists, 'c1')?.id).toBe('p1');
    expect(clientPriceList(lists, 'c2')).toBeNull();
    expect(clientPriceList(lists, null)).toBeNull();
  });

  it('uses the fixed price, else the visible discount', () => {
    const list = clientPriceList(lists, 'c1');
    expect(applyPriceList(line('fixed'), list)).toMatchObject({ unitPriceCents: 8_000, discountBp: 0 });
    const discounted = applyPriceList(line('other'), list);
    expect(discounted).toMatchObject({ unitPriceCents: 9_500, discountBp: 1_000 });
    // 2 × 95.00 = 190.00 − 10 % = 171.00 + TVA 8.1 % = 184.85.
    expect(documentLineTotals(discounted).totalCents).toBe(18_485);
    expect(applyPriceList(line(null), list)).toEqual(line(null));
    expect(applyPriceList(line('other'), null)).toEqual(line('other'));
  });

  it('gives a net unit price for signed reports', () => {
    const list = clientPriceList(lists, 'c1');
    expect(listUnitPrice('fixed', 9_500, list)).toBe(8_000);
    expect(listUnitPrice('other', 9_995, list)).toBe(8_996);
    expect(listUnitPrice('other', 9_995, null)).toBe(9_995);
  });

  it('reads a discount in percent', () => {
    expect(parseDiscountPercent('10')).toBe(1_000);
    expect(parseDiscountPercent('12,5')).toBe(1_250);
    expect(parseDiscountPercent('100')).toBe(10_000);
    expect(parseDiscountPercent('101')).toBeNull();
    expect(parseDiscountPercent('-1')).toBeNull();
  });
});
