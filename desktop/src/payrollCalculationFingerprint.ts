import type { PayrollContributionSelection, PayslipLine } from './types';

export type PayrollCalculationFingerprintInput = {
  employeeId: string;
  period: string;
  lines: PayslipLine[];
  selections: PayrollContributionSelection[];
};

/**
 * Empreinte canonique de toutes les données dont dépend l'aperçu de paie.
 * Elle ne constitue pas une signature de sécurité; le serveur recalcule
 * toujours. Elle empêche l'interface d'enregistrer un aperçu devenu obsolète.
 */
export function payrollCalculationFingerprint(
  input: PayrollCalculationFingerprintInput,
): string {
  return JSON.stringify({
    employeeId: input.employeeId.trim(),
    period: input.period,
    lines: input.lines.map((line) => ({
      id: line.id,
      label: line.label,
      kind: line.kind,
      amountCents: line.amountCents,
    })),
    selections: [...input.selections]
      .sort((left, right) =>
        left.definitionId.localeCompare(right.definitionId),
      )
      .map((selection) => ({
        definitionId: selection.definitionId,
        basisCents: selection.basisCents ?? null,
        yearToDateBasisCents: selection.yearToDateBasisCents ?? null,
      })),
  });
}

export function isPayrollCalculationCurrent(
  calculatedFingerprint: string | null,
  currentFingerprint: string,
): boolean {
  return (
    calculatedFingerprint !== null &&
    calculatedFingerprint === currentFingerprint
  );
}
