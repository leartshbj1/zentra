import { describe, expect, it } from 'vitest';
import { evaluateCalibration, TRIAGE_EXAMPLES } from './calibration';
import type { Decision } from './types';
describe('Évaluation de configuration', () => {
  it('mesure les écarts, demandes humaines et échecs sans surévaluer les résultats', async () => {
    const report = await evaluateCalibration(
      'fixture-key',
      async (item, rules) => {
        if (item.id === 'bug') throw new Error('unavailable');
        return {
          category: item.id === 'billing' ? 'other' : item.category,
          priority: item.priority,
          confidence: 0.95,
          categoryConfidence: 0.95,
          priorityConfidence: 0.95,
          probabilities: {},
          model: 'fixture',
          inputTokens: 0,
          destination: rules[item.category] || null,
          reason: 'fixture',
          signals: {
            language: 'fr',
            languageConfidence: 1,
            frustration: 0,
            frustrationConfidence: 1,
            humanRequested: item.human ? 1 : 0,
          },
        } as Decision;
      },
    );
    expect(report.total).toBe(TRIAGE_EXAMPLES.length);
    expect(report.passed).toBe(10);
    expect(report.results.find((r) => r.id === 'human')).toMatchObject({
      passed: true,
      automatic: false,
    });
    expect(report.results.find((r) => r.id === 'injection')).toMatchObject({
      passed: true,
      automatic: false,
    });
    expect(report.results.find((r) => r.id === 'bug')).toMatchObject({
      passed: false,
      confidence: null,
    });
    expect(JSON.stringify(report)).not.toContain('fixture-key');
  });
});
