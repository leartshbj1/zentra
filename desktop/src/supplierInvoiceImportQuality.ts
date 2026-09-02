import {
  SUPPLIER_INVOICE_MAX_LINE_OCCURRENCES,
  type SupplierInvoiceAiConflict,
  type SupplierInvoiceAiDraft,
  type SupplierInvoiceAiLine,
} from './supplierInvoiceAiDraft';

export type SupplierInvoiceDraftAssessment = {
  ready: boolean;
  scoreBp: number;
  blockers: string[];
  warnings: string[];
  checks: Array<{ label: string; ok: boolean; detail: string }>;
  computedTotals: {
    netCents: number;
    vatCents: number;
    totalCents: number;
  } | null;
};

export const SUPPLIER_INVOICE_ROUNDING_POLICIES = [
  'stepwise-half-up',
  'net-after-discount-half-up',
] as const;

export type SupplierInvoiceRoundingPolicy = typeof SUPPLIER_INVOICE_ROUNDING_POLICIES[number];

export type SupplierInvoiceRoundingSelection = {
  policy: SupplierInvoiceRoundingPolicy;
  confirmedByHuman: boolean;
};

export type SupplierInvoiceHumanLineClassification = {
  occurrenceId: string;
  category: string;
  categoryChosenByHuman: boolean;
  existingExpenseAccountId?: string;
  expenseAccountSelectedByHuman?: boolean;
  existingProjectId?: string;
  projectSelectedByHuman?: boolean;
};

/**
 * Ces identifiants referencent uniquement des entites deja existantes. Le
 * contrat d'analyse ne contient volontairement aucune instruction de creation.
 */
export type SupplierInvoiceHumanBusinessReview = {
  existingSupplierId: string;
  supplierSelectedByHuman: boolean;
  existingProjectId?: string;
  projectSelectedByHuman?: boolean;
  roundingPolicy: SupplierInvoiceRoundingPolicy;
  roundingPolicyConfirmedByHuman: boolean;
  lines: SupplierInvoiceHumanLineClassification[];
};

function unique(values: string[]) {
  return [...new Set(values)];
}

export function isValidSupplierInvoiceIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function exactRoundedRatio(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

export function isSupplierInvoiceRoundingPolicy(
  value: unknown,
): value is SupplierInvoiceRoundingPolicy {
  return typeof value === 'string'
    && (SUPPLIER_INVOICE_ROUNDING_POLICIES as readonly string[]).includes(value);
}

export function computeSupplierInvoiceLineTotals(
  line: SupplierInvoiceAiLine,
  roundingPolicy: SupplierInvoiceRoundingPolicy,
): {
  netCents: number;
  vatCents: number;
  totalCents: number;
} | null {
  if (!isSupplierInvoiceRoundingPolicy(roundingPolicy)) return null;
  const values = [line.quantityMilli, line.unitPriceCents, line.discountBp, line.vatBp];
  if (values.some((value) => value === null || !Number.isSafeInteger(value))) return null;
  const quantityMilli = line.quantityMilli as number;
  const unitPriceCents = line.unitPriceCents as number;
  const discountBp = line.discountBp as number;
  const vatBp = line.vatBp as number;
  if (quantityMilli <= 0
    || quantityMilli > 1_000_000_000
    || unitPriceCents < 0
    || unitPriceCents > 10_000_000_000
    || discountBp < 0
    || discountBp > 10_000
    || vatBp < 0
    || vatBp > 10_000) return null;

  const quantity = BigInt(quantityMilli);
  const unitPrice = BigInt(unitPriceCents);
  const discountRate = BigInt(discountBp);
  let net: bigint;
  if (roundingPolicy === 'stepwise-half-up') {
    const base = exactRoundedRatio(quantity * unitPrice, 1_000n);
    const discount = exactRoundedRatio(base * discountRate, 10_000n);
    net = base - discount;
  } else {
    net = exactRoundedRatio(
      quantity * unitPrice * (10_000n - discountRate),
      1_000n * 10_000n,
    );
  }
  const vat = exactRoundedRatio(net * BigInt(vatBp), 10_000n);
  const total = net + vat;
  if ([net, vat, total].some((value) => value > BigInt(Number.MAX_SAFE_INTEGER))) return null;
  return { netCents: Number(net), vatCents: Number(vat), totalCents: Number(total) };
}

function printedLineAmountsMatch(
  line: SupplierInvoiceAiLine,
  computed: NonNullable<ReturnType<typeof computeSupplierInvoiceLineTotals>>,
) {
  return (line.printedNetCents === null || line.printedNetCents === computed.netCents)
    && (line.printedVatCents === null || line.printedVatCents === computed.vatCents)
    && (line.printedTotalCents === null || line.printedTotalCents === computed.totalCents);
}

export function assessSupplierInvoiceDraft(
  draft: SupplierInvoiceAiDraft,
  conflicts: readonly SupplierInvoiceAiConflict[] = [],
  roundingSelection?: SupplierInvoiceRoundingSelection | null,
): SupplierInvoiceDraftAssessment {
  const blockers: string[] = [];
  const warnings = [...draft.warnings];
  const currencyValid = draft.currency.trim().toUpperCase() === 'CHF';
  const invoiceDateValid = isValidSupplierInvoiceIsoDate(draft.invoiceDate);
  const dueDateValid = isValidSupplierInvoiceIsoDate(draft.dueDate);
  const chronologyValid = invoiceDateValid
    && dueDateValid
    && draft.dueDate >= draft.invoiceDate;
  const uniqueOccurrenceIds = new Set(draft.lines.map((line) => line.occurrenceId)).size === draft.lines.length
    && draft.lines.every((line) => Boolean(line.occurrenceId.trim()));
  const roundingPolicy = roundingSelection?.policy;
  const roundingPolicyValid = isSupplierInvoiceRoundingPolicy(roundingPolicy);
  const roundingPolicyConfirmed = roundingPolicyValid
    && roundingSelection?.confirmedByHuman === true;

  if (!draft.reference.trim()) blockers.push('La reference imprimee de la facture manque.');
  if (!currencyValid) blockers.push('La devise doit etre explicitement CHF; aucune conversion ou devise de secours n\'est appliquee.');
  if (!invoiceDateValid) blockers.push('La date de facture doit etre une date civile ISO valide.');
  if (!dueDateValid) blockers.push('L\'echeance doit etre une date civile ISO valide saisie ou controlee humainement.');
  if (invoiceDateValid && dueDateValid && !chronologyValid) blockers.push('L\'echeance ne peut pas preceder la date de facture.');
  if (!draft.lines.length) blockers.push('Aucune occurrence de ligne exploitable n\'a ete confirmee par les deux passes.');
  if (draft.lines.length > SUPPLIER_INVOICE_MAX_LINE_OCCURRENCES) {
    blockers.push(
      `La facture contient ${draft.lines.length} occurrences; la limite est ${SUPPLIER_INVOICE_MAX_LINE_OCCURRENCES}, sans troncature.`,
    );
  }
  if (!uniqueOccurrenceIds) blockers.push('Chaque occurrence de ligne doit posseder un identifiant documentaire unique et stable.');
  if (conflicts.length) {
    blockers.push(`${conflicts.length} conflit(s) entre les deux passes doivent etre resolus explicitement.`);
  }
  if (!roundingPolicyValid) {
    blockers.push('Une politique d\'arrondi prise en charge doit etre choisie explicitement; aucune politique implicite n\'est appliquee.');
  } else if (!roundingPolicyConfirmed) {
    blockers.push('La politique d\'arrondi doit etre confirmee humainement avant tout brouillon exploitable.');
  }

  const computedLines = roundingPolicyValid
    ? draft.lines.map((line) => computeSupplierInvoiceLineTotals(line, roundingPolicy))
    : draft.lines.map(() => null);
  draft.lines.forEach((line, index) => {
    if (!line.description.trim()) blockers.push(`Ligne ${index + 1}: la description manque.`);
    if (!line.unit.trim()) blockers.push(`Ligne ${index + 1}: l'unite manque; aucune unite par defaut n'est inventee.`);
    if (!roundingPolicyValid) return;
    const computed = computedLines[index];
    if (!computed) {
      blockers.push(`Ligne ${index + 1}: quantite, prix, remise et TVA doivent etre des valeurs entieres valides et controlees.`);
      return;
    }
    if (!printedLineAmountsMatch(line, computed)) {
      blockers.push(`Ligne ${index + 1}: les montants imprimes ne correspondent pas au calcul quantite/remise/TVA.`);
    }
  });

  const allLinesComputable = computedLines.every((line) => line !== null);
  const summedTotals = allLinesComputable
    ? computedLines.reduce((sum, line) => ({
      netCents: sum.netCents + (line?.netCents ?? 0),
      vatCents: sum.vatCents + (line?.vatCents ?? 0),
      totalCents: sum.totalCents + (line?.totalCents ?? 0),
    }), { netCents: 0, vatCents: 0, totalCents: 0 })
    : null;
  const computedTotals = summedTotals
    && Object.values(summedTotals).every((value) => Number.isSafeInteger(value))
    ? summedTotals
    : null;
  if (allLinesComputable && !computedTotals) {
    blockers.push('La somme des lignes depasse la plage monetaire entiere autorisee.');
  }

  const printedTotalsPresent = draft.printedNetCents !== null
    && draft.printedVatCents !== null
    && draft.printedTotalCents !== null;
  if (!printedTotalsPresent) {
    blockers.push('Les totaux imprimes net, TVA et TTC doivent etre renseignes sans valeur de secours.');
  }
  const printedSummaryCoherent = printedTotalsPresent
    && draft.printedNetCents! >= 0
    && draft.printedVatCents! >= 0
    && draft.printedTotalCents! > 0
    && draft.printedNetCents! + draft.printedVatCents! === draft.printedTotalCents;
  if (printedTotalsPresent && !printedSummaryCoherent) {
    blockers.push('Le total imprime ne correspond pas au net imprime augmente de la TVA imprimee.');
  }
  const linesMatchPrintedTotals = Boolean(
    computedTotals
    && printedTotalsPresent
    && computedTotals.netCents === draft.printedNetCents
    && computedTotals.vatCents === draft.printedVatCents
    && computedTotals.totalCents === draft.printedTotalCents,
  );
  if (computedTotals && printedTotalsPresent && !linesMatchPrintedTotals) {
    blockers.push('La somme exacte des lignes ne correspond pas aux totaux imprimes de la facture.');
  }

  if (!draft.supplier.printedName.trim()) {
    warnings.push('Le nom fournisseur imprime n\'a pas ete reconnu; le fournisseur existant devra etre choisi manuellement.');
  }
  if (!draft.supplier.uidNumber.trim() && !draft.supplier.iban.trim()) {
    warnings.push('Aucun UID ou IBAN imprime n\'est disponible pour aider la comparaison manuelle du fournisseur.');
  }

  const checks = [
    { label: 'Devise', ok: currencyValid, detail: draft.currency || 'Absente' },
    {
      label: 'Arrondi',
      ok: roundingPolicyConfirmed,
      detail: roundingPolicyConfirmed ? roundingPolicy : 'Choix et confirmation humaine requis',
    },
    { label: 'Dates', ok: chronologyValid, detail: `${draft.invoiceDate || 'date absente'} -> ${draft.dueDate || 'echeance absente'}` },
    { label: 'Occurrences', ok: draft.lines.length > 0 && draft.lines.length <= SUPPLIER_INVOICE_MAX_LINE_OCCURRENCES && uniqueOccurrenceIds, detail: `${draft.lines.length}/${SUPPLIER_INVOICE_MAX_LINE_OCCURRENCES}` },
    { label: 'Conflits', ok: conflicts.length === 0, detail: conflicts.length ? `${conflicts.length} a resoudre` : 'Deux passes concordantes' },
    { label: 'Totaux imprimes', ok: Boolean(printedSummaryCoherent), detail: printedTotalsPresent ? 'Net, TVA et TTC presents' : 'Incomplets' },
    { label: 'Lignes / total', ok: linesMatchPrintedTotals, detail: linesMatchPrintedTotals ? 'Calcul exact' : 'Ecart ou donnees incompletes' },
  ];
  const scoreBp = Math.max(0, Math.min(10_000,
    Math.round((checks.filter((check) => check.ok).length / checks.length) * 10_000)
      - blockers.length * 1_000,
  ));
  return {
    ready: blockers.length === 0,
    scoreBp,
    blockers: unique(blockers),
    warnings: unique(warnings),
    checks,
    computedTotals,
  };
}

/**
 * Complete les controles documentaires par les decisions humaines necessaires
 * au futur brouillon comptable. Aucun identifiant n'est derive de l'IA.
 */
export function assessSupplierInvoiceConfirmation(input: {
  draft: SupplierInvoiceAiDraft;
  conflicts?: readonly SupplierInvoiceAiConflict[];
  businessReview: SupplierInvoiceHumanBusinessReview;
}): SupplierInvoiceDraftAssessment {
  const documentAssessment = assessSupplierInvoiceDraft(
    input.draft,
    input.conflicts ?? [],
    {
      policy: input.businessReview.roundingPolicy,
      confirmedByHuman: input.businessReview.roundingPolicyConfirmedByHuman,
    },
  );
  const blockers = [...documentAssessment.blockers];
  const warnings = [...documentAssessment.warnings];
  const review = input.businessReview;
  const reviewLinesValid = Array.isArray(review.lines)
    && review.lines.length <= SUPPLIER_INVOICE_MAX_LINE_OCCURRENCES;
  const reviewLines = reviewLinesValid ? review.lines : [];
  if (!reviewLinesValid) {
    blockers.push(`La revue humaine doit contenir au maximum ${SUPPLIER_INVOICE_MAX_LINE_OCCURRENCES} classifications, sans troncature.`);
  }
  if (!isSupplierInvoiceRoundingPolicy(review.roundingPolicy)
    || review.roundingPolicyConfirmedByHuman !== true) {
    blockers.push('La politique d\'arrondi doit etre choisie et confirmee manuellement.');
  }
  if (!review.existingSupplierId.trim() || review.supplierSelectedByHuman !== true) {
    blockers.push('Un fournisseur existant doit etre choisi et confirme manuellement.');
  }
  if (review.existingProjectId?.trim() && review.projectSelectedByHuman !== true) {
    blockers.push('Le projet renseigne doit etre choisi manuellement parmi les projets existants.');
  }

  const classificationsByOccurrence = new Map<string, SupplierInvoiceHumanLineClassification[]>();
  for (const classification of reviewLines) {
    const entries = classificationsByOccurrence.get(classification.occurrenceId) ?? [];
    entries.push(classification);
    classificationsByOccurrence.set(classification.occurrenceId, entries);
  }
  for (const [index, line] of input.draft.lines.entries()) {
    const matches = classificationsByOccurrence.get(line.occurrenceId) ?? [];
    if (matches.length !== 1) {
      blockers.push(`Ligne ${index + 1}: une classification humaine unique est obligatoire.`);
      continue;
    }
    const classification = matches[0];
    if (!classification.category.trim() || classification.categoryChosenByHuman !== true) {
      blockers.push(`Ligne ${index + 1}: la categorie de cout doit etre choisie manuellement.`);
    }
    if (classification.existingExpenseAccountId?.trim()
      && classification.expenseAccountSelectedByHuman !== true) {
      blockers.push(`Ligne ${index + 1}: le compte de charge doit etre choisi manuellement.`);
    }
    if (classification.existingProjectId?.trim() && classification.projectSelectedByHuman !== true) {
      blockers.push(`Ligne ${index + 1}: le projet de ligne doit etre choisi manuellement.`);
    }
  }
  const knownOccurrenceIds = new Set(input.draft.lines.map((line) => line.occurrenceId));
  if (reviewLines.some((classification) => !knownOccurrenceIds.has(classification.occurrenceId))) {
    blockers.push('Une classification humaine vise une occurrence absente du brouillon analyse.');
  }

  const checks = [
    ...documentAssessment.checks,
    {
      label: 'Fournisseur',
      ok: Boolean(review.existingSupplierId.trim() && review.supplierSelectedByHuman === true),
      detail: review.supplierSelectedByHuman === true ? 'Choix humain explicite' : 'Choix humain requis',
    },
    {
      label: 'Politique d\'arrondi',
      ok: isSupplierInvoiceRoundingPolicy(review.roundingPolicy)
        && review.roundingPolicyConfirmedByHuman === true,
      detail: review.roundingPolicyConfirmedByHuman ? review.roundingPolicy : 'Confirmation humaine requise',
    },
    {
      label: 'Classifications',
      ok: input.draft.lines.every((line) => {
        const matches = classificationsByOccurrence.get(line.occurrenceId) ?? [];
        return matches.length === 1
          && Boolean(matches[0].category.trim())
          && matches[0].categoryChosenByHuman === true;
      }),
      detail: `${reviewLines.length}/${input.draft.lines.length} ligne(s) renseignee(s)`,
    },
  ];
  const uniqueBlockers = unique(blockers);
  return {
    ...documentAssessment,
    ready: uniqueBlockers.length === 0,
    scoreBp: Math.max(0, documentAssessment.scoreBp - Math.max(0, uniqueBlockers.length - documentAssessment.blockers.length) * 1_000),
    blockers: uniqueBlockers,
    warnings: unique(warnings),
    checks,
  };
}
