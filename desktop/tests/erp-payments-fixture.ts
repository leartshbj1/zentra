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

/** ?erp=chart : plan comptable de démarrage installé, plan PME à compléter. */
export function installErpChartFixture() {
  const missing = [
    ['1000', 'Caisse'], ['1060', 'Titres'], ['1109', 'Ducroire'], ['1200', 'Marchandises commerciales'], ['1300', "Charges payées d'avance"],
    ['1500', 'Machines et appareils'], ['1510', 'Mobilier et installations'], ['1530', 'Véhicules'], ['2100', 'Dettes bancaires à court terme'],
    ['2300', 'Charges à payer'], ['2800', 'Capital propre ou capital social'], ['3400', 'Ventes de prestations de services'],
    ['4200', 'Achats de marchandises'], ['6100', 'Entretien, réparations et remplacement'], ['6510', 'Téléphone et internet'], ['6940', 'Frais bancaires'],
  ].map(([code, name]) => ({ code, name }));
  let remaining = missing;
  desktopApi.swissSmeChartPreview = async () => ({ total: 110, present: 110 - remaining.length, missing: remaining });
  desktopApi.completeSwissSmeChart = async () => { const added = remaining.length; remaining = []; return { added }; };
}

/** ?erp=bexio : clients repris de bexio, reprise d'ouverture simulée sans app native. */
export function installErpBexioFixture(data: Workspace) {
  const client = (id: string, name: string, street: string, postalCode: string, city: string) => ({
    id, name, company: name, email: '', phone: '', address: `${street}\n${postalCode} ${city}`, addressLine1: street, postalCode, city, country: 'CH', uidNumber: '', notes: 'Import bexio',
  });
  data.clients = [
    ...data.clients,
    client('c-muster', 'Muster AG', 'Bahnhofstrasse 1', '8001', 'Zürich'),
    client('c-favre', 'Boulangerie Favre Sàrl', 'Rue de Lausanne 12', '1630', 'Bulle'),
    client('c-commune', 'Commune de Riaz', 'Route de Riaz 2', '1632', 'Riaz'),
  ] as Workspace['clients'];
  // Après les autres fixtures du banc, qui remplacent aussi le pont natif.
  setTimeout(() => {
  const tauri = window as unknown as { __TAURI_INTERNALS__?: { invoke: (command: string) => Promise<unknown> } };
  const previous = tauri.__TAURI_INTERNALS__?.invoke;
  tauri.__TAURI_INTERNALS__ = {
    ...(tauri.__TAURI_INTERNALS__ ?? {}),
    invoke: async (command: string, ...rest: unknown[]) => {
      if (command === 'bexio_import_scope') return 'fixture-company';
      if (previous) return (previous as (...args: unknown[]) => Promise<unknown>)(command, ...rest);
      throw new Error(`Commande indisponible dans l’aperçu : ${command}`);
    },
  } as never;
  }, 0);
  const names: Record<string, string> = { '1020': 'Banque', '1100': 'Créances résultant de livraisons et prestations', '1500': 'Machines et appareils', '2000': 'Dettes résultant d’achats et de prestations', '2100': 'Dettes bancaires à court terme', '2800': 'Capital propre ou capital social', '2970': 'Bénéfice ou perte reporté' };
  desktopApi.previewOpeningBalance = async (entryDate, lines) => {
    const receivables = 225_050;
    const planned = lines.map((line) => {
      const debitNormal = line.code.startsWith('1');
      const balance = line.balance_cents ?? (line.debit_cents ?? 0) - (line.credit_cents ?? 0);
      let net = line.balance_cents === undefined ? balance : debitNormal ? balance : -balance;
      const note = line.code === '1100' ? "dont 2'250.50 déjà repris avec les factures ouvertes" : '';
      if (line.code === '1100') net -= receivables;
      return { line: line.line, code: line.code, name: names[line.code] ?? line.name ?? '', debitCents: Math.max(net, 0), creditCents: Math.max(-net, 0), create: line.code === '1500', note };
    });
    const sum = planned.reduce((total, line) => total + line.debitCents - line.creditCents, 0);
    return { entryDate, lines: planned, opening: { code: '9100', name: "Bilan d'ouverture", debitCents: Math.max(-sum, 0), creditCents: Math.max(sum, 0) }, receivablesCents: receivables, differenceCents: sum + receivables };
  };
  desktopApi.importOpeningReceivables = async (rows) => ({ receipt: { created: rows.length, skipped: 0, rows: rows.map((row) => ({ line: row.line, number: row.number, status: 'created' as const })) }, workspace: structuredClone(data) });
  desktopApi.importOpeningBalance = async (entryDate, lines) => ({ plan: await desktopApi.previewOpeningBalance(entryDate, lines), journalNumber: 'J-2026-000001' });
}

/** ?erp=paylink : paiement en ligne activé, un lien payé à enregistrer. */
export function installErpPaymentLinkFixture(data: Workspace) {
  desktopApi.getOnlinePaymentSettings = async () => ({ enabled: true, provider: 'payrexx', instance: 'atelier-leman', secretPresent: true });
  const invoice = data.invoices.find((row) => row.number && row.status !== 'paid' && row.status !== 'draft' && row.status !== 'cancelled');
  if (!invoice) return;
  data.invoicePaymentLinks = [{ id: 'link-1', invoiceId: invoice.id, url: 'https://atelier-leman.payrexx.com/?payment=1', amountCents: 48_600, currency: 'CHF', status: 'paid', paidAt: new Date().toISOString(), paymentId: null, createdAt: new Date().toISOString() }];
}
