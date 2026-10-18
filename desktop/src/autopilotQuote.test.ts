// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { autopilotCreatedQuote, autopilotNewClient, autopilotQuoteLines, findAutopilotClient, saveAutopilotCreatedQuote } from './autopilotQuote';
import type { AutopilotReviewSuggestion } from './autopilotReview';
import type { CatalogItem, Client } from './types';

const client = (id: string, values: Partial<Client>) => ({ id, name: '', company: '', email: '', ...values }) as Client;
const article = (id: string, name: string) => ({ id, name, unit: 'pce', salesPriceCents: 4500, vatBp: 810 }) as CatalogItem;

describe('autopilot quote', () => {
  beforeEach(() => window.localStorage.clear());

  it('takes the matched lines and the linked lines', () => {
    const suggestion: AutopilotReviewSuggestion = { customer: { kind: 'new', name: 'Atelier Rive' }, currency: 'CHF', netCents: 2000,
      lines: [{ articleId: 'a1', description: 'Pose', unit: 'h', quantityMilli: 2500, unitPriceCents: 800, taxRateBp: 810, netCents: 2000 }],
      unmatched: ['3 licences', 'inconnu'] };
    let n = 0;
    const lines = autopilotQuoteLines(suggestion, { '3 licences': { articleId: 'a2', name: 'Licence', term: 'licences' } },
      [article('a1', 'Pose'), article('a2', 'Licence')], () => `l${++n}`);
    expect(lines).toEqual([
      { id: 'l1', catalogItemId: 'a1', description: 'Pose', quantity: 2.5, unit: 'h', unitPriceCents: 800, discountBp: 0, vatRateBp: 810 },
      { id: 'l2', catalogItemId: 'a2', description: 'Licence', quantity: 3, unit: 'pce', unitPriceCents: 4500, discountBp: 0, vatRateBp: 810 },
    ]);
  });

  it('finds the client by e-mail first, then by name or company', () => {
    const clients = [client('c1', { name: 'Marie Rochat', email: 'marie@rive.ch' }), client('c2', { name: 'Atelier', company: 'Atelier Rive' }),
      client('c3', { name: 'Ancien', email: 'old@x.ch', archivedAt: '2026-01-01' })];
    expect(findAutopilotClient(clients, { name: 'Autre', email: 'MARIE@rive.ch ' }, 'fr-CH')?.id).toBe('c1');
    expect(findAutopilotClient(clients, { name: 'atelier rive' }, 'fr-CH')?.id).toBe('c2');
    expect(findAutopilotClient(clients, { email: 'old@x.ch' }, 'fr-CH')).toBeUndefined();
    expect(findAutopilotClient(clients, {}, 'fr-CH')).toBeUndefined();
  });

  it('creates a client from the name, the company or the address', () => {
    expect(autopilotNewClient('c9', { name: ' Marie ', email: 'm@r.ch' })).toMatchObject({ id: 'c9', name: 'Marie', contactPerson: 'Marie', email: 'm@r.ch' });
    expect(autopilotNewClient('c9', { name: 'Marie', company: 'Rive SA' })?.name).toBe('Rive SA');
    expect(autopilotNewClient('c9', { email: 'm@r.ch' })?.name).toBe('m@r.ch');
    expect(autopilotNewClient('c9', {})).toBeNull();
  });

  it('remembers the quote made from a request, per company', () => {
    saveAutopilotCreatedQuote('org', 'p1', { quoteId: 'q1', clientId: 'c1' });
    expect(autopilotCreatedQuote('org', 'p1')).toEqual({ quoteId: 'q1', clientId: 'c1' });
    expect(autopilotCreatedQuote('other', 'p1')).toBeNull();
    saveAutopilotCreatedQuote('org', 'p1', null);
    expect(autopilotCreatedQuote('org', 'p1')).toBeNull();
  });
});
