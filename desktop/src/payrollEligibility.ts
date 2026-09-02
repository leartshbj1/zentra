import type {
  AppSettings,
  ContributionCategory,
  Employee,
  PayrollContributionDefinition,
} from './types';

export type PayrollEligibilityAssessment = {
  blockers: string[];
  warnings: string[];
  coordinatedAnnualSalaryCents: number | null;
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

export type SwissLppUiAssessment = {
  blockers: string[];
  warnings: string[];
  status: string;
  statusTone: 'ok' | 'warning' | 'neutral';
  annualSalaryCents: number | null;
  coordinatedAnnualSalaryCents: number | null;
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

const SWISS_LAA_ANNUAL_CEILING_CENTS_2026 = 14_820_000;
const SWISS_LPP_ENTRY_THRESHOLD_CENTS_2026 = 2_268_000;
const SWISS_LPP_ANNUAL_SALARY_CEILING_CENTS_2026 = 9_072_000;
const SWISS_LPP_COORDINATION_DEDUCTION_CENTS_2026 = 2_646_000;
const SWISS_LPP_MIN_COORDINATED_SALARY_CENTS_2026 = 378_000;
const SWISS_LPP_MAX_COORDINATED_SALARY_CENTS_2026 = 6_426_000;

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

function addCalendarMonths(value: string, months: number): string | null {
  if (!isRealIsoDate(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const monthIndex = month - 1 + months;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonthIndex = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(
    Date.UTC(targetYear, targetMonthIndex + 1, 0),
  ).getUTCDate();
  const targetDay = Math.min(day, lastDay);
  return `${targetYear.toString().padStart(4, '0')}-${(targetMonthIndex + 1)
    .toString()
    .padStart(2, '0')}-${targetDay.toString().padStart(2, '0')}`;
}

function formatChf(cents: number): string {
  return (cents / 100).toLocaleString('fr-CH', {
    style: 'currency',
    currency: 'CHF',
  });
}

/**
 * Miroir explicatif et conservateur du moteur LPP Rust 2026. Le backend reste
 * l'autorité et recalcule tout lors de la validation. Aucun taux de caisse
 * n'est déduit ici : seuls le statut légal et le salaire coordonné indicatif
 * sont établis à partir des données annuelles confirmées.
 */
export function assessSwissLppEligibility(input: {
  employee: Employee;
  settings: AppSettings;
  period: string;
  contributionDate?: string;
  definitions: PayrollContributionDefinition[];
  selectedIds: ReadonlySet<string>;
}): SwissLppUiAssessment {
  const employee = input.employee;
  const definitions = input.definitions;
  const [year, month] = input.period.split('-').map(Number);
  const periodValid =
    Number.isInteger(year) &&
    year >= 2000 &&
    Number.isInteger(month) &&
    month >= 1 &&
    month <= 12;
  const selected = definitions.filter(
    (definition) =>
      definition.active &&
      definition.category === 'lpp' &&
      input.selectedIds.has(definition.id),
  );
  const applicable = selected.filter(
    (definition) => definition.lppEmployeeId === employee.id,
  );
  const selectedPlan = selected.length > 0;
  const blockers: string[] = [];
  const warnings: string[] = [];
  const assessmentYear = employee.lppAssessmentYear ?? null;
  const annualSalaryCents = employee.lppAnnualSalaryCents ?? null;

  const result = (
    status: string,
    statusTone: SwissLppUiAssessment['statusTone'],
    coordinatedAnnualSalaryCents: number | null = null,
  ): SwissLppUiAssessment => ({
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    status,
    statusTone,
    annualSalaryCents,
    coordinatedAnnualSalaryCents,
  });

  const validatePlanAndDefinitions = (
    minimum: 'none' | 'risk' | 'risk_and_savings',
    coordinatedAnnualSalaryCents: number | null,
  ) => {
    const minimumDue = minimum !== 'none';
    if (!minimumDue && !selected.length) return;
    if (minimumDue && !applicable.length)
      blockers.push(
        'La LPP est obligatoire pour cette période: sélectionnez une définition positive liée à ce collaborateur et au règlement de sa caisse.',
      );
    if (
      selected.some((definition) => definition.lppEmployeeId !== employee.id)
    )
      blockers.push(
        'Une cotisation LPP sélectionnée appartient à un autre collaborateur.',
      );

    for (const definition of selected) {
      if (
        definition.calculationKind !== 'fixed' ||
        (definition.fixedAmountCents ?? 0) <= 0
      )
        blockers.push(
          'Chaque définition LPP doit utiliser un montant fixe mensuel strictement positif issu du règlement.',
        );
      if (!['coordinated', 'custom'].includes(definition.basisKind))
        blockers.push(
          'Chaque définition LPP doit utiliser la base « salaire coordonné » ou une base personnalisée confirmée.',
        );
      if (
        definition.basisKind === 'coordinated' &&
        coordinatedAnnualSalaryCents === null
      )
        blockers.push(
          'La base « salaire coordonné » est réservée au salaire coordonné légal calculé. Pour une couverture plus favorable ou une base propre au règlement, utilisez « base personnalisée ».',
        );
      if (!definition.lppComponent)
        blockers.push(
          'Chaque définition LPP doit préciser sa composante risque, épargne ou combinée.',
        );
    }

    const plan = input.settings.payroll.lppPlanEvidence;
    if (!input.settings.payroll.pensionFund.trim())
      blockers.push(
        'La caisse de pension manque pour la cotisation LPP sélectionnée.',
      );
    if (
      !plan ||
      !plan.contractNumber.trim() ||
      !plan.regulationReference.trim() ||
      !isRealIsoDate(plan.effectiveFrom) ||
      !isRealIsoDate(plan.effectiveTo) ||
      plan.effectiveTo < plan.effectiveFrom ||
      !plan.employerAggregateShareConfirmed
    ) {
      blockers.push(
        'Le plan LPP exige le numéro de contrat, la référence du règlement, sa période d’effet et l’attestation de la part employeur agrégée.',
      );
    } else {
      const contributionDate =
        input.contributionDate && isRealIsoDate(input.contributionDate)
          ? input.contributionDate
          : `${input.period}-01`;
      if (
        contributionDate < plan.effectiveFrom ||
        contributionDate > plan.effectiveTo
      )
        blockers.push(
          `La date réglementaire ${contributionDate} sort de la fenêtre du règlement LPP ${plan.contractNumber} (${plan.effectiveFrom} à ${plan.effectiveTo}).`,
        );
      if (
        selected.some(
          (definition) =>
            definition.source.trim() !== plan.regulationReference.trim(),
        )
      )
        blockers.push(
          'La source de chaque définition LPP doit correspondre exactement à la référence du règlement conservée dans les paramètres.',
        );
      if (
        selected.some(
          (definition) =>
            !isRealIsoDate(definition.effectiveFrom) ||
            !isRealIsoDate(definition.effectiveTo) ||
            definition.effectiveFrom < plan.effectiveFrom ||
            definition.effectiveTo > plan.effectiveTo,
        )
      )
        blockers.push(
          'La période d’effet de chaque définition LPP doit rester entièrement comprise dans celle du règlement enregistré.',
        );
    }

    const components = new Set(applicable.map((item) => item.lppComponent));
    if (
      minimum !== 'none' &&
      applicable.length &&
      !components.has('combined') &&
      !components.has('risk')
    )
      blockers.push(
        'La couverture LPP obligatoire doit inclure la composante risque.',
      );
    if (
      minimum === 'risk_and_savings' &&
      applicable.length &&
      !components.has('combined') &&
      !components.has('savings')
    )
      blockers.push(
        'La couverture LPP obligatoire doit inclure la composante épargne dès le 1er janvier suivant le 24e anniversaire.',
      );
  };

  if (!periodValid) {
    blockers.push('La période LPP doit être au format AAAA-MM.');
    return result('Période invalide', 'warning');
  }
  if (year !== 2026) {
    blockers.push(
      'Le contrôle LPP déterministe de cette version couvre uniquement 2026; utilisez un profil réglementaire adapté avant de valider.',
    );
    return result('Hors profil LPP 2026', 'warning');
  }
  if (!isRealIsoDate(employee.birthDate)) {
    blockers.push(
      'La date de naissance est obligatoire et doit être valide pour contrôler la LPP.',
    );
    return result('Date de naissance requise', 'warning');
  }

  const birthYear = Number(employee.birthDate.slice(0, 4));
  const riskDue = year >= birthYear + 18;
  const savingsDue = year >= birthYear + 25;
  if (!riskDue) {
    validatePlanAndDefinitions('none', null);
    if (selectedPlan)
      warnings.push(
        'Une couverture LPP avant l’âge légal minimal est traitée comme un plan plus favorable; vérifiez-la dans le règlement de la caisse.',
      );
    return result(
      selectedPlan
        ? 'Plan plus favorable · avant l’âge légal'
        : 'Non obligatoire · avant l’âge légal',
      blockers.length || selectedPlan ? 'warning' : 'neutral',
    );
  }

  if (
    assessmentYear === null ||
    annualSalaryCents === null ||
    !Number.isInteger(assessmentYear) ||
    !Number.isInteger(annualSalaryCents) ||
    annualSalaryCents < 0
  ) {
    blockers.push(
      'Confirmez ensemble l’année d’évaluation et le salaire annuel LPP sur la fiche collaborateur, zéro compris.',
    );
    return result('Évaluation annuelle requise', 'warning');
  }
  if (assessmentYear !== year) {
    blockers.push(
      `L’évaluation salariale LPP du collaborateur porte sur ${assessmentYear}; confirmez-la pour ${year}.`,
    );
    return result(`Évaluation ${year} requise`, 'warning');
  }
  if (annualSalaryCents <= SWISS_LPP_ENTRY_THRESHOLD_CENTS_2026) {
    validatePlanAndDefinitions('none', null);
    if (selectedPlan)
      warnings.push(
        'La couverture sélectionnée sous le seuil légal est un plan plus favorable; ses montants doivent correspondre au règlement réel.',
      );
    return result(
      selectedPlan
        ? 'Plan plus favorable · sous le seuil légal'
        : 'Non obligatoire · sous le seuil légal',
      blockers.length || selectedPlan ? 'warning' : 'neutral',
    );
  }

  if (!employee.employmentContractKind) {
    blockers.push(
      'Confirmez si le contrat est à durée indéterminée ou déterminée pour contrôler la LPP.',
    );
  }
  if (!isRealIsoDate(employee.employmentStart)) {
    blockers.push(
      'La date de début du contrat est obligatoire et doit être valide pour contrôler la LPP.',
    );
  }
  if (
    employee.employmentContractKind === 'fixed' &&
    !isRealIsoDate(employee.employmentEnd)
  ) {
    blockers.push(
      'Un contrat à durée déterminée exige une date de fin valide pour contrôler la LPP.',
    );
  }
  if (
    isRealIsoDate(employee.employmentStart) &&
    isRealIsoDate(employee.employmentEnd) &&
    employee.employmentEnd < employee.employmentStart
  ) {
    blockers.push('La fin du contrat précède son début.');
  }
  if (isRealIsoDate(employee.employmentStart)) {
    const periodStart = `${input.period}-01`;
    const periodEnd = new Date(Date.UTC(year, month, 0))
      .toISOString()
      .slice(0, 10);
    if (
      employee.employmentStart > periodEnd ||
      (isRealIsoDate(employee.employmentEnd) &&
        employee.employmentEnd < periodStart)
    ) {
      blockers.push(
        'La période LPP se situe hors des rapports de travail confirmés.',
      );
    }
  }

  const exceptionCode = employee.lppExceptionCode ?? '';
  const exceptionEvidence = (
    employee.lppExceptionEvidenceReference ?? ''
  ).trim();
  if (Boolean(exceptionCode) !== Boolean(exceptionEvidence)) {
    blockers.push(
      'Une exception LPP exige simultanément son motif et la référence de sa preuve.',
    );
  }
  const threeMonthMark = addCalendarMonths(employee.employmentStart, 3);
  const shortFixedContract = Boolean(
    employee.employmentContractKind === 'fixed' &&
      threeMonthMark &&
      isRealIsoDate(employee.employmentEnd) &&
      employee.employmentEnd < threeMonthMark,
  );
  if (shortFixedContract && !exceptionCode) {
    blockers.push(
      'Le contrat déterminé de trois mois au maximum exige une exception LPP documentée sur la fiche collaborateur.',
    );
  }
  if (exceptionCode === 'short_fixed_contract' && !shortFixedContract) {
    blockers.push(
      'L’exception « contrat court » ne correspond pas aux dates et à la nature du contrat confirmées.',
    );
  }
  const exempt =
    Boolean(exceptionEvidence) &&
    (exceptionCode === 'other_legal' ||
      (exceptionCode === 'short_fixed_contract' && shortFixedContract));
  if (exempt) {
    validatePlanAndDefinitions('none', null);
    return result(
      'Exception documentée',
      blockers.length ? 'warning' : 'ok',
    );
  }

  const coordinatedAnnualSalaryCents = Math.min(
    SWISS_LPP_MAX_COORDINATED_SALARY_CENTS_2026,
    Math.max(
      SWISS_LPP_MIN_COORDINATED_SALARY_CENTS_2026,
      Math.min(
        annualSalaryCents,
        SWISS_LPP_ANNUAL_SALARY_CEILING_CENTS_2026,
      ) - SWISS_LPP_COORDINATION_DEDUCTION_CENTS_2026,
    ),
  );

  validatePlanAndDefinitions(
    savingsDue ? 'risk_and_savings' : 'risk',
    coordinatedAnnualSalaryCents,
  );

  return result(
    savingsDue ? 'Obligatoire · risque et épargne' : 'Obligatoire · risque',
    blockers.length ? 'warning' : 'ok',
    coordinatedAnnualSalaryCents,
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
  contributionDate?: string;
  definitions: PayrollContributionDefinition[];
  selectedIds: Set<string>;
  referenceAgeOverride?: RetirementReferenceOverride | null;
}): PayrollEligibilityAssessment {
  const { employee, settings, period, definitions, selectedIds } = input;
  if (!employee)
    return {
      blockers: ['Sélectionnez un collaborateur.'],
      warnings: [],
      coordinatedAnnualSalaryCents: null,
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
  const selectedDefinitions = definitions.filter(
    (item) => item.active && selectedIds.has(item.id),
  );
  const selectedCategories = new Set<ContributionCategory>(
    selectedDefinitions.map((item) => item.category),
  );
  const has = (category: ContributionCategory) =>
    selectedCategories.has(category);
  const federalProfile = assessSwissFederalProfile(definitions, selectedIds);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const lpp = assessSwissLppEligibility({
    employee,
    settings,
    period,
    contributionDate: input.contributionDate,
    definitions,
    selectedIds,
  });

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
      'La date de naissance manque; Zentra ne peut pas contrôler AVS, AC et LPP.',
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
      'Dès 64 ans, renseignez une date/validation explicite de l’âge de référence confirmée par la caisse ou la fiduciaire; Zentra ne la déduit pas du sexe.',
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
      'Franchise AVS conservée: saisissez la base AVS avant franchise; Zentra déduira automatiquement CHF 1’400 pour ce mois, dans la limite de CHF 16’800/an et par employeur.',
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
  const invalidLaaCategories = (['aap', 'aanp'] as const).filter((category) =>
    selectedDefinitions
      .filter((item) => item.category === category)
      .some(
        (item) =>
          item.calculationKind !== 'rate' ||
          (item.rateBp ?? 0) <= 0 ||
          item.annualCeilingCents !==
            SWISS_LAA_ANNUAL_CEILING_CENTS_2026 ||
          !item.source.trim(),
      ),
  );
  for (const category of invalidLaaCategories)
    blockers.push(
      `${category.toUpperCase()} doit utiliser le taux positif de la police LAA, sa source et le plafond fédéral 2026 de CHF 148’200.`,
    );
  const aanpEmployerDefinitions = selectedDefinitions.filter(
    (item) => item.category === 'aanp' && item.side === 'employer',
  );
  if (aanpEmployerDefinitions.length) {
    const evidence = settings.payroll.aanpEmployerCoverage;
    const periodDate = periodValid ? `${period}-01` : '';
    if (
      !evidence?.enabled ||
      !evidence.reference.trim() ||
      !isRealIsoDate(evidence.effectiveFrom) ||
      (evidence.effectiveTo !== '' && !isRealIsoDate(evidence.effectiveTo)) ||
      (evidence.effectiveTo !== '' && evidence.effectiveTo < evidence.effectiveFrom)
    ) {
      blockers.push(
        'Une part AANP employeur exige une convention plus favorable structurée, datée et référencée dans les paramètres de paie.',
      );
    } else {
      if (
        periodDate &&
        (periodDate < evidence.effectiveFrom ||
          (evidence.effectiveTo && periodDate > evidence.effectiveTo))
      )
        blockers.push(
          `La convention de prise en charge AANP employeur ne couvre pas la période ${period}.`,
        );
      if (
        aanpEmployerDefinitions.some(
          (definition) => definition.source.trim() !== evidence.reference.trim(),
        )
      )
        blockers.push(
          'La source de chaque définition AANP employeur doit correspondre exactement à la référence de convention conservée dans les paramètres.',
        );
    }
  }
  if (weeklyHours !== null && weeklyHours >= 8 && !has('aanp'))
    blockers.push(
      'Le collaborateur atteint 8 h/semaine: la couverture AANP doit être configurée.',
    );
  if (weeklyHours !== null && weeklyHours < 8 && has('aanp'))
    blockers.push(
      'AANP est sélectionnée alors que le taux de travail indique moins de 8 h/semaine; contrôlez l’horaire réel.',
    );
  blockers.push(...lpp.blockers);
  warnings.push(...lpp.warnings);
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
      'L’impôt à la source ne peut pas être validé avec un taux linéaire Zentra; utilisez un montant issu du barème cantonal officiel puis conservez sa référence.',
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
      `Confirmez sur la fiche collaborateur la base d’ouverture AC ${periodValid ? year : 'de l’année'} (zéro compris); Zentra ajoutera automatiquement les bases des fiches antérieures.`,
    );
  return {
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    coordinatedAnnualSalaryCents: lpp.coordinatedAnnualSalaryCents,
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
        label: 'Statut LPP 2026',
        value: lpp.status,
        tone: lpp.statusTone,
      },
      {
        label: 'Salaire annuel LPP confirmé',
        value:
          lpp.annualSalaryCents === null
            ? 'À confirmer sur la fiche'
            : formatChf(lpp.annualSalaryCents),
        tone: lpp.annualSalaryCents === null ? 'warning' : 'ok',
      },
      {
        label: 'Salaire coordonné indicatif',
        value:
          lpp.coordinatedAnnualSalaryCents === null
            ? 'Non applicable au statut actuel'
            : formatChf(lpp.coordinatedAnnualSalaryCents),
        tone:
          lpp.coordinatedAnnualSalaryCents === null ? 'neutral' : 'ok',
      },
      {
        label: 'Entrée en fonction',
        value: employee.employmentStart || 'Non renseignée',
        tone: employee.employmentStart ? 'ok' : 'warning',
      },
    ],
  };
}
