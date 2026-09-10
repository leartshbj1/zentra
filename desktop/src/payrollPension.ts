import type { AppSettings } from './types';

export const PENSION_GUIDE_SOURCE =
  'https://www.bsv.admin.ch/fr/financement-de-la-prevoyance-professionnelle';

/** Form completeness only; native payroll eligibility remains authoritative. */
export function pensionPlanComplete(
  payroll: AppSettings['payroll'],
  period?: string,
) {
  const p = payroll.lppPlanEvidence;
  const realDate = (v: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    Number.isFinite(Date.parse(v)) &&
    new Date(v).toISOString().slice(0, 10) === v;
  return Boolean(
    payroll.pensionFund.trim() &&
    p?.contractNumber.trim() &&
    p.regulationReference.trim().length >= 8 &&
    realDate(p.effectiveFrom) &&
    realDate(p.effectiveTo) &&
    p.effectiveTo >= p.effectiveFrom &&
    p.employerAggregateShareConfirmed &&
    (!period ||
      (p.effectiveFrom.slice(0, 7) <= period &&
        p.effectiveTo.slice(0, 7) >= period)),
  );
}
