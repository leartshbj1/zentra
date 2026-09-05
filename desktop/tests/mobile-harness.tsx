// Development-only UI fixture. This entry is excluded from the production Vite build.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceApp } from '../src/WorkspaceApp';
import { desktopApi } from '../src/bridge';
import { initialOnboardingSettings } from '../src/onboardingDraft';
import { useMobileLayout } from '../src/useMobileLayout';
import type { Project, Workspace } from '../src/types';
import { installFinanceFixture } from './finance-fixture';
import { installBankFixture } from './bank-fixture';
import '../src/styles.css';
import '../src/workspace-design.css';
import '../src/mobile.css';

const collectionNames = ['clients','catalogItems','stockMovements','suppliers','projects','projectMilestones','projectTasks','agendaEvents','quotes','salesOrders','recurrenceSchedules','recurrenceOccurrences','deliveryNotes','stockReservationEvents','stockAvailability','salesOrderInvoiceBatches','salesOrderInvoiceAllocations','invoices','invoiceCorrectionWorkflows','payments','employees','timeEntries','timeBillingBatches','timeBillingEntries','expenses','supplierOrders','supplierOrderCancellationLines','supplierReceipts','supplierInvoices','supplierInvoicePayments','supplierInvoiceMatches','supplierCreditNotes','supplierExpenseReclassifications','payslips','payrollImports','employeePayrollTemplates','accounts','attachments'];
let data = {
  ...Object.fromEntries(collectionNames.map((name) => [name, []])), schemaVersion: 42,
  onboardingCompleted: true, activityProfileRequired: false, activeTimer: null, accountingSettings: null,
  backupStatus: { lastSuccessAt: null, lastPath: null, nextScheduledAt: null },
  settings: {
    ...structuredClone(initialOnboardingSettings),
    business: { nogaSection: 'M', nogaDivision: '68', activityDescription: 'Services professionnels', nogaDetailedCode: '' },
    organization: { ...initialOnboardingSettings.organization, legalName: 'Atelier de recette', legalForm: 'Sàrl', contactName: 'Compte de test', email: 'qa@example.invalid', address: { street: 'Rue de test', buildingNumber: '1', postalCode: '1000', city: 'Lausanne', canton: 'VD', country: 'CH' } },
    billing: { ...initialOnboardingSettings.billing, currency: 'CHF', iban: 'CH9300762011623852957', accountHolder: 'Atelier de recette', paymentTermsDays: 30, quoteValidityDays: 30 },
  },
  clients: [{ id: 'client-qa', name: 'Client de recette', company: 'Client de recette', email: 'client@example.invalid', phone: '021 000 00 00', address: 'Rue de test 2, Lausanne', notes: '', archivedAt: null }],
} as unknown as Workspace;
const storedFiles = new Map<string, File>();
desktopApi.loadWorkspace = async () => structuredClone(data);
desktopApi.getReminderSettings = async () => ({ enabled: false, senderName: '', lastScanAt: '' });
desktopApi.listReminderTemplates = async () => [];
desktopApi.listReminders = async () => [];
desktopApi.getBankWorkspace = async () => ({ summary: { importCount: 0, movementCount: 0, unreconciledCount: 0, unreconciledSupplierCount: 0, pendingCount: 0, bookedCreditCount: 0, bookedDebitCount: 0 }, accounts: [], imports: [], movements: [], reconciliations: [], supplierReconciliations: [] });
desktopApi.listAccounts = async () => [];
desktopApi.getAccountingSettings = async () => ({ enabled: false, arAccountId: '', revenueAccountId: '', vatPayableAccountId: '', vatDeferredPayableAccountId: '', bankAccountId: '', expenseAccountId: '', vatReceivableAccountId: '', wagesExpenseAccountId: '', wagesPayableAccountId: '', socialExpenseAccountId: '', socialPayableAccountId: '', supplierPayableAccountId: '' });
desktopApi.listAccountingPeriods = async () => [];
desktopApi.getAccountingContinuity = async () => ({ enabled: false, mappingReady: false, starterAvailable: true, journalEntryCount: 0, missingInvoices: 0, missingPayments: 0, missingExpenses: 0, missingSupplierInvoices: 0, missingSupplierPayments: 0, missingPayslips: 0, missingPayslipPayments: 0, undatedPayslipPayments: 0, payslipPaymentLinksMissing: 0, totalMissing: 0, closedHistoryRequiresOpening: 0, skippedCancelledInvoices: 0, cancelledInvoicePayments: 0, reversedSources: 0, cancelledActivePostings: 0, semanticPostingMismatches: 0, totalAnomalies: 0 });
const currency = { baseCurrency: 'CHF', currencies: ['CHF'], singleCurrency: true, exchangeRatesApplied: false };
const scope = { dateFrom: '2026-01-01', dateTo: '2026-12-31', previousDateFrom: '2025-01-01', previousDateTo: '2025-12-31', comparisonLabel: 'Exercice précédent', comparisonSource: 'same_dates_previous_year' as const, previousHasActivity: false };
desktopApi.getJournal = async () => ({ entries: [], lines: [], currency });
desktopApi.getTrialBalance = async () => ({ rows: [], currency, openingDebitBalanceCents: 0, openingCreditBalanceCents: 0, debitCents: 0, creditCents: 0, closingDebitBalanceCents: 0, closingCreditBalanceCents: 0, balanced: true });
desktopApi.getBalanceSheet = async () => ({ asOf: scope.dateTo, exerciseFrom: scope.dateFrom, scope, currency, rows: [], sections: {}, previousSections: {}, assetsCents: 0, liabilitiesCents: 0, equityCents: 0, currentResultCents: 0, unallocatedPriorResultsCents: 0, balanced: true, previousAssetsCents: 0, previousLiabilitiesCents: 0, previousEquityCents: 0, previousCurrentResultCents: 0, previousUnallocatedPriorResultsCents: 0, previousBalanced: true });
desktopApi.getIncomeStatement = async () => ({ scope, currency, rows: [], sections: {}, previousSections: {}, revenueCents: 0, expenseCents: 0, profitCents: 0, previousRevenueCents: 0, previousExpenseCents: 0, previousProfitCents: 0 });
desktopApi.getSecureUpdatePolicy = async () => ({ enabled: false, reason: 'Recette locale' }) as never;
desktopApi.getNogaCatalog = async () => ({ version: 'Recette', source: 'https://www.kubb-tool.bfs.admin.ch/fr/noga/2025', sections: [{ code: 'M', label: 'Activités immobilières', divisions: [{ code: '68', label: 'Activités immobilières' }] }] });
desktopApi.saveProject = async (input, existingId) => {
  const id = existingId || crypto.randomUUID();
  const project = { id, clientId: input.clientId, name: input.name, address: input.addressLine1, status: input.status, plannedStart: input.plannedStartDate, plannedEnd: input.plannedEndDate, actualStart: input.actualStartDate, actualEnd: input.actualEndDate, budgetCents: input.budgetCents, plannedMinutes: input.plannedMinutes, notes: input.notes } as Project;
  data.projects = [...data.projects.filter((item) => item.id !== id), project];
  return id;
};
desktopApi.addProjectDocument = async (projectId, file) => {
  const id = crypto.randomUUID(); storedFiles.set(id, file);
  data.attachments!.push({ id, projectId, entityId: projectId, entityType: 'project', originalName: file.name, sizeBytes: file.size, mimeType: file.type || 'text/plain', sha256: 'qa-only', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
};
desktopApi.deleteProjectDocument = async (id) => { data.attachments = data.attachments!.filter((file) => file.id !== id); return structuredClone(data); };
desktopApi.readProjectDocument = async (id) => btoa(await storedFiles.get(id)!.text());
desktopApi.saveDocument = async (entity, input, lines, existing) => {
  const id = existing?.id || crypto.randomUUID();
  const document = { ...input, id, lines, status: 'draft', number: '', createdAt: new Date().toISOString() };
  data[entity] = [...data[entity].filter((item) => item.id !== id), document] as never;
  return structuredClone(data);
};
if (['finance', 'browsing', 'volume'].some((name) => new URLSearchParams(location.search).has(name))) installFinanceFixture(data);
if (new URLSearchParams(location.search).has('browsing')) {
  data.clients.push({ ...data.clients[0], id: 'client-other', name: 'Autre client', company: 'Autre entreprise' });
  data.projects = [
    { id: 'project-qa', clientId: 'client-qa', name: 'Projet du client de recette', status: 'planned' },
    { id: 'project-other', clientId: 'client-other', name: 'Projet d’un autre client', status: 'planned' },
  ] as Workspace['projects'];
  data.quotes[1].currency = 'EUR';
  data.quotes[1].number = '';
  data.invoices[1].currency = 'EUR';
  data.invoices[1].projectId = 'project-qa';
  data.invoices[1].number = '';
  data.invoices[0].status = 'issued';
  data.invoices[0].dueDate = '2026-01-31';
  data.invoices[2].status = 'paid';
  data.invoices[2].currency = 'EUR';
  data.invoices[2].clientId = 'client-other';
  data.invoices[2].projectId = 'project-other';
  data.payments = [{ id: 'paid-qa', invoiceId: data.invoices[2].id, amountCents: 108100, date: '2026-07-01', method: 'bank', reference: '' }] as Workspace['payments'];
}
if (new URLSearchParams(location.search).has('volume')) {
  data.invoices = Array.from({ length: 80 }, (_, index) => ({ ...structuredClone(data.invoices[0]), id: `volume-${index}`, number: `F-2026-${String(index + 1).padStart(4, '0')}`, title: `Prestation ${index + 1}` }));
}
if (new URLSearchParams(location.search).has('bank')) installBankFixture(() => data);
function Harness() {
  useMobileLayout();
  const [workspace, setWorkspace] = useState<Workspace | null>(data);
  return <WorkspaceApp workspace={workspace!} setWorkspace={(next) => { setWorkspace(next); if (next && typeof next !== 'function') data = next; }} />;
}
createRoot(document.getElementById('root')!).render(<Harness />);
