// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { acceptanceDecisions, matchAcceptance, saveAcceptanceDecision, type AutopilotAcceptance } from './autopilotAcceptance';
import type { Client, Invoice, Quote } from './types';

const quote = (id: string, number: string, clientId: string, status: Quote['status'], issueDate = '2026-10-10') =>
  ({ id, number, clientId, status, issueDate, createdAt: issueDate + 'T08:00:00Z' }) as Quote;
const client = (id: string, email: string) => ({ id, name: id, company: '', email }) as Client;
const mail = (values: Partial<AutopilotAcceptance>): AutopilotAcceptance => ({ sourceId: 's1', receivedAt: 1, quoteReference: null, evidence: 'J’accepte',
  sender: null, requiresHumanValidation: true, ...values });

describe('quote acceptance mails', () => {
  beforeEach(() => window.localStorage.clear());
  const quotes = [quote('q1', 'D-2026-0006', 'c1', 'issued', '2026-10-01'), quote('q2', 'D-2026-0007', 'c1', 'issued', '2026-10-12'),
    quote('q3', 'D-2026-0008', 'c2', 'issued'), quote('q4', '', 'c1', 'draft')];
  const clients = [client('c1', 'marie@rive.ch'), client('c2', 'paul@x.ch')];

  it('takes the quote numbered in the mail, ignoring case and spaces', () => {
    expect(matchAcceptance(mail({ quoteReference: 'd-2026- 0006' }), quotes, clients, [])).toEqual({ quote: quotes[0] });
  });
  it('else takes the latest sent quote of the sender that is not invoiced', () => {
    const sender = { email: 'Marie@Rive.ch', name: null, company: null, phone: null, street: null, postcode: null, city: null, source: 'envelope' as const };
    expect(matchAcceptance(mail({ quoteReference: 'D-9999', sender }), quotes, clients, [])).toEqual({ quote: quotes[1] });
    const invoiced = [{ id: 'i1', quoteId: 'q2', status: 'draft', type: 'standard' } as Invoice];
    expect(matchAcceptance(mail({ sender }), quotes, clients, invoiced)).toEqual({ quote: quotes[0] });
  });
  it('leaves an unknown sender to the person, with the sent quotes to choose from', () => {
    const found = matchAcceptance(mail({}), quotes, clients, []);
    expect('candidates' in found && found.candidates.map(row => row.id)).toEqual(['q1', 'q2', 'q3']);
  });
  it('remembers each mail once per company', () => {
    saveAcceptanceDecision('org', 's1', { quoteId: 'q1', state: 'accepted' });
    expect(acceptanceDecisions('org')).toEqual({ s1: { quoteId: 'q1', state: 'accepted' } });
    expect(acceptanceDecisions('other')).toEqual({});
  });
});
