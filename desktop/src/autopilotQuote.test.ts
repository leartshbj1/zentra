// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { autopilotCreatedQuote, autopilotCustomer, autopilotNewClient, autopilotRequestStage, linkAutopilotInvoice, markAutopilotDocumentSent, markAutopilotQuoteSent, autopilotQuoteLines, findAutopilotClient, saveAutopilotCreatedQuote } from './autopilotQuote';
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

  it('finds the client by e-mail, then company, then name, and leaves several matches to the person', () => {
    const clients = [client('c1', { name: 'Marie Rochat', email: 'marie@rive.ch' }), client('c2', { name: 'Atelier', company: 'Atelier Rive' }),
      client('c3', { name: 'Ancien', email: 'old@x.ch', archivedAt: '2026-01-01' }), client('c4', { name: 'Paul' }), client('c5', { name: 'Paul' })];
    expect(findAutopilotClient(clients, { name: 'Paul', company: 'Atelier Rive', email: 'marie@rive.ch' }, 'fr-CH')).toMatchObject({ id: 'c1' });
    expect(findAutopilotClient(clients, { name: 'Marie Rochat', company: 'atelier rive', email: 'new@x.ch' }, 'fr-CH')).toMatchObject({ id: 'c2' });
    expect(findAutopilotClient(clients, { name: 'marie rochat' }, 'fr-CH')).toMatchObject({ id: 'c1' });
    expect(findAutopilotClient(clients, { name: 'Paul' }, 'fr-CH')).toBe('ambiguous');
    expect(findAutopilotClient(clients, { email: 'old@x.ch' }, 'fr-CH')).toBeUndefined();
    expect(findAutopilotClient(clients, {}, 'fr-CH')).toBeUndefined();
  });

  it('reads the customer from the sender, and creates a client with the signature details', () => {
    const suggestion = { customer: { kind: 'new', name: 'Rochat' }, currency: 'CHF', netCents: 0, lines: [],
      sender: { email: 'marie@rive.ch', name: 'Marie Rochat', company: 'Atelier Rive SA', phone: '+41 21 000 00 00', street: 'Rue du Lac 4', postcode: '1003', city: 'Lausanne', source: 'signature' } } as AutopilotReviewSuggestion;
    const customer = autopilotCustomer(suggestion);
    expect(customer).toEqual({ name: 'Marie Rochat', company: 'Atelier Rive SA', email: 'marie@rive.ch', phone: '+41 21 000 00 00', street: 'Rue du Lac 4', postcode: '1003', city: 'Lausanne' });
    expect(autopilotNewClient('c9', customer)).toMatchObject({ id: 'c9', name: 'Atelier Rive SA', contactPerson: 'Marie Rochat', email: 'marie@rive.ch',
      phone: '+41 21 000 00 00', addressLine1: 'Rue du Lac 4', postalCode: '1003', city: 'Lausanne' });
    expect(autopilotCustomer({ ...suggestion, sender: undefined }).name).toBe('Rochat');
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
describe('sent quotes', () => {
  beforeEach(() => window.localStorage.clear());
  it('marks the request done once, and keeps it across a restart', () => {
    saveAutopilotCreatedQuote('org', 'p1', { quoteId: 'q1', clientId: 'c1' });
    markAutopilotQuoteSent('org', 'p1', 1000); markAutopilotQuoteSent('org', 'p1', 2000);
    expect(JSON.parse(window.localStorage.getItem('zentra.autopilot.created-quotes.v1')!).org.p1.sentAt).toBe(1000);
    expect(autopilotCreatedQuote('org', 'p1')).toEqual({ quoteId: 'q1', clientId: 'c1', sentAt: 1000 });
    markAutopilotQuoteSent('org', 'unknown', 1000);
    expect(autopilotCreatedQuote('org', 'unknown')).toBeNull();
  });
});
describe('request stages', () => {
  beforeEach(() => window.localStorage.clear());
  it('goes from open to done, back to accepted, then done once the invoice is sent', () => {
    expect(autopilotRequestStage(null)).toBe('open');
    expect(autopilotRequestStage({})).toBe('open');
    expect(autopilotRequestStage({ sentAt: 1 })).toBe('done');
    expect(autopilotRequestStage({ sentAt: 1, accepted: true })).toBe('accepted');
    expect(autopilotRequestStage({ sentAt: 1, accepted: true, invoiceSentAt: 2 })).toBe('done');
  });
  it('remembers the invoice of the request and when it was sent', () => {
    saveAutopilotCreatedQuote('org', 'p1', { quoteId: 'q1', clientId: 'c1', sentAt: 5 });
    markAutopilotQuoteSent('org', 'p1', 9, 'invoice');
    expect(autopilotCreatedQuote('org', 'p1')?.invoiceSentAt).toBeUndefined();
    linkAutopilotInvoice('org', 'p1', 'i1'); linkAutopilotInvoice('org', 'p1', 'i2');
    markAutopilotQuoteSent('org', 'p1', 9, 'invoice');
    expect(autopilotCreatedQuote('org', 'p1')).toEqual({ quoteId: 'q1', clientId: 'c1', sentAt: 5, invoiceId: 'i1', invoiceSentAt: 9 });
  });
});
describe('sent from any screen', () => {
  beforeEach(() => window.localStorage.clear());
  it('marks the request of a followed quote or invoice, wherever it was sent from', () => {
    saveAutopilotCreatedQuote('org', 'p1', { quoteId: 'q1', clientId: 'c1', sentAt: 5, invoiceId: 'i1' });
    expect(markAutopilotDocumentSent('quotes', 'unknown', 9)).toBe(false);
    expect(markAutopilotDocumentSent('invoices', 'i1', 9)).toBe(true);
    expect(autopilotCreatedQuote('org', 'p1')?.invoiceSentAt).toBe(9);
    expect(markAutopilotDocumentSent('reminders', 'i1', 9)).toBe(false);
  });
});
