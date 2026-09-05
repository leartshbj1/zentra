// Synthetic data and RPCs used only by the browser acceptance harness.
import { desktopApi } from '../src/bridge';
import type { VatProfile, VatReturnPreview, Workspace } from '../src/types';
import { seedReceivedCreditPreview } from './vat-received-credit-fixture';

export function installFinanceFixture(workspace: Workspace) {
  workspace.settings.organization.vatRegistered = true;
  workspace.settings.work.costCategories = ['Marchandises'];
  workspace.settings.billing.vatRatesBp = [810, 260, 380];
  const profile: VatProfile = { id: 'vat-qa', effectiveFrom: '2026-01-01', effectiveTo: null, reportingMethod: 'effective', formOfReporting: 'agreed', periodicity: 'quarterly', grossOrNet: 'net', tdfnActivityId: null, tdfnRateBp: null, afcAuthorizationConfirmed: true, notes: '', createdAt: '', updatedAt: '' };
  const preview: VatReturnPreview = {
    standard: 'eCH-0217', standardVersion: '2.0.0', currency: 'CHF', profile,
    dateFrom: '2026-01-01', dateTo: '2026-03-31', submissionType: 'initial', exportable: true,
    blockingIssues: [], warnings: [], unclassifiedSources: [], sourceSha256: 'synthetic-qa',
    classifiedSources: [
      { sourceType: 'supplier_invoice_item', sourceId: 'purchase-one', parentId: 'purchase-qa', occurrenceDate: '2026-02-10', description: 'Vis et fixations', amountCents: 10000, vatCents: 810, vatRateBp: 810, treatment: 'input_materials', currency: 'CHF' },
      { sourceType: 'expense', sourceId: 'purchase-two', parentId: 'purchase-two', occurrenceDate: '2026-01-15', description: 'Fournitures d’atelier', amountCents: 40000, vatCents: 3240, vatRateBp: 810, treatment: 'input_materials', currency: 'CHF' },
    ],
    turnoverComputation: { totalConsiderationCents: 100000, suppliesToForeignCountriesCents: 0, suppliesAbroadCents: 0, transferNotificationProcedureCents: 0, suppliesExemptFromTaxCents: 0, reductionOfConsiderationCents: 0, variousDeduction: null, taxableTurnoverCents: 100000 },
    effectiveReportingMethod: { grossOrNet: 'net', grossOrNetCode: 1, optedCents: 0, suppliesPerTaxRate: [{ taxRateBp: 810, turnoverCents: 100000, calculatedTaxCents: 8100 }], acquisitionTax: [], inputTaxMaterialAndServicesCents: 4050, inputTaxInvestmentsCents: 0, subsequentInputTaxDeductionCents: 0, inputTaxCorrectionsCents: 0, inputTaxReductionsCents: 0, outputTaxCents: 8100, acquisitionTaxCents: 0 },
    simpleTaxRateMethod: null, payableTaxCents: 4050, payableCode: '500', otherFlowsOfFunds: { subsidiesCents: 0, donationsCents: 0 }, sourceCount: 2, adjustmentCount: 0, transmissionWording: 'Exemple de recette, aucune donnée réelle.',
  };
  desktopApi.listVatProfiles = async () => [profile];
  if (new URLSearchParams(location.search).has('transitionVat')) {
    preview.exportable = false;
    preview.blockingIssues = [{ code: 'vat_reporting_transition_open_balance', sourceType: 'invoice_item', sourceId: 'transition-invoice', message: 'Au 2026-01-01, facture client F-2025-DECEMBRE-REFERENCE-DOCUMENTAIRE-TRES-LONGUE-001 : solde avant changement : 58.10 CHF. La reprise TVA prévue à l’art. 106 OTVA doit être documentée avant l’export; elle n’est pas encore automatisée.' }];
    desktopApi.createVatProfile = async () => { throw new Error('Changement de mode TVA non enregistré : une reprise des soldes ouverts est nécessaire et n’est pas encore automatisée. Les profils précédents sont conservés. Facture F-2025-001 : 58.10 CHF.'); };
  }
  if (new URLSearchParams(location.search).has('receivedVat')) {
    profile.formOfReporting = 'received';
    preview.receivedAllocations = Array.from({ length: 32 }, (_, index) => ({
      sourceType: index % 2 ? 'supplier_invoice_item' as const : 'invoice_item' as const,
      sourceId: `received-line-${index}`, parentId: `received-invoice-${index}`, paymentId: `payment-${String(index).padStart(2, '0')}`,
      description: `${index % 2 ? 'ACH' : 'F'}-2026-${String(index).padStart(3, '0')} · ${index % 2 ? 'Matériaux pour la rénovation du séjour et de la salle de bains' : 'Étude et suivi du projet'}`,
      date: `2026-03-${String(Math.floor(index / 2) + 1).padStart(2, '0')}`, currency: 'CHF', grossCents: 5000, netCents: 4625, vatCents: 375,
    }));
    preview.classifiedSources = preview.receivedAllocations.filter((row) => row.sourceType === 'supplier_invoice_item').map((row) => ({ ...row, occurrenceDate: row.date, amountCents: row.netCents, vatRateBp: 810, treatment: 'input_materials' }));
    preview.preClosingSources = [{ sourceType: 'supplier_invoice_item', sourceId: 'unpaid-materials', parentId: 'unpaid-purchase', occurrenceDate: '2026-03-15', description: 'MAT-IMPAYÉE · Matériaux pour le prochain projet', amountCents: 50000, vatCents: 4050, vatRateBp: 810, currency: 'CHF' }];
    preview.turnoverComputation.totalConsiderationCents = 74000;
    preview.turnoverComputation.taxableTurnoverCents = 74000;
    preview.effectiveReportingMethod!.suppliesPerTaxRate = [{ taxRateBp: 810, turnoverCents: 74000, calculatedTaxCents: 5994 }];
    preview.effectiveReportingMethod!.outputTaxCents = 5994;
    preview.effectiveReportingMethod!.inputTaxMaterialAndServicesCents = 6000;
    preview.payableTaxCents = -6;
    preview.payableCode = '510';
    preview.sourceCount = 32;
  }
  if (new URLSearchParams(location.search).has('creditVat')) {
    preview.unclassifiedSources = [{ sourceType: 'supplier_credit_note_item', sourceId: 'credit-line', parentId: 'credit-qa', occurrenceDate: '2026-03-10', description: 'Avoir fournisseur · Retour de vis', amountCents: -5000, vatCents: -405, vatRateBp: 810 }];
    preview.exportable = false;
    preview.sourceCount += 1;
  }
  if (new URLSearchParams(location.search).has('receivedCredits')) seedReceivedCreditPreview(preview);
  desktopApi.listVatAdjustments = async () => [];
  desktopApi.listVatReturnExports = async () => [];
  desktopApi.previewVatReturn = async (input) => ({ ...structuredClone(preview), ...input });
  const originalBalance = desktopApi.getBalanceSheet;
  desktopApi.getBalanceSheet = async (input) => {
    sessionStorage.setItem('qa-balance-refresh', String(Number(sessionStorage.getItem('qa-balance-refresh') || 0) + 1));
    return originalBalance(input);
  };
  desktopApi.exportAnnualAccountsPdf = async () => ({ path: 'bilan-recette.pdf', pages: 3, closed: false, balanced: true, sha256: 'synthetic-qa' });
  workspace.suppliers = [{ id: 'supplier-qa', name: 'Fournitures du Léman', email: '', phone: '', address: '', notes: '', archivedAt: null }] as Workspace['suppliers'];
  const line = { id: 'line-qa', description: 'Prestation', quantity: 1, unit: 'forfait', unitPriceCents: 100000, discountBp: 0, vatRateBp: 810 };
  const dates = ['2026-01-05', '2026-09-05', '2026-06-05'];
  workspace.quotes = dates.map((date, i) => ({ id: `quote-${i}`, number: `D-2026-00${i + 1}`, clientId: 'client-qa', projectId: null, title: `Devis ${date}`, issueDate: date, validUntil: '2026-12-31', currency: 'CHF', status: 'draft', lines: [line], notes: '', terms: '', createdAt: `${date}T10:00:00Z` })) as Workspace['quotes'];
  workspace.invoices = workspace.quotes.map((quote, i) => ({ ...quote, id: `invoice-${i}`, number: `F-2026-00${i + 1}`, title: `Facture ${quote.issueDate}`, quoteId: null, originalInvoiceId: null, type: 'standard', dueDate: '2026-12-31', serviceDateFrom: quote.issueDate, serviceDateTo: quote.issueDate, depositPercentageBp: null, depositBasisLines: null, qrBill: { input: { reference: `RF18539007547034${i}` } } })) as Workspace['invoices'];
  desktopApi.saveSupplierInvoiceDraft = async (input) => {
    const saved = structuredClone(workspace);
    saved.supplierInvoices = [{ ...input, id: input.id, documentDate: input.date, documentStatus: 'draft', paymentStatus: null, supplierName: 'Fournitures du Léman', currency: 'CHF', netCents: 50000, vatCents: 4050, totalCents: 54050, paidCents: 0, creditedCents: 0, balanceCents: 54050, matchStatus: 'unmatched', validatedAt: null, validationJournalEntryId: null, attachments: [], payments: [], createdAt: '', updatedAt: '', lines: input.items.map((item) => ({ ...item, supplierInvoiceId: input.id })) }] as Workspace['supplierInvoices'];
    return saved;
  };
  desktopApi.saveSupplierCreditNoteDraft = async (input) => {
    const attempts = JSON.parse(sessionStorage.getItem('qa-credit-attempts') || '[]');
    attempts.push(input);
    sessionStorage.setItem('qa-credit-attempts', JSON.stringify(attempts));
    if (attempts.length === 1 && new URLSearchParams(location.search).has('creditRetry')) throw new Error('Brouillon enregistré, mais actualisation interrompue. Réessayez.');
    const saved = structuredClone(workspace);
    saved.supplierCreditNotes = [{ ...input, id: input.id, number: '', status: 'draft', supplierName: 'Fournitures du Léman', currency: 'CHF', netCents: 5000, vatCents: 405, totalCents: 5405, allocatedCents: 0, availableCents: 5405, validationJournalEntryId: null, validatedAt: null, createdAt: '', updatedAt: '', items: input.items.map((item) => ({ ...item, supplierCreditNoteId: input.id, lineNetCents: 5000, lineVatCents: 405, lineTotalCents: 5405 })) }] as Workspace['supplierCreditNotes'];
    return saved;
  };
  desktopApi.setVatSourceClassification = async (input) => {
    if (sessionStorage.getItem('qa-reject-classification') === '1') throw new Error('Le compte de TVA est inactif. Aucune modification enregistrée.');
    sessionStorage.setItem('qa-vat-classification', JSON.stringify(input));
    if (preview.preClosingSources?.some((item) => item.sourceId === input.sourceId && item.sourceType === input.sourceType)) {
      preview.preClosingSources = preview.preClosingSources.filter((item) => item.sourceId !== input.sourceId || item.sourceType !== input.sourceType);
      return { id: 'qa-pre-close', ...input, note: input.note || '', createdAt: '', updatedAt: '' };
    }
    const unclassified = preview.unclassifiedSources.find((item) => item.sourceId === input.sourceId && item.sourceType === input.sourceType);
    if (unclassified) {
      preview.classifiedSources!.push({ ...unclassified, treatment: input.treatment, currency: 'CHF' });
      preview.unclassifiedSources = preview.unclassifiedSources.filter((item) => item !== unclassified);
      preview.exportable = !preview.unclassifiedSources.length;
    }
    const source = preview.classifiedSources?.find((item) => item.sourceId === input.sourceId && item.sourceType === input.sourceType);
    if (source && preview.effectiveReportingMethod) {
      source.treatment = input.treatment;
      const amounts = (treatment: string) => preview.classifiedSources!.filter((item) => item.treatment === treatment).reduce((sum, item) => sum + item.vatCents, 0);
      preview.effectiveReportingMethod.inputTaxMaterialAndServicesCents = amounts('input_materials');
      preview.effectiveReportingMethod.inputTaxInvestmentsCents = amounts('input_investments');
      preview.payableTaxCents = 8100 - amounts('input_materials') - amounts('input_investments');
    }
    return { ...input, id: 'classification-qa', createdAt: '', updatedAt: '' };
  };
}
