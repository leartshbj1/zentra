import type { PayrollContributionDefinition, PayrollContributionSelection } from './types';

/** Parse two decimals as an integer. Blank, negative and imprecise values stay unknown. */
export function payrollDecimal(value: string): number | undefined {
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(value.trim());
  if (!match) return undefined;
  const result = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(result) ? result : undefined;
}

export function hourlySalaryCents(hours: string, rate: string): number | undefined {
  const quantity = payrollDecimal(hours), cents = payrollDecimal(rate);
  if (!quantity || !cents) return undefined;
  const product = quantity * cents;
  if (!Number.isSafeInteger(product + 50)) return undefined;
  const rounded = Math.floor((product + 50) / 100);
  return rounded > 0 ? rounded : undefined;
}

const names: Partial<Record<PayrollContributionDefinition['category'], string>> = {
  avs_ai_apg: 'AVS, AI et APG', ac: 'Assurance chômage',
  aap: 'Accidents au travail', aanp: 'Accidents hors travail',
  family_allowance: 'Caisse d’allocations familiales', ijm: 'Perte de gain maladie',
};
export type PayrollBasisQuestion = {
  id: string;
  definitionId: string;
  label: string;
  definitions: PayrollContributionDefinition[];
  field: 'basisCents' | 'yearToDateBasisCents';
  amountCents?: number;
};

/** Group only the statutory bases already shared by the editor and native engine.
 * Different insurance contracts must never inherit one another's confirmed base. */
export function payrollBasisQuestions(
  definitions: PayrollContributionDefinition[], selections: PayrollContributionSelection[],
): PayrollBasisQuestion[] {
  const selected = new Map(selections.map(item => [item.definitionId, item]));
  const available = definitions.filter(item => selected.has(item.id));
  const result = new Map<string, PayrollBasisQuestion>();
  for (const definition of available) {
    const shared = ['avs_ai_apg', 'ac'].includes(definition.category);
    const grossGroup = shared && available.some(item => item.category === definition.category && item.basisKind === 'gross');
    const editable = !grossGroup && definition.basisKind !== 'gross' && !(definition.category === 'lpp' && definition.basisKind === 'coordinated');
    const fields: PayrollBasisQuestion['field'][] = editable ? ['basisCents'] : [];
    if (definition.annualCeilingCents && !['ac', 'aap', 'aanp'].includes(definition.category)) fields.push('yearToDateBasisCents');
    for (const field of fields) {
      // AVS/AI/APG share a monthly base, but their custom annual cumuls are independent.
      const group = shared && field === 'basisCents' ? definition.category : definition.id;
      const id = `${group}:${field}`;
      const amountCents = selected.get(definition.id)?.[field];
      const previous = result.get(id);
      if (previous) {
        previous.definitions.push(definition);
        if (previous.amountCents !== amountCents) previous.amountCents = undefined;
      } else result.set(id, {
        id, definitionId: definition.id, label: names[definition.category] ?? definition.label,
        definitions: [definition], field, amountCents,
      });
    }
  }
  return [...result.values()];
}

export function missingPayrollBasis(question: PayrollBasisQuestion): boolean {
  return question.amountCents === undefined || !Number.isSafeInteger(question.amountCents) || question.amountCents < 0;
}
