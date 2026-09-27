import type { MailInvoice, SupplierInboxState } from './supplierInbox';
import type { SupplierInvoice } from './types';

/** A mail import and its local draft are the same action, even before acknowledgment. */
export function purchaseInboxCount(localInvoiceIds: string[], orders: number, credits: number, mailbox?: SupplierInboxState | null) {
  const documents = new Set(localInvoiceIds.map(id => `invoice:${id}`));
  for (const item of mailbox?.items || []) {
    if (item.state === 'imported' || item.state === 'ignored') continue;
    documents.add(item.invoiceId ? `invoice:${item.invoiceId}` : `mail:${item.id}`);
  }
  return documents.size + orders + credits;
}

/** Import is not proof of accounting. Read the actual document state when available. */
export function mailInvoiceStage(item: MailInvoice, invoices: SupplierInvoice[]) {
  if (item.state !== 'imported') return item.otherDevice || item.state === 'processing'
    ? 'Import en cours' : 'À vérifier';
  const invoice = invoices.find(row => row.id === (item.invoiceId || item.id));
  if (invoice?.documentStatus === 'draft') return 'Brouillon à valider';
  if (invoice?.documentStatus === 'validated') return invoice.paymentStatus === 'paid'
    ? 'Payée' : 'Comptabilisée · à payer';
  return 'Enregistrée dans Gestion';
}
