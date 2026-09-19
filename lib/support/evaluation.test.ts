import { describe, expect, it, vi } from 'vitest';
import { evaluationTickets, evaluateTestBatch } from './evaluation';
import type { Decision } from './types';

describe('Évaluation privée de tickets fictifs', () => {
  const ticket = { id: 'case-1', subject: 'Question', body: 'Comment faire ?' };
  it('refuse les lots invalides et les réponses attendues envoyées au modèle', () => {
    for (const value of [
      null,
      [],
      Array(11).fill(ticket),
      [ticket, ticket],
      [{ ...ticket, body: '' }],
      [{ ...ticket, body: 'x'.repeat(4001) }],
      [{ ...ticket, expectedCategory: 'billing' }],
      [{ ...ticket, id: '../private' }],
    ])
      expect(() => evaluationTickets(value)).toThrow();
    expect(evaluationTickets([ticket])).toEqual([ticket]);
  });
  it('borne la concurrence, utilise des destinations fictives et conserve les échecs', async () => {
    let active = 0,
      maximum = 0;
    const evaluate = vi.fn(async (item, rules) => {
      active++;
      maximum = Math.max(active, maximum);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      if (item.id === 'case-2') throw new Error('secret-key-should-never-leak');
      return {
        category: 'billing',
        priority: 'normal',
        confidence: 0.99,
        destination: rules.billing,
        signals: { humanRequested: item.id === 'case-3' ? 1 : 0 },
      } as Decision;
    });
    const report = await evaluateTestBatch(
      'private-key',
      Array.from({ length: 10 }, (_, i) => ({ ...ticket, id: `case-${i}` })),
      evaluate,
    );
    expect(maximum).toBe(3);
    expect(report.results).toHaveLength(10);
    expect(report.results[0]).toMatchObject({
      automatic: true,
      decision: { destination: { teamId: 'evaluation-billing' } },
    });
    expect(report.results[2]).toMatchObject({
      automatic: false,
      error: 'analysis_unavailable',
    });
    expect(report.results[3]).toMatchObject({ automatic: false });
    expect(JSON.stringify(report)).not.toContain('secret-key');
    expect(JSON.stringify(report)).not.toContain('private-key');
  });
});
