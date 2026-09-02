import { describe, expect, it } from 'vitest';
import {
  buildSupplierInvoiceHumanReviewAttestation,
  canonicalSupplierInvoiceBusinessReviewJson,
  canonicalSupplierInvoiceJson,
  reconcileSupplierInvoiceAnalysisManifest,
  supplierInvoiceAnalysisManifestFromAi,
  supplierInvoiceDraftSha256,
  type SupplierInvoiceAnalysisManifest,
} from './supplierInvoiceAnalysisManifest';
import type {
  ReconciledSupplierInvoiceAiDraft,
  SupplierInvoiceAiDraft,
  SupplierInvoiceAiProvenance,
} from './supplierInvoiceAiDraft';
import type { SupplierInvoiceHumanBusinessReview } from './supplierInvoiceImportQuality';

const sourceSha256 = 'a'.repeat(64);

function analyzedDraft(): SupplierInvoiceAiDraft {
  return {
    supplier: {
      printedName: 'Materiaux Exemple SA',
      uidNumber: 'CHE-123.456.789',
      iban: 'CH93 0076 2011 6238 5295 7',
    },
    reference: 'INV-42',
    invoiceDate: '2026-09-01',
    dueDate: '2026-09-30',
    currency: 'CHF',
    printedNetCents: 20_000,
    printedVatCents: 1_620,
    printedTotalCents: 21_620,
    lines: [
      {
        occurrenceId: 'supplier-line:p1:o1',
        description: 'Sac de mortier',
        quantityMilli: 1_000,
        unit: 'piece',
        unitPriceCents: 10_000,
        discountBp: 0,
        vatBp: 810,
        printedNetCents: 10_000,
        printedVatCents: 810,
        printedTotalCents: 10_810,
      },
      {
        occurrenceId: 'supplier-line:p1:o2',
        description: 'Sac de mortier',
        quantityMilli: 1_000,
        unit: 'piece',
        unitPriceCents: 10_000,
        discountBp: 0,
        vatBp: 810,
        printedNetCents: 10_000,
        printedVatCents: 810,
        printedTotalCents: 10_810,
      },
    ],
    warnings: [],
  };
}

function analyzedProvenance(): SupplierInvoiceAiProvenance {
  const fields: SupplierInvoiceAiProvenance['fields'] = {
    'supplier.printed_name': { pages: [1], passIndexes: [1, 2] },
    reference: { pages: [1], passIndexes: [1, 2] },
    invoice_date: { pages: [1], passIndexes: [1, 2] },
    due_date: { pages: [1], passIndexes: [1, 2] },
    currency: { pages: [1], passIndexes: [1, 2] },
    printed_net_cents: { pages: [1], passIndexes: [1, 2] },
    printed_vat_cents: { pages: [1], passIndexes: [1, 2] },
    printed_total_cents: { pages: [1], passIndexes: [1, 2] },
  };
  return {
    fields,
    lines: [
      { occurrenceId: 'supplier-line:p1:o1', lineIndex: 0, pages: [1], passIndexes: [1, 2] },
      { occurrenceId: 'supplier-line:p1:o2', lineIndex: 1, pages: [1], passIndexes: [1, 2] },
    ],
    conflicts: [],
  };
}

function businessReview(draft = analyzedDraft()): SupplierInvoiceHumanBusinessReview {
  return {
    existingSupplierId: 'supplier-existing',
    supplierSelectedByHuman: true,
    roundingPolicy: 'stepwise-half-up',
    roundingPolicyConfirmedByHuman: true,
    lines: draft.lines.map((line) => ({
      occurrenceId: line.occurrenceId,
      category: 'Materiaux',
      categoryChosenByHuman: true,
    })),
  };
}

function reconciledAnalysis(
  draft = analyzedDraft(),
  provenance = analyzedProvenance(),
): ReconciledSupplierInvoiceAiDraft {
  return {
    analysisContext: {
      analyzedPageCount: 1,
      inputSha256: sourceSha256,
      modelId: 'HuggingFaceTB/SmolVLM-500M-Instruct',
      modelRevision: 'revision-pinned',
    },
    draft,
    provenance,
  };
}

function manifestFor(
  draft = analyzedDraft(),
  provenance = analyzedProvenance(),
): SupplierInvoiceAnalysisManifest {
  return supplierInvoiceAnalysisManifestFromAi({
    reconciled: reconciledAnalysis(draft, provenance),
    analyzedAt: '2026-09-02T10:00:00.000Z',
  });
}

describe('manifeste d analyse de facture fournisseur', () => {
  it('lie chaque champ et occurrence aux pages, passes, hash et revision du modele', () => {
    const manifest = manifestFor();

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      inputSha256: sourceSha256,
      analyzedPages: [1],
      passes: 2,
      modelRevision: 'revision-pinned',
    });
    expect(manifest.fieldProvenance).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'reference', value: 'INV-42', pages: [1], passIndexes: [1, 2], confidenceBp: 9_000 }),
    ]));
    expect(manifest.lineProvenance.map((item) => item.occurrenceId)).toEqual([
      'supplier-line:p1:o1',
      'supplier-line:p1:o2',
    ]);
  });

  it('retire seulement le champ et l occurrence modifies puis reindexe l occurrence intacte', () => {
    const previous = analyzedDraft();
    const manifest = manifestFor(previous);
    const next: SupplierInvoiceAiDraft = {
      ...previous,
      supplier: { ...previous.supplier },
      reference: 'INV-42-CORRIGE',
      lines: [
        { ...previous.lines[1] },
        { ...previous.lines[0], unitPriceCents: 9_000 },
      ],
      warnings: [...previous.warnings],
    };

    const reconciled = reconcileSupplierInvoiceAnalysisManifest(manifest, previous, next);

    expect(reconciled.fieldProvenance.map((item) => item.field)).not.toContain('reference');
    expect(reconciled.fieldProvenance.map((item) => item.field)).toContain('currency');
    expect(reconciled.lineProvenance).toEqual([
      expect.objectContaining({ occurrenceId: 'supplier-line:p1:o2', lineIndex: 0 }),
    ]);
    expect(manifest.lineProvenance).toHaveLength(2);
  });

  it('ne transfere jamais la preuve vers une nouvelle occurrence pourtant identique', () => {
    const previous = analyzedDraft();
    const manifest = manifestFor(previous);
    const next: SupplierInvoiceAiDraft = {
      ...previous,
      supplier: { ...previous.supplier },
      lines: [
        { ...previous.lines[0], occurrenceId: 'human-line' },
        { ...previous.lines[1] },
      ],
      warnings: [],
    };

    const reconciled = reconcileSupplierInvoiceAnalysisManifest(manifest, previous, next);

    expect(reconciled.lineProvenance.map((item) => item.occurrenceId)).toEqual([
      'supplier-line:p1:o2',
    ]);
  });

  it('produit un SHA de brouillon deterministe avec Web Crypto', async () => {
    const first = analyzedDraft();
    const second: SupplierInvoiceAiDraft = JSON.parse(JSON.stringify(first)) as SupplierInvoiceAiDraft;

    await expect(supplierInvoiceDraftSha256(first)).resolves.toMatch(/^[0-9a-f]{64}$/);
    await expect(supplierInvoiceDraftSha256(second)).resolves.toBe(await supplierInvoiceDraftSha256(first));
  });

  it('construit une attestation deterministe uniquement apres confirmation explicite', async () => {
    const draft = analyzedDraft();
    const manifest = manifestFor(draft);

    await expect(buildSupplierInvoiceHumanReviewAttestation({
      draft,
      manifest,
      businessReview: businessReview(draft),
      sourceSha256,
      humanConfirmed: false,
    })).rejects.toThrow(/confirmation humaine explicite/);

    const first = await buildSupplierInvoiceHumanReviewAttestation({
      draft,
      manifest,
      businessReview: businessReview(draft),
      sourceSha256,
      humanConfirmed: true,
    });
    const second = await buildSupplierInvoiceHumanReviewAttestation({
      draft,
      manifest,
      businessReview: businessReview(draft),
      sourceSha256,
      humanConfirmed: true,
    });
    expect(first).toEqual(second);
    expect(first.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.attestation.draftSha256).toBe(await supplierInvoiceDraftSha256(draft));
    expect(first.attestation.businessReviewSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.attestation.roundingPolicy).toBe('stepwise-half-up');
    const changedReview = businessReview(draft);
    changedReview.lines[0] = { ...changedReview.lines[0], category: 'Outillage' };
    const changedAttestation = await buildSupplierInvoiceHumanReviewAttestation({
      draft,
      manifest,
      businessReview: changedReview,
      sourceSha256,
      humanConfirmed: true,
    });
    expect(changedAttestation.attestation.businessReviewSha256).not.toBe(
      first.attestation.businessReviewSha256,
    );
  });

  it('refuse une attestation liee a un autre fichier ou a un conflit non resolu', async () => {
    const draft = analyzedDraft();
    const manifest = manifestFor(draft);
    await expect(buildSupplierInvoiceHumanReviewAttestation({
      draft,
      manifest,
      businessReview: businessReview(draft),
      sourceSha256: 'b'.repeat(64),
      humanConfirmed: true,
    })).rejects.toThrow(/ne correspond pas au hash/);

    const conflicted: SupplierInvoiceAnalysisManifest = {
      ...manifest,
      conflicts: [{
        target: 'reference',
        kind: 'field',
        values: ['INV-42', 'INV-47'],
        pages: [1],
        passIndexes: [1, 2],
      }],
    };
    await expect(buildSupplierInvoiceHumanReviewAttestation({
      draft,
      manifest: conflicted,
      businessReview: businessReview(draft),
      sourceSha256,
      humanConfirmed: true,
    })).rejects.toThrow(/conflits entre passes/);
  });

  it('refuse de certifier un brouillon non CHF ou une politique non confirmee', async () => {
    const draft = analyzedDraft();
    const manifest = manifestFor(draft);
    const eurDraft = { ...draft, supplier: { ...draft.supplier }, currency: 'EUR' };
    await expect(buildSupplierInvoiceHumanReviewAttestation({
      draft: eurDraft,
      manifest,
      businessReview: businessReview(eurDraft),
      sourceSha256,
      humanConfirmed: true,
    })).rejects.toThrow(/devise doit etre explicitement CHF/);

    const unconfirmedPolicy = businessReview(draft);
    unconfirmedPolicy.roundingPolicyConfirmedByHuman = false;
    await expect(buildSupplierInvoiceHumanReviewAttestation({
      draft,
      manifest,
      businessReview: unconfirmedPolicy,
      sourceSha256,
      humanConfirmed: true,
    })).rejects.toThrow(/politique d'arrondi.*confirmee manuellement/);
  });

  it('lie le hash aux choix metier canoniques sans dependre de l ordre des lignes', () => {
    const first = businessReview();
    const reordered = { ...first, lines: [...first.lines].reverse() };
    expect(canonicalSupplierInvoiceBusinessReviewJson(reordered)).toBe(
      canonicalSupplierInvoiceBusinessReviewJson(first),
    );

    const changed = businessReview();
    changed.lines[0] = { ...changed.lines[0], category: 'Outillage' };
    expect(canonicalSupplierInvoiceBusinessReviewJson(changed)).not.toBe(
      canonicalSupplierInvoiceBusinessReviewJson(first),
    );
  });

  it('rejette les cles de prototype, objets non JSON et cycles avant le hash', () => {
    const hostile = JSON.parse('{"__proto__":{"evidence":"different"},"a":1}') as unknown;
    expect(() => canonicalSupplierInvoiceJson(hostile)).toThrow(/cle de prototype/);
    expect(() => canonicalSupplierInvoiceJson(new Date())).toThrow(/objets JSON simples/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalSupplierInvoiceJson(cyclic)).toThrow(/cyclique ou partagee/);
  });

  it('conserve un conflit jusqu a une resolution humaine ciblee et le rouvre si elle devient obsolete', async () => {
    const previous = analyzedDraft();
    previous.reference = '';
    const provenance = analyzedProvenance();
    delete provenance.fields.reference;
    provenance.conflicts = [{
      target: 'reference',
      kind: 'field',
      values: ['INV-42', 'INV-47'],
      pages: [1],
      passIndexes: [1, 2],
    }];
    const manifest = manifestFor(previous, provenance);
    const corrected = { ...previous, supplier: { ...previous.supplier }, reference: 'INV-42' };

    const stillOpen = reconcileSupplierInvoiceAnalysisManifest(manifest, previous, corrected);
    expect(stillOpen.conflicts).toHaveLength(1);
    expect(() => reconcileSupplierInvoiceAnalysisManifest(manifest, previous, corrected, [{
      target: 'reference',
      resolvedCanonicalValue: 'INV-42',
      confirmedByHuman: false,
    }])).toThrow(/confirmation humaine explicite/);

    const resolved = reconcileSupplierInvoiceAnalysisManifest(manifest, previous, corrected, [{
      target: 'reference',
      resolvedCanonicalValue: 'INV-42',
      confirmedByHuman: true,
    }]);
    expect(resolved.conflicts).toEqual([]);
    expect(resolved.resolvedConflicts).toEqual([
      expect.objectContaining({ resolvedCanonicalValue: 'INV-42', confirmedByHuman: true }),
    ]);
    await expect(buildSupplierInvoiceHumanReviewAttestation({
      draft: corrected,
      manifest: resolved,
      businessReview: businessReview(corrected),
      sourceSha256,
      humanConfirmed: true,
    })).resolves.toEqual(expect.objectContaining({
      evidenceSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));

    const changedAgain = { ...corrected, reference: 'INV-42-BIS' };
    const reopened = reconcileSupplierInvoiceAnalysisManifest(resolved, corrected, changedAgain);
    expect(reopened.conflicts).toHaveLength(1);
    expect(reopened.resolvedConflicts).toEqual([]);
  });
});
