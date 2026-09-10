import type { Account, PayrollContributionDefinition } from './types';

/** Add missing official lines without layering them over custom equivalent coverage. */
export function missingFederalContributions<
  T extends Omit<
    PayrollContributionDefinition,
    'id' | 'expenseAccountId' | 'liabilityAccountId'
  >,
>(profile: T[], current: PayrollContributionDefinition[]) {
  const federal = profile.filter((d) =>
    ['avs_ai_apg', 'ac'].includes(d.category),
  );
  return federal.filter(
    (d) =>
      !current.some(
        (existing) =>
          existing.code === d.code ||
          (existing.category === d.category &&
            existing.side === d.side &&
            existing.effectiveFrom <= d.effectiveTo &&
            (!existing.effectiveTo ||
              existing.effectiveTo >= d.effectiveFrom) &&
            !federal.some((official) => official.code === existing.code)),
      ),
  );
}
export const CONTRACT_PRESETS = {
  aap: {
    label: 'Accidents au travail',
    code: 'AAP',
    side: 'employer',
    explanation:
      'La prime est payée par l’entreprise. Recopiez le taux accidents professionnels (AAP) du contrat.',
  },
  aanp: {
    label: 'Accidents hors du travail',
    code: 'AANP',
    side: 'employee',
    explanation:
      'Recopiez le taux accidents non professionnels (AANP). La part habituelle est à la charge du salarié ; une prise en charge par l’employeur se règle dans les paramètres détaillés.',
  },
  family_allowance: {
    label: 'Financement des allocations familiales',
    code: 'CAF',
    side: 'employer',
    explanation:
      'Recopiez le taux de votre caisse pour l’employeur. Ce n’est pas le montant des allocations versées aux enfants.',
  },
  ijm: {
    label: 'Salaire en cas de maladie',
    code: 'IJM',
    side: 'employee',
    explanation:
      'Recopiez uniquement la part du taux prévue pour le salarié ou pour l’entreprise dans votre contrat collectif.',
  },
  lpp: {
    label: 'Caisse de pension',
    code: 'LPP',
    side: 'employee',
    explanation:
      'Recopiez le montant mensuel de la personne et la part de l’entreprise, séparément, depuis le certificat de prévoyance.',
  },
} as const;
export type ContractPreset = keyof typeof CONTRACT_PRESETS;
export function exactPayrollRate(value: string) {
  const text = value.trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(text))
    throw new Error(
      'Ce taux ne peut pas être enregistré exactement : cette version accepte deux décimales en pourcentage. Ne l’arrondissez pas ; demandez le traitement adapté à votre contrat.',
    );
  const [whole, part = ''] = text.split('.');
  const rate = Number(whole) * 100 + Number(part.padEnd(2, '0'));
  if (!Number.isSafeInteger(rate) || rate <= 0 || rate > 10000)
    throw new Error(
      'Indiquez un taux supérieur à zéro et inférieur ou égal à 100 %.',
    );
  return rate;
}
export function contractContribution(input: {
  id: string;
  category: ContractPreset;
  side: 'employee' | 'employer';
  rate: string;
  amountCents: number;
  employeeId: string;
  component: PayrollContributionDefinition['lppComponent'];
  source: string;
  from: string;
  to: string;
  liability: string;
  expense: string;
}): PayrollContributionDefinition {
  const preset = CONTRACT_PRESETS[input.category];
  const validDate = (value: string) =>
    /^2026-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T12:00:00Z`)) &&
    new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
  if (!validDate(input.from) || !validDate(input.to) || input.to < input.from)
    throw new Error(
      'Choisissez les dates réelles du contrat à l’intérieur de 2026. Les autres années se configurent dans les réglages détaillés.',
    );
  if (input.source.trim().length < 8)
    throw new Error(
      'Indiquez une référence de contrat assez précise pour retrouver le taux : assureur, numéro de police et année.',
    );
  if (
    (input.category === 'aap' || input.category === 'family_allowance') &&
    input.side !== 'employer'
  )
    throw new Error('Cette configuration concerne la part employeur.');
  if (input.category === 'aanp' && input.side !== 'employee')
    throw new Error(
      'Une prise en charge des accidents hors travail par l’employeur nécessite une convention dans les paramètres détaillés.',
    );
  const pension = input.category === 'lpp';
  if (
    pension &&
    (!input.employeeId ||
      !input.component ||
      !Number.isSafeInteger(input.amountCents) ||
      input.amountCents <= 0)
  )
    throw new Error(
      'Choisissez le salarié, la couverture du certificat et un montant mensuel positif.',
    );
  return {
    id: input.id,
    code: `PAIE_${preset.code}_${input.id.replaceAll('-', '').slice(0, 16).toUpperCase()}`,
    label: `${preset.label} · ${input.side === 'employee' ? 'salarié' : 'entreprise'}`,
    category: input.category,
    side: input.side,
    calculationKind: pension ? 'fixed' : 'rate',
    rateBp: pension ? null : exactPayrollRate(input.rate),
    fixedAmountCents: pension ? input.amountCents : null,
    annualCeilingCents:
      input.category === 'aap' || input.category === 'aanp' ? 14820000 : null,
    basisKind: pension ? 'coordinated' : 'ahv_salary',
    lppComponent: pension ? input.component : null,
    lppEmployeeId: pension ? input.employeeId : null,
    source: input.source.trim(),
    effectiveFrom: input.from,
    effectiveTo: input.to,
    active: true,
    liabilityAccountId: input.liability,
    expenseAccountId: input.side === 'employer' ? input.expense : '',
  };
}
/** A choice is proposed only when there is a single account of the required kind. */
export function singlePayrollAccount(
  accounts: Account[],
  kind: 'liability' | 'expense',
) {
  const choices = accounts.filter(
    (account) => account.active && account.accountType === kind,
  );
  return choices.length === 1 ? choices[0].id : '';
}
