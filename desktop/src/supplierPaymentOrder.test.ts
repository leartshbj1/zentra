import { describe, expect, it } from 'vitest';
import { defaultSelection, nextBankDay, parseFreeAddress, payableInvoices, paymentOrderSummary, prepareSupplierPaymentOrder } from './supplierPaymentOrder';
import type { Supplier, SupplierInvoice, Workspace } from './types';

const supplier = (id: string, name: string, iban: string, address = ''): Supplier => ({
  id, name, iban, address, contactName: '', email: '', phone: '', uidNumber: '', currency: 'CHF', paymentTermsDays: 30, notes: '', createdAt: '', updatedAt: '',
});

const invoice = (id: string, supplierId: string, dueDate: string, balanceCents: number, extra: Partial<SupplierInvoice> = {}): SupplierInvoice => ({
  id, supplierId, projectId: null, documentDate: '2026-10-01', dueDate, supplierName: supplierId, reference: `R-${id}`, currency: 'CHF',
  documentStatus: 'validated', paymentStatus: 'pending', netCents: balanceCents, vatCents: 0, totalCents: balanceCents, paidCents: 0, creditedCents: 0,
  balanceCents, matchStatus: 'unmatched', validatedAt: '2026-10-02', validationJournalEntryId: null, note: '', lines: [], payments: [], attachments: [],
  createdAt: '2026-10-02T08:00:00Z', updatedAt: '2026-10-02T08:00:00Z', ...extra,
});

function workspace(): Workspace {
  return {
    settings: {
      organization: { legalName: 'Menuiserie Dupont Sàrl', address: { street: 'Route de Berne', buildingNumber: '12', postalCode: '1700', city: 'Fribourg', canton: 'FR', country: 'CH' } },
      billing: { iban: 'CH93 0076 2011 6238 5295 7', accountHolder: 'Menuiserie Dupont Sàrl' },
    },
    suppliers: [
      supplier('swisscom', 'Swisscom (Schweiz) AG', 'CH58 0079 1123 0008 8901 2', 'Alte Tiefenaustrasse 6, 3048 Worblaufen'),
      supplier('schneider', 'Robert Schneider AG', ''),
      supplier('sans-iban', 'Garage Martin', ''),
    ],
    supplierInvoices: [
      invoice('a', 'swisscom', '2026-10-22', 8990),
      invoice('b', 'schneider', '2026-10-25', 194975, {
        paymentDetails: {
          supplierInvoiceId: 'b', creditorIban: 'CH4431999123000889012', referenceType: 'QRR', reference: '210000000003139471430009017',
          creditorName: 'Robert Schneider AG', creditorStreet: 'Rue du Lac', creditorBuildingNumber: '1268', creditorPostalCode: '2501', creditorCity: 'Biel',
          creditorCountry: 'CH', amountCents: 194975, currency: 'CHF', message: '', billInformation: '', source: 'qr_bill', updatedAt: '',
        },
      }),
      invoice('c', 'sans-iban', '2026-10-21', 5000),
      invoice('d', 'swisscom', '2026-12-30', 1200),
      invoice('e', 'swisscom', '2026-10-20', 0),
      invoice('f', 'swisscom', '2026-10-20', 700, { documentStatus: 'draft' }),
    ],
    supplierPaymentOrders: [],
  } as unknown as Workspace;
}

describe('ordre de paiement des factures fournisseurs', () => {
  it('liste les factures à payer et repère l’IBAN manquant', () => {
    const rows = payableInvoices(workspace());
    expect(rows.map((row) => row.invoice.id)).toEqual(['c', 'a', 'b', 'd']);
    expect(rows[0].missing).toBe('iban');
    expect(rows[2].line?.reference).toEqual({ type: 'QRR', value: '210000000003139471430009017' });
    expect(rows[1].line?.creditor.address).toEqual({ street: 'Alte Tiefenaustrasse', buildingNumber: '6', postalCode: '3048', city: 'Worblaufen', country: 'CH' });
  });

  it('propose les factures payables de la semaine, sans celles déjà dans un ordre', () => {
    const ws = workspace();
    expect(defaultSelection(payableInvoices(ws), '2026-10-20')).toEqual(['a', 'b']);
    ws.supplierPaymentOrders = [{ id: 'o', messageId: 'M', executionDate: '2026-10-21', debtorIban: '', transactionCount: 1, totalCents: 8990, fileName: '', createdAt: '2026-10-20T09:00:00Z', items: [{ supplierInvoiceId: 'a', endToEndId: 'R-a', amountCents: 8990 }] }];
    expect(defaultSelection(payableInvoices(ws), '2026-10-20')).toEqual(['b']);
    expect(paymentOrderSummary(ws, '2026-10-20')).toEqual({ count: 1, totalCents: 194975, ids: ['b'] });
  });

  it('prépare le fichier avec le solde ouvert de chaque facture', () => {
    const ws = workspace();
    const rows = payableInvoices(ws);
    const order = prepareSupplierPaymentOrder(ws, rows, ['a', 'b', 'c'], '2026-10-21', new Date(2026, 9, 20, 10, 15, 0), 'A1B2');
    expect(order.ok).toBe(true);
    if (!order.ok) return;
    expect(order.totalCents).toBe(203965);
    expect(order.messageId).toBe('ZENTRA-20261020-101500-A1B2');
    expect(order.fileName).toBe('ordre-de-paiement-2026-10-21.xml');
    expect(order.items).toEqual([
      { supplierInvoiceId: 'a', endToEndId: 'R-a', amountCents: 8990 },
      { supplierInvoiceId: 'b', endToEndId: 'R-b', amountCents: 194975 },
    ]);
    expect(order.xml).toContain('<IBAN>CH9300762011623852957</IBAN>');
    expect(order.xml).toContain('<Ustrd>Facture R-a</Ustrd>');
  });

  it('refuse sans IBAN d’entreprise valide', () => {
    const ws = workspace();
    ws.settings!.billing.iban = '';
    expect(prepareSupplierPaymentOrder(ws, payableInvoices(ws), ['a'], '2026-10-21', new Date(), 'X')).toMatchObject({ ok: false, reason: 'company_iban' });
  });

  it('calcule le prochain jour bancaire et lit une adresse libre', () => {
    expect(nextBankDay('2026-10-20')).toBe('2026-10-21');
    expect(nextBankDay('2026-10-23')).toBe('2026-10-26');
    expect(parseFreeAddress('Grand-Rue 4\n1630 Bulle')).toEqual({ street: 'Grand-Rue', buildingNumber: '4', postalCode: '1630', city: 'Bulle', country: 'CH' });
    expect(parseFreeAddress('Case postale')).toBeUndefined();
  });
});
