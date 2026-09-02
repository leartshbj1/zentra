import { supplierInvoiceDraftSha256 } from './supplierInvoiceAnalysisManifest';
import type { SupplierInvoiceAiDraft } from './supplierInvoiceAiDraft';

export type SupplierInvoiceAnalysisDraftSnapshot = {
  importId: string;
  revision: number;
  inputSha256: string;
  draftSha256: string;
};

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export async function supplierInvoiceAnalysisDraftSnapshot(input: {
  importId: string;
  revision: number;
  inputSha256: string;
  draft: SupplierInvoiceAiDraft;
}): Promise<SupplierInvoiceAnalysisDraftSnapshot> {
  const normalizedImportId = input.importId.trim();
  const normalizedSha256 = input.inputSha256.trim().toLowerCase();
  if (!normalizedImportId) throw new Error('L\'identifiant d\'import manque.');
  if (normalizedImportId.length > 200 || /[\u0000-\u001f\u007f]/.test(normalizedImportId)) {
    throw new Error('L\'identifiant d\'import est invalide.');
  }
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new Error('La revision du brouillon est invalide.');
  if (!SHA256_PATTERN.test(normalizedSha256)) throw new Error('Le hash source du brouillon est invalide.');
  return {
    importId: normalizedImportId,
    revision: input.revision,
    inputSha256: normalizedSha256,
    draftSha256: await supplierInvoiceDraftSha256(input.draft),
  };
}

/**
 * Empeche un resultat asynchrone, calcule sur un ancien brouillon ou un autre
 * fichier, de remplacer les corrections humaines courantes.
 */
export function assertSupplierInvoiceAnalysisDraftUnchanged(
  snapshot: SupplierInvoiceAnalysisDraftSnapshot,
  current: SupplierInvoiceAnalysisDraftSnapshot,
) {
  if (snapshot.importId === current.importId
    && snapshot.revision === current.revision
    && snapshot.inputSha256 === current.inputSha256
    && snapshot.draftSha256 === current.draftSha256) return;
  throw new Error(
    'Le document ou le brouillon a change pendant l\'analyse. Les saisies humaines ont ete conservees; relancez l\'analyse locale.',
  );
}
