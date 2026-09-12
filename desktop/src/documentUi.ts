import { activeCatalogItems } from './catalog';
import type {
  CatalogItem,
  DocumentLine,
  DocumentFooterTemplate,
  Invoice,
  InvoiceCorrectionWorkflow,
} from './types';
import { searchText } from './utils';

export const DOCUMENT_CATALOG_RESULT_LIMIT = 100;

export function documentVatRateFromInput(value: string): number {
  return value === '' ? -1 : Number(value);
}

export function documentLinesValidationError(lines: DocumentLine[]): string {
  return documentLineIssue(lines)?.message || '';
}

export function documentLineIssue(lines: DocumentLine[]): { index: number; field: string; message: string } | null {
  if (!lines.length) return { index: 0, field: 'Description', message: 'Ajoutez au moins une prestation.' };
  for (const [index, line] of lines.entries()) {
    const issue = (field: string, message: string) => ({ index, field, message: `Ligne ${index + 1} : ${message}` });
    if (!line.description.trim()) return issue('Description', 'décrivez la prestation ou l’article.');
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) return issue('Quantité', 'indiquez une quantité supérieure à zéro.');
    if (!line.unit.trim()) return issue('Unité', 'indiquez une unité, par exemple h, pièce ou forfait.');
    if (!Number.isSafeInteger(line.unitPriceCents) || line.unitPriceCents < 0) return issue('Prix unitaire', 'indiquez un prix positif, ou 0 pour une prestation offerte.');
    if (!Number.isSafeInteger(Math.round(line.quantity * line.unitPriceCents))) return issue('Prix unitaire', 'le montant calculé est trop grand. Vérifiez la quantité et le prix.');
    if (!Number.isInteger(line.discountBp ?? 0) || (line.discountBp ?? 0) < 0 || (line.discountBp ?? 0) > 10000) return issue('Remise en pour cent', 'la remise doit être comprise entre 0 et 100 %.');
    if (!Number.isInteger(line.vatRateBp) || line.vatRateBp < 0 || line.vatRateBp > 10000) return issue('Taux TVA', 'choisissez le taux de TVA de cette prestation.');
  }
  return null;
}

export type DocumentQuickClientDraft = {
  contactPerson: string;
  company: string;
  email: string;
  phone: string;
  street: string;
  buildingNumber: string;
  postalCode: string;
  city: string;
  canton: string;
  country: string;
};

export function prepareDocumentQuickClient(
  draft: DocumentQuickClientDraft,
  id: string,
) {
  const contactPerson = draft.contactPerson.trim();
  const company = draft.company.trim();
  const addressLine1 = draft.street.trim();
  const postalCode = draft.postalCode.trim();
  const city = draft.city.trim();
  const country = draft.country.trim().toUpperCase();
  const displayName = company || contactPerson;
  if (
    !displayName ||
    !addressLine1 ||
    !postalCode ||
    !city ||
    !/^[A-Z]{2}$/.test(country)
  ) {
    throw new Error(
      'Pour ajouter le client, renseignez au moins un nom de contact ou une entreprise, puis la rue, le NPA, la localité et un code pays à deux lettres.',
    );
  }
  return {
    id,
    name: displayName,
    contactPerson,
    company,
    email: draft.email.trim(),
    phone: draft.phone.trim(),
    addressLine1,
    addressLine2: draft.buildingNumber.trim(),
    postalCode,
    city,
    canton: draft.canton.trim(),
    country,
    notes: '',
  };
}

export function salesDocumentDateError(
  entity: 'quotes' | 'invoices',
  issueDate: string,
  endDate: string,
): string {
  if (!issueDate || !endDate || endDate >= issueDate) return '';
  return entity === 'quotes'
    ? 'La date de validité ne peut pas précéder la date d’émission.'
    : 'L’échéance ne peut pas précéder la date d’émission.';
}

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
  const newestForOriginal = (originalInvoiceId: string) =>
    workflows
      .filter((workflow) => workflow.originalInvoiceId === originalInvoiceId)
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        right.id.localeCompare(left.id),
      )[0];

  // Une facture de remplacement peut appartenir à l'ancien workflow tout en
  // devenant l'original d'une correction suivante. Partir en priorité du lien
  // où elle est l'original évite de revenir vers l'ancienne correction.
  let current =
    newestForOriginal(invoiceId) ??
    workflows.find((workflow) => workflow.replacementInvoiceId === invoiceId);

  // Un avoir sert uniquement à afficher son propre lien de correction. Il ne
  // doit jamais hériter d'une correction ultérieure de la facture remplacée.
  if (!current) {
    return workflows.find((workflow) => workflow.creditNoteId === invoiceId);
  }

  // Depuis une ancienne facture, suivre toute la chaîne A -> B -> C afin que
  // « Modifier » cible toujours la version la plus récente. La garde bornée et
  // les identifiants visités empêchent une sauvegarde corrompue de boucler.
  const visited = new Set<string>();
  for (let depth = 0; depth < workflows.length; depth += 1) {
    if (visited.has(current.id)) break;
    visited.add(current.id);
    const next = newestForOriginal(current.replacementInvoiceId);
    if (!next || visited.has(next.id)) break;
    current = next;
  }
  return current;
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
