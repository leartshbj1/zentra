import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { diagnosticInvoke as invoke } from './diagnostics';

/**
 * The single price grid published by the site at /api/plans. The app shows
 * names and prices exactly as returned and keeps this bundled copy for
 * offline use, so prices are never invented or converted locally.
 */
export type PlanOffer = Readonly<{
  id: string;
  name: string;
  monthlyChfCents: number;
  people: number;
  supportAnalyses: number;
  recommended: boolean;
}>;
export type PlanCatalog = Readonly<{
  currency: 'CHF';
  trialDays: number;
  plans: readonly PlanOffer[];
  complet: readonly PlanOffer[];
}>;

export const BUNDLED_PLAN_CATALOG: PlanCatalog = {
  currency: 'CHF',
  trialDays: 14,
  plans: [
    { id: 'solo', name: 'Solo', monthlyChfCents: 4900, people: 1, supportAnalyses: 0, recommended: false },
    { id: 'start', name: 'Start', monthlyChfCents: 5900, people: 3, supportAnalyses: 0, recommended: true },
    { id: 'pro', name: 'Pro', monthlyChfCents: 8900, people: 10, supportAnalyses: 0, recommended: false },
  ],
  complet: [
    { id: 'solo', name: 'Solo', monthlyChfCents: 7900, people: 1, supportAnalyses: 2000, recommended: false },
    { id: 'team', name: 'Équipe', monthlyChfCents: 9900, people: 3, supportAnalyses: 5000, recommended: true },
    { id: 'pro', name: 'Pro', monthlyChfCents: 16900, people: 10, supportAnalyses: 15000, recommended: false },
  ],
};

const count = (value: unknown, max: number) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;

function offer(raw: unknown): PlanOffer | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(row.id) ? row.id : null;
  const name = typeof row.name === 'string' && row.name.trim() && row.name.length <= 40 ? row.name.trim() : null;
  const cents = count(row.monthlyChfCents, 10_000_000);
  const people = count(row.people, 100_000);
  const analyses = count(row.supportAnalyses, 10_000_000);
  if (!id || !name || cents === null || people === null || analyses === null) return null;
  return { id, name, monthlyChfCents: cents, people, supportAnalyses: analyses, recommended: row.recommended === true };
}

function offers(raw: unknown): PlanOffer[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 12) return null;
  const parsed = raw.map(offer);
  if (parsed.some(item => item === null)) return null;
  const list = parsed as PlanOffer[];
  return new Set(list.map(item => item.id)).size === list.length ? list : null;
}

/** Accepts only a well-formed CHF grid; anything else keeps the bundled copy. */
export function normalizePlanCatalog(raw: unknown): PlanCatalog | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;
  if (body.version !== 1 || body.currency !== 'CHF') return null;
  const plans = offers(body.plans);
  const complet = offers(body.complet);
  if (!plans || !complet) return null;
  const trial = body.trial && typeof body.trial === 'object' ? count((body.trial as Record<string, unknown>).days, 365) : null;
  return { currency: 'CHF', trialDays: trial ?? BUNDLED_PLAN_CATALOG.trialDays, plans, complet };
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
