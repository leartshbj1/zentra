import { describe, expect, it } from 'vitest';
import {
  assessSupplierInvoiceConfirmation,
  assessSupplierInvoiceDraft,
  computeSupplierInvoiceLineTotals,
  isValidSupplierInvoiceIsoDate,
  type SupplierInvoiceHumanBusinessReview,
} from './supplierInvoiceImportQuality';
import type { SupplierInvoiceAiDraft } from './supplierInvoiceAiDraft';

const roundingPolicy = 'stepwise-half-up' as const;
const roundingSelection = { policy: roundingPolicy, confirmedByHuman: true } as const;

function validDraft(): SupplierInvoiceAiDraft {
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

function humanReview(draft: SupplierInvoiceAiDraft): SupplierInvoiceHumanBusinessReview {
  return {
    existingSupplierId: 'supplier-existing',
    supplierSelectedByHuman: true,
    roundingPolicy,
    roundingPolicyConfirmedByHuman: true,
    lines: draft.lines.map((line) => ({
      occurrenceId: line.occurrenceId,
      category: 'Materiaux',
      categoryChosenByHuman: true,
    })),
  };
}

describe('controles deterministes de facture fournisseur', () => {
  it('accepte deux occurrences identiques lorsqu elles ont des identites distinctes et des totaux exacts', () => {
    const draft = validDraft();
    const assessment = assessSupplierInvoiceDraft(draft, [], roundingSelection);

    expect(assessment.ready).toBe(true);
    expect(assessment.blockers).toEqual([]);
    expect(assessment.computedTotals).toEqual({
      netCents: 20_000,
      vatCents: 1_620,
      totalCents: 21_620,
    });
    expect(assessSupplierInvoiceConfirmation({
      draft,
      businessReview: humanReview(draft),
    }).ready).toBe(true);
  });

  it('calcule exactement quantite, remise et TVA en entiers', () => {
    const line = {
      ...validDraft().lines[0],
      quantityMilli: 2_500,
      unitPriceCents: 1_999,
      discountBp: 500,
      vatBp: 810,
    };

    expect(computeSupplierInvoiceLineTotals(line, roundingPolicy)).toEqual({
      netCents: 4_748,
      vatCents: 385,
      totalCents: 5_133,
    });
  });

  it('bloque toute devise autre que CHF sans la convertir', () => {
    const draft = { ...validDraft(), currency: 'EUR' };
    const assessment = assessSupplierInvoiceDraft(draft, [], roundingSelection);

    expect(assessment.ready).toBe(false);
    expect(assessment.blockers.join(' ')).toMatch(/devise doit etre explicitement CHF/);
    expect(draft.currency).toBe('EUR');
  });

  it('bloque un ecart entre lignes et totaux imprimes', () => {
    const wrongSummary = { ...validDraft(), printedTotalCents: 21_621 };
    expect(assessSupplierInvoiceDraft(wrongSummary, [], roundingSelection).blockers.join(' ')).toMatch(
      /total imprime.*net imprime|somme exacte des lignes/,
    );

    const wrongLine = validDraft();
    wrongLine.lines[0] = { ...wrongLine.lines[0], printedTotalCents: 10_811 };
    expect(assessSupplierInvoiceDraft(wrongLine, [], roundingSelection).blockers.join(' ')).toMatch(
      /Ligne 1.*ne correspondent pas/,
    );
  });

  it('bloque les valeurs absentes au lieu de supposer remise, TVA ou unite', () => {
    const draft = validDraft();
    draft.lines[0] = {
      ...draft.lines[0],
      unit: '',
      discountBp: null,
      vatBp: null,
    };

    const blockers = assessSupplierInvoiceDraft(draft, [], roundingSelection).blockers.join(' ');
    expect(blockers).toMatch(/unite manque/);
    expect(blockers).toMatch(/quantite, prix, remise et TVA/);
  });

  it('bloque la 41e occurrence sans modifier le brouillon', () => {
    const draft = validDraft();
    draft.lines = Array.from({ length: 41 }, (_, index) => ({
      ...draft.lines[0],
      occurrenceId: `supplier-line:p1:o${index + 1}`,
    }));
    const before = draft.lines.length;

    const assessment = assessSupplierInvoiceDraft(draft, [], roundingSelection);

    expect(assessment.blockers.join(' ')).toMatch(/41 occurrences.*40, sans troncature/);
    expect(draft.lines).toHaveLength(before);
  });

  it('bloque tout conflit entre les deux passes', () => {
    const draft = validDraft();
    const assessment = assessSupplierInvoiceDraft(draft, [{
      target: 'reference',
      kind: 'field',
      values: ['INV-42', 'INV-47'],
      pages: [1],
      passIndexes: [1, 2],
    }], roundingSelection);

    expect(assessment.ready).toBe(false);
    expect(assessment.blockers.join(' ')).toMatch(/conflit.*resolus explicitement/);
  });

  it('exige des choix humains pour fournisseur, projet, categorie et compte existants', () => {
    const draft = validDraft();
    const review = humanReview(draft);
    review.supplierSelectedByHuman = false;
    review.existingProjectId = 'project-existing';
    review.projectSelectedByHuman = false;
    review.lines[0] = {
      ...review.lines[0],
      categoryChosenByHuman: false,
      existingExpenseAccountId: 'account-existing',
      expenseAccountSelectedByHuman: false,
    };

    const blockers = assessSupplierInvoiceConfirmation({ draft, businessReview: review }).blockers.join(' ');
    expect(blockers).toMatch(/fournisseur existant.*confirme manuellement/);
    expect(blockers).toMatch(/projet renseigne.*choisi manuellement/);
    expect(blockers).toMatch(/categorie de cout.*choisie manuellement/);
    expect(blockers).toMatch(/compte de charge.*choisi manuellement/);
  });

  it('refuse les dates civiles impossibles et une echeance anterieure', () => {
    expect(isValidSupplierInvoiceIsoDate('2026-02-29')).toBe(false);
    expect(isValidSupplierInvoiceIsoDate('2028-02-29')).toBe(true);
    const draft = { ...validDraft(), dueDate: '2026-08-31' };
    expect(assessSupplierInvoiceDraft(draft, [], roundingSelection).blockers.join(' ')).toMatch(/echeance ne peut pas preceder/);
  });

  it('bloque toute politique implicite et exige sa confirmation humaine', () => {
    const draft = validDraft();
    expect(assessSupplierInvoiceDraft(draft).blockers.join(' ')).toMatch(
      /politique d'arrondi.*choisie explicitement/,
    );
    const review = humanReview(draft);
    review.roundingPolicyConfirmedByHuman = false;
    expect(assessSupplierInvoiceConfirmation({ draft, businessReview: review }).blockers.join(' ')).toMatch(
      /politique d'arrondi.*confirmee manuellement/,
    );
  });

  it('applique exactement la convention d arrondi choisie au lieu d en inventer une', () => {
    const line = {
      ...validDraft().lines[0],
      quantityMilli: 2_400,
      unitPriceCents: 1,
      discountBp: 2_500,
      vatBp: 0,
    };
    expect(computeSupplierInvoiceLineTotals(line, 'stepwise-half-up')?.netCents).toBe(1);
    expect(computeSupplierInvoiceLineTotals(line, 'net-after-discount-half-up')?.netCents).toBe(2);
  });
});
