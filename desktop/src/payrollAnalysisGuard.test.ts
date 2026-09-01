import { describe, expect, it } from 'vitest';
import {
  assertPayrollAnalysisDraftUnchanged,
  payrollAnalysisDraftSnapshot,
} from './payrollAnalysisGuard';

describe('verrou de brouillon pendant l’analyse paie', () => {
  it('accepte le résultat si aucune saisie n’a changé', () => {
    const snapshot = payrollAnalysisDraftSnapshot('import-1', 4);
    expect(() => assertPayrollAnalysisDraftUnchanged(snapshot, 4)).not.toThrow();
  });

  it('refuse le résultat tardif sans écraser la saisie plus récente', () => {
    const snapshot = payrollAnalysisDraftSnapshot('import-1', 4);
    expect(() => assertPayrollAnalysisDraftUnchanged(snapshot, 5)).toThrow(
      /saisies ont été conservées/,
    );
  });
});
