import type { Workspace } from './types';

export type SupplierEmailInspection = {
  fileName: string;
  fileSizeBytes: number;
  sha256: string;
  messageId: string;
  subject: string;
  senderName: string;
  senderEmail: string;
  attachmentNames: string[];
  invoiceSignal: boolean;
  confidence: 'low' | 'medium' | 'high';
  matchedSupplierId: string | null;
  duplicateInvoiceId: string | null;
  reference: string;
  documentDate: string;
  dueDate: string;
  currency: string;
  netCents: number | null;
  vatCents: number | null;
  totalCents: number | null;
  issues: string[];
  networkAccess: false;
  aiUsed: false;
};

export type SupplierEmailImportDraft = {
  /** Stable across retries so a successful save followed by a refresh failure cannot duplicate the draft. */
  id: string;
  supplierId: string;
  projectId: string;
  reference: string;
  documentDate: string;
  dueDate: string;
  totalCents: number;
  currency: string;
  vatBp: number;
  category: string;
  expenseAccountId: string;
  description: string;
};

export function netAmountForGross(
  totalCents: number,
  vatBp: number,
): number | null {
  if (
    !Number.isSafeInteger(totalCents) ||
    totalCents <= 0 ||
    !Number.isInteger(vatBp) ||
    vatBp < 0 ||
    vatBp > 10_000
  )
    return null;
  const estimate = Math.round((totalCents * 10_000) / (10_000 + vatBp));
  for (let distance = 0; distance <= 100; distance += 1) {
    for (const candidate of distance
      ? [estimate - distance, estimate + distance]
      : [estimate]) {
      if (
        candidate > 0 &&
        candidate + Math.round((candidate * vatBp) / 10_000) === totalCents
      )
        return candidate;
    }
  }
  return null;
}

export function supplierEmailDraftIssues(
  draft: SupplierEmailImportDraft,
  inspection: SupplierEmailInspection,
  workspace: Workspace,
): string[] {
  const issues: string[] = [];
  const canonicalDate = (value: string) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const date = new Date(
      Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
    );
    return (
      date.getUTCFullYear() === Number(match[1]) &&
      date.getUTCMonth() + 1 === Number(match[2]) &&
      date.getUTCDate() === Number(match[3])
    );
  };
  if (!inspection.invoiceSignal)
    issues.push(
      'Confirmez d’abord que ce message contient réellement une facture.',
    );
  if (supplierEmailDuplicateId(draft, workspace))
    issues.push('Cette référence existe déjà pour ce fournisseur.');
  if (draft.currency !== 'CHF')
    issues.push(
      'Seules les factures fournisseurs en CHF sont importables actuellement.',
    );
  if (
    !workspace.suppliers.some(
      (supplier) => supplier.id === draft.supplierId && !supplier.archivedAt,
    )
  )
    issues.push('Choisissez un fournisseur actif.');
  if (!canonicalDate(draft.documentDate))
    issues.push('Indiquez la date de facture.');
  if (!canonicalDate(draft.dueDate))
    issues.push("Indiquez la date d'échéance.");
  if (draft.documentDate && draft.dueDate && draft.dueDate < draft.documentDate)
    issues.push("L'échéance ne peut pas précéder la date de facture.");
  if (!draft.reference.trim())
    issues.push('Indiquez la référence fournisseur.');
  if (!draft.category.trim())
    issues.push('Choisissez une catégorie comptable.');
  if (!draft.description.trim()) issues.push('Indiquez un libellé comptable.');
  if (!Number.isSafeInteger(draft.totalCents) || draft.totalCents <= 0)
    issues.push('Indiquez un montant total positif.');
  if (netAmountForGross(draft.totalCents, draft.vatBp) === null)
    issues.push(
      'Le total ne peut pas être ventilé exactement avec ce taux de TVA.',
    );
  return [...new Set(issues)];
}

export function supplierEmailDuplicateId(
  draft: Pick<SupplierEmailImportDraft, 'id' | 'supplierId' | 'reference'>,
  workspace: Workspace,
): string | null {
  const normalized = draft.reference
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLocaleUpperCase('fr-CH');
  if (!draft.supplierId || !normalized) return null;
  return (
    workspace.supplierInvoices.find(
      (invoice) =>
        invoice.id !== draft.id &&
        invoice.supplierId === draft.supplierId &&
        invoice.reference
          .normalize('NFKC')
          .replace(/[^\p{L}\p{N}]/gu, '')
          .toLocaleUpperCase('fr-CH') === normalized,
    )?.id ?? null
  );
}

export function supplierEmailImportPayload(
  draft: SupplierEmailImportDraft,
  inspection: SupplierEmailInspection,
) {
  const netCents = netAmountForGross(draft.totalCents, draft.vatBp);
  if (netCents === null) throw new Error('Ventilation TVA invalide.');
  return {
    id: draft.id,
    supplierId: draft.supplierId,
    projectId: draft.projectId || null,
    date: draft.documentDate,
    dueDate: draft.dueDate,
    reference: draft.reference.trim(),
    note: [
      'Import déterministe depuis un e-mail exporté; données à contrôler avant validation.',
      `Source: ${inspection.fileName}`,
      `SHA-256: ${inspection.sha256}`,
      inspection.messageId ? `Message-ID: ${inspection.messageId}` : '',
      inspection.senderEmail ? `Expéditeur: ${inspection.senderEmail}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    items: [
      {
        description:
          draft.description.trim() || `Facture ${draft.reference.trim()}`,
        quantityMilli: 1_000,
        unit: 'forfait',
        unitPriceCents: netCents,
        discountBp: 0,
        vatBp: draft.vatBp,
        category: draft.category,
        expenseAccountId: draft.expenseAccountId || null,
        projectId: draft.projectId || null,
      },
    ],
  };
}
