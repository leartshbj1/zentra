// Synthetic data and RPCs used only by the browser acceptance harness.
import { desktopApi } from '../src/bridge';
import type { VatProfile, VatReturnPreview, Workspace } from '../src/types';

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
  desktopApi.setVatSourceClassification = async (input) => {
    if (sessionStorage.getItem('qa-reject-classification') === '1') throw new Error('Le compte de TVA est inactif. Aucune modification enregistrée.');
    sessionStorage.setItem('qa-vat-classification', JSON.stringify(input));
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
