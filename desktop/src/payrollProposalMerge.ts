import type { PayrollContributionDefinition } from './types';

type Draft = { basisCents?: number; yearToDateBasisCents?: number };

/** Add only approved proposals. Existing choices and manually entered bases stay intact. */
export function mergePayrollProposals(input: {
  current: Record<string, Draft>;
  automaticIds: ReadonlySet<string>;
  proposals: PayrollContributionDefinition[];
  approvedIds: ReadonlySet<string>;
  grossCents: number;
  ahvBasisCents?: number;
  coordinatedAnnualCents?: number;
}) {
  const selections = { ...input.current };
  const automaticIds = new Set(input.automaticIds);
  const addedIds: string[] = [];
  for (const definition of input.proposals) {
    if (!input.approvedIds.has(definition.id) ||
        Object.prototype.hasOwnProperty.call(selections, definition.id)) continue;
    selections[definition.id] = {
      basisCents: definition.basisKind === 'coordinated' ? input.coordinatedAnnualCents
        : definition.basisKind === 'gross' ? input.grossCents
          : definition.basisKind === 'ahv_salary' ? input.ahvBasisCents : undefined,
    };
    if (definition.basisKind === 'ahv_salary') automaticIds.add(definition.id);
    addedIds.push(definition.id);
  }
  return { selections, automaticIds, addedIds };
}
