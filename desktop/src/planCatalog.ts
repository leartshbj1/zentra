import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { diagnosticInvoke as invoke } from './diagnostics';

/**
 * The single price grid published by the site at /api/plans?version=2 (Solo,
 * Équipe, Pro, Autopilote included). The app shows names and prices exactly as
 * returned and keeps this bundled copy for offline use, so prices are never
 * invented or converted locally. A server that only knows version 1 answers
 * with its Complet list, which also included Autopilote.
 */
export type PlanOffer = Readonly<{
  id: string;
  name: string;
  monthlyChfCents: number;
  /** null when the grid publishes no yearly price (version 1). */
  yearlyChfCents: number | null;
  minPeople: number;
  people: number;
  analyses: number;
  recommended: boolean;
}>;
export type PlanCatalog = Readonly<{
  version: 1 | 2;
  currency: 'CHF';
  trialDays: number;
  trialPeople: number;
  trialAnalyses: number;
  /** Share of the monthly analyses after which the owner is warned. */
  warningAt: number;
  plans: readonly PlanOffer[];
}>;

/** Terms of the v2 subscriptions, used only when the server sends no version. */
export const SUBSCRIPTION_TERMS_VERSION = 'abonnement-2026-10-23';

export const BUNDLED_PLAN_CATALOG: PlanCatalog = {
  version: 2,
  currency: 'CHF',
  trialDays: 14,
  trialPeople: 5,
  trialAnalyses: 500,
  warningAt: 0.8,
  plans: [
    { id: 'solo', name: 'Solo', monthlyChfCents: 4900, yearlyChfCents: 49000, minPeople: 1, people: 1, analyses: 1000, recommended: false },
    { id: 'equipe', name: 'Équipe', monthlyChfCents: 7900, yearlyChfCents: 79000, minPeople: 2, people: 5, analyses: 3000, recommended: true },
    { id: 'pro', name: 'Pro', monthlyChfCents: 12900, yearlyChfCents: 129000, minPeople: 6, people: 15, analyses: 10000, recommended: false },
  ],
};

// Licence tokens keep the identifiers the app already verifies; the formula
// shown to people is the catalogue's (Équipe, not Start; Pro 129, not 89).
const LICENSE_PLANS: Readonly<Record<string, string>> = {
  'zentra-solo-monthly-49-chf': 'solo',
  'zentra-start-monthly-59-chf': 'equipe',
  'zentra-pro-monthly-89-chf': 'pro',
};
// The account server names Équipe "team" internally (Complet engine).
const canonical = (id: string | null | undefined) => (id === 'team' ? 'equipe' : id ?? '');

export function findPlan(catalog: PlanCatalog, id: string | null | undefined): PlanOffer | null {
  const wanted = canonical(id);
  return wanted ? catalog.plans.find(plan => canonical(plan.id) === wanted) ?? null : null;
}
export function planForLicense(catalog: PlanCatalog, licensePlan: string | null | undefined): PlanOffer | null {
  return licensePlan ? findPlan(catalog, LICENSE_PLANS[licensePlan]) : null;
}

const count = (value: unknown, max: number) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
const field = (raw: unknown) => (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null);

function offer(raw: unknown, version: 1 | 2): PlanOffer | null {
  const row = field(raw);
  if (!row) return null;
  const id = typeof row.id === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(row.id) ? row.id : null;
  const name = typeof row.name === 'string' && row.name.trim() && row.name.length <= 40 ? row.name.trim() : null;
  const monthly = count(row.monthlyChfCents, 10_000_000);
  const people = count(row.people, 100_000);
  const analyses = count(version === 2 ? row.analyses : row.supportAnalyses, 10_000_000);
  const yearly = version === 2 ? count(row.yearlyChfCents, 100_000_000) : null;
  const minPeople = version === 2 ? count(row.minPeople, 100_000) : 1;
  if (!id || !name || monthly === null || people === null || analyses === null || minPeople === null || minPeople > people) return null;
  if (version === 2 && (yearly === null || row.autopilote !== true)) return null;
  return { id, name, monthlyChfCents: monthly, yearlyChfCents: yearly, minPeople, people, analyses, recommended: row.recommended === true };
}

function offers(raw: unknown, version: 1 | 2): PlanOffer[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 12) return null;
  const parsed = raw.map(item => offer(item, version));
  if (parsed.some(item => item === null)) return null;
  const list = parsed as PlanOffer[];
  return new Set(list.map(item => canonical(item.id))).size === list.length ? list : null;
}

/** Accepts only a well-formed CHF grid; anything else keeps the bundled copy. */
export function normalizePlanCatalog(raw: unknown): PlanCatalog | null {
  const body = field(raw);
  if (!body || body.currency !== 'CHF' || (body.version !== 1 && body.version !== 2)) return null;
  const version = body.version as 1 | 2;
  // Version 1: only the Complet list included Autopilote, the gestion-only
  // "plans" are no longer sold.
  const plans = offers(version === 2 ? body.plans : body.complet, version);
  if (!plans) return null;
  const trial = field(body.trial);
  const warning = field(body.analyses)?.warningAt;
  return {
    version,
    currency: 'CHF',
    plans,
    trialDays: count(trial?.days, 365) ?? BUNDLED_PLAN_CATALOG.trialDays,
    trialPeople: count(trial?.people, 100_000) ?? BUNDLED_PLAN_CATALOG.trialPeople,
    trialAnalyses: count(version === 2 ? trial?.analyses : trial?.supportAnalyses, 10_000_000) ?? BUNDLED_PLAN_CATALOG.trialAnalyses,
    warningAt: typeof warning === 'number' && warning > 0 && warning < 1 ? warning : BUNDLED_PLAN_CATALOG.warningAt,
  };
}

let cached: PlanCatalog | null = null;
let pending: Promise<PlanCatalog> | null = null;

export function loadPlanCatalog(): Promise<PlanCatalog> {
  if (cached) return Promise.resolve(cached);
  if (!isTauri()) return Promise.resolve(BUNDLED_PLAN_CATALOG);
  pending ??= invoke<unknown>('get_plan_catalog')
    .then(raw => (cached = normalizePlanCatalog(raw) ?? BUNDLED_PLAN_CATALOG))
    .catch(() => BUNDLED_PLAN_CATALOG)
    .finally(() => { pending = null; });
  return pending;
}

export function usePlanCatalog(): PlanCatalog {
  const [catalog, setCatalog] = useState<PlanCatalog>(cached ?? BUNDLED_PLAN_CATALOG);
  useEffect(() => {
    let active = true;
    void loadPlanCatalog().then(value => { if (active) setCatalog(value); });
    return () => { active = false; };
  }, []);
  return catalog;
}

export function formatPlanPrice(cents: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'CHF', maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
}
