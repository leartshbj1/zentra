import type { Workspace } from './types';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';

/** A retry reads the stored status of this invoice; it never sends validation again. */
export function supplierInvoiceWasValidated(workspace: Workspace, invoiceId: string): boolean {
  if (!workspace.onboardingCompleted || !workspace.settings || !Array.isArray(workspace.supplierInvoices)) throw Error('Les achats doivent être relus avant de poursuivre la validation.');
  const matches = workspace.supplierInvoices.filter(row => row.id === invoiceId);
  if (matches.length !== 1) throw Error('La facture à vérifier est absente ou ambiguë dans les achats relus.');
  const invoice = matches[0];
  if (invoice.documentStatus === 'draft' && !invoice.validationJournalEntryId) return false;
  if (invoice.documentStatus !== 'validated' || !invoice.validationJournalEntryId) throw Error('L’état de validation et son écriture comptable doivent encore être vérifiés.');
  return true;
}

export class SupplierInvoiceValidationOutcomeUnknownError extends Error {
  constructor(readonly invoiceId: string, readonly mutationCause: unknown) { super('La réponse de validation a été interrompue. Vérifions la facture avant de réessayer.'); }
  wasRecorded(workspace: Workspace) { return supplierInvoiceWasValidated(workspace, this.invoiceId); }
}

export class SupplierInvoiceValidationRefreshError extends WorkspaceRefreshAfterMutationError {
  constructor(readonly invoiceId: string, cause: unknown) { super(cause); }
  validateRead(workspace: Workspace) { if (!supplierInvoiceWasValidated(workspace, this.invoiceId)) throw Error('La facture validée n’apparaît pas encore dans les données relues. Actualisez sans renvoyer la validation.'); }
}

export async function runSupplierInvoiceValidation(invoiceId: string, write: () => Promise<unknown>, load: () => Promise<Workspace>) {
  try { await write(); } catch (cause) { throw new SupplierInvoiceValidationOutcomeUnknownError(invoiceId, cause); }
  try { const next = await load(); new SupplierInvoiceValidationRefreshError(invoiceId, null).validateRead(next); return next; }
  catch (cause) { throw new SupplierInvoiceValidationRefreshError(invoiceId, cause); }
}
