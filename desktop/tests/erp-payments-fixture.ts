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
  desktopApi.importMigrationReceivables = async (_origin, rows) => ({ receipt: { created: rows.length, skipped: 0, import_id: 'import-invoices' }, workspace: structuredClone(data) });
  desktopApi.importMigrationBalance = async (_origin, entryDate, lines) => ({ plan: await desktopApi.previewOpeningBalance(entryDate, lines), journalNumber: 'J-2026-000001', importId: 'import-balance' });
  desktopApi.importMigrationContacts = async (_origin, contacts) => ({ created: contacts.rows.length, skipped: 0, import_id: 'import-contacts', rows: contacts.rows.map((row) => ({ line: row.line, name: row.data.name ?? '', status: 'created' as const })) });
  desktopApi.importMigrationAccounts = async (_origin, rows) => ({ created: rows.length, skipped: 0, import_id: 'import-accounts' });
  desktopApi.listAccounts = async () => Object.entries(names).map(([code, name]) => ({ id: code, code, name, accountType: code.startsWith('1') ? 'asset' : code.startsWith('28') || code.startsWith('29') ? 'equity' : 'liability', normalBalance: code.startsWith('1') ? 'debit' : 'credit', reportSection: 'current_assets', active: true }));
  // Historique : deux reprises WinBIZ, dont une déjà annulée.
  const at = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  desktopApi.listDataImports = async () => [
    { id: 'h1', source: 'winbiz', kind: 'clients', fileName: 'adresses-clients.xlsx', createdCount: 48, updatedCount: 0, skippedCount: 2, createdAt: at(1), undoneAt: null, undoReport: null },
    { id: 'h2', source: 'winbiz', kind: 'accounts', fileName: 'plan-comptable.csv', createdCount: 12, updatedCount: 0, skippedCount: 64, createdAt: at(2), undoneAt: at(2), undoReport: { removed: 11, restored: 0, reversed: 0, kept: [{ entity: 'accounts', id: 'a1', name: '1025', reason: 'Déjà utilisée dans Zentra' }] } },
  ];
  // Journal de démonstration pour l'export fiduciaire : facture, encaissement, achat, facture à deux taux.
  const entry = (id: string, number: string, entryDate: string, description: string) => ({ id, number, entryDate, description, sourceType: 'manual', sourceId: id, sourceEvent: 'posted', status: 'posted' as const, reversalOf: null, hasReversal: false });
  const jl = (entryId: string, n: number, code: string, accountName: string, debitCents: number, creditCents: number, memo = '') => ({ id: `${entryId}-${n}`, journalEntryId: entryId, accountId: code, accountCode: code, accountName, entryNumber: entryId, entryDate: '', debitCents, creditCents, currency: 'CHF', memo, projectId: null, clientId: null, employeeId: null });
  desktopApi.getJournal = async () => ({
    entries: [entry('e1', 'J-2026-000041', '2026-03-05', 'Émission F-1042 Muster AG'), entry('e2', 'J-2026-000042', '2026-03-20', 'Encaissement F-1042'), entry('e3', 'J-2026-000043', '2026-03-21', 'Facture fournisseur Bois Léman'), entry('e4', 'J-2026-000044', '2026-03-22', 'Émission F-1043 Boulangerie Favre')],
    lines: [jl('e1', 1, '1100', 'Créances clients', 108_100, 0, 'Créance client'), jl('e1', 2, '3200', 'Ventes de prestations', 0, 100_000, 'Produit facturé'), jl('e1', 3, '2200', 'TVA due', 0, 8_100, 'TVA due'),
      jl('e2', 1, '1020', 'Banque', 108_100, 0), jl('e2', 2, '1100', 'Créances clients', 0, 108_100),
      jl('e3', 1, '4000', 'Achats de matériel', 20_000, 0), jl('e3', 2, '1170', 'Impôt préalable', 1_620, 0), jl('e3', 3, '2000', 'Fournisseurs', 0, 21_620),
      jl('e4', 1, '1100', 'Créances clients', 21_070, 0), jl('e4', 2, '3200', 'Ventes de prestations', 0, 20_000), jl('e4', 3, '2200', 'TVA due', 0, 1_070)],
    currency: { baseCurrency: 'CHF' },
  }) as never;
  const previousSettings = desktopApi.getAccountingSettings;
  desktopApi.getAccountingSettings = async () => ({ ...(await previousSettings().catch(() => ({}))), enabled: true, vatPayableAccountId: '2200', vatReceivableAccountId: '1170' }) as never;
  desktopApi.undoDataImport = async () => ({ report: { removed: 46, restored: 0, reversed: 0, kept: [{ entity: 'clients', id: 'c1', name: 'Menuiserie Dubois Sàrl', reason: 'Déjà utilisée dans Zentra' }] }, workspace: structuredClone(data) });
}

/** ?erp=paylink : paiement en ligne activé, un lien payé à enregistrer. */
export function installErpPaymentLinkFixture(data: Workspace) {
  desktopApi.getOnlinePaymentSettings = async () => ({ enabled: true, provider: 'payrexx', instance: 'atelier-leman', secretPresent: true });
  const invoice = data.invoices.find((row) => row.number && row.status !== 'paid' && row.status !== 'draft' && row.status !== 'cancelled');
  if (!invoice) return;
  data.invoicePaymentLinks = [{ id: 'link-1', invoiceId: invoice.id, url: 'https://atelier-leman.payrexx.com/?payment=1', amountCents: 48_600, currency: 'CHF', status: 'paid', paidAt: new Date().toISOString(), paymentId: null, createdAt: new Date().toISOString() }];
}

/** ?erp=cash : livre de caisse avec un comptage à corriger, contrats et trésorerie. */
export function installErpCashFixture(data: Workspace) {
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const entry = (id: string, offset: number, kind: NonNullable<Workspace['cashBookEntries']>[number]['kind'], amountCents: number, description: string, countId: string | null = null) =>
    ({ id, entryDate: day(offset), kind, amountCents, description, reference: '', countId, createdAt: `${day(offset)}T09:00:00Z` });
  data.cashBookEntries = [
    entry('cb1', -12, 'opening', 50_000, 'Fond de caisse'),
    entry('cb2', -6, 'receipt', 18_500, 'Vente au comptoir'),
    entry('cb3', -4, 'expense', -4_250, 'Timbres et fournitures'),
    entry('cb4', -2, 'bank_deposit', -40_000, 'Versement UBS'),
    entry('cb5', -1, 'receipt', 22_000, 'Réparation payée sur place'),
  ];
  data.cashCounts = [{ id: 'cc1', countDate: day(-1), countedCents: 45_050, expectedCents: 46_250, differenceCents: -1_200, denominations: { '10000': 2, '5000': 3, '2000': 4, '1000': 1, '500': 2, '50': 1 }, note: '', createdAt: `${day(-1)}T18:30:00Z` }];
  data.contracts = [
    { id: 'k1', side: 'supplier', clientId: null, supplierId: null, partyName: 'Régie du Lac SA', title: 'Bail de l’atelier', startDate: '2023-04-01', endDate: day(150).slice(0, 8) + '01', noticeMonths: 6, autoRenew: true, renewalMonths: 12, amountCents: 240_000, currency: 'CHF', frequency: 'monthly', indexation: 'IPC chaque avril', note: '', status: 'active', terminatedOn: null },
    { id: 'k2', side: 'supplier', clientId: null, supplierId: null, partyName: 'Helvetia', title: 'Assurance RC entreprise', startDate: '2024-01-01', endDate: '2025-12-31', noticeMonths: 3, autoRenew: true, renewalMonths: 12, amountCents: 186_000, currency: 'CHF', frequency: 'yearly', indexation: '', note: '', status: 'active', terminatedOn: null },
    { id: 'k3', side: 'supplier', clientId: null, supplierId: null, partyName: 'Swisscom (Suisse) SA', title: 'Internet et téléphonie', startDate: '2025-06-01', endDate: null, noticeMonths: 2, autoRenew: false, renewalMonths: 12, amountCents: 8_990, currency: 'CHF', frequency: 'monthly', indexation: '', note: '', status: 'active', terminatedOn: null },
    { id: 'k4', side: 'customer', clientId: null, supplierId: null, partyName: 'Résidence Bellevue', title: 'Entretien annuel des parquets', startDate: '2025-01-01', endDate: day(40), noticeMonths: 1, autoRenew: false, renewalMonths: 12, amountCents: 120_000, currency: 'CHF', frequency: 'yearly', indexation: '', note: '', status: 'active', terminatedOn: null },
  ];
}

/** ?erp=reports : rapports d'intervention en brouillon, signé et facturé. */
export function installErpReportsFixture(data: Workspace) {
  const client = data.clients[0];
  if (!client) return;
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const line = (id: string, kind: 'labor' | 'material', description: string, quantity: number, unit: string, unitPriceCents: number) => ({ id, kind, catalogItemId: null, description, quantity, unit, unitPriceCents, vatBp: 810 });
  const signature = 'M60 140 L90 80 L120 150 L150 70 L190 140 L230 90 L260 120 M300 130 L360 110 L420 125 L480 100';
  data.workReports = [
    { id: 'wr1', clientId: client.id, projectId: null, reportDate: day(0), site: 'Cuisine, 2e étage', description: 'Remplacement du mitigeur et contrôle de l’écoulement.', technician: 'Marc', status: 'draft', signerName: '', signaturePath: '', signedAt: null, invoiceId: null,
      lines: [line('l1', 'labor', 'Main-d’œuvre', 2.5, 'h', 9_500), line('l2', 'material', 'Mitigeur évier', 1, 'pce', 18_900)] },
    { id: 'wr2', clientId: client.id, projectId: null, reportDate: day(-1), site: 'Hall d’entrée', description: 'Ponçage et vitrification du parquet.', technician: 'Sara', status: 'signed', signerName: 'M. Dupont', signaturePath: signature, signedAt: day(-1) + 'T16:30:00Z', invoiceId: null,
      lines: [line('l3', 'labor', 'Main-d’œuvre', 6, 'h', 9_500), line('l4', 'material', 'Vitrificateur mat 5 l', 1, 'pce', 14_500)] },
  ];
}

/** ?erp=team : deux collaborateurs, absences dont un arrêt maladie long, notes de frais. */
export function installErpTeamFixture(data: Workspace) {
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const base = data.employees[0] ?? ({} as Workspace['employees'][number]);
  data.employees = [
    { ...base, id: 'emp-marc', name: 'Marc Rochat', role: 'Menuisier', archivedAt: null },
    { ...base, id: 'emp-sara', name: 'Sara Keller', role: 'Apprentie', archivedAt: null },
  ] as Workspace['employees'];
  data.leaveSettings = [{ employeeId: 'emp-sara', vacationDaysPerYear: 25, carriedOverDays: 0 }, { employeeId: 'emp-marc', vacationDaysPerYear: 20, carriedOverDays: -3 }];
  const absence = (id: string, employeeId: string, kind: NonNullable<Workspace['absences']>[number]['kind'], start: number, end: number, days: number) =>
    ({ id, employeeId, kind, startDate: day(start), endDate: day(end), days, incapacityPercent: 100, certificate: kind === 'sick', note: '', ijmDeclaredAt: null });
  data.absences = [absence('ab1', 'emp-marc', 'vacation', -120, -100, 15), absence('ab2', 'emp-marc', 'vacation', -60, -55, 5), absence('ab3', 'emp-sara', 'sick', -34, 20, 38), absence('ab4', 'emp-sara', 'vacation', -200, -196, 5)];
  const claim = (id: string, employeeId: string, offset: number, category: string, description: string, amountCents: number, status: NonNullable<Workspace['expenseClaims']>[number]['status']) =>
    ({ id, employeeId, claimDate: day(offset), category, description, amountCents, attachmentId: 'att', status, decisionNote: '', payslipId: null, createdAt: day(offset) + 'T10:00:00Z' });
  data.expenseClaims = [claim('ec1', 'emp-marc', -2, 'Repas', 'Repas chantier Morel', 2_850, 'submitted'), claim('ec2', 'emp-marc', -3, 'Matériel', 'Vis et chevilles', 4_390, 'submitted'), claim('ec3', 'emp-sara', -9, 'Transport', 'Billet CFF Lausanne', 3_600, 'approved')];
}

/** Devis émis prêt pour le lien d'acceptation (?erp=portal). */
export function installErpPortalFixture(data: Workspace) {
  const quote = data.quotes.find(row => row.number === 'D-2026-003');
  if (quote) { quote.status = 'issued'; quote.number = 'D-2026-014'; quote.title = 'Rénovation salle de bain'; }
}

/** Deux listes de prix (?erp=prices). */
export function installErpPricesFixture(data: Workspace) {
  if (!data.catalogItems.some(item => !item.archivedAt)) {
    const now = '2026-10-15T08:00:00Z';
    const base = { kind: 'service', sku: '', description: '', unit: 'h', purchaseCostCents: 0, vatBp: 810, trackStock: false, stockQuantityMilli: 0, reorderLevelMilli: 0, archivedAt: null, createdAt: now, updatedAt: now };
    data.catalogItems = [{ ...base, id: 'ci-pose', name: 'Pose de carrelage', unit: 'm²', salesPriceCents: 8_000 }, { ...base, id: 'ci-mo', name: 'Main-d’œuvre installateur', salesPriceCents: 9_500 }, { ...base, id: 'ci-depl', name: 'Déplacement', unit: 'forfait', salesPriceCents: 6_000 }] as never;
  }
  const items = data.catalogItems.filter(item => !item.archivedAt);
  const clients = data.clients.filter(client => !client.archivedAt);
  data.priceLists = [
    { id: 'pl-revendeurs', name: 'Revendeurs', discountBp: 1_000, archivedAt: null, items: items.slice(0, 2).map(item => ({ catalogItemId: item.id, unitPriceCents: Math.round(item.salesPriceCents * 0.85) })), clientIds: clients.slice(0, 2).map(client => client.id) },
    { id: 'pl-regie', name: 'Contrats de maintenance', discountBp: 500, archivedAt: null, items: [], clientIds: clients.slice(2, 3).map(client => client.id) },
  ];
}

/** Pipeline des ventes (?erp=pipeline), avec un devis émis lié. */
export function installErpPipelineFixture(data: Workspace) {
  installErpPortalFixture(data);
  const issued = data.quotes.find(row => row.status === 'issued');
  const client = data.clients[0]?.id ?? null;
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString();
  const row = (id: string, title: string, stage: 'lead' | 'contact' | 'quote' | 'won' | 'lost', amountCents: number, patch: Record<string, unknown> = {}) => ({
    id, clientId: null, prospectName: '', title, stage, amountCents, expectedCloseDate: null, quoteId: null, notes: '', lostReason: '',
    stageChangedAt: day(-5), createdAt: day(-12), updatedAt: day(-3), ...patch });
  data.opportunities = [
    row('o1', 'Rénovation de la cuisine', 'lead', 1_850_000, { prospectName: 'Famille Rochat', expectedCloseDate: day(20).slice(0, 10) }),
    row('o2', 'Salle de bain à l’étage', 'lead', 920_000, { prospectName: 'Claire Morel', updatedAt: day(-26) }),
    row('o3', 'Entretien annuel des chaudières', 'contact', 640_000, { clientId: client, notes: 'Visite prévue jeudi' }),
    row('o4', 'Agrandissement de l’atelier', 'contact', 4_200_000, { prospectName: 'Menuiserie Favre Sàrl', expectedCloseDate: day(-4).slice(0, 10) }),
    row('o5', 'Entretien annuel', 'contact', 0, { clientId: issued?.clientId ?? client, quoteId: issued?.id ?? null }),
    row('o6', 'Réfection des sanitaires', 'won', 1_250_000, { clientId: client, stageChangedAt: day(-40) }),
    row('o7', 'Terrasse en bois', 'lost', 780_000, { prospectName: 'M. Dupont', lostReason: 'Budget reporté', stageChangedAt: day(-30) }),
  ] as never;
}

/** Dépôts, lots et numéros de série (?erp=stock). */
export function installErpStockFixture(data: Workspace) {
  const now = '2026-10-15T08:00:00Z';
  const product = (id: string, name: string, unit: string, price: number) => ({ id, kind: 'product', sku: '', name, description: '', unit, salesPriceCents: price, purchaseCostCents: Math.round(price * 0.6), vatBp: 810,
    trackStock: true, stockQuantityMilli: 0, reorderLevelMilli: 0, archivedAt: null, createdAt: now, updatedAt: now });
  data.catalogItems = [product('kit', 'Kit radiateur prêt à poser', 'pce', 39_000), product('valve', 'Robinet thermostatique', 'pce', 18_000), product('glue', 'Colle carrelage flex', 'sac', 3_450), product('pipe', 'Tube multicouche 16 mm', 'm', 420), ...data.catalogItems] as never;
  (data.catalogItems[0] as { reorderLevelMilli: number }).reorderLevelMilli = 2_000;
  for (const [id, milli] of [['valve', 4_000], ['glue', 16_000], ['pipe', 150_000], ['kit', 1_000]] as const) (data.catalogItems.find(item => item.id === id) as { stockQuantityMilli: number }).stockQuantityMilli = milli;
  data.billsOfMaterials = [{ id: 'bom-kit', catalogItemId: 'kit', outputQuantityMilli: 1_000, notes: 'Contrôler l’étanchéité avant emballage.', lines: [{ componentItemId: 'valve', quantityMilli: 1_000 }, { componentItemId: 'pipe', quantityMilli: 6_000 }] }];
  data.productionOrders = [{ id: 'po-1', catalogItemId: 'kit', quantityMilli: 2_000, productionDate: '2026-10-07', reference: 'OF-2026-004', components: [{ catalogItemId: 'valve', name: 'Robinet thermostatique', quantityMilli: 2_000, tracked: true }, { catalogItemId: 'pipe', name: 'Tube multicouche 16 mm', quantityMilli: 12_000, tracked: true }] }];
  const movement = (id: string, item: string, delta: number, date: string, reason: string, sequence: number) => ({ sequence, id, sourceKey: id, requestId: null, catalogItemId: item, movementType: delta > 0 ? 'entry' : 'exit',
    quantityDeltaMilli: delta, balanceAfterMilli: 0, reason, reference: null, movementDate: date, sourceType: 'manual', invoiceId: null, invoiceItemId: null, createdAt: now });
  data.stockMovements = [movement('m1', 'valve', 6_000, '2026-10-01', 'Réception REC-2026-0012', 1), movement('m2', 'glue', 20_000, '2026-10-02', 'Réception REC-2026-0013', 2),
    movement('m3', 'pipe', 150_000, '2026-10-02', 'Réception REC-2026-0013', 3), movement('m4', 'valve', -2_000, '2026-10-08', 'Livraison BL-2026-0031', 4), movement('m5', 'glue', -4_000, '2026-10-09', 'Chantier Morel', 5)] as never;
  data.stockLocations = {
    warehouses: [{ id: 'w-main', code: 'ATELIER', name: 'Atelier Bulle', isDefault: true, archivedAt: null }, { id: 'w-van', code: 'VAN-1', name: 'Camionnette', isDefault: false, archivedAt: null }, { id: 'w-site', code: 'MOREL', name: 'Chantier Morel', isDefault: false, archivedAt: null }],
    movementWarehouses: { m5: 'w-site' },
    transfers: [{ id: 't1', catalogItemId: 'pipe', fromWarehouseId: 'w-main', toWarehouseId: 'w-van', quantityMilli: 40_000, transferDate: '2026-10-05', note: '' }, { id: 't2', catalogItemId: 'glue', fromWarehouseId: 'w-main', toWarehouseId: 'w-site', quantityMilli: 8_000, transferDate: '2026-10-06', note: 'Chantier Morel' }],
    tracking: [{ catalogItemId: 'valve', mode: 'serial' }, { catalogItemId: 'glue', mode: 'lot' }],
    lots: [{ id: 'l1', catalogItemId: 'glue', mode: 'lot', code: 'L-2610-A', expiryDate: '2026-11-08', warehouseId: null, createdAt: now }, { id: 'l2', catalogItemId: 'glue', mode: 'lot', code: 'L-2702-C', expiryDate: '2027-02-28', warehouseId: null, createdAt: now },
      ...['TV-88231', 'TV-88232', 'TV-88233', 'TV-88234', 'TV-88235', 'TV-88236'].map((code, index) => ({ id: 's' + index, catalogItemId: 'valve', mode: 'serial' as const, code, expiryDate: null, warehouseId: null, createdAt: now }))],
    lotMovements: [{ id: 'a', lotId: 'l1', quantityMilli: 12_000, movementDate: '2026-10-02', sourceType: 'receipt', sourceId: null, reference: 'REC-2026-0013' }, { id: 'b', lotId: 'l2', quantityMilli: 8_000, movementDate: '2026-10-02', sourceType: 'receipt', sourceId: null, reference: 'REC-2026-0013' },
      { id: 'c', lotId: 'l1', quantityMilli: -4_000, movementDate: '2026-10-09', sourceType: 'exit', sourceId: null, reference: 'Chantier Morel' },
      ...[0, 1, 2, 3, 4, 5].map(index => ({ id: 'r' + index, lotId: 's' + index, quantityMilli: 1_000, movementDate: '2026-10-01', sourceType: 'receipt' as const, sourceId: null, reference: 'REC-2026-0012' }))],
  } as never;
}
