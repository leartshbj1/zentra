import type {
  AppSettings,
  ContributionCategory,
  Employee,
  PayrollContributionDefinition,
} from './types';

export type PayrollEligibilityAssessment = {
  blockers: string[];
  warnings: string[];
  facts: Array<{
    label: string;
    value: string;
    tone: 'ok' | 'warning' | 'neutral';
  }>;
};

export type RetirementReferenceOverride = {
  /** Date confirmée à laquelle l'âge de référence est atteint; les règles après âge s'appliquent au mois suivant. */
  effectiveDate: string;
  /** Permet aussi de documenter explicitement qu'il n'est pas encore atteint à la période contrôlée. */
  reached: boolean;
};

export type SwissFederalProfileAssessment = {
  avsAiApgComplete: boolean;
  acComplete: boolean;
  issues: string[];
};

const FEDERAL_PROFILE = {
  avs_ai_apg: [
    ['AVS_EMPLOYEE', 'employee', 435, null],
    ['AVS_EMPLOYER', 'employer', 435, null],
    ['AI_EMPLOYEE', 'employee', 70, null],
    ['AI_EMPLOYER', 'employer', 70, null],
    ['APG_EMPLOYEE', 'employee', 25, null],
    ['APG_EMPLOYER', 'employer', 25, null],
  ],
  ac: [
    ['AC_EMPLOYEE', 'employee', 110, 14_820_000],
    ['AC_EMPLOYER', 'employer', 110, 14_820_000],
  ],
} as const;

function isRealIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Vérifie le profil fédéral par code, part, taux et plafond. Une simple
 * catégorie présente ne suffit pas : elle pouvait masquer cinq lignes AVS/AI/APG
 * manquantes ou la part employeur de l'AC.
 */
export function assessSwissFederalProfile(
  definitions: PayrollContributionDefinition[],
  selectedIds: ReadonlySet<string> = new Set(
    definitions.filter((item) => item.active).map((item) => item.id),
  ),
): SwissFederalProfileAssessment {
  const selected = definitions.filter(
    (item) => item.active && selectedIds.has(item.id),
  );
  const issues: string[] = [];

  const checkCategory = (category: 'avs_ai_apg' | 'ac') => {
    const expected = FEDERAL_PROFILE[category];
    const relevant = selected.filter((item) => item.category === category);
    let complete = true;
    for (const [code, side, rateBp, ceiling] of expected) {
      const definition = relevant.find(
        (item) => item.code.trim().toUpperCase() === code,
      );
      const valid = Boolean(
        definition &&
        definition.side === side &&
        definition.calculationKind === 'rate' &&
        definition.rateBp === rateBp &&
        (ceiling === null || definition.annualCeilingCents === ceiling),
      );
      if (!valid) {
        complete = false;
        issues.push(
          `${code} manque ou ne correspond pas au taux, à la part ou au plafond officiel 2026.`,
        );
      }
    }
    for (const side of ['employee', 'employer'] as const) {
      const actualTotal = relevant
        .filter((item) => item.side === side && item.calculationKind === 'rate')
        .reduce((sum, item) => sum + (item.rateBp ?? 0), 0);
      const expectedTotal = expected
        .filter(([, expectedSide]) => expectedSide === side)
        .reduce((sum, [, , rateBp]) => sum + rateBp, 0);
      if (actualTotal !== expectedTotal) {
        complete = false;
        issues.push(
          `${category === 'ac' ? 'AC' : 'AVS/AI/APG'} ${side === 'employee' ? 'employé' : 'employeur'} totalise ${(actualTotal / 100).toLocaleString('fr-CH')} % au lieu de ${(expectedTotal / 100).toLocaleString('fr-CH')} %.`,
        );
      }
    }
    return complete;
  };

  return {
    avsAiApgComplete: checkCategory('avs_ai_apg'),
    acComplete: checkCategory('ac'),
    issues: [...new Set(issues)],
  };
}

function ageAt(
  dateOfBirth: string,
  year: number,
  month: number,
): number | null {
  if (!isRealIsoDate(dateOfBirth)) return null;
  const birth = new Date(`${dateOfBirth}T12:00:00`);
  if (Number.isNaN(birth.getTime())) return null;
  let age = year - birth.getFullYear();
  if (month < birth.getMonth() + 1) age -= 1;
  return age;
}

export function assessSwissPayrollEligibility(input: {
  employee: Employee | undefined;
  settings: AppSettings;
  period: string;
  grossCents: number;
  definitions: PayrollContributionDefinition[];
  selectedIds: Set<string>;
  referenceAgeOverride?: RetirementReferenceOverride | null;
}): PayrollEligibilityAssessment {
  const { employee, settings, period, grossCents, definitions, selectedIds } =
    input;
  if (!employee)
    return {
      blockers: ['Sélectionnez un collaborateur.'],
      warnings: [],
      facts: [],
    };
  const [year, month] = period.split('-').map(Number);
  const periodValid =
    Number.isInteger(year) &&
    year >= 2000 &&
    Number.isInteger(month) &&
    month >= 1 &&
    month <= 12;
  const age = periodValid ? ageAt(employee.birthDate, year, month) : null;
  const weeklyHours = typeof employee.contractualWeeklyMinutes === 'number'
    && Number.isFinite(employee.contractualWeeklyMinutes)
    ? employee.contractualWeeklyMinutes / 60
    : null;
  const annualizedGrossCents = grossCents * 12;
  const selectedCategories = new Set<ContributionCategory>(
    definitions
      .filter((item) => selectedIds.has(item.id))
      .map((item) => item.category),
  );
  const has = (category: ContributionCategory) =>
    selectedCategories.has(category);
  const federalProfile = assessSwissFederalProfile(definitions, selectedIds);
  const blockers: string[] = [];
  const warnings: string[] = [];

  const birthDateValid = isRealIsoDate(employee.birthDate);
  const birthYear = birthDateValid ? employee.birthDate.slice(0, 4) : null;
  // L'obligation AVS commence le 1er janvier de l'année qui suit le 17e anniversaire.
  const avsLiable =
    periodValid && birthYear ? year >= Number(birthYear) + 18 : null;
  const resolvedReferenceOverride =
    input.referenceAgeOverride ??
    (employee.referenceAgeDate
      ? { effectiveDate: employee.referenceAgeDate, reached: true }
      : null);
  const referenceOverrideValid = Boolean(
    resolvedReferenceOverride &&
    isRealIsoDate(resolvedReferenceOverride.effectiveDate),
  );
  const inReferenceAgeReviewWindow = age !== null && age >= 64;
  let referenceAgeReached: boolean | null = null;
  if (referenceOverrideValid && resolvedReferenceOverride) {
    // L'AC reste due pendant le mois où l'âge de référence est atteint. La
    // franchise AVS et l'exemption AC commencent le mois civil suivant.
    referenceAgeReached =
      resolvedReferenceOverride.reached &&
      resolvedReferenceOverride.effectiveDate.slice(0, 7) < period;
  }

  if (!periodValid)
    blockers.push(
      'La période est nécessaire pour contrôler les règles d’assujettissement.',
    );
  if (!employee.birthDate)
    blockers.push(
      'La date de naissance manque; Elyko ne peut pas contrôler AVS, AC et LPP.',
    );
  else if (!birthDateValid)
    blockers.push(
      'La date de naissance est invalide; utilisez une date réelle au format AAAA-MM-JJ.',
    );
  if (!employee.employmentStart) {
    const message =
      'La date d’entrée manque; le plafond AC ne peut pas être proratisé de manière fiable.';
    if (has('ac')) blockers.push(message);
    else warnings.push(message);
  }
  if (weeklyHours === null)
    blockers.push(
      'L’horaire contractuel hebdomadaire manque; la couverture AANP ne peut pas être décidée sans cette donnée explicite.',
    );
  if (avsLiable === false && (has('avs_ai_apg') || has('ac')))
    blockers.push(
      'AVS/AI/APG et AC ne doivent pas être sélectionnées avant le 1er janvier suivant le 17e anniversaire.',
    );
  if (avsLiable && !federalProfile.avsAiApgComplete)
    blockers.push(
      ...federalProfile.issues.filter(
        (issue) =>
          issue.startsWith('AVS') ||
          issue.startsWith('AI_') ||
          issue.startsWith('APG_'),
      ),
    );
  if (inReferenceAgeReviewWindow && !referenceOverrideValid)
    blockers.push(
      'Dès 64 ans, renseignez une date/validation explicite de l’âge de référence confirmée par la caisse ou la fiduciaire; Elyko ne la déduit pas du sexe.',
    );
  if (avsLiable && referenceAgeReached !== true && !federalProfile.acComplete)
    blockers.push(
      ...federalProfile.issues.filter((issue) => issue.startsWith('AC')),
    );
  if (referenceAgeReached === true && has('ac'))
    blockers.push(
      'Le mois suivant l’atteinte de l’âge de référence a commencé: retirez l’AC pour cette période.',
    );
  if (
    referenceAgeReached === true &&
    has('avs_ai_apg') &&
    employee.avsAllowanceWaived === null
  )
    blockers.push(
      'Après l’âge de référence, confirmez si le collaborateur conserve la franchise AVS ou y renonce.',
    );
  if (referenceAgeReached === true && employee.avsAllowanceWaived === false)
    warnings.push(
      'Franchise AVS conservée: saisissez la base AVS avant franchise; Elyko déduira automatiquement CHF 1’400 pour ce mois, dans la limite de CHF 16’800/an et par employeur.',
    );
  if (referenceAgeReached === true && employee.avsAllowanceWaived === true)
    warnings.push(
      'Renonciation à la franchise AVS enregistrée: conservez la confirmation de la caisse ou de la fiduciaire.',
    );
  if (
    (has('avs_ai_apg') && !federalProfile.avsAiApgComplete) ||
    (has('ac') && !federalProfile.acComplete)
  )
    blockers.push(...federalProfile.issues);
  if (!has('aap'))
    blockers.push(
      'La prime accidents professionnels AAP doit être configurée pour tout salarié.',
    );
  if (weeklyHours !== null && weeklyHours >= 8 && !has('aanp'))
    blockers.push(
      'Le collaborateur atteint 8 h/semaine: la couverture AANP doit être configurée.',
    );
  if (weeklyHours !== null && weeklyHours < 8 && has('aanp'))
    blockers.push(
      'AANP est sélectionnée alors que le taux de travail indique moins de 8 h/semaine; contrôlez l’horaire réel.',
    );
  if (
    age !== null &&
    age >= 18 &&
    annualizedGrossCents >= 2_268_000 &&
    !has('lpp')
  )
    warnings.push(
      'Le salaire annualisé atteint le seuil LPP de CHF 22’680; documentez une éventuelle exception ou sélectionnez le plan de caisse.',
    );
  if (has('lpp') && !settings.payroll.pensionFund.trim())
    blockers.push(
      'La caisse de pension manque pour la cotisation LPP sélectionnée.',
    );
  if ((has('aap') || has('aanp')) && !settings.payroll.accidentInsurer.trim())
    blockers.push(
      'L’assureur accidents manque pour les cotisations LAA sélectionnées.',
    );
  if (has('ijm') && !settings.payroll.dailyAllowanceInsurer.trim())
    blockers.push('L’assureur IJM manque pour la cotisation sélectionnée.');
  if (has('family_allowance') && !settings.payroll.familyAllowanceFund.trim())
    blockers.push(
      'La caisse d’allocations familiales manque pour la cotisation sélectionnée.',
    );
  if (has('source_tax'))
    blockers.push(
      'L’impôt à la source ne peut pas être validé avec un taux linéaire Elyko; utilisez un montant issu du barème cantonal officiel puis conservez sa référence.',
    );
  if (!settings.payroll.avsFund.trim() && has('avs_ai_apg'))
    blockers.push('La caisse AVS doit être renseignée avant validation.');
  if (
    has('ac') &&
    (!periodValid ||
      employee.acOpeningYear !== year ||
      employee.acOpeningBasisCents == null)
  )
    blockers.push(
      `Confirmez sur la fiche collaborateur la base d’ouverture AC ${periodValid ? year : 'de l’année'} (zéro compris); Elyko ajoutera automatiquement les bases des fiches antérieures.`,
    );
  if (grossCents > 0 && grossCents * 12 <= 250_000)
    warnings.push(
      'Salaire annualisé ≤ CHF 2’500: vérifiez la règle des rémunérations de minime importance et ses exceptions.',
    );

  return {
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    facts: [
      {
        label: 'Âge à la période',
        value: age === null ? 'Date de naissance manquante' : `${age} ans`,
        tone: age === null ? 'warning' : 'ok',
      },
      {
        label: 'Âge de référence',
        value: !inReferenceAgeReviewWindow
          ? 'Hors zone de contrôle'
          : referenceOverrideValid
            ? referenceAgeReached
              ? 'Atteint · date confirmée'
              : 'Non atteint · contrôle explicite'
            : 'Date/validation requise',
        tone:
          inReferenceAgeReviewWindow && !referenceOverrideValid
            ? 'warning'
            : 'ok',
      },
      {
        label: 'Franchise AVS',
        value:
          employee.avsAllowanceWaived === null
            ? 'À confirmer'
            : employee.avsAllowanceWaived
              ? 'Renonciation confirmée'
              : 'Franchise conservée',
        tone:
          referenceAgeReached === true && employee.avsAllowanceWaived === null
            ? 'warning'
            : 'neutral',
      },
      {
        label: 'Horaire contractuel',
        value: weeklyHours === null ? 'Non renseigné' : `${weeklyHours.toLocaleString('fr-CH', { maximumFractionDigits: 2 })} h/semaine`,
        tone: weeklyHours === null ? 'warning' : weeklyHours >= 8 ? 'ok' : 'neutral',
      },
      {
        label: 'Ouverture AC',
        value:
          employee.acOpeningYear === year && employee.acOpeningBasisCents != null
            ? `${(employee.acOpeningBasisCents / 100).toLocaleString('fr-CH', { style: 'currency', currency: 'CHF' })} · ${year}`
            : 'À confirmer pour la période',
        tone:
          employee.acOpeningYear === year && employee.acOpeningBasisCents != null
            ? 'ok'
            : 'warning',
      },
      {
        label: 'Salaire annualisé',
        value: `${(annualizedGrossCents / 100).toLocaleString('fr-CH', { style: 'currency', currency: 'CHF' })}`,
        tone: annualizedGrossCents >= 2_268_000 ? 'warning' : 'neutral',
      },
      {
        label: 'Entrée en fonction',
        value: employee.employmentStart || 'Non renseignée',
        tone: employee.employmentStart ? 'ok' : 'warning',
      },
    ],
  };
}
