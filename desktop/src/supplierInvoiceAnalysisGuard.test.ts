import { describe, expect, it } from 'vitest';
import {
  assertSupplierInvoiceAnalysisDraftUnchanged,
  supplierInvoiceAnalysisDraftSnapshot,
} from './supplierInvoiceAnalysisGuard';
import type { SupplierInvoiceAiDraft } from './supplierInvoiceAiDraft';

function draft(reference = 'INV-42'): SupplierInvoiceAiDraft {
  return {
    supplier: { printedName: '', uidNumber: '', iban: '' },
    reference,
    invoiceDate: '',
    dueDate: '',
    currency: 'CHF',
    printedNetCents: null,
    printedVatCents: null,
    printedTotalCents: null,
    lines: [],
    warnings: [],
  };
}

describe('verrou asynchrone de facture fournisseur', () => {
  const sha = 'a'.repeat(64);

  it('accepte uniquement le meme import, la meme revision, la meme source et le meme brouillon', async () => {
    const snapshot = await supplierInvoiceAnalysisDraftSnapshot({
      importId: 'import-1', revision: 4, inputSha256: sha.toUpperCase(), draft: draft(),
    });
    const current = await supplierInvoiceAnalysisDraftSnapshot({
      importId: 'import-1', revision: 4, inputSha256: sha, draft: draft(),
    });

    expect(() => assertSupplierInvoiceAnalysisDraftUnchanged(snapshot, current)).not.toThrow();
    expect(snapshot.inputSha256).toBe(sha);
  });

  it('refuse un resultat tardif sans ecraser les corrections humaines', async () => {
    const snapshot = await supplierInvoiceAnalysisDraftSnapshot({
      importId: 'import-1', revision: 4, inputSha256: sha, draft: draft(),
    });
    const current = await supplierInvoiceAnalysisDraftSnapshot({
      importId: 'import-1', revision: 5, inputSha256: sha, draft: draft(),
    });

    expect(() => assertSupplierInvoiceAnalysisDraftUnchanged(snapshot, current)).toThrow(
      /saisies humaines ont ete conservees/,
    );
  });

  it('refuse un resultat calcule sur un autre fichier', async () => {
    const snapshot = await supplierInvoiceAnalysisDraftSnapshot({
      importId: 'import-1', revision: 4, inputSha256: sha, draft: draft(),
    });
    const current = await supplierInvoiceAnalysisDraftSnapshot({
      importId: 'import-1', revision: 4, inputSha256: 'b'.repeat(64), draft: draft(),
    });

    expect(() => assertSupplierInvoiceAnalysisDraftUnchanged(snapshot, current)).toThrow(
      /document ou le brouillon a change/,
    );
  });

  it('refuse un brouillon modifie meme si l appelant oublie d incrementer la revision', async () => {
    const snapshot = await supplierInvoiceAnalysisDraftSnapshot({
      importId: 'import-1', revision: 4, inputSha256: sha, draft: draft('INV-42'),
    });
    const current = await supplierInvoiceAnalysisDraftSnapshot({
      importId: 'import-1', revision: 4, inputSha256: sha, draft: draft('INV-47'),
    });
    expect(() => assertSupplierInvoiceAnalysisDraftUnchanged(snapshot, current)).toThrow(
      /document ou le brouillon a change/,
    );
  });

  it('refuse un snapshot incomplet plutot que d accepter une garde affaiblie', async () => {
    await expect(supplierInvoiceAnalysisDraftSnapshot({
      importId: '', revision: 0, inputSha256: sha, draft: draft(),
    })).rejects.toThrow(/identifiant d'import manque/);
    await expect(supplierInvoiceAnalysisDraftSnapshot({
      importId: 'import-1', revision: -1, inputSha256: sha, draft: draft(),
    })).rejects.toThrow(/revision.*invalide/);
    await expect(supplierInvoiceAnalysisDraftSnapshot({
      importId: 'import-1', revision: 0, inputSha256: 'abc', draft: draft(),
    })).rejects.toThrow(/hash source.*invalide/);
  });
});
