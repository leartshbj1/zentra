import { describe, expect, it } from 'vitest';
import { approvedPayrollSetupDefinitions } from './payrollSetupSelections';
import { mergePayrollProposals } from './payrollProposalMerge';
import type { PayrollContributionDefinition } from './types';

const aap = { id: 'aap', active: true, category: 'aap', side: 'employer', basisKind: 'ahv_salary', effectiveFrom: '2026-09-15', effectiveTo: '2026-12-31' } as PayrollContributionDefinition;
const input = { definitions: [aap, { ...aap, id: 'other' }], proposals: [], previousProposalIds: new Set<string>(), employeeId: 'employee', contributionDate: '2026-09-30' };
describe('retour du contrat vers la fiche de salaire', () => {
  it('reprend exactement le contrat choisi parmi plusieurs, sans choisir les autres', () => {
    const chosen = approvedPayrollSetupDefinitions({ ...input, explicitIds: ['aap'] });
    expect(chosen).toEqual([aap]);
    const merged = mergePayrollProposals({ current: { custom: { basisCents: 12345 } }, automaticIds: new Set(), proposals: chosen, approvedIds: new Set(['aap']), grossCents: 500000, ahvBasisCents: 500000 });
    expect(merged.selections).toEqual({ custom: { basisCents: 12345 }, aap: { basisCents: 500000 } });
  });
  it('conserve un contrat déjà proposé mais explicitement enregistré ou choisi', () => {
    expect(approvedPayrollSetupDefinitions({ ...input, previousProposalIds: new Set(['aap']), explicitIds: ['aap'] })).toEqual([aap]);
  });
  it('ne réintroduit pas les propositions auparavant écartées', () => {
    expect(approvedPayrollSetupDefinitions({ ...input, proposals: [aap], previousProposalIds: new Set(['aap']) })).toEqual([]);
  });
  it('écarte les contrats inactifs, hors période et LPP d’une autre personne', () => {
    const definitions = [
      { ...aap, id: 'inactive', active: false }, { ...aap, id: 'future', effectiveFrom: '2026-10-01' },
      { ...aap, id: 'expired', effectiveTo: '2026-09-29' }, { ...aap, id: 'lpp', category: 'lpp' as const, lppEmployeeId: 'someone-else' },
    ];
    expect(approvedPayrollSetupDefinitions({ ...input, definitions, explicitIds: definitions.map(d => d.id) })).toEqual([]);
  });
});
