// Development-only UI fixture. This entry is excluded from the production Vite build.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceApp } from '../src/WorkspaceApp';
import { desktopApi } from '../src/bridge';
import { initialOnboardingSettings } from '../src/onboardingDraft';
import { useMobileLayout } from '../src/useMobileLayout';
import type { Project, Workspace } from '../src/types';
import '../src/styles.css';
import '../src/mobile.css';

const collectionNames = ['clients','catalogItems','stockMovements','suppliers','projects','projectMilestones','projectTasks','agendaEvents','quotes','salesOrders','recurrenceSchedules','recurrenceOccurrences','deliveryNotes','stockReservationEvents','stockAvailability','salesOrderInvoiceBatches','salesOrderInvoiceAllocations','invoices','invoiceCorrectionWorkflows','payments','employees','timeEntries','timeBillingBatches','timeBillingEntries','expenses','supplierOrders','supplierOrderCancellationLines','supplierReceipts','supplierInvoices','supplierInvoicePayments','supplierInvoiceMatches','supplierCreditNotes','supplierExpenseReclassifications','payslips','payrollImports','employeePayrollTemplates','accounts','attachments'];
let data = {
  ...Object.fromEntries(collectionNames.map((name) => [name, []])), schemaVersion: 41,
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
desktopApi.getReminderSettings = async () => ({ enabled: false }) as never;
desktopApi.getSecureUpdatePolicy = async () => ({ enabled: false, reason: 'Recette locale' }) as never;
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
function Harness() {
  useMobileLayout();
  const [workspace, setWorkspace] = useState<Workspace | null>(data);
  return <WorkspaceApp workspace={workspace!} setWorkspace={(next) => { setWorkspace(next); if (next && typeof next !== 'function') data = next; }} />;
}
createRoot(document.getElementById('root')!).render(<Harness />);
