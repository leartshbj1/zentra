// Fictitious data for the ERP payment captures (?erp=payments). Excluded from production.
import { desktopApi } from '../src/bridge';
import type { Supplier, SupplierInvoice, Workspace } from '../src/types';

const now = '2026-10-15T08:00:00Z';
const today = new Date().toISOString().slice(0, 10);
const shift = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

function supplier(id: string, name: string, iban: string, address: string): Supplier {
  return { id, name, contactName: '', email: '', phone: '', address, uidNumber: '', iban, currency: 'CHF', paymentTermsDays: 30, notes: '', archivedAt: null, createdAt: now, updatedAt: now };
}

function invoice(id: string, owner: Supplier, reference: string, dueDate: string, totalCents: number, extra: Partial<SupplierInvoice> = {}): SupplierInvoice {
  return {
    id, supplierId: owner.id, projectId: null, documentDate: shift(-20), dueDate, supplierName: owner.name, reference, currency: 'CHF',
    documentStatus: 'validated', paymentStatus: 'pending', netCents: totalCents, vatCents: 0, totalCents, paidCents: 0, creditedCents: 0,
    balanceCents: totalCents, matchStatus: 'unmatched', validatedAt: now, validationJournalEntryId: 'journal-' + id, note: '',
    lines: [], payments: [], attachments: [], createdAt: now, updatedAt: now, ...extra,
  };
}

export function installErpPaymentsFixture(data: Workspace) {
  const swisscom = supplier('s-swisscom', 'Swisscom (Suisse) SA', 'CH58 0079 1123 0008 8901 2', 'Alte Tiefenaustrasse 6\n3048 Worblaufen');
  const bois = supplier('s-bois', 'Scierie du Jura Sàrl', '', 'Route de Moutier 14\n2800 Delémont');
  const garage = supplier('s-garage', 'Garage Martin', '', 'Rue du Collège 3\n1630 Bulle');
  const papeterie = supplier('s-papeterie', 'Papeterie des Alpes', 'CH93 0076 2011 6238 5295 7', 'Grand-Rue 4\n1630 Bulle');
  data.suppliers = [swisscom, bois, garage, papeterie];
  data.supplierInvoices = [
    invoice('i-1', swisscom, 'R-2026-118', shift(2), 8990),
    invoice('i-2', bois, '10201409', shift(4), 94975, {
      paymentDetails: {
        supplierInvoiceId: 'i-2', creditorIban: 'CH4431999123000889012', referenceType: 'QRR', reference: '210000000003139471430009017',
        creditorName: 'Scierie du Jura Sàrl', creditorStreet: 'Route de Moutier', creditorBuildingNumber: '14', creditorPostalCode: '2800',
        creditorCity: 'Delémont', creditorCountry: 'CH', amountCents: 94975, currency: 'CHF', message: '', billInformation: '', source: 'qr_bill', updatedAt: now,
      },
    }),
    invoice('i-3', papeterie, 'F-77', shift(-3), 20035),
    invoice('i-4', garage, 'Révision fourgon', shift(6), 61000),
    invoice('i-5', papeterie, 'F-91', shift(25), 4500),
  ];
  data.supplierPaymentOrders = [];
  data.accountingSettings = { enabled: true, arAccountId: 'ar', revenueAccountId: 'revenue', vatPayableAccountId: 'vat-out', vatDeferredPayableAccountId: 'vat-deferred', bankAccountId: 'bank', expenseAccountId: 'expense', vatReceivableAccountId: 'vat-in', wagesExpenseAccountId: 'wages', wagesPayableAccountId: 'wages-payable', socialExpenseAccountId: 'social', socialPayableAccountId: 'social-payable', supplierPayableAccountId: 'ap' };
  data.accounts = [
    { id: 'bank', code: '1020', name: 'Banque', accountType: 'asset', normalBalance: 'debit', reportSection: 'current_assets', active: true },
    { id: 'expense', code: '4000', name: 'Achats de marchandises', accountType: 'expense', normalBalance: 'debit', reportSection: 'cost_of_goods', active: true },
    { id: 'vat-in', code: '1170', name: 'TVA préalable', accountType: 'asset', normalBalance: 'debit', reportSection: 'current_assets', active: true },
    { id: 'ap', code: '2000', name: 'Dettes fournisseurs', accountType: 'liability', normalBalance: 'credit', reportSection: 'short_term_liabilities', active: true },
  ] as Workspace['accounts'];
  void today;
  desktopApi.exportSupplierPaymentOrder = async (input) => {
    const order = {
      id: 'order-1', messageId: input.messageId, executionDate: input.executionDate, debtorIban: input.debtorIban,
      transactionCount: input.items.length, totalCents: input.items.reduce((sum, item) => sum + item.amountCents, 0),
      fileName: input.fileName, createdAt: new Date().toISOString(), items: input.items,
    };
    data.supplierPaymentOrders = [order, ...(data.supplierPaymentOrders ?? [])];
    return { id: order.id, path: `C:\\Users\\Vous\\Downloads\\${input.fileName}`, transactionCount: order.transactionCount, totalCents: order.totalCents, deliveryWarning: undefined, workspace: structuredClone(data) };
  };
}
