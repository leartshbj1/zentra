import { payrollMessage, type PayrollPresentationRegistry } from './payrollPresentation';
import type {
  AppSettings,
  PayrollContributionDefinition,
} from './types';
import { SWISS_FAMILY_ALLOWANCES_2026_SOURCE } from './swissFamilyAllowances2026';

export const SWISS_LAA_ANNUAL_CEILING_CENTS_2026 = 14_820_000;
export const VALAIS_EMPLOYEE_CAF_RATE_BP_2026 = 13;
export const SWISS_FEDERAL_SOCIAL_INSURANCE_2026_SOURCE =
  'https://www.ahv-iv.ch/Portals/0/adam/AHV-IV/Ypzfdm2t_km4jeHFYxWRdA/Document/Tableau%20synoptique%2020-1.pdf';

export const SWISS_INSURANCE_SOURCES = {
  federalContributions: SWISS_FEDERAL_SOCIAL_INSURANCE_2026_SOURCE,
  accidentCoverage:
    'https://www.suva.ch/fr-ch/assurance/assurance-accidents/assurance-accidents-laa/assurance-accidents-qui-est-assure',
  accidentPremiums:
    'https://www.suva.ch/fr-ch/download/document/tarif-des-primes-2026/2026--2925-26.F',
  dailyAllowance:
    'https://www.bag.admin.ch/fr/assurance-maladie-lassurance-facultative-dindemnites-journalieres',
  familyAllowances: SWISS_FAMILY_ALLOWANCES_2026_SOURCE,
} as const;

const SWISS_CANTON_CODES = new Set([
  'AG', 'AI', 'AR', 'BE', 'BL', 'BS', 'FR', 'GE', 'GL', 'GR', 'JU', 'LU', 'NE',
  'NW', 'OW', 'SG', 'SH', 'SO', 'SZ', 'TG', 'TI', 'UR', 'VD', 'VS', 'ZG', 'ZH',
]);

export type InsuranceEmployeeContext = {
  active: boolean;
  contractualWeeklyMinutes: number | null;
};

export type InsuranceReadinessItem = {
  complete: boolean;
  configured: boolean;
  required: boolean | null;
  issues: string[];
};

export type SwissPayrollInsuranceReadiness = {
  aap: InsuranceReadinessItem;
  aanp: InsuranceReadinessItem;
  familyAllowance: InsuranceReadinessItem;
  dailyAllowance: InsuranceReadinessItem;
};

function appliesOn(definition: PayrollContributionDefinition, asOf: string) {
  return definition.active
    && definition.effectiveFrom <= asOf
    && (!definition.effectiveTo || definition.effectiveTo >= asOf);
}

function currentDefinitions(
  definitions: PayrollContributionDefinition[],
  category: PayrollContributionDefinition['category'],
  asOf: string,
) {
  return definitions.filter(
    (definition) => definition.category === category && appliesOn(definition, asOf),
  );
}

function sourceIsExplicit(definition: PayrollContributionDefinition) {
  return definition.source.trim().length >= 8;
}

function validRateOrAmount(definition: PayrollContributionDefinition) {
  if (definition.calculationKind === 'rate')
    return Number.isInteger(definition.rateBp) && (definition.rateBp ?? 0) > 0;
  return Number.isInteger(definition.fixedAmountCents)
    && (definition.fixedAmountCents ?? 0) > 0;
}

function validPositiveRate(definition: PayrollContributionDefinition) {
  return definition.calculationKind === 'rate'
    && definition.fixedAmountCents === null
    && Number.isInteger(definition.rateBp)
    && (definition.rateBp ?? 0) > 0
    && (definition.rateBp ?? 0) <= 10_000;
}

export function swissPayrollReferenceDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function validInsuranceBasis(definition: PayrollContributionDefinition) {
  // Le gain LAA et les primes usuelles se fondent sur le salaire assuré.
  // `custom` reste disponible lorsque la police documente une assiette qui
  // diverge du salaire AVS. `gross` sans décision explicite est trop ambigu.
  return definition.basisKind === 'ahv_salary' || definition.basisKind === 'custom';
}

function assessLaaDefinitions(
  category: 'aap' | 'aanp',
  settings: AppSettings,
  definitions: PayrollContributionDefinition[],
  asOf: string,
  required: boolean,
  presentations?: PayrollPresentationRegistry,
): InsuranceReadinessItem {
  const rows = currentDefinitions(definitions, category, asOf);
  const issues: string[] = [];
  const label = category.toUpperCase();
  if (!settings.payroll.accidentInsurer.trim())
    issues.push('Renseignez l’assureur-accidents de l’entreprise.');
  if (required && rows.length === 0)
    issues.push(payrollMessage(presentations, "Ajoutez au moins une prime {v0} valable à la date de paie.", { v0: { source: label } }));

  for (const row of rows) {
    if (row.calculationKind !== 'rate' || !Number.isInteger(row.rateBp) || (row.rateBp ?? 0) <= 0)
      issues.push(payrollMessage(presentations, "{v0}: utilisez le taux positif exact de la police.", { v0: row.code }));
    if (row.annualCeilingCents !== SWISS_LAA_ANNUAL_CEILING_CENTS_2026)
      issues.push(payrollMessage(presentations, "{v0}: le plafond LAA 2026 doit être CHF 148’200.", { v0: row.code }));
    if (!validInsuranceBasis(row))
      issues.push(payrollMessage(presentations, "{v0}: choisissez salaire soumis AVS ou une base personnalisée documentée.", { v0: row.code }));
    if (!sourceIsExplicit(row))
      issues.push(payrollMessage(presentations, "{v0}: citez la police, la classe ou le tarif réellement appliqué.", { v0: row.code }));
    if (category === 'aap' && row.side !== 'employer')
      issues.push(payrollMessage(presentations, "{v0}: l’AAP doit être entièrement à charge de l’employeur.", { v0: row.code }));
    if (category === 'aanp' && row.side === 'employer') {
      const evidence = settings.payroll.aanpEmployerCoverage;
      if (!evidence?.enabled)
        issues.push(payrollMessage(presentations, "{v0}: une part AANP employeur exige une convention plus favorable.", { v0: row.code }));
      else {
        if (!evidence.reference.trim() || row.source.trim() !== evidence.reference.trim())
          issues.push(payrollMessage(presentations, "{v0}: la source doit correspondre à la convention AANP enregistrée.", { v0: row.code }));
        if (!evidence.effectiveFrom || evidence.effectiveFrom > row.effectiveFrom)
          issues.push(payrollMessage(presentations, "{v0}: la définition commence avant la convention AANP.", { v0: row.code }));
        if (evidence.effectiveTo && (!row.effectiveTo || row.effectiveTo > evidence.effectiveTo))
          issues.push(payrollMessage(presentations, "{v0}: la définition dépasse la convention AANP.", { v0: row.code }));
      }
    }
  }

  return {
    complete: issues.length === 0 && (!required || rows.length > 0),
    configured: Boolean(settings.payroll.accidentInsurer.trim() || rows.length),
    required,
    issues: [...new Set(issues)],
  };
}

function assessFamilyAllowance(
  settings: AppSettings,
  definitions: PayrollContributionDefinition[],
  asOf: string,
  hasEmployees: boolean,
  presentations?: PayrollPresentationRegistry,
): InsuranceReadinessItem {
  const rows = currentDefinitions(definitions, 'family_allowance', asOf);
  const employerRows = rows.filter((row) => row.side === 'employer');
  const employeeRows = rows.filter((row) => row.side === 'employee');
  const canton = settings.payroll.payrollCanton.trim().toUpperCase();
  const issues: string[] = [];

  if (!settings.payroll.familyAllowanceFund.trim())
    issues.push('Renseignez la caisse d’allocations familiales compétente.');
  if (!SWISS_CANTON_CODES.has(canton))
    issues.push('Renseignez un canton suisse de paie valide sur deux lettres.');
  if (hasEmployees && employerRows.length === 0)
    issues.push('Ajoutez le taux employeur communiqué par la caisse, avec sa période et sa source.');
  for (const row of employerRows) {
    if (!validPositiveRate(row))
      issues.push(payrollMessage(presentations, "{v0}: le financement employeur doit être un taux positif communiqué par la caisse.", { v0: row.code }));
    if (row.basisKind !== 'ahv_salary')
      issues.push(payrollMessage(presentations, "{v0}: la CAF employeur doit être calculée sur le salaire soumis AVS.", { v0: row.code }));
    if (row.annualCeilingCents !== null)
      issues.push(payrollMessage(presentations, "{v0}: aucun plafond annuel libre ne doit limiter la base CAF.", { v0: row.code }));
    if (!sourceIsExplicit(row))
      issues.push(payrollMessage(presentations, "{v0}: citez précisément le décompte ou tarif de la caisse.", { v0: row.code }));
  }

  if (canton === 'VS') {
    if (hasEmployees && employeeRows.length === 0)
      issues.push('En Valais, ajoutez la part salarié CAF 2026 de 0,13 %.');
    for (const row of employeeRows) {
      if (
        !validPositiveRate(row)
        || row.rateBp !== VALAIS_EMPLOYEE_CAF_RATE_BP_2026
        || row.basisKind !== 'ahv_salary'
        || row.annualCeilingCents !== null
        || !row.source.includes(SWISS_FEDERAL_SOCIAL_INSURANCE_2026_SOURCE)
        || row.effectiveFrom !== '2026-01-01'
        || row.effectiveTo !== '2026-12-31'
      )
        issues.push(payrollMessage(presentations, "{v0}: la part salarié Valais doit reprendre le taux, la source et la fenêtre officiels 2026.", { v0: row.code }));
    }
  } else if (employeeRows.length) {
    issues.push('Une part salarié CAF n’est admise par le référentiel Zentra qu’en Valais.');
  }

  return {
    complete: issues.length === 0 && (!hasEmployees || employerRows.length > 0),
    configured: Boolean(settings.payroll.familyAllowanceFund.trim() || rows.length),
    required: hasEmployees,
    issues: [...new Set(issues)],
  };
}

function assessDailyAllowance(
  settings: AppSettings,
  definitions: PayrollContributionDefinition[],
  asOf: string,
  presentations?: PayrollPresentationRegistry,
): InsuranceReadinessItem {
  const rows = currentDefinitions(definitions, 'ijm', asOf);
  const insurer = settings.payroll.dailyAllowanceInsurer.trim();
  const issues: string[] = [];
  if (Boolean(insurer) !== Boolean(rows.length))
    issues.push(
      insurer
        ? 'Ajoutez les primes IJM exactes de la police ou retirez l’assureur si aucune police ne s’applique.'
        : 'Renseignez l’assureur IJM correspondant aux retenues configurées.',
    );
  for (const row of rows) {
    if (!validRateOrAmount(row))
      issues.push(payrollMessage(presentations, "{v0}: le taux ou montant IJM doit être positif.", { v0: row.code }));
    if (!validInsuranceBasis(row))
      issues.push(payrollMessage(presentations, "{v0}: documentez le salaire assuré avec une base AVS ou personnalisée.", { v0: row.code }));
    if (!sourceIsExplicit(row))
      issues.push(payrollMessage(presentations, "{v0}: citez la police ou la CCT applicable.", { v0: row.code }));
  }
  if (insurer || rows.length) {
    issues.push(
      'Structurez le régime (LAMal ou LCA), le numéro de police, le taux de couverture, le délai d’attente, la durée des prestations et la répartition employeur/salarié. Un assureur et une source libre ne suffisent pas.',
    );
  }
  return {
    // Le modèle de données actuel ne conserve pas encore toutes les clauses
    // déterminantes d'une police IJM. Rester fail-closed évite d'afficher une
    // configuration contractuelle partielle comme complète.
    complete: false,
    configured: Boolean(insurer || rows.length),
    // Il n’existe aucun taux fédéral universel : l’applicabilité doit être
    // décidée à partir du contrat de travail, de la CCT et de la police.
    required: null,
    issues: [...new Set(issues)],
  };
}

export function assessSwissPayrollInsuranceReadiness(input: {
  settings: AppSettings;
  definitions: PayrollContributionDefinition[];
  employees: InsuranceEmployeeContext[];
  asOf?: string;
}, presentations?: PayrollPresentationRegistry): SwissPayrollInsuranceReadiness {
  const asOf = input.asOf ?? swissPayrollReferenceDate();
  const activeEmployees = input.employees.filter((employee) => employee.active);
  const hasEmployees = activeEmployees.length > 0;
  const hasConfirmedWeeklyMinutes = (employee: InsuranceEmployeeContext) => (
    Number.isInteger(employee.contractualWeeklyMinutes)
    && (employee.contractualWeeklyMinutes ?? 0) > 0
    && (employee.contractualWeeklyMinutes ?? 0) <= 7 * 24 * 60
  );
  const aanpRequired = activeEmployees.some((employee) => (
    hasConfirmedWeeklyMinutes(employee) && (employee.contractualWeeklyMinutes ?? 0) >= 480
  ));
  const unknownWeeklyHours = activeEmployees.some(
    (employee) => !hasConfirmedWeeklyMinutes(employee),
  );
  const aanp = assessLaaDefinitions(
    'aanp',
    input.settings,
    input.definitions,
    asOf,
    aanpRequired,
    presentations,
  );
  if (unknownWeeklyHours) {
    aanp.complete = false;
    aanp.required = null;
    aanp.issues.unshift(
      'Confirmez pour chaque salarié l’horaire contractuel régulier ou, si l’horaire est irrégulier, une moyenne hebdomadaire représentative documentée avant de décider l’AANP.',
    );
  }

  return {
    aap: assessLaaDefinitions(
      'aap',
      input.settings,
      input.definitions,
      asOf,
      hasEmployees,
      presentations,
    ),
    aanp,
    familyAllowance: assessFamilyAllowance(
      input.settings,
      input.definitions,
      asOf,
      hasEmployees,
      presentations,
    ),
    dailyAllowance: assessDailyAllowance(
      input.settings,
      input.definitions,
      asOf,
      presentations,
    ),
  };
}
