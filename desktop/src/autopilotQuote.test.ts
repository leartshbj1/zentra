// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { autopilotCreatedQuote, autopilotCustomer, autopilotDeposit, quoteTermsWithDeposit, withAutopilotDiscount, autopilotNewClient, autopilotRequestStage, linkAutopilotInvoice, markAutopilotDocumentSent, markAutopilotQuoteSent, autopilotQuoteLines, findAutopilotClient, saveAutopilotCreatedQuote } from './autopilotQuote';
import type { AutopilotReviewSuggestion } from './autopilotReview';
import type { CatalogItem, Client } from './types';
import { documentTotals } from './utils';

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

describe('discount and deposit chosen with the quote', () => {
  const line = (id: string, quantity: number, unitPriceCents: number, vatRateBp = 810, discountBp = 0) =>
    ({ id, catalogItemId: null, description: id, quantity, unit: 'pce', unitPriceCents, discountBp, vatRateBp });

  it('puts a percentage on every line and keeps a list discount already there', () => {
    const lines = withAutopilotDiscount([line('a', 2, 10_000), line('b', 1, 5_000, 810, 1000)], { unit: 'percent', value: 1000 });
    expect(lines.map(row => row.discountBp)).toEqual([1000, 1900]);
  });

  it('turns an amount into the percentage that comes closest to it', () => {
    const lines = [line('a', 3, 33_333), line('b', 1, 12_345, 260)];
    const before = documentTotals(lines).netCents;
    const after = documentTotals(withAutopilotDiscount(lines, { unit: 'amount', value: 10_000 })).netCents;
    expect(Math.abs(before - after - 10_000)).toBeLessThanOrEqual(6);
    expect(withAutopilotDiscount(lines, undefined)).toEqual(lines);
  });

  it('never discounts more than the quote', () => {
    const lines = withAutopilotDiscount([line('a', 1, 1_000)], { unit: 'amount', value: 50_000 });
    expect(documentTotals(lines).netCents).toBe(0);
  });

  it('computes the deposit like the deposit invoice: each line net, then its VAT', () => {
    const lines = [line('a', 1, 100_000), line('b', 1, 10_000, 0)];
    expect(autopilotDeposit(lines, { unit: 'percent', value: 3000 })).toEqual({ bp: 3000, amountCents: 30_000 + 2_430 + 3_000 });
    const asAmount = autopilotDeposit(lines, { unit: 'amount', value: 50_000 })!;
    expect(asAmount.bp).toBe(Math.round(50_000 * 10_000 / documentTotals(lines).totalCents));
    expect(Math.abs(asAmount.amountCents - 50_000)).toBeLessThanOrEqual(10);
    expect(autopilotDeposit(lines, undefined)).toBeNull();
  });

  it('writes the deposit in the quote terms and keeps it for the invoice', () => {
    expect(quoteTermsWithDeposit('Merci de votre confiance.', { bp: 3000, amountCents: 35_430 }, 'CHF'))
      .toMatch(/^Merci de votre confiance\.\n\nAcompte de 30 % à la commande, soit .*354\.30.*\.$/);
    saveAutopilotCreatedQuote('org', 'p1', { quoteId: 'q1', clientId: 'c1', depositBp: 3000 });
    expect(autopilotCreatedQuote('org', 'p1')).toEqual({ quoteId: 'q1', clientId: 'c1', depositBp: 3000 });
    saveAutopilotCreatedQuote('org', 'p2', { quoteId: 'q2', clientId: 'c1', depositBp: 20_000 });
    expect(autopilotCreatedQuote('org', 'p2')).toEqual({ quoteId: 'q2', clientId: 'c1' });
  });
});
