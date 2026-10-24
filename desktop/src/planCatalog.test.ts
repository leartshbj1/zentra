import { describe, expect, it } from 'vitest';
import { BUNDLED_PLAN_CATALOG, findPlan, formatPlanPrice, normalizePlanCatalog, planForLicense } from './planCatalog';

// Shape served by https://zentraapp.ch/api/plans?version=2 on 24.10.2026.
const grid = {
  version: 2, currency: 'CHF', vatIncluded: true,
  trial: { days: 14, cardRequired: false, plan: 'equipe', people: 5, analyses: 500, autopilote: true },
  plans: [
    { id: 'solo', name: 'Solo', monthlyChfCents: 4900, yearlyChfCents: 49000, minPeople: 1, people: 1, analyses: 1000, autopilote: true, recommended: false },
    { id: 'equipe', name: 'Équipe', monthlyChfCents: 7900, yearlyChfCents: 79000, minPeople: 2, people: 5, analyses: 3000, autopilote: true, recommended: true },
    { id: 'pro', name: 'Pro', monthlyChfCents: 12900, yearlyChfCents: 129000, minPeople: 6, people: 15, analyses: 10000, autopilote: true, recommended: false },
  ],
  extraPerson: { plan: 'pro', monthlyChfCents: 700, yearlyChfCents: 7000, analyses: 500, available: false },
  analyses: { warningAt: 0.8, overageBilled: false },
};
const legacy = {
  version: 1, currency: 'CHF', trial: { days: 14, cardRequired: false, people: 3, supportAnalyses: 250 },
  plans: [{ id: 'start', name: 'Start', monthlyChfCents: 5900, people: 3, supportAnalyses: 0, recommended: true, licensePlan: 'zentra-start-monthly-59-chf' }],
  complet: [{ id: 'team', name: 'Équipe', monthlyChfCents: 9900, people: 3, supportAnalyses: 5000, recommended: true, includes: { automation: true } }],
  support: [], automation: { monthlyChfCents: 1500 },
};

describe('plan catalog', () => {
  it('reads the version 2 grid exactly as published, monthly and yearly', () => {
    const catalog = normalizePlanCatalog(grid);
    expect(catalog?.version).toBe(2);
    expect(catalog?.plans.map(plan => [plan.id, plan.name, plan.monthlyChfCents, plan.yearlyChfCents, plan.people, plan.analyses, plan.recommended])).toEqual([
      ['solo', 'Solo', 4900, 49000, 1, 1000, false], ['equipe', 'Équipe', 7900, 79000, 5, 3000, true], ['pro', 'Pro', 12900, 129000, 15, 10000, false]]);
    expect(catalog).toMatchObject({ trialDays: 14, trialPeople: 5, trialAnalyses: 500, warningAt: 0.8 });
  });

  it('bundles the same grid for offline use', () => {
    expect(normalizePlanCatalog(grid)).toEqual(BUNDLED_PLAN_CATALOG);
  });

  it('falls back to the Complet list of a version 1 server, never to the gestion-only plans', () => {
    const catalog = normalizePlanCatalog(legacy);
    expect(catalog?.version).toBe(1);
    expect(catalog?.plans).toEqual([{ id: 'team', name: 'Équipe', monthlyChfCents: 9900, yearlyChfCents: null, minPeople: 1, people: 3, analyses: 5000, recommended: true }]);
    expect(catalog).toMatchObject({ trialPeople: 3, trialAnalyses: 250 });
  });

  it('rejects unknown versions, other currencies, missing Autopilote and malformed or duplicate rows', () => {
    const row = grid.plans[0];
    for (const change of [{ version: 3 }, { currency: 'EUR' }, { plans: [] }, { plans: [{ ...row, monthlyChfCents: -1 }] },
      { plans: [{ ...row, monthlyChfCents: 49.5 }] }, { plans: [row, row] }, { plans: [{ ...row, yearlyChfCents: undefined }] },
      { plans: [{ ...row, autopilote: false }] }, { plans: [{ ...row, minPeople: 2 }] }, { plans: 'none' }])
      expect(normalizePlanCatalog({ ...grid, ...change })).toBeNull();
    expect(normalizePlanCatalog({ ...legacy, complet: 'none' })).toBeNull();
    expect(normalizePlanCatalog(null)).toBeNull();
  });

  it('names licence ids and the account server ids after the catalogue', () => {
    expect(planForLicense(BUNDLED_PLAN_CATALOG, 'zentra-solo-monthly-49-chf')?.name).toBe('Solo');
    expect(planForLicense(BUNDLED_PLAN_CATALOG, 'zentra-start-monthly-59-chf')?.name).toBe('Équipe');
    expect(planForLicense(BUNDLED_PLAN_CATALOG, 'zentra-pro-monthly-89-chf')).toMatchObject({ name: 'Pro', monthlyChfCents: 12900 });
    expect(planForLicense(BUNDLED_PLAN_CATALOG, 'zentra-unknown')).toBeNull();
    expect(findPlan(BUNDLED_PLAN_CATALOG, 'team')?.id).toBe('equipe');
    expect(findPlan(normalizePlanCatalog(legacy)!, 'equipe')?.id).toBe('team');
    expect(findPlan(BUNDLED_PLAN_CATALOG, null)).toBeNull();
  });

  it('formats prices in CHF', () => {
    expect(formatPlanPrice(4900, 'fr-CH')).toMatch(/49/);
    expect(formatPlanPrice(4900, 'fr-CH')).toMatch(/CHF/);
  });
});
