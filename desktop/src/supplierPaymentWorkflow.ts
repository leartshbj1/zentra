import type { SupplierInvoice, Workspace } from './types';
import { creditAmount } from './creditAllocationWorkflow';
import { supplierPaymentInput } from './purchaseFormValidation';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';

export type SupplierPaymentDraft = { amount: string; date: string; method: string; reference: string; notes: string };
export type SupplierPaymentResume = { requestId: string; draft: SupplierPaymentDraft };
export type SupplierPaymentProblem = { field: keyof SupplierPaymentDraft | 'record'; message: string; section?: 'accounts' | 'periods' };
export type SupplierPaymentIntent = Omit<SupplierPaymentDraft, 'amount'> & { requestId: string; supplierInvoiceId: string; amountCents: number };

export function supplierPaymentProblem(invoice: SupplierInvoice | undefined, workspace: Workspace, draft: SupplierPaymentDraft, today: string): SupplierPaymentProblem | null {
  if (!invoice || invoice.documentStatus !== 'validated') return { field: 'record', message: 'Retrouvez une facture fournisseur validée avant d’enregistrer son paiement. Actualisez les achats si nécessaire.' };
  if (!Number.isSafeInteger(invoice.balanceCents) || invoice.balanceCents <= 0) return { field: 'record', message: 'Cette facture n’a plus de solde à payer. Consultez ses paiements et ses avoirs.' };
  const check = supplierPaymentInput(draft.amount, draft.date, invoice.documentDate, invoice.balanceCents);
  if (check.error) return { field: check.field!, message: check.error };
  if (draft.date > today) return { field: 'date', message: 'Indiquez le jour où vous avez réellement payé, au plus tard aujourd’hui.' };
  if (!['bank_transfer', 'card', 'cash', 'other'].includes(draft.method)) return { field: 'method', message: 'Choisissez comment ce paiement a été effectué.' };
  if ([...draft.reference.trim()].length > 200 || draft.reference.includes('\0')) return { field: 'reference', message: 'La référence peut contenir jusqu’à 200 caractères, sans caractère de contrôle.' };
  if ([...draft.notes.trim()].length > 2000 || draft.notes.includes('\0')) return { field: 'notes', message: 'La note peut contenir jusqu’à 2 000 caractères, sans caractère de contrôle.' };
  const bank = workspace.accounts.find(row => row.id === workspace.accountingSettings?.bankAccountId);
  if (!workspace.accountingSettings?.enabled || !bank?.active || bank.accountType !== 'asset') return { field: 'record', section: 'accounts', message: 'Choisissez un compte de paiement actif dans Plan & liaisons. Votre saisie sera conservée pendant la correction.' };
  return null;
}

export function supplierPaymentNativeProblem(source: string): SupplierPaymentProblem {
  if (/période|exercice|clôtur|fermée/iu.test(source)) return { field: 'record', section: 'periods', message: 'La date du paiement appartient à un exercice fermé. Vérifiez cet exercice ; corrigez la date seulement si elle a été mal recopiée.' };
  if (/solde|changé depuis/iu.test(source)) return { field: 'record', message: 'Le solde de la facture a changé. Actualisez les achats et vérifiez le montant avant de réessayer.' };
  if (/compte|écriture|liaison/iu.test(source)) return { field: 'record', section: 'accounts', message: 'Un compte comptable doit être vérifié. Ouvrez Plan & liaisons, puis reprenez ce paiement avec votre saisie conservée.' };
  return { field: 'record', message: 'Le paiement n’a pas pu être confirmé. Votre saisie est conservée. Vérifiez le message détaillé et actualisez les achats avant de réessayer.' };
}

export function supplierPaymentReviewKey(invoice: SupplierInvoice | undefined, workspace: Workspace, draft: SupplierPaymentDraft): string {
  const bank = workspace.accounts.find(row => row.id === workspace.accountingSettings?.bankAccountId);
  return JSON.stringify([invoice?.id, invoice?.documentStatus, invoice?.documentDate, invoice?.balanceCents, invoice?.paidCents, invoice?.creditedCents, invoice?.reference, invoice?.supplierName, bank, workspace.accountingSettings?.enabled, draft]);
}

export function requireSupplierPaymentWorkspace(workspace: Workspace) {
  if (!workspace.onboardingCompleted || !workspace.settings || !Array.isArray(workspace.supplierInvoices) || !Array.isArray(workspace.accounts) || workspace.supplierInvoices.some(row => !Array.isArray(row.payments))) throw Error('Les factures fournisseurs et leur historique doivent être relus avant de continuer.');
}

export function supplierPaymentWasRecorded(workspace: Workspace, intent: SupplierPaymentIntent): boolean {
  requireSupplierPaymentWorkspace(workspace);
  const invoice = workspace.supplierInvoices.find(row => row.id === intent.supplierInvoiceId);
  if (!invoice) throw Error('La facture du paiement est absente des données relues. Actualisez les achats.');
  const found = workspace.supplierInvoices.flatMap(row => row.payments).filter(row => row.requestId === intent.requestId);
  if (!found.length) return false;
  const payment = found[0];
  if (found.length !== 1 || payment.supplierInvoiceId !== intent.supplierInvoiceId || payment.amountCents !== intent.amountCents || payment.date !== intent.date || payment.method !== intent.method.trim() || payment.reference !== intent.reference.trim() || payment.notes !== intent.notes.trim() || !payment.journalEntryId || invoice.documentStatus !== 'validated') throw Error('Le paiement retrouvé ne correspond pas entièrement à cette tentative. Gardez cette fenêtre ouverte et actualisez les données.');
  return true;
}

export class SupplierPaymentOutcomeUnknownError extends Error {
  constructor(readonly intent: SupplierPaymentIntent, readonly mutationCause: unknown) { super('La réponse du paiement fournisseur a été interrompue. Vérifions son historique avant de réessayer.'); }
  wasRecorded(workspace: Workspace) { return supplierPaymentWasRecorded(workspace, this.intent); }
}
export class SupplierPaymentRefreshError extends WorkspaceRefreshAfterMutationError {
  constructor(readonly intent: SupplierPaymentIntent, cause: unknown) { super(cause); }
  validateRead(workspace: Workspace) { if (!supplierPaymentWasRecorded(workspace, this.intent)) throw Error('Le paiement enregistré n’apparaît pas encore dans son historique. Actualisez sans renvoyer le paiement.'); }
}
export async function runSupplierPaymentMutation(intent: SupplierPaymentIntent, write: () => Promise<unknown>, load: () => Promise<Workspace>) {
  try { await write(); } catch (cause) { throw new SupplierPaymentOutcomeUnknownError(intent, cause); }
  try { const next = await load(); new SupplierPaymentRefreshError(intent, null).validateRead(next); return next; }
  catch (cause) { throw new SupplierPaymentRefreshError(intent, cause); }
}

export const supplierPaymentAmount = creditAmount;
