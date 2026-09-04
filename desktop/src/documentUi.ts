import { activeCatalogItems } from './catalog';
import type {
  CatalogItem,
  DocumentFooterTemplate,
  Invoice,
  InvoiceCorrectionWorkflow,
} from './types';
import { searchText } from './utils';

export const DOCUMENT_CATALOG_RESULT_LIMIT = 100;

export function searchableDocumentCatalogItems(
  items: CatalogItem[],
  query: string,
  limit = DOCUMENT_CATALOG_RESULT_LIMIT,
): CatalogItem[] {
  const normalizedQuery = query.trim();
  return activeCatalogItems(items)
    .filter(
      (item) =>
        !normalizedQuery ||
        searchText([item.sku, item.name, item.description, item.unit], normalizedQuery),
    )
    .slice(0, Math.max(0, limit));
}

export function upsertDocumentFooterTemplate(
  templates: DocumentFooterTemplate[],
  selectedId: string,
  nameInput: string,
  textInput: string,
  idFactory: () => string,
): { id: string; name: string; templates: DocumentFooterTemplate[] } {
  const name = nameInput.trim();
  const text = textInput.trim();
  if (!name || !text) {
    throw new Error('Saisissez un nom de modèle et un texte de bas de page.');
  }

  const selected = templates.find((template) => template.id === selectedId);
  const sameName = templates.find(
    (template) =>
      template.name.localeCompare(name, 'fr-CH', { sensitivity: 'base' }) === 0,
  );
  if (selected && sameName && selected.id !== sameName.id) {
    throw new Error(`Un autre modèle porte déjà le nom « ${name} ».`);
  }

  const id = selected?.id ?? sameName?.id ?? idFactory();
  const next = [
    ...templates.filter((template) => template.id !== id),
    { id, name, text },
  ].sort((left, right) => left.name.localeCompare(right.name, 'fr-CH'));
  return { id, name, templates: next };
}

export type InvoiceModificationAction = {
  kind: 'edit' | 'correct' | 'view';
  invoice: Invoice;
};

export function invoiceCorrectionWorkflowFor(
  invoiceId: string,
  workflows: InvoiceCorrectionWorkflow[],
): InvoiceCorrectionWorkflow | undefined {
  return workflows.find(
    (workflow) =>
      workflow.originalInvoiceId === invoiceId ||
      workflow.creditNoteId === invoiceId ||
      workflow.replacementInvoiceId === invoiceId,
  );
}

export function invoiceModificationAction(
  invoice: Invoice,
  workflow: InvoiceCorrectionWorkflow | undefined,
  invoices: Invoice[],
): InvoiceModificationAction {
  const replacement = workflow
    ? invoices.find((candidate) => candidate.id === workflow.replacementInvoiceId)
    : undefined;
  if (!replacement || replacement.id === invoice.id) {
    return { kind: 'correct', invoice };
  }
  if (replacement.status === 'draft') {
    return { kind: 'edit', invoice: replacement };
  }
  if (replacement.status === 'cancelled') {
    return { kind: 'view', invoice: replacement };
  }
  return { kind: 'correct', invoice: replacement };
}

export function reserveDocumentAction(
  pendingIds: Set<string>,
  documentId: string,
): boolean {
  if (pendingIds.has(documentId)) return false;
  pendingIds.add(documentId);
  return true;
}
