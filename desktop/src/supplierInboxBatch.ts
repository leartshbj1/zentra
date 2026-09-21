import type { InboxDraft, MailInvoice, SupplierInboxState } from './supplierInbox';
import type { Workspace } from './types';
import { mailboxInvoiceDefaults } from './supplierInboxReview';

export type MailboxBatchResult = {
  id: string;
  label: string;
  supplierName: string;
  supplierId?: string;
  supplierCreated?: boolean;
  invoiceId?: string;
  status: 'posted' | 'draft' | 'review' | 'error';
  message?: string;
};
export type MailboxBatch = { done: number; total: number; results: MailboxBatchResult[] };
type Prepared = { id: string; supplierId?: string; created?: boolean; error?: string };
type Saved = { id: string; saved?: boolean; posted?: boolean; alreadyImported?: boolean };
type BatchDependencies = {
  request: <T>(data: unknown) => Promise<T>;
  loadWorkspace: () => Promise<Workspace>;
  isCurrent: () => boolean;
  progress: (batch: MailboxBatch) => void;
};
const errorMessage = (error: unknown) => String(error instanceof Error ? error.message : error)
  .replace(/^(?:Champ invalide\s*:\s*)+/i, '').trim();

function draft(item: MailInvoice, supplierId: string, workspace: Workspace, inbox: SupplierInboxState): InboxDraft {
  const e = item.extraction;
  if (e.currency !== 'CHF') throw Error('La devise doit être vérifiée.');
  if (!e.reference || !e.invoiceDate || !e.dueDate) throw Error('Complétez la référence ou les dates.');
  if (e.netCents === null || !Number.isSafeInteger(e.netCents) || e.netCents <= 0
    || e.vatBp === null || !Number.isSafeInteger(e.vatBp) || e.vatBp < 0 || e.vatBp > 10000
    || e.vatCents === null || !Number.isSafeInteger(e.vatCents)
    || e.totalCents !== e.netCents + e.vatCents
    || Number((BigInt(e.netCents) * BigInt(e.vatBp) + 5000n) / 10000n) !== e.vatCents)
    throw Error('Les montants ou la TVA doivent être vérifiés.');
  const defaults = mailboxInvoiceDefaults(item, workspace, inbox.habits);
  if (!defaults.category) throw Error('Choisissez la catégorie de cet achat.');
  return {
    supplier_id: supplierId, date: e.invoiceDate, due_date: e.dueDate, reference: e.reference,
    items: [{ description: `Facture ${e.reference}`, quantity_milli: 1000, unit_price_cents: e.netCents,
      vat_bp: e.vatBp, category: defaults.category, expense_account_id: defaults.accountId || null }],
  };
}

/** Uses the same native supplier resolver as individual review, before any financial checks. */
export async function prepareMailboxBatch(inbox: SupplierInboxState, dependencies: BatchDependencies): Promise<MailboxBatch> {
  const { request, loadWorkspace, isCurrent, progress } = dependencies;
  const queue = inbox.items.filter(item => !item.otherDevice && !['imported', 'ignored'].includes(item.state));
  const batch: MailboxBatch = { done: 0, total: queue.length, results: [] };
  progress({ ...batch });
  if (!inbox.prepareEnabled || !inbox.linked || !isCurrent()) return batch;
  let workspace = await loadWorkspace();
  for (let offset = 0; offset < queue.length && isCurrent(); offset += 10) {
    const items = queue.slice(offset, offset + 10);
    let prepared: Prepared[];
    try {
      prepared = (await request<{ results: Prepared[] }>({ action: 'prepareSuppliers', ids: items.map(item => item.id) })).results;
    } catch (error) {
      prepared = items.map(item => ({ id: item.id, error: errorMessage(error) }));
    }
    if (!isCurrent()) break;
    // Newly created vendors must be available to every invoice in the batch, including duplicates.
    workspace = await loadWorkspace();
    for (const item of items) {
      if (!isCurrent()) break;
      const resolution = prepared.find(row => row.id === item.id);
      const supplierId = resolution?.supplierId;
      const result: MailboxBatchResult = {
        id: item.id, label: item.extraction.reference || item.fileName,
        supplierName: workspace.suppliers.find(s => s.id === supplierId)?.name || item.extraction.supplierName || '',
        supplierId, supplierCreated: !!resolution?.created, status: 'review',
      };
      try {
        if (!supplierId) throw Error(resolution?.error || 'Le nom du fournisseur doit être confirmé.');
        let saved: Saved | undefined;
        if (inbox.autoPost && item.state === 'ready') {
          try { saved = await request<Saved>({ action: 'import', id: item.id, automatic: true }); }
          catch { /* The native posting guard may require a first confirmed classification. */ }
        }
        if (!isCurrent()) break;
        if (!saved?.saved && !saved?.alreadyImported) {
          saved = await request<Saved>({ action: 'import', id: item.id, automatic: false, confirm: false,
            invoice: draft(item, supplierId, workspace, inbox) });
        }
        if (!isCurrent()) break;
        result.invoiceId = saved.id;
        result.status = saved.posted ? 'posted' : 'draft';
      } catch (error) {
        result.message = errorMessage(error);
        result.status = supplierId || resolution?.error ? 'review' : 'error';
      }
      if (!isCurrent()) break;
      batch.results.push(result);
      batch.done = batch.results.length;
      progress({ ...batch, results: [...batch.results] });
    }
  }
  return batch;
}
