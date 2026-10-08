import type { AccountRole } from '../account-security';
import { validateErpRequest } from './erp-request';
import { estimateTotals, invoiceBalance } from './invoicing';
import { addMoney, decimalToMoney, money, subtractMoney } from './money';
import { validateProjectInput, type ProjectInput, type StoredProject } from './projects';
import { vendorBillBalance } from './purchasing';
import type { ErpCommand, ErpState } from './runtime-types';
import type { Money } from './types';

export interface BrowserProjectDraft {
  customerId: string; name: string; status: 'active' | 'archived'; notes: string;
  startDate: string; targetDate: string; budget: string; vendorBillIds: readonly string[];
}
export const emptyBrowserProject = (): BrowserProjectDraft => ({ customerId: '', name: '', status: 'active', notes: '', startDate: '', targetDate: '', budget: '', vendorBillIds: [] });
/** Presentation eligibility. The server independently verifies fresh authority. */
export function canUseBrowserProjects(role: AccountRole, capability: number): boolean { return capability >= 3 && ['owner', 'admin', 'accountant'].includes(role); }
export function browserProjectDraft(project: StoredProject): BrowserProjectDraft {
  const units = project.budget === null ? null : BigInt(project.budget.minorUnits);
  return { customerId: project.customerId, name: project.name, status: project.status, notes: project.notes, startDate: project.startDate ?? '', targetDate: project.targetDate ?? '', budget: units === null ? '' : `${units / BigInt(100)}.${(units % BigInt(100)).toString().padStart(2, '0')}`, vendorBillIds: [...project.vendorBillIds] };
}
export function eligibleBrowserProjects(state: ErpState, customerId: string): readonly StoredProject[] {
  return (state.projects ?? []).filter(project => project.status === 'active' && project.customerId === customerId);
}
export function checkBrowserEstimateProject(state: ErpState, customerId: string, projectId: string): void {
  if (state.schemaVersion !== 3 || !eligibleBrowserProjects(state, customerId).some(project => project.id === projectId)) throw new TypeError('Invalid project selection');
}
export interface LegacyProjectReference { readonly id: string; readonly customerIds: readonly string[]; readonly estimateIds: readonly string[]; readonly invoiceIds: readonly string[] }
/** Real unresolved IDs only. Never derive or manufacture a project name. */
export function browserLegacyProjectReferences(state: ErpState): readonly LegacyProjectReference[] {
  const registered = new Set((state.projects ?? []).map(project => project.id));
  const grouped = new Map<string, { customerIds: Set<string>; estimateIds: string[]; invoiceIds: string[] }>();
  for (const [kind, documents] of [['estimateIds', state.estimates], ['invoiceIds', state.invoices]] as const) for (const document of documents) {
    if (!document.projectId || registered.has(document.projectId)) continue;
    const group = grouped.get(document.projectId) ?? { customerIds: new Set<string>(), estimateIds: [], invoiceIds: [] };
    group.customerIds.add(document.customer.id); group[kind].push(document.id); grouped.set(document.projectId, group);
  }
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, value]) => ({ id, customerIds: [...value.customerIds], estimateIds: value.estimateIds, invoiceIds: value.invoiceIds }));
}
export function buildBrowserProjectsCommand(organizationId: string, state: ErpState, rows: readonly { id: string; draft: BrowserProjectDraft; expectedProjectRevision: number }[]): Extract<ErpCommand, { type: 'save_projects' }> {
  if (state.configuration.organizationId !== organizationId || state.configuration.country !== 'US' || state.configuration.currency !== 'USD' || !rows.length || rows.length > 1000) throw new TypeError('Invalid project workspace');
  const projects: ProjectInput[] = rows.map(({ id, draft, expectedProjectRevision }) => {
    if (draft.budget !== '' && !/^[0-9]{1,36}(?:\.[0-9]{1,2})?$/.test(draft.budget)) throw new TypeError('Invalid project budget');
    if (!state.customers.some(customer => customer.id === draft.customerId)) throw new TypeError('Invalid project customer');
    const previous = state.projects?.find(project => project.id === id);
    if ((previous?.revision ?? 0) !== expectedProjectRevision) throw new TypeError('Stale project draft');
    if ([...state.estimates, ...state.invoices].some(document => document.projectId === id && document.customer.id !== draft.customerId)) throw new TypeError('Project customer is locked');
    if (draft.vendorBillIds.some(billId => !state.vendorBills?.some(bill => bill.id === billId))) throw new TypeError('Unknown purchase');
    return validateProjectInput({ id, expectedProjectRevision, customerId: draft.customerId, name: draft.name.trim(), status: draft.status, notes: draft.notes, startDate: draft.startDate || null, targetDate: draft.targetDate || null, budgetMinor: draft.budget === '' ? null : decimalToMoney('USD', draft.budget).minorUnits, vendorBillIds: [...draft.vendorBillIds] });
  });
  const supplied = new Set(projects.map(project => project.id));
  if (supplied.size !== projects.length || browserLegacyProjectReferences(state).some(reference => !supplied.has(reference.id))) throw new TypeError('Explicit legacy review required');
  const associations = new Set<string>();
  for (const project of [...(state.projects ?? []).filter(project => !supplied.has(project.id)), ...projects]) for (const billId of project.vendorBillIds) {
    if (associations.has(billId)) throw new TypeError('Purchase already linked'); associations.add(billId);
  }
  return validateErpRequest({ idempotencyKey: 'browser-project-validation', expectedRevision: state.revision, command: { type: 'save_projects', projects } }, organizationId).command as Extract<ErpCommand, { type: 'save_projects' }>;
}
/** Totals have deliberately separate meanings. No inferred margin or tax claim. */
export function browserProjectFigures(state: ErpState, project: StoredProject) {
  const estimates = state.estimates.filter(document => document.projectId === project.id), invoices = state.invoices.filter(document => document.projectId === project.id);
  const bills = (state.vendorBills ?? []).filter(bill => project.vendorBillIds.includes(bill.id));
  const sum = (values: readonly Money[]) => values.reduce((total, value) => addMoney(total, value), money('USD', '0'));
  return { estimates, invoices, bills,
    estimatedNet: sum(estimates.map(document => estimateTotals(document).net)),
    invoicedNet: sum(invoices.map(document => subtractMoney(document.subtotal, document.discount))),
    invoicedTotal: sum(invoices.map(document => document.total)),
    received: sum(invoices.flatMap(document => document.payments.map(payment => payment.amount))),
    receivable: sum(invoices.map(invoiceBalance)),
    purchasedNet: sum(bills.map(bill => bill.net)),
    purchasedTotal: sum(bills.map(bill => bill.total)),
    payable: sum(bills.map(bill => vendorBillBalance(bill, (state.vendorPayments ?? []).filter(payment => payment.billId === bill.id)))),
  };
}
export const browserDocumentAnchor = (kind: 'estimate' | 'invoice' | 'vendor_bill', id: string): string => `us-${kind}-${encodeURIComponent(id)}`;
