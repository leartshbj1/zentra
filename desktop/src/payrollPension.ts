import type { AppSettings } from './types';

export const PENSION_GUIDE_SOURCE =
  'https://www.bsv.admin.ch/fr/financement-de-la-prevoyance-professionnelle';

export type PensionPlanIssue = {
  field: 'pensionFund' | 'contractNumber' | 'regulationReference' | 'lppFrom' | 'lppTo' | 'lppParity';
  message: string;
};
const realDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const displayDate = (value: string) => value.split('-').reverse().join('.');

/** Explain the existing plan requirements at the exact input, before saving. */
export function pensionPlanIssue(payroll: AppSettings['payroll'], contributionDate?: string): PensionPlanIssue | null {
  const plan = payroll.lppPlanEvidence;
  if (!payroll.pensionFund.trim()) return { field: 'pensionFund', message: 'Recopiez le nom de votre caisse de pension sur le contrat d’affiliation, ou cherchez cette caisse dans la liste.' };
  if (!plan?.contractNumber.trim()) return { field: 'contractNumber', message: 'Recopiez le numéro de contrat ou d’affiliation de votre entreprise. Il figure sur le courrier de votre caisse de pension.' };
  if (plan.regulationReference.trim().length < 8) return { field: 'regulationReference', message: 'Indiquez un titre précis avec son année ou sa version, par exemple « Règlement de prévoyance 2026 ». Utilisez le titre de votre propre document, avec au moins 8 caractères.' };
  if (!realDate(plan.effectiveFrom)) return { field: 'lppFrom', message: 'Choisissez la date de début de validité indiquée sur le contrat ou le règlement de votre caisse.' };
  if (!realDate(plan.effectiveTo)) return { field: 'lppTo', message: 'Indiquez jusqu’à quelle date les informations reçues de la caisse sont confirmées. Si aucune période n’est indiquée, demandez-la à votre caisse.' };
  if (plan.effectiveTo < plan.effectiveFrom) return { field: 'lppTo', message: `La fin indiquée (${displayDate(plan.effectiveTo)}) est avant le début (${displayDate(plan.effectiveFrom)}). Vérifiez ces deux dates sur le document de la caisse.` };
  if (contributionDate && realDate(contributionDate)) {
    if (contributionDate < plan.effectiveFrom) return { field: 'lppFrom', message: `Cette fiche utilise la date du ${displayDate(contributionDate)}, mais le contrat commence le ${displayDate(plan.effectiveFrom)}. Reprenez le contrat applicable à cette date, ou revenez au salaire si sa date de paiement est erronée.` };
    if (contributionDate > plan.effectiveTo) return { field: 'lppTo', message: `Cette fiche utilise la date du ${displayDate(contributionDate)}, mais les informations du contrat s’arrêtent au ${displayDate(plan.effectiveTo)}. Demandez la période à jour à votre caisse, ou revenez au salaire si sa date de paiement est erronée.` };
  }
  if (!plan.employerAggregateShareConfirmed) return { field: 'lppParity', message: 'Vérifiez dans le règlement que l’entreprise finance au moins la moitié des cotisations de l’ensemble du personnel assuré, puis cochez la confirmation. Si ce n’est pas indiqué, demandez confirmation à votre caisse.' };
  return null;
}

/** Form completeness only; native payroll eligibility remains authoritative. */
export function pensionPlanComplete(
  payroll: AppSettings['payroll'],
  period?: string,
) {
  const p = payroll.lppPlanEvidence;
  return Boolean(
    !pensionPlanIssue(payroll) &&
    (!period ||
      (p && p.effectiveFrom.slice(0, 7) <= period &&
        p.effectiveTo.slice(0, 7) >= period)),
  );
}
