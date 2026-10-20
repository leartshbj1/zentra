import { describe, expect, it } from 'vitest';
import { applyQrBill, matchQrBillSupplier, netFromGross, qrBillPaymentDetails, supplierFromQrBill } from './qrBillPurchase';
import { parseSwissQrBill, type QrBill } from './swissQrBill';
import type { Workspace } from './types';

function bill(billInformation: string, amount = '1949.75'): QrBill {
  const result = parseSwissQrBill([
    'SPC', '0200', '1', 'CH4431999123000889012', 'S', 'Robert Schneider AG', 'Rue du Lac', '1268', '2501', 'Biel', 'CH',
    '', '', '', '', '', '', '', amount, 'CHF', '', '', '', '', '', '', '',
    'QRR', '210000000003139471430009017', 'Commande 4471', 'EPD', billInformation,
  ].join('\n'));
  if (!result.ok) throw new Error(result.problem);
  return result.bill;
}

function workspace(suppliers: { id: string; name: string; iban?: string }[] = []): Workspace {
  return {
    settings: {
      organization: { vatRegistered: true },
      billing: { paymentTermsDays: 30, vatRatesBp: [810, 260, 380] },
      work: { costCategories: ['Matériel', 'Sous-traitance'] },
    },
    suppliers: suppliers.map((supplier) => ({ iban: '', archivedAt: null, paymentTermsDays: 20, ...supplier })),
    supplierInvoices: [],
  } as unknown as Workspace;
}

const empty = { supplierId: '', reference: '', date: '', dueDate: '', projectId: '', note: '', vatTreatment: '' as const, lines: [] };

describe('facture fournisseur depuis une QR-facture', () => {
  it('retrouve le montant net exact d’un total TTC', () => {
    expect(netFromGross(194975, 810)).toBe(180365);
    expect(netFromGross(10810, 810)).toBe(10000);
    expect(netFromGross(1000, 0)).toBe(1000);
    for (let total = 1; total < 3000; total += 7) {
      const net = netFromGross(total, 260);
      if (net !== null) expect(net + Math.floor((net * 260 + 5000) / 10000)).toBe(total);
    }
  });

  it('reconnaît le fournisseur par son nom quand l’IBAN est un QR-IBAN inconnu', () => {
    const ws = workspace([{ id: 's1', name: 'Robert  Schneider AG' }, { id: 's2', name: 'Autre SA' }]);
    expect(matchQrBillSupplier(bill(''), ws)?.id).toBe('s1');
    expect(matchQrBillSupplier(bill(''), workspace([{ id: 's3', name: 'X', iban: 'CH44 3199 9123 0008 8901 2' }]))?.id).toBe('s3');
    expect(matchQrBillSupplier(bill(''), workspace([{ id: 's4', name: 'Y' }]))).toBeNull();
  });

  it('remplit numéro, dates et montant net quand la TVA est indiquée', () => {
    const ws = workspace([{ id: 's1', name: 'Robert Schneider AG' }]);
    const qr = bill('//S1/10/10201409/11/261015/32/8.1/40/0:30');
    const { fields, complete } = applyQrBill(qr, empty, ws, ws.suppliers[0], '2026-10-20', [810, 260, 380]);
    expect(complete).toBe(true);
    expect(fields).toMatchObject({ supplierId: 's1', reference: '10201409', date: '2026-10-15', dueDate: '2026-11-14' });
    expect(fields.lines).toHaveLength(1);
    expect(fields.lines[0]).toMatchObject({ description: 'Facture 10201409', quantity: '1', price: '1803.65', vatBp: 810 });
  });

  it('crée une ligne par taux quand les montants nets sont donnés', () => {
    const ws = workspace();
    const { fields, complete } = applyQrBill(bill('//S1/10/7/32/8.1:1000;2.6:200'), empty, ws, null, '2026-10-20', [810, 260]);
    expect(complete).toBe(true);
    expect(fields.lines.map((line) => [line.price, line.vatBp])).toEqual([['1000.00', 810], ['200.00', 260]]);
    // Sans conditions ni fournisseur : délai habituel de l'entreprise depuis la date du jour.
    expect(fields.date).toBe('2026-10-20');
    expect(fields.dueDate).toBe('2026-11-19');
  });

  it('ne force pas un montant net qui ne retombe pas exactement sur le total', () => {
    // 949.75 TTC à 8,1 % : aucun montant HT au centime ne donne exactement ce total.
    expect(netFromGross(94975, 810)).toBeNull();
    const { complete } = applyQrBill(bill('//S1/10/1/32/8.1', '949.75'), empty, workspace(), null, '2026-10-20', [810]);
    expect(complete).toBe(false);
  });

  it('laisse le montant HT à compléter quand la TVA n’est pas indiquée', () => {
    const { fields, complete } = applyQrBill(bill(''), empty, workspace(), null, '2026-10-20', [810]);
    expect(complete).toBe(false);
    expect(fields.lines[0].price).toBe('');
  });

  it('garde les coordonnées de paiement et propose une fiche sans QR-IBAN', () => {
    const qr = bill('//S1/10/10201409/30/106017086/40/2:10;0:45');
    expect(qrBillPaymentDetails(qr, 'inv-1')).toMatchObject({
      supplierInvoiceId: 'inv-1', creditorIban: 'CH4431999123000889012', referenceType: 'QRR', reference: '210000000003139471430009017',
      creditorStreet: 'Rue du Lac', creditorBuildingNumber: '1268', creditorCity: 'Biel', amountCents: 194975, source: 'qr_bill',
    });
    expect(supplierFromQrBill(qr)).toEqual({
      name: 'Robert Schneider AG', address: 'Rue du Lac 1268\n2501 Biel', iban: '', currency: 'CHF', paymentTermsDays: 45, uidNumber: 'CHE-106.017.086',
    });
  });
});
