import type { PayrollContributionDefinition } from './types';

/** A saved/selected contract is explicit consent, even when duplicate contracts
 * prevent automatic suggestions. Never add an expired or another person's plan. */
export function approvedPayrollSetupDefinitions(input: {
  definitions: PayrollContributionDefinition[];
  proposals: PayrollContributionDefinition[];
  previousProposalIds: ReadonlySet<string>;
  explicitIds?: readonly string[];
  employeeId: string;
  contributionDate: string;
}) {
  const approved = new Set([
    ...input.proposals.filter(d => !input.previousProposalIds.has(d.id)).map(d => d.id),
    ...(input.explicitIds ?? []),
  ]);
  return input.definitions.filter(d => approved.has(d.id) && d.active &&
    d.effectiveFrom <= input.contributionDate && (!d.effectiveTo || d.effectiveTo >= input.contributionDate) &&
    (d.category !== 'lpp' || d.lppEmployeeId === input.employeeId));
}
