// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { matchAcceptance, type AutopilotAcceptance } from './autopilotAcceptance';
import { missingInfoDraft, requestsMissingInfo } from './autopilotMissingInfo';
import { quoteNamedInMail, writtenAmountCents, writtenDate } from './autopilotQuoteMatch';
import { clarificationFrom, normalizeAutopilotReviewPage } from './autopilotReview';
import { mailSignalFrom, proposeForSignal, type MailSignal } from './autopilotSignals';
import type { Client, DocumentLine, Quote } from './types';

const line = (unitPriceCents: number, quantity = 1): DocumentLine => ({ id: 'l', description: 'Article', quantity, unit: 'pce', unitPriceCents, vatRateBp: 810 });
const quote = (id: string, number: string, clientId: string, issueDate: string, lines: DocumentLine[], status: Quote['status'] = 'issued') =>
  ({ id, number, clientId, status, issueDate, createdAt: issueDate + 'T08:00:00Z', lines }) as Quote;
const client = (id: string, email: string) => ({ id, name: id, company: '', email }) as Client;
const sender = { email: 'marc@rochat.ch', name: 'Marc Rochat', company: null, phone: null, street: null, postcode: null, city: null, source: 'envelope' as const };
// 12 Oct: CHF 1’200 without VAT; 14 Oct: CHF 3’480 without VAT.
const quotes = [quote('q38', 'D-2026-0038', 'c1', '2026-10-12', [line(120_000)]), quote('q41', 'D-2026-0041', 'c1', '2026-10-14', [line(348_000)])];
const clients = [client('c1', 'marc@rochat.ch')];
const received = Date.UTC(2026, 10, 2) / 1000;

describe('the quote a client’s mail is about', () => {
  beforeEach(() => window.localStorage.clear());
  it('reads amounts and dates as the client writes them', () => {
    expect(writtenAmountCents('pour l’offre du 14 octobre (CHF 3’480.-)')).toBe(348_000);
    expect(writtenAmountCents('3 480,50 CHF')).toBe(348_050);
    expect(writtenAmountCents('merci')).toBeNull();
    expect(writtenDate('l’offre du 14 octobre', received)).toBe('2026-10-14');
    expect(writtenDate('Angebot vom 14.10.', received)).toBe('2026-10-14');
    expect(writtenDate('offre du 20 décembre', received)).toBe('2025-12-20');
  });
  it('links an acceptance by number, then amount, then date, before asking', () => {
    const accept = (evidence: string, quoteReference: string | null = null): AutopilotAcceptance =>
      ({ sourceId: 's', receivedAt: received, quoteReference, evidence, sender, requiresHumanValidation: true });
    expect(matchAcceptance(accept('Bon pour accord', 'D-2026-0038'), quotes, clients, [])).toEqual({ quote: quotes[0] });
    expect(matchAcceptance(accept('Bon de commande pour l’offre de CHF 3’480.-'), quotes, clients, [])).toEqual({ quote: quotes[1] });
    // With VAT, rounded to the franc: 1’200 + 8.1 % = 1’297.20.
    expect(matchAcceptance(accept('OK pour les Fr. 1297.-'), quotes, clients, [])).toEqual({ quote: quotes[0] });
    expect(matchAcceptance(accept('Ok pour l’offre du 12 octobre'), quotes, clients, [])).toEqual({ quote: quotes[0] });
    const asked = matchAcceptance(accept('C’est tout bon pour nous'), quotes, clients, []);
    expect('candidates' in asked && asked.candidates.map(row => row.id)).toEqual(['q41', 'q38']);
    expect(quoteNamedInMail({ quoteReference: null, evidence: 'CHF 9’999.-', receivedAt: received }, quotes)).toBeNull();
  });
});

describe('change requests and client reminders', () => {
  const signal = (kind: string, evidence: string, quoteReference: string | null = null) => mailSignalFrom({ kind, sourceId: 't1', receivedAt: received,
    subject: 'Votre offre', evidence, quoteReference, invoiceReference: null, amountCents: null, currency: null, documentType: null, requiresHumanValidation: true }, sender);
  const data = { invoices: [], payments: [], quotes, clients, suppliers: [], supplierInvoices: [] };
  it('opens the quote the client wants changed, by number, date or as their latest', () => {
    const change = signal('quote_change', 'Pouvez-vous enlever la pose ?', 'D-2026-0038') as MailSignal;
    expect(change.kind).toBe('quote_change');
    expect(proposeForSignal(change, data)).toEqual({ action: 'change_quote', quote: quotes[0] });
    expect(proposeForSignal(signal('quote_change', 'Pour l’offre du 12 octobre, sans la pose svp')!, data)).toEqual({ action: 'change_quote', quote: quotes[0] });
    expect(proposeForSignal(signal('quote_change', 'Une version sans la pose ?')!, data)).toEqual({ action: 'change_quote', quote: quotes[1] });
  });
  it('turns a reminder into a follow-up of the client', () => {
    expect(proposeForSignal(signal('customer_reminder', 'Avez-vous pu avancer sur mon devis ?')!, data)).toEqual({ action: 'follow_up', client: clients[0] });
  });
  it('still leaves an unknown kind out', () => {
    expect(signal('invented', 'x')).toBeNull();
  });
});

describe('what to ask the client', () => {
  const item = (clarification: unknown) => normalizeAutopilotReviewPage({ organizationId: 'org', nextCursor: null, items: [{ proposalId: 'p1', sourceId: 's1', createdAt: 1,
    disposition: 'needs_review', reasons: ['low_confidence'], requiresHumanValidation: true, clarification,
    suggestion: { customer: null, currency: 'CHF', netCents: 0, lines: [], sender } }] }, 'org')!.items[0];
  it('keeps the question and notes, and drops a malformed clarification alone', () => {
    const asked = item({ question: 'Quelle puissance souhaitez-vous ?', notes: ['RAD-900 : 900 W demandé, pas 600 W'] });
    expect(asked.clarification).toEqual({ question: 'Quelle puissance souhaitez-vous ?', notes: ['RAD-900 : 900 W demandé, pas 600 W'] });
    expect(item({ question: 'x'.repeat(301), notes: [] }).clarification).toBeUndefined();
    expect(item({ question: null, notes: [], extra: 1 }).proposalId).toBe('p1');
    expect(clarificationFrom({ question: null, notes: [] })).toBeUndefined();
  });
  it('drafts the reply with that exact question, even when only the confidence was low', () => {
    const asked = item({ question: 'Quelle puissance souhaitez-vous : 600 W ou 900 W ?', notes: [] });
    expect(requestsMissingInfo([asked])).toHaveLength(1);
    const draft = missingInfoDraft(asked, 'fr', 'Morel Sanitaire SA');
    expect(draft.to).toBe('marc@rochat.ch');
    expect(draft.body).toBe('Bonjour Marc Rochat,\n\nMerci pour votre demande. Pour vous envoyer un devis exact :\nQuelle puissance souhaitez-vous : 600 W ou 900 W ?\n\nAvec nos meilleures salutations\nMorel Sanitaire SA');
  });
});
