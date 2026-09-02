import type { Payslip, PayslipContributionSnapshot } from './types';

export type PayrollPaymentDateAssessment = {
  blocked: boolean;
  overrideAllowed: boolean;
  reason: string;
  frozenContributionDate: string;
};

function isRealIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function frozenDateForPayslip(payslip: Payslip): string {
  const snapshot = payslip.snapshot;
  if (!snapshot) return '';
  if (snapshot?.contributionDate) return snapshot.contributionDate;
  if (snapshot?.paymentDate) return snapshot.paymentDate;
  const period = snapshot?.period || payslip.period;
  return period ? `${period}-01` : '';
}

function contributionContainsDate(
  contribution: PayslipContributionSnapshot,
  date: string,
): boolean {
  return (
    date >= contribution.effectiveFrom &&
    (!contribution.effectiveTo || date <= contribution.effectiveTo)
  );
}

/**
 * Précontrôle UX. Le backend rejoue toujours la même règle dans la transaction
 * de paiement; cette fonction explique immédiatement pourquoi une date exige
 * une décomptabilisation/extourne et un nouveau calcul.
 */
export function assessPayrollPaymentDate(
  payslip: Payslip,
  paymentDate: string,
): PayrollPaymentDateAssessment {
  const frozenContributionDate = frozenDateForPayslip(payslip);
  if (!isRealIsoDate(paymentDate)) {
    return {
      blocked: true,
      overrideAllowed: false,
      reason: 'Saisissez une date de paiement réelle.',
      frozenContributionDate,
    };
  }
  if (!isRealIsoDate(frozenContributionDate)) {
    return {
      blocked: true,
      overrideAllowed: false,
      reason:
        'La preuve réglementaire figée est absente ou illisible. Le paiement doit être contrôlé avant de poursuivre.',
      frozenContributionDate,
    };
  }
  const contributions = payslip.snapshot?.contributions ?? [];
  if (paymentDate.slice(0, 4) !== frozenContributionDate.slice(0, 4)) {
    return {
      blocked: true,
      overrideAllowed: true,
      reason: `Cette date change le millésime réglementaire figé au ${frozenContributionDate}. Décomptabilisez/extournez la fiche, recalculez-la avec la date réelle puis faites-la revalider.`,
      frozenContributionDate,
    };
  }
  if (!contributions.length) {
    return {
      blocked: false,
      overrideAllowed: false,
      reason: '',
      frozenContributionDate,
    };
  }
  const invalidFrozenWindow = contributions.find(
    (item) =>
      !isRealIsoDate(item.effectiveFrom) ||
      (Boolean(item.effectiveTo) && !isRealIsoDate(item.effectiveTo)) ||
      (Boolean(item.effectiveTo) && item.effectiveTo < item.effectiveFrom) ||
      !contributionContainsDate(item, frozenContributionDate),
  );
  if (invalidFrozenWindow) {
    return {
      blocked: true,
      overrideAllowed: false,
      reason: `La fenêtre réglementaire figée de « ${invalidFrozenWindow.label} » est incohérente. Le paiement doit être contrôlé.`,
      frozenContributionDate,
    };
  }
  const outside = contributions.find(
    (item) => !contributionContainsDate(item, paymentDate),
  );
  if (outside) {
    return {
      blocked: true,
      overrideAllowed: true,
      reason: `Cette date sort de la fenêtre réglementaire figée de « ${outside.label} » (${outside.effectiveFrom} à ${outside.effectiveTo || 'sans fin'}). Décomptabilisez/extournez la fiche, recalculez-la avec la date réelle puis faites-la revalider.`,
      frozenContributionDate,
    };
  }
  return {
    blocked: false,
    overrideAllowed: false,
    reason: '',
    frozenContributionDate,
  };
}
