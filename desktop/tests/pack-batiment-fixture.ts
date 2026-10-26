import type { Workspace } from '../src/types';

// Chantier de peinture fictif (?pack=1), réservé au banc d'essai de l'interface
// et aux captures : aucune donnée réelle, jamais inclus dans une release.
export function installPackBatimentFixture(data: Workspace) {
  const now = '2026-10-20T08:00:00Z';
  data.settings!.organization.legalName = 'Peinture Léman Sàrl';
  data.settings!.organization.vatRegistered = true;
  data.settings!.billing.vatRatesBp = [810, 260, 0];
  data.clients = [
    { id: 'client-dupont', name: 'Famille Dupont', company: 'Famille Dupont', email: 'dupont@example.invalid', phone: '022 000 00 00', address: 'Chemin des Vignes 14\n1253 Vandœuvres', notes: '', archivedAt: null },
    { id: 'client-regie', name: 'Régie du Lac', company: 'Régie du Lac SA', email: 'regie@example.invalid', phone: '021 000 00 00', address: 'Quai du Mont-Blanc 2\n1201 Genève', notes: '', archivedAt: null },
  ] as never;
  data.projects = [
    { id: 'site-dupont', clientId: 'client-dupont', name: 'Villa Dupont', address: 'Chemin des Vignes 14, 1253 Vandœuvres', status: 'in_progress', plannedStart: '2026-09-15', plannedEnd: '2026-11-30', actualStart: '2026-09-21', actualEnd: '', budgetCents: 0, plannedMinutes: 0, notes: '', archivedAt: null },
    { id: 'site-lac', clientId: 'client-regie', name: 'Cage d’escalier Quai 2', address: 'Quai du Mont-Blanc 2, 1201 Genève', status: 'planned', plannedStart: '', plannedEnd: '', actualStart: '', actualEnd: '', budgetCents: 0, plannedMinutes: 0, notes: '', archivedAt: null },
  ] as never;
  const item = (id: string, kind: 'product' | 'service', name: string, unit: string, sale: number, cost: number, sku = '') => ({ id, kind, sku, name, description: '', unit, salesPriceCents: sale, purchaseCostCents: cost, vatBp: 810, trackStock: false, stockQuantityMilli: 0, reorderLevelMilli: 0, archivedAt: null, createdAt: now, updatedAt: now });
  data.catalogItems = [
    item('paint', 'product', 'Peinture dispersion blanche 10 l', 'pièce', 8_990, 5_400, 'PE-10'),
    item('tape', 'product', 'Ruban de masquage', 'pièce', 650, 310, 'RU-50'),
    item('kit-door', 'service', 'Peinture d’une porte, 2 faces', 'pièce', 18_350, 9_210),
    item('labour', 'service', 'Main-d’œuvre peintre', 'h', 9_200, 0),
  ] as never;
  data.serviceKits = [{ catalogItemId: 'kit-door', notes: '', lines: [
    { kind: 'material', componentItemId: 'paint', description: 'Peinture dispersion blanche 10 l', quantityMilli: 250, unitPriceCents: 8_990, unitCostCents: 5_400 },
    { kind: 'material', componentItemId: 'tape', description: 'Ruban de masquage', quantityMilli: 1_000, unitPriceCents: 650, unitCostCents: 310 },
    { kind: 'labor', componentItemId: null, description: 'Peintre qualifié', quantityMilli: 1_500, unitPriceCents: 9_200, unitCostCents: 6_000 },
  ] }];
  const line = (id: string, sectionTitle: string, description: string, quantity: number, unit: string, price: number, extra: Record<string, unknown> = {}) => ({ id, sectionTitle, description, quantity, unit, unitPriceCents: price, discountBp: 0, vatRateBp: 810, catalogItemId: null, ...extra });
  const walls = [{ label: 'Mur nord', formula: '4,20 × 2,60' }, { label: 'Mur sud', formula: '4,20 × 2,60' }, { label: 'Mur est', formula: '3,80 × 2,60' }, { label: 'Porte-fenêtre', formula: '1,80 × 2,20', deduct: true }];
  const quoteLines = [
    line('q-l1', 'Séjour', 'Peinture murs, dispersion, 2 couches', 26.24, 'm²', 2_800, { measurements: walls }),
    line('q-l2', 'Séjour', 'Plafond, 2 couches', 16.2, 'm²', 3_100, { measurements: [{ label: 'Plafond', formula: '4,20 × 3,80 + 0,24' }] }),
    line('q-l3', 'Séjour', 'Peinture d’une porte, 2 faces', 2, 'pièce', 18_350, { catalogItemId: 'kit-door' }),
    line('q-l4', 'Cuisine', 'Préparation et rebouchage', 6, 'h', 9_200),
    line('q-l5', 'Cuisine', 'Peinture lavable, 2 couches', 22.5, 'm²', 3_400),
    line('q-l6', 'Façade', 'Façade, peinture minérale, 2 couches', 182, 'm²', 3_800, { measurements: [{ label: 'Façade sud', formula: '12,40 × 6,20' }, { label: 'Façade nord', formula: '12,40 × 6,20' }, { label: 'Pignons', formula: '2 × 8,20 × 3,10' }, { label: 'Fenêtres', formula: '14 × 1,20 × 1,40', deduct: true }] }),
  ];
  data.quotes = [
    { id: 'quote-dupont', number: 'D-2026-0031', clientId: 'client-dupont', projectId: 'site-dupont', title: 'Rafraîchissement séjour et cuisine', issueDate: '2026-09-10', validUntil: '2026-10-10', currency: 'CHF', status: 'accepted', lines: quoteLines, notes: '', terms: '', showMeasurements: true, createdAt: now, snapshot: null },
    { id: 'quote-lac', number: '', clientId: 'client-regie', projectId: 'site-lac', title: 'Cage d’escalier, 4 étages', issueDate: '2026-10-22', validUntil: '2026-11-21', currency: 'CHF', status: 'draft', lines: [
      line('l-l1', '314 Peinture', '314.211 Dispersion intérieure, 2 couches', 225.8, 'm²', 1_850, { measurements: [{ label: 'Murs, 4 étages', formula: '4 × (2 × 6,50 + 2 × 3,20) × 3,10' }, { label: 'Portes palières', formula: '8 × 0,90 × 2,05', deduct: true }] }),
      line('l-l2', '314 Peinture', '314.411 Main courante, laque', 46, 'm', 2_400),
      line('l-l3', '211 Préparation', '211.111 Protection et nettoyage', 1, 'forfait', 85_000),
    ], notes: '', terms: '', createdAt: now, snapshot: null },
  ] as never;
  const invoiceBase = { clientId: 'client-dupont', projectId: 'site-dupont', quoteId: 'quote-dupont', originalInvoiceId: null, currency: 'CHF', notes: '', terms: '', depositPercentageBp: null, depositBasisLines: null, createdAt: now, issueDate: '2026-10-05', dueDate: '2026-11-04', serviceDateFrom: '2026-10-05', serviceDateTo: '2026-10-05' };
  data.invoices = [
    { ...invoiceBase, id: 'inv-sit-1', number: 'F-2026-0112', title: 'Situation n° 1 — Rafraîchissement séjour et cuisine', type: 'progress', status: 'issued', lines: [
      { id: 's1-a', description: 'Peinture murs, dispersion, 2 couches — cumul 100 %', quantity: 1, unit: 'situation', unitPriceCents: 73_472, vatRateBp: 810 },
      { id: 's1-b', description: 'Plafond, 2 couches — cumul 50 %', quantity: 1, unit: 'situation', unitPriceCents: 25_110, vatRateBp: 810 },
      { id: 's1-r', description: 'Retenue de garantie 10 % sur les travaux exécutés', quantity: 1, unit: 'forfait', unitPriceCents: -9_858, vatRateBp: 810 },
    ] },
    { ...invoiceBase, id: 'inv-sit-2', number: 'F-2026-0127', title: 'Situation n° 2 — Rafraîchissement séjour et cuisine', type: 'progress', status: 'issued', issueDate: '2026-10-19', lines: [
      { id: 's2-a', description: 'Façade, peinture minérale, 2 couches — cumul 80 %', quantity: 1, unit: 'situation', unitPriceCents: 553_280, vatRateBp: 810 },
      { id: 's2-r', description: 'Retenue de garantie 10 % sur les travaux exécutés', quantity: 1, unit: 'forfait', unitPriceCents: -55_328, vatRateBp: 810 },
    ] },
  ] as never;
  data.progressPlans = [{ quoteId: 'quote-dupont', retentionBp: 1_000, roundToFive: true }];
  data.progressBills = [{ id: 'bill-2', quoteId: 'quote-dupont', invoiceId: 'inv-sit-2', sequence: 2, kind: 'situation', progressDate: '2026-10-19', retentionBp: 1_000, cumulativeNetCents: 651_862, cumulativeRetentionCents: 65_186, retentionByRate: { 810: 65_186 }, previousNetCents: 88_724, netCents: 497_952, roundingCents: 0, lines: [
    { quoteItemId: 'q-l1', mode: 'percent', cumulativePercentBp: 10_000, cumulativeQuantity: 26.24, cumulativeNetCents: 73_472 },
    { quoteItemId: 'q-l2', mode: 'percent', cumulativePercentBp: 5_000, cumulativeQuantity: 8.1, cumulativeNetCents: 25_110 },
    { quoteItemId: 'q-l6', mode: 'percent', cumulativePercentBp: 8_000, cumulativeQuantity: 145.6, cumulativeNetCents: 553_280 },
  ] }, { id: 'bill-1', quoteId: 'quote-dupont', invoiceId: 'inv-sit-1', sequence: 1, kind: 'situation', progressDate: '2026-10-05', retentionBp: 1_000, cumulativeNetCents: 98_582, cumulativeRetentionCents: 9_858, retentionByRate: { 810: 9_858 }, previousNetCents: 0, netCents: 88_724, roundingCents: 0, lines: [
    { quoteItemId: 'q-l1', mode: 'percent', cumulativePercentBp: 10_000, cumulativeQuantity: 26.24, cumulativeNetCents: 73_472 },
    { quoteItemId: 'q-l2', mode: 'percent', cumulativePercentBp: 5_000, cumulativeQuantity: 8.1, cumulativeNetCents: 25_110 },
  ] }];
  data.laborRateTables = [{ id: 'rates-2026', name: 'Tarifs de régie 2026', source: 'Association cantonale (fichier fictif)', validFrom: '2026-01-01', isDefault: true, archivedAt: null, rates: [
    { id: 'r-ce', kind: 'personnel', code: 'CE', label: 'Chef d’équipe', unit: 'h', rateCents: 9_850, costCents: 7_200 },
    { id: 'r-oq', kind: 'personnel', code: 'OQ', label: 'Ouvrier qualifié', unit: 'h', rateCents: 8_900, costCents: 6_500 },
    { id: 'r-ai', kind: 'personnel', code: 'AI', label: 'Aide', unit: 'h', rateCents: 7_200, costCents: 5_200 },
    { id: 'r-ap', kind: 'personnel', code: 'AP', label: 'Apprenti', unit: 'h', rateCents: 4_200, costCents: null },
    { id: 'r-na', kind: 'machine', code: 'NA', label: 'Nacelle ciseaux 8 m', unit: 'jour', rateCents: 24_000, costCents: 15_000 },
  ] }];
  data.workReports = [{ id: 'wr-1', clientId: 'client-dupont', projectId: 'site-dupont', reportDate: '2026-10-14', site: 'Chemin des Vignes 14', description: 'Reprise des fissures du couloir', technician: 'Marc', status: 'signed', signerName: 'C. Dupont', signaturePath: 'M10 60 L40 20 L70 70 L100 30 L130 60', signedAt: now, invoiceId: null, lines: [
    { id: 'wr-1a', kind: 'labor', catalogItemId: null, description: 'Chef d’équipe', quantity: 3, unit: 'h', unitPriceCents: 9_850, vatBp: 810, laborRateId: 'r-ce' },
    { id: 'wr-1b', kind: 'labor', catalogItemId: null, description: 'Apprenti', quantity: 3, unit: 'h', unitPriceCents: 4_200, vatBp: 810, laborRateId: 'r-ap' },
    { id: 'wr-1c', kind: 'material', catalogItemId: 'paint', description: 'Peinture dispersion blanche 10 l', quantity: 1, unit: 'pièce', unitPriceCents: 8_990, vatBp: 810 },
  ] }] as never;
  data.employees = [{ id: 'emp-marc', name: 'Marc Favre', hourlyCostCents: 6_500 }] as never;
  data.timeEntries = [
    { id: 'te-1', projectId: 'site-dupont', taskId: null, employeeId: 'emp-marc', date: '2026-10-01', minutes: 960, hourlyCostCents: 6_500, note: '', status: 'approved', billingStatus: 'unbilled', billingBatchId: null, billingInvoiceId: null, billingInvoiceNumber: null, createdAt: now },
    { id: 'te-2', projectId: 'site-dupont', taskId: null, employeeId: 'emp-marc', date: '2026-10-08', minutes: 1_440, hourlyCostCents: 6_500, note: '', status: 'approved', billingStatus: 'unbilled', billingBatchId: null, billingInvoiceId: null, billingInvoiceNumber: null, createdAt: now },
  ] as never;
  data.suppliers = [{ id: 'sup-couleurs', name: 'Couleurs Romandes SA', archivedAt: null }, { id: 'sup-echaf', name: 'Échafaudages Léman SA', archivedAt: null }] as never;
  const supplierLine = (id: string, description: string, net: number, category: string) => ({ id, supplierInvoiceId: '', position: 0, description, quantityMilli: 1_000, unit: 'forfait', unitPriceCents: net, discountBp: 0, vatBp: 810, netCents: net, vatCents: Math.round(net * 0.081), totalCents: net + Math.round(net * 0.081), category, expenseAccountId: null, projectId: null });
  const supplierBase = { currency: 'CHF', paymentStatus: 'pending', paidCents: 0, creditedCents: 0, matchStatus: 'unmatched', validatedAt: now, validationJournalEntryId: null, payments: [], attachments: [], createdAt: now, updatedAt: now, documentDate: '2026-10-12', dueDate: '2026-11-11' };
  data.supplierInvoices = [
    { ...supplierBase, id: 'si-paint', supplierId: 'sup-couleurs', projectId: 'site-dupont', supplierName: 'Couleurs Romandes SA', reference: 'CR-88412', documentStatus: 'validated', netCents: 41_800, vatCents: 3_386, totalCents: 45_186, balanceCents: 45_186, note: '', lines: [supplierLine('si-paint-l', 'Peintures et fournitures', 41_800, 'Matériel')] },
    { ...supplierBase, id: 'si-echaf', supplierId: 'sup-echaf', projectId: 'site-dupont', supplierName: 'Échafaudages Léman SA', reference: 'EL-2026-301', documentStatus: 'validated', netCents: 120_000, vatCents: 9_720, totalCents: 129_720, balanceCents: 129_720, note: '', lines: [supplierLine('si-echaf-l', 'Échafaudage façade, montage et location', 120_000, 'Sous-traitance')] },
    { ...supplierBase, id: 'si-new', supplierId: 'sup-couleurs', projectId: null, supplierName: 'Couleurs Romandes SA', reference: 'CR-88590', documentStatus: 'draft', validatedAt: null, netCents: 12_600, vatCents: 1_021, totalCents: 13_621, balanceCents: 13_621, note: 'Livraison : chemin des Vignes 14, Vandœuvres', lines: [supplierLine('si-new-l', 'Laque satinée 2,5 l', 12_600, 'Matériel')] },
  ] as never;
  data.supplierOrders = [] as never;
  data.projectBudgetLines = [
    { id: 'b-1', projectId: 'site-dupont', category: 'labor', label: 'Peintres', amountCents: 390_000, minutes: 3_600 },
    { id: 'b-2', projectId: 'site-dupont', category: 'material', label: 'Peintures et fournitures', amountCents: 62_000, minutes: null },
    { id: 'b-3', projectId: 'site-dupont', category: 'subcontract', label: 'Échafaudage façade', amountCents: 150_000, minutes: null },
  ];
  data.projectSubcontracts = [{ id: 'sc-echaf', projectId: 'site-dupont', supplierId: 'sup-echaf', label: 'Échafaudage façade', agreedCents: 150_000, closed: false }];
  data.subcontractLinks = [{ supplierInvoiceId: 'si-echaf', subcontractId: 'sc-echaf' }];
}
