// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { mailSignalFrom, proposeForSignal, saveSignalDecision, signalDecisions, type MailSignal } from './autopilotSignals';
import type { Client, Invoice, Quote, Supplier, SupplierInvoice } from './types';

const line = (cents: number) => [{ id: 'l', description: 'x', quantity: 1, unit: 'pce', unitPriceCents: cents, discountBp: 0, vatRateBp: 0 }];
const invoice = (id: string, number: string, clientId: string, cents: number, status: Invoice['status'] = 'issued') =>
  ({ id, number, clientId, status, type: 'standard', lines: line(cents) }) as unknown as Invoice;
const client = (id: string, email: string, company = '') => ({ id, name: id, company, email }) as Client;
const signal = (values: Partial<MailSignal>): MailSignal => ({ kind: 'payment_announced', sourceId: 's1', receivedAt: 1, subject: 'Re: facture',
  evidence: 'Le virement a été effectué.', quoteReference: null, invoiceReference: null, amountCents: null, currency: 'CHF', documentType: null,
  sender: { email: 'marie@rive.ch', name: null, company: null, phone: null, street: null, postcode: null, city: null, source: 'envelope' },
  requiresHumanValidation: true, ...values });
const data = (values: Partial<Parameters<typeof proposeForSignal>[1]> = {}) => ({ invoices: [], payments: [], quotes: [], clients: [client('c1', 'marie@rive.ch')],
  suppliers: [], supplierInvoices: [], ...values }) as Parameters<typeof proposeForSignal>[1];

describe('mail signals', () => {
  beforeEach(() => window.localStorage.clear());
  it('reads a valid signal and drops an unknown kind', () => {
    const raw = { ...signal({}), sender: undefined } as unknown as Record<string, unknown>;
    expect(mailSignalFrom(raw, null)?.kind).toBe('payment_announced');
    expect(mailSignalFrom({ ...raw, kind: 'invented' }, null)).toBeNull();
    expect(mailSignalFrom({ ...raw, amountCents: -1 }, null)).toBeNull();
  });
  it('finds the invoice of a payment by number, else by the only open invoice with that amount', () => {
    const invoices = [invoice('i1', 'F-2026-0012', 'c1', 17800), invoice('i2', 'F-2026-0013', 'c1', 5000)];
    expect(proposeForSignal(signal({ invoiceReference: 'f-2026- 0012', amountCents: 17800 }), data({ invoices }))).toMatchObject({ action: 'record_payment', invoice: { id: 'i1' }, amountCents: 17800 });
    expect(proposeForSignal(signal({ amountCents: 5000 }), data({ invoices }))).toMatchObject({ action: 'record_payment', invoice: { id: 'i2' } });
    expect(proposeForSignal(signal({ amountCents: 999 }), data({ invoices }))).toMatchObject({ action: 'choose_invoice' });
    expect(proposeForSignal(signal({ amountCents: 5000 }), data({ invoices: [invoice('i3', 'F-1', 'c1', 5000, 'paid')] }))).toEqual({ action: 'none' });
  });
  it('declines the quoted or latest sent quote, finds the supplier, and links a follow-up to the client', () => {
    const quotes = [{ id: 'q1', number: 'D-2026-0007', clientId: 'c1', status: 'issued', issueDate: '2026-10-19', createdAt: 'a' } as Quote];
    expect(proposeForSignal(signal({ kind: 'quote_declined' }), data({ quotes }))).toMatchObject({ action: 'decline_quote', quote: { id: 'q1' } });
    const suppliers = [{ id: 'sup', name: 'Acme SA', email: 'billing@acme.ch' } as Supplier];
    const supplierInvoices = [{ id: 'si', supplierId: 'sup', reference: 'R-77' } as SupplierInvoice];
    const sender = { ...signal({}).sender!, email: 'billing@acme.ch' };
    expect(proposeForSignal(signal({ kind: 'supplier_document', documentType: 'payment_reminder', invoiceReference: 'R-77', sender }), data({ suppliers, supplierInvoices })))
      .toMatchObject({ action: 'open_purchase', supplier: { id: 'sup' }, supplierInvoice: { id: 'si' } });
    expect(proposeForSignal(signal({ kind: 'follow_up' }), data())).toMatchObject({ action: 'follow_up', client: { id: 'c1' } });
  });
  it('remembers handled and ignored signals per company', () => {
    saveSignalDecision('org', 's1', 'ignored');
    expect(signalDecisions('org')).toEqual({ s1: 'ignored' });
    expect(signalDecisions('other')).toEqual({});
  });
});
