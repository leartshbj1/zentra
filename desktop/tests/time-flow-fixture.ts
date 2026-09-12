import { desktopApi } from '../src/bridge';
import type { TimeEntry, Workspace } from '../src/types';
import { WorkspaceRefreshAfterMutationError } from '../src/workspaceMutation';

// In-memory native boundary for the browser journey. Never touches user data.
export function installTimeFlowFixture(stored: Workspace) {
  stored.employees = [{ id: 'time-worker', name: 'Noé de recette', active: true, hourlyCostCents: 4500, grossSalaryCents: 500000, salaryMode: 'monthly', role: 'Conseiller' }] as Workspace['employees'];
  const entry = (id: string, projectId = 'project-qa'): TimeEntry => ({ id, projectId, taskId: null, employeeId: 'time-worker', date: '2026-09-12', minutes: 61, breakMinutes: 30, billable: true, billingRateCents: 9550, hourlyCostCents: 4500, note: `Prestation ${id}`, status: 'approved', billingStatus: 'unbilled', billingBatchId: null, billingInvoiceId: null, billingInvoiceNumber: null, createdAt: '2026-09-12T08:00:00Z' });
  stored.timeEntries = [entry('minute-61'), entry('second-time'), entry('other-time', 'project-other')];
  stored.projectTasks = [];
  const state = {
    stored, attempts: [] as Array<{ entity: string; id?: string; data: Record<string, unknown> }>,
    invoiceAttempts: [] as Parameters<typeof desktopApi.createInvoiceFromTimeEntries>[0][],
    invoiceWrites: [] as string[], timers: [] as Record<string, unknown>[],
    rejectEntry: false, rejectInvoice: false, readFailures: 0, invoiceReadFailure: false,
    holdEntry: false, holdTimer: false, release: () => {},
  };
  Object.assign(window, { timeFlow: state });
  desktopApi.loadWorkspace = async () => {
    if (state.readFailures > 0) { state.readFailures--; throw new Error('Lecture de recette interrompue.'); }
    return structuredClone(stored);
  };
  const save = async (entity: string, data: Record<string, unknown>, id?: string) => {
    if (entity !== 'timeEntries') throw new Error('Only time entries may be changed in this fixture');
    state.attempts.push({ entity, id, data: structuredClone(data) });
    if (state.holdEntry) await new Promise<void>(resolve => { state.release = () => { state.holdEntry = false; resolve(); }; });
    if (state.rejectEntry) { state.rejectEntry = false; throw new Error('Cette saisie est momentanément indisponible. Vos informations sont conservées.'); }
    const row = { ...entry(id || `added-time-${state.attempts.length}`), ...data, hourlyCostCents: Number(data.costRateCents) } as TimeEntry;
    stored.timeEntries = [...stored.timeEntries.filter(candidate => candidate.id !== row.id), row];
    return structuredClone(stored);
  };
  desktopApi.createEntity = (entity, data) => save(entity, data);
  desktopApi.updateEntity = (entity, id, data) => save(entity, data, id);
  desktopApi.startTimer = async data => {
    state.timers.push(structuredClone(data));
    if (state.holdTimer) await new Promise<void>(resolve => { state.release = () => { state.holdTimer = false; resolve(); }; });
    stored.activeTimer = { ...data, startedAt: new Date().toISOString(), hourlyCostCents: Number(data.costRateCents) } as Workspace['activeTimer'];
    return structuredClone(stored);
  };
  desktopApi.stopTimer = async () => { stored.activeTimer = null; return structuredClone(stored); };
  desktopApi.createInvoiceFromTimeEntries = async input => {
    state.invoiceAttempts.push(structuredClone(input));
    if (state.rejectInvoice) {
      state.rejectInvoice = false;
      stored.timeEntries.push(entry('new-during-refresh'));
      throw new Error('La création de la facture est momentanément indisponible. Réessayez.');
    }
    if (state.invoiceWrites.includes(input.requestId)) throw new Error('The browser journey must never resend an acknowledged invoice.');
    state.invoiceWrites.push(input.requestId);
    const invoiceId = `time-invoice-${state.invoiceWrites.length}`;
    stored.timeBillingBatches.push({ id: 'time-batch', requestId: input.requestId, invoiceId, projectId: input.projectId, clientId: 'client-qa', vatBp: input.vatBp || 0, createdAt: new Date().toISOString() });
    stored.invoices.push({ ...structuredClone(stored.invoices[0]), id: invoiceId, status: 'draft', number: '', projectId: input.projectId, title: input.title || 'Facture des heures', issueDate: '', dueDate: '', paidAt: '', lines: [] });
    stored.timeEntries = stored.timeEntries.map(row => input.timeEntryIds.includes(row.id) ? { ...row, billingStatus: 'reserved', billingInvoiceId: invoiceId, billingBatchId: 'time-batch' } : row);
    if (state.invoiceReadFailure) {
      state.invoiceReadFailure = false; state.readFailures = 2;
      // The initial refresh failed before this exception; one more read fails
      // in the action runner and one in the explicit recovery dialogue.
      throw new WorkspaceRefreshAfterMutationError(new Error('Lecture après création interrompue.'));
    }
    return structuredClone(stored);
  };
}
