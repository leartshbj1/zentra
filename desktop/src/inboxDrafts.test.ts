import { describe, expect, it } from 'vitest';
import { apiDraftLines, inboxCardSource, invoiceForShopPayment, matchShopPayout, netFromGross, partyCustomer, partyFrom, shopMarker, shopOrderLines } from './inboxDrafts';
import { inboxFromRaw, posDayFromRaw, statusFromRaw } from './openApi';
import type { CatalogItem, Invoice } from './types';

const tea = { id: 'tea', kind: 'product', sku: 'TH-250', name: 'Thé vert', unit: 'sachet', salesPriceCents: 2200, vatBp: 260, trackStock: true, archivedAt: null } as unknown as CatalogItem;
const service = { id: 'pose', kind: 'service', sku: 'POSE', name: 'Pose', unit: 'h', salesPriceCents: 9500, vatBp: 810, trackStock: false, archivedAt: null } as unknown as CatalogItem;

const shopOrder = {
  platform: 'shopify', shop: 'the-shop.myshopify.com', externalId: '5550001', number: '#1001', currency: 'CHF', pricesIncludeTax: true,
  customer: { name: 'Léa Favre', email: 'lea@example.test', addressLine1: 'Rue Neuve 4', postalCode: '1003', city: 'Lausanne', country: 'CH' },
  lines: [
    { sku: 'th-250', description: 'Thé vert 250 g', quantityMilli: 2000, unitPriceCents: 2490, lineTotalCents: 4980, taxRateBp: 260 },
    { sku: null, description: 'Carte cadeau', quantityMilli: 1000, unitPriceCents: 1000, lineTotalCents: 500, taxRateBp: null },
  ],
  shippingCents: 1000, shippingDescription: 'Courrier A', totalCents: 6480,
};

describe('boîte d’entrée', () => {
  it('reprend une commande de boutique en prix hors taxe, remise et port compris', () => {
    const lines = shopOrderLines(shopOrder, [tea, service], 810);
    expect(lines).toEqual([
      { catalogItemId: 'tea', position: 0, description: 'Thé vert 250 g', quantityMilli: 2000, unit: 'sachet', unitPriceCents: netFromGross(2490, 260), discountBp: 0, vatBp: 260, fulfillmentMode: 'stocked_delivery' },
      { catalogItemId: null, position: 1, description: 'Carte cadeau', quantityMilli: 1000, unit: 'pce', unitPriceCents: netFromGross(1000, 810), discountBp: 5000, vatBp: 810, fulfillmentMode: 'direct' },
      { catalogItemId: null, position: 2, description: 'Courrier A', quantityMilli: 1000, unit: 'forfait', unitPriceCents: netFromGross(1000, 810), discountBp: 0, vatBp: 810, fulfillmentMode: 'direct' },
    ]);
    expect(netFromGross(2490, 260)).toBe(2427);
  });

  it('applique le catalogue pour un brouillon de l’API', () => {
    const lines = apiDraftLines({ lines: [{ articleId: 'pose', quantityMilli: 2500, unitPriceCents: 1 }, { sku: null, description: 'Déplacement', quantityMilli: 1000, unitPriceCents: 4000 }] }, [tea, service], 810);
    expect(lines.map((line) => [line.catalogItemId, line.unitPriceCents, line.vatBp, line.fulfillmentMode])).toEqual([['pose', 9500, 810, 'direct'], [null, 4000, 810, 'direct']]);
  });

  it('retrouve la facture de la commande par son repère', () => {
    const marker = shopMarker(shopOrder);
    expect(marker).toBe('[shopify:the-shop.myshopify.com:5550001]');
    const invoices = [
      { id: 'i1', type: 'standard', status: 'paid', notes: marker },
      { id: 'i2', type: 'standard', status: 'issued', notes: `Commande ${marker}` },
    ] as unknown as Invoice[];
    expect(invoiceForShopPayment(shopOrder, invoices)?.id).toBe('i2');
  });

  it('écrit le titre de la carte selon la source', () => {
    const card = inboxCardSource({ itemId: 'in_x', seq: 1, source: 'shopify', kind: 'order', createdAt: '', payload: shopOrder });
    expect(card).toEqual({ titleKey: 'Commande {platform} {number} à valider', values: { platform: 'Shopify', number: '#1001' }, detail: 'Léa Favre' });
    expect(partyCustomer(partyFrom(shopOrder.customer))).toMatchObject({ name: 'Léa Favre', email: 'lea@example.test', postcode: '1003' });
  });

  it('rapproche un versement de boutique, frais déduits', () => {
    const payments = [{ platform: 'shopify', amountCents: 6480 }, { platform: 'shopify', amountCents: 3000 }, { platform: 'woocommerce', amountCents: 999 }];
    expect(matchShopPayout({ amountCents: 9200, text: 'SHOPIFY PAYMENTS PAYOUT' }, payments)).toEqual({ platform: 'shopify', grossCents: 9480, feeCents: 280, count: 2 });
    expect(matchShopPayout({ amountCents: 9200, text: 'Virement' }, payments)).toBeNull();
    expect(matchShopPayout({ amountCents: 5000, text: 'Shopify' }, payments)).toBeNull();
  });
});

describe('réponses natives du lot 5', () => {
  it('ne garde que les éléments connus de la boîte d’entrée', () => {
    const items = inboxFromRaw({ items: [
      { itemId: 'in_0f3e1968-d7ef-4577-bd21-fb15389f25fe', seq: 1, source: 'shopify', kind: 'order', createdAt: '2026-10-25T10:00:00Z', payload: { number: '#1' } },
      { itemId: 'in_bad', seq: 2, source: 'shopify', kind: 'order', payload: {} },
      { itemId: 'in_0f3e1968-d7ef-4577-bd21-fb15389f25ff', seq: 3, source: 'fax', kind: 'order', payload: {} },
    ] });
    expect(items.map((item) => item.seq)).toEqual([1]);
    expect(statusFromRaw({ projection: { wanted: true, revision: 3, publishedAt: null }, inbox: { pending: 2 }, postal: { configured: true, mode: 'staging' } }))
      .toEqual({ projection: { wanted: true, revision: 3, publishedAt: null }, inboxPending: 2, postal: { configured: true, mode: 'staging' }, calendarWanted: false });
  });

  it('lit une journée de caisse', () => {
    const day = posDayFromRaw({ date: '2026-10-25', tickets: [{ id: 't', number: 'T-1', kind: 'sale', ticket_date: '2026-10-25', payment_method: 'terminal', total_cents: 486 }],
      lines: [], totals: { total_cents: 486, terminal_cents: 486, ticket_count: 1 }, closing: null });
    expect(day.tickets[0]).toMatchObject({ method: 'terminal', totalCents: 486, date: '2026-10-25' });
    expect(day.totals).toEqual({ cashCents: 0, payrexxCents: 0, terminalCents: 486, totalCents: 486, ticketCount: 1 });
    expect(day.closing).toBeNull();
  });
});
