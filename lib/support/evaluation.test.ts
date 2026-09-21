import { describe, expect, it, vi } from 'vitest';
import { evaluationTickets, evaluateTestBatch, evaluationDocuments, evaluateDocumentBatch } from './evaluation';
import { emptyExtraction } from '../supplier-inbox/extraction';
import type { Decision } from './types';

describe('Évaluation privée de tickets fictifs', () => {
  const ticket = { id: 'case-1', subject: 'Question', body: 'Comment faire ?' };
  it('valide le destinataire et interdit des critères attendus ou instructions de test arbitraires', () => {
    expect(evaluationDocuments([{...ticket, recipient: 'Entreprise Test'}])[0].recipient).toBe('Entreprise Test');
    for (const input of [null, [], [{...ticket}], [{...ticket, recipient:''}], [{...ticket, recipient:'Test', expected:'supplier_invoice'}]])
      expect(() => evaluationDocuments(input)).toThrow();
  });
  it('mesure séparément extraction et classement sans masquer un échec ni exposer un secret', async () => {
    const items = [0,1].map(i => ({...ticket,id:`doc-${i}`,recipient:'Test'}));
    const result = await evaluateDocumentBatch('unused', items,
      async () => ({policyVersion:'test',threshold:85,results:items.map(item => ({id:item.id,automatic:false,error:'analysis_unavailable',durationMs:1}))}),
      async item => {if(item.id==='doc-1') throw Error('private-secret'); return emptyExtraction('à vérifier');},
    );
    expect(result.results[0]).toHaveProperty('extraction.kind','unknown');
    expect(result.results[1]).toHaveProperty('extractionError','analysis_unavailable');
    expect(JSON.stringify(result)).not.toContain('private-secret');
  });
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
