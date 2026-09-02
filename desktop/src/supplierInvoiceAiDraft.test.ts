import { describe, expect, it } from 'vitest';
import {
  parseSupplierInvoiceAiPass,
  reconcileSupplierInvoiceAiPasses,
  reconcileSupplierInvoiceAiJsonPasses,
} from './supplierInvoiceAiDraft';

const analysisIdentity = {
  inputSha256: 'a'.repeat(64),
  modelId: 'HuggingFaceTB/SmolVLM-500M-Instruct',
  modelRevision: 'revision-pinned',
};

function invoicePayload() {
  return {
    supplier: {
      printed_name: 'Materiaux Exemple SA',
      uid_number: 'CHE-123.456.789',
      iban: 'CH93 0076 2011 6238 5295 7',
    },
    reference: 'INV-2026-0042',
    invoice_date: '2026-09-01',
    due_date: '2026-09-30',
    currency: 'CHF',
    printed_net_cents: 20_000,
    printed_vat_cents: 1_620,
    printed_total_cents: 21_620,
    field_pages: {
      'supplier.printed_name': [1],
      'supplier.uid_number': [1],
      'supplier.iban': [1],
      reference: [1],
      invoice_date: [1],
      due_date: [1],
      currency: [1],
      printed_net_cents: [1],
      printed_vat_cents: [1],
      printed_total_cents: [1],
    },
    lines: [
      {
        source_ordinal: 1,
        pages: [1],
        description: 'Sac de mortier',
        quantity_milli: 1_000,
        unit: 'piece',
        unit_price_cents: 10_000,
        discount_bp: 0,
        vat_bp: 810,
        printed_net_cents: 10_000,
        printed_vat_cents: 810,
        printed_total_cents: 10_810,
      },
      {
        source_ordinal: 2,
        pages: [1],
        description: 'Sac de mortier',
        quantity_milli: 1_000,
        unit: 'piece',
        unit_price_cents: 10_000,
        discount_bp: 0,
        vat_bp: 810,
        printed_net_cents: 10_000,
        printed_vat_cents: 810,
        printed_total_cents: 10_810,
      },
    ],
    warnings: [],
  };
}

describe('contrat hostile de sortie IA pour facture fournisseur', () => {
  it('conserve deux occurrences imprimees identiques avec des identites distinctes', () => {
    const raw = JSON.stringify(invoicePayload());
    const result = reconcileSupplierInvoiceAiJsonPasses({
      primaryRaw: raw,
      verificationRaw: raw,
      analyzedPageCount: 1,
      ...analysisIdentity,
    });

    expect(result.draft.lines).toHaveLength(2);
    expect(result.draft.lines.map((line) => line.occurrenceId)).toEqual([
      'supplier-line:p1:o1',
      'supplier-line:p1:o2',
    ]);
    expect(result.provenance.lines).toEqual([
      expect.objectContaining({ occurrenceId: 'supplier-line:p1:o1', pages: [1], passIndexes: [1, 2] }),
      expect.objectContaining({ occurrenceId: 'supplier-line:p1:o2', pages: [1], passIndexes: [1, 2] }),
    ]);
    expect(result.analysisContext).toEqual({
      analyzedPageCount: 1,
      ...analysisIdentity,
    });
  });

  it('rend explicites les divergences et ne choisit aucune passe arbitrairement', () => {
    const primary = invoicePayload();
    const verification = invoicePayload();
    verification.reference = 'INV-2026-0047';
    verification.lines[0].unit_price_cents = 9_000;

    const result = reconcileSupplierInvoiceAiJsonPasses({
      primaryRaw: JSON.stringify(primary),
      verificationRaw: JSON.stringify(verification),
      analyzedPageCount: 1,
      ...analysisIdentity,
    });

    expect(result.draft.reference).toBe('');
    expect(result.draft.lines.map((line) => line.occurrenceId)).toEqual(['supplier-line:p1:o2']);
    expect(result.provenance.conflicts.map((conflict) => conflict.target)).toEqual([
      'reference',
      'line:supplier-line:p1:o1',
    ]);
    expect(result.provenance.conflicts[0].passIndexes).toEqual([1, 2]);
  });

  it('preserve une devise observee non prise en charge afin que la qualite la bloque', () => {
    const payload = invoicePayload();
    payload.currency = 'eur';
    const parsed = parseSupplierInvoiceAiPass({
      raw: JSON.stringify(payload),
      passIndex: 1,
      analyzedPageCount: 1,
      ...analysisIdentity,
    });

    expect(parsed.draft.currency).toBe('EUR');
  });

  it('refuse toute selection metier proposee par le modele', () => {
    const payload = invoicePayload() as ReturnType<typeof invoicePayload> & { supplier_id?: string };
    payload.supplier_id = 'supplier-existing';

    expect(() => parseSupplierInvoiceAiPass({
      raw: JSON.stringify(payload),
      passIndex: 1,
      analyzedPageCount: 1,
      ...analysisIdentity,
    })).toThrow(/ne peut ni creer ni choisir fournisseur/);
  });

  it('refuse les nombres encodes en texte et les champs sans page source', () => {
    const numericString = invoicePayload();
    (numericString as unknown as Record<string, unknown>).printed_total_cents = '21620';
    expect(() => parseSupplierInvoiceAiPass({
      raw: JSON.stringify(numericString),
      passIndex: 1,
      analyzedPageCount: 1,
      ...analysisIdentity,
    })).toThrow(/printed_total_cents doit etre un entier/);

    const missingPages = invoicePayload();
    delete (missingPages.field_pages as Partial<typeof missingPages.field_pages>).reference;
    expect(() => parseSupplierInvoiceAiPass({
      raw: JSON.stringify(missingPages),
      passIndex: 1,
      analyzedPageCount: 1,
      ...analysisIdentity,
    })).toThrow(/field_pages.reference doit indiquer au moins une page/);
  });

  it('refuse la 41e occurrence sans tronquer le resultat', () => {
    const payload = invoicePayload();
    payload.lines = Array.from({ length: 41 }, (_, index) => ({
      ...payload.lines[0],
      source_ordinal: index + 1,
      description: `Ligne ${index + 1}`,
    }));

    expect(() => parseSupplierInvoiceAiPass({
      raw: JSON.stringify(payload),
      passIndex: 1,
      analyzedPageCount: 1,
      ...analysisIdentity,
    })).toThrow(/41 occurrences.*40, sans troncature/);
  });

  it('refuse un JSON incomplet au lieu de tenter une reparation permissive', () => {
    expect(() => parseSupplierInvoiceAiPass({
      raw: '{"currency":"CHF"',
      passIndex: 1,
      analyzedPageCount: 1,
      ...analysisIdentity,
    })).toThrow(/JSON complet et valide/);
  });

  it('refuse de reconcilier des passes liees a des fichiers ou modeles differents', () => {
    const raw = JSON.stringify(invoicePayload());
    const primary = parseSupplierInvoiceAiPass({
      raw,
      passIndex: 1,
      analyzedPageCount: 1,
      ...analysisIdentity,
    });
    const verification = parseSupplierInvoiceAiPass({
      raw,
      passIndex: 2,
      analyzedPageCount: 1,
      ...analysisIdentity,
      inputSha256: 'b'.repeat(64),
    });

    expect(() => reconcileSupplierInvoiceAiPasses(primary, verification)).toThrow(
      /meme fichier et a la meme revision du modele/,
    );
  });

  it('refuse profondeur et nombre de noeuds hostiles sans depassement de pile', () => {
    const deeplyNested = invoicePayload() as ReturnType<typeof invoicePayload> & { noise?: unknown };
    let noise: unknown = 0;
    for (let depth = 0; depth < 40; depth += 1) noise = { child: noise };
    deeplyNested.noise = noise;
    expect(() => parseSupplierInvoiceAiPass({
      raw: JSON.stringify(deeplyNested),
      passIndex: 1,
      analyzedPageCount: 1,
      ...analysisIdentity,
    })).toThrow(/profondeur maximale/);

    const tooManyNodes = invoicePayload() as ReturnType<typeof invoicePayload> & { noise?: unknown };
    tooManyNodes.noise = Array.from({ length: 20_001 }, () => 0);
    expect(() => parseSupplierInvoiceAiPass({
      raw: JSON.stringify(tooManyNodes),
      passIndex: 1,
      analyzedPageCount: 1,
      ...analysisIdentity,
    })).toThrow(/noeuds autorises/);
  });
});
