import { describe, expect, it } from 'vitest';
import { BUNDLED_PLAN_CATALOG, formatPlanPrice, normalizePlanCatalog } from './planCatalog';

const grid = {
  version: 1, currency: 'CHF', trial: { days: 14, cardRequired: false },
  plans: [
    { id: 'solo', name: 'Solo', monthlyChfCents: 4900, people: 1, supportAnalyses: 0, recommended: false, licensePlan: 'zentra-solo-monthly-49-chf' },
    { id: 'start', name: 'Start', monthlyChfCents: 5900, people: 3, supportAnalyses: 0, recommended: true },
  ],
  complet: [{ id: 'team', name: 'Équipe', monthlyChfCents: 9900, people: 3, supportAnalyses: 5000, recommended: true, includes: { automation: true } }],
  support: [], automation: { monthlyChfCents: 1500 },
};

describe('plan catalog', () => {
  it('keeps names and prices exactly as published and ignores extra fields', () => {
    const catalog = normalizePlanCatalog(grid);
    expect(catalog?.plans.map(plan => [plan.id, plan.name, plan.monthlyChfCents, plan.recommended])).toEqual([['solo', 'Solo', 4900, false], ['start', 'Start', 5900, true]]);
    expect(catalog?.complet[0]).toEqual({ id: 'team', name: 'Équipe', monthlyChfCents: 9900, people: 3, supportAnalyses: 5000, recommended: true });
    expect(catalog?.trialDays).toBe(14);
  });

  it('rejects unknown versions, other currencies and malformed or duplicate rows', () => {
    for (const change of [{ version: 2 }, { currency: 'EUR' }, { plans: [] }, { plans: [{ ...grid.plans[0], monthlyChfCents: -1 }] },
      { plans: [{ ...grid.plans[0], monthlyChfCents: 49.5 }] }, { plans: [grid.plans[0], grid.plans[0]] }, { complet: 'none' }])
      expect(normalizePlanCatalog({ ...grid, ...change })).toBeNull();
    expect(normalizePlanCatalog(null)).toBeNull();
  });

  it('bundles the live grid for offline use and formats prices in CHF', () => {
    expect(BUNDLED_PLAN_CATALOG.plans.map(plan => plan.monthlyChfCents)).toEqual([4900, 5900, 8900]);
    expect(formatPlanPrice(4900, 'fr-CH')).toMatch(/49/);
    expect(formatPlanPrice(4900, 'fr-CH')).toMatch(/CHF/);
  });
});
