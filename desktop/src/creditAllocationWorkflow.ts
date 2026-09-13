import type { SupplierCreditAllocation, SupplierCreditNote, SupplierInvoice, Workspace } from './types';
import { creditSettlementDateError } from './supplierCreditSettlement';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';

export type CreditBalances = { creditAvailableCents: number; invoiceBalanceCents: number };
export type CreditProblem = { field: 'amount' | 'date' | 'reason' | 'invoice' | 'record'; message: string };
export function creditAmount(value: string): number | null {
  const text = value.trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return cents > 0n && cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}
export const creditAmountInput = (cents: number) => Number.isSafeInteger(cents) && cents >= 0 ? `${BigInt(cents) / 100n}.${String(BigInt(cents) % 100n).padStart(2, '0')}` : '';
export function creditBalances(credit?: SupplierCreditNote, invoice?: SupplierInvoice): CreditBalances | null {
  if (!credit || !invoice || ![credit.totalCents, credit.allocatedCents, credit.refundedCents, invoice.balanceCents].every(n => Number.isSafeInteger(n) && n >= 0)) return null;
  const available = credit.totalCents - credit.allocatedCents - credit.refundedCents;
  return Number.isSafeInteger(available) && available >= 0 ? { creditAvailableCents: available, invoiceBalanceCents: invoice.balanceCents } : null;
}
export function eligibleCreditInvoices(credit: SupplierCreditNote | undefined, invoices: SupplierInvoice[]) {
  return credit ? invoices.filter(row => row.supplierId === credit.supplierId && row.currency === credit.currency && row.documentStatus === 'validated' && row.balanceCents > 0).sort((a, b) => b.documentDate.localeCompare(a.documentDate) || a.id.localeCompare(b.id)) : [];
}
export function creditAllocationProblem(credit: SupplierCreditNote | undefined, invoice: SupplierInvoice | undefined, allocation: SupplierCreditAllocation | undefined, draft: { amount: string; date: string; reason: string; reverse: boolean }, today: string): CreditProblem | null {
  if (!credit || credit.status !== 'validated') return { field: 'record', message: 'Cet avoir doit être validé avant de pouvoir être utilisé. Retrouvez-le dans Factures et avoirs.' };
  if (!invoice || invoice.documentStatus !== 'validated' || invoice.supplierId !== credit.supplierId || invoice.currency !== credit.currency) return { field: 'invoice', message: 'Choisissez une facture validée du même fournisseur et dans la même monnaie.' };
  if (draft.reverse && (!allocation || allocation.supplierCreditNoteId !== credit.id || allocation.supplierInvoiceId !== invoice.id || allocation.eventType !== 'apply' || credit.allocations.some(row => row.eventType === 'reverse' && row.reversesAllocationId === allocation.id))) return { field: 'record', message: 'Cette utilisation a déjà été annulée ou n’est plus accessible. Actualisez les soldes pour vérifier son historique.' };
  const balances = creditBalances(credit, invoice);
  if (!balances) return { field: 'record', message: 'Les soldes ne sont pas encore lisibles. Actualisez les données avant de continuer.' };
  const amount = draft.reverse ? allocation?.amountCents : creditAmount(draft.amount);
  if (!amount || !Number.isSafeInteger(amount) || amount <= 0) return { field: 'amount', message: 'Indiquez un montant supérieur à zéro, avec deux décimales maximum. Par exemple : 25,50.' };
  if (!draft.reverse && amount > balances.creditAvailableCents) return { field: 'amount', message: 'Ce montant dépasse ce qui reste disponible sur l’avoir. Utilisez le montant maximum proposé ou saisissez un montant plus petit.' };
  if (!draft.reverse && amount > balances.invoiceBalanceCents) return { field: 'amount', message: 'Ce montant dépasse ce qui reste à payer sur la facture. Utilisez le montant maximum proposé ou saisissez un montant plus petit.' };
  if (draft.reverse && (![balances.creditAvailableCents + amount, balances.invoiceBalanceCents + amount].every(Number.isSafeInteger))) return { field: 'record', message: 'Les nouveaux soldes dépassent la capacité de calcul. Vérifiez les montants du dossier.' };
  const minimum = [credit.documentDate, invoice.documentDate, draft.reverse ? allocation?.effectiveDate || '' : ''].sort().at(-1)!;
  const dateError = creditSettlementDateError(draft.date, minimum, today);
  if (dateError) return { field: 'date', message: draft.date < minimum ? `Choisissez une date à partir du ${minimum.split('-').reverse().join('.')} et au plus tard aujourd’hui : les documents et l’utilisation initiale doivent déjà exister.` : 'Indiquez le jour réel de cette opération, au plus tard aujourd’hui.' };
  if (draft.reverse && (!draft.reason.trim() || [...draft.reason.trim()].length > 500)) return { field: 'reason', message: 'Expliquez brièvement pourquoi vous annulez cette utilisation, en 500 caractères maximum. Par exemple : « Mauvaise facture ».' };
  return null;
}

export type CreditAllocationIntent = { requestId: string; kind: 'apply' | 'reverse'; date: string; creditId?: string; invoiceId?: string; amountCents?: number; allocationId?: string; reason?: string };
export function requireCreditAllocationWorkspace(workspace: Workspace) {
  if (!workspace.onboardingCompleted || !workspace.settings || !Array.isArray(workspace.supplierCreditNotes) || !Array.isArray(workspace.supplierInvoices) || workspace.supplierCreditNotes.some(row => !Array.isArray(row.allocations))) throw Error('Les avoirs, leur historique et les factures doivent être accessibles. Réessayez l’actualisation.');
}
export function creditAllocationWasRecorded(workspace: Workspace, intent: CreditAllocationIntent) {
  requireCreditAllocationWorkspace(workspace);
  return workspace.supplierCreditNotes.some(credit => credit.allocations.some(row => workspace.supplierInvoices.some(invoice => invoice.id === row.supplierInvoiceId) && row.requestId === intent.requestId && row.eventType === intent.kind && row.effectiveDate === intent.date && (intent.kind === 'apply'
    ? credit.id === intent.creditId && row.supplierInvoiceId === intent.invoiceId && row.amountCents === intent.amountCents
    : row.reversesAllocationId === intent.allocationId && row.reason === intent.reason?.trim())));
}
export class CreditAllocationOutcomeUnknownError extends Error {
  constructor(readonly intent: CreditAllocationIntent, readonly mutationCause: unknown) { super('La réponse de l’avoir a été interrompue. Vérifions l’historique avant de réessayer.'); }
  wasRecorded(workspace: Workspace) { return creditAllocationWasRecorded(workspace, this.intent); }
}
export class CreditAllocationRefreshError extends WorkspaceRefreshAfterMutationError {
  constructor(readonly intent: CreditAllocationIntent, cause: unknown) { super(cause); }
  validateRead(workspace: Workspace) { if (!creditAllocationWasRecorded(workspace, this.intent)) throw Error('L’opération enregistrée ne figure pas encore dans l’historique relu. Actualisez à nouveau sans renvoyer l’opération.'); }
}
export async function runCreditAllocationMutation(intent: CreditAllocationIntent, write: () => Promise<unknown>, load: () => Promise<Workspace>) {
  try { await write(); } catch (reason) { throw new CreditAllocationOutcomeUnknownError(intent, reason); }
  try { const next = await load(); new CreditAllocationRefreshError(intent, null).validateRead(next); return next; }
  catch (reason) { throw new CreditAllocationRefreshError(intent, reason); }
}
