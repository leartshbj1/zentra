export type PayrollAnalysisDraftSnapshot = {
  importId: string;
  revision: number;
};

export function payrollAnalysisDraftSnapshot(
  importId: string,
  revision: number,
): PayrollAnalysisDraftSnapshot {
  return { importId, revision };
}

/**
 * Empêche un résultat asynchrone de remplacer une saisie effectuée après le
 * lancement de l'analyse. La personne conserve son brouillon et peut relancer.
 */
export function assertPayrollAnalysisDraftUnchanged(
  snapshot: PayrollAnalysisDraftSnapshot,
  currentRevision: number,
) {
  if (snapshot.revision === currentRevision) return;
  throw new Error(
    'Le brouillon a été modifié pendant l’analyse. Vos saisies ont été conservées; relancez l’analyse pour les fusionner avec le document.',
  );
}
