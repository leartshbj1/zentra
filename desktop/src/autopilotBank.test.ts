import { describe, expect, it } from 'vitest';
import { bankProposals, hasLinkedBank, statementDue } from './autopilotBank';
import type { MailSignal } from './autopilotSignals';
import type { BankMovement, BankWorkspace } from './types';

const movement = (id: string, values: Partial<BankMovement>) => ({ id, creditDebit: 'CRDT', amountCents: 17800, currency: 'CHF', reversal: false, bookingDate: '2026-10-19',
  reconciliation: null, supplierReconciliation: null, expenseReconciliation: null, refundMatch: null,
  suggestion: { kind: 'none', invoiceId: null, invoiceNumber: null, reason: '', confirmable: false, candidates: [] },
  supplierSuggestion: { entityType: 'supplier_invoice', kind: 'none', supplierInvoiceId: null, reason: '', confirmable: false, requiresConfirmation: false, candidates: [] }, ...values }) as BankMovement;
const bank = (movements: BankMovement[], imports: string[] = ['2026-10-19']) => ({ accounts: [{ accountId: 'CH', currency: 'CHF', linked: true, linkSource: 'explicit', movementCount: 1 }],
  imports: imports.map(createdAt => ({ createdAt })), movements, summary: {}, reconciliations: [], supplierReconciliations: [] }) as unknown as BankWorkspace;
const signal: MailSignal = { kind: 'payment_announced', sourceId: 's1', receivedAt: 1, subject: '', evidence: '', quoteReference: null, invoiceReference: 'F-2026-0012',
  amountCents: 17800, currency: 'CHF', documentType: null, sender: null, requiresHumanValidation: true };

describe('bank proposals', () => {
  it('puts sure invoice matches first and links the mail that announced them', () => {
    const rows = bankProposals(bank([
      movement('unknown', { suggestion: { kind: 'review', invoiceId: null, invoiceNumber: null, reason: '', confirmable: false, candidates: [{}] as never } }),
      movement('exact', { suggestion: { kind: 'automatic_exact', invoiceId: 'i1', invoiceNumber: 'F-2026-0012', reason: '', confirmable: true, candidates: [] } }),
      movement('done', { reconciliation: {} as never, suggestion: { kind: 'automatic_exact', invoiceId: 'i2', invoiceNumber: 'F-2', reason: '', confirmable: true, candidates: [] } }),
    ]), [signal], [], []);
    expect(rows.map(row => [row.movement.id, row.action])).toEqual([['exact', 'confirm_invoice'], ['unknown', 'choose']]);
    expect(rows[0].announcedBy?.sourceId).toBe('s1');
  });
  it('links a recorded payment the bank took a fee from, and never a refused direction', () => {
    const near = (confirmable: boolean, feeCents?: number) => ({ invoiceId: 'i1', invoiceNumber: 'F-2026-0012', remainingCents: 0, amountRelation: 'existing_payment_differs', reason: '', confirmable,
      nearPaymentId: 'p1', nearPaymentAmountCents: 17800, ...(feeCents ? { feeCents } : {}) });
    const rows = bankProposals(bank([
      movement('fee', { amountCents: 17750, suggestion: { kind: 'review', invoiceId: 'i1', invoiceNumber: 'F-2026-0012', reason: '', confirmable: true, candidates: [near(true, 50)] } }),
      movement('wrong-way', { amountCents: 17850, suggestion: { kind: 'review', invoiceId: 'i1', invoiceNumber: 'F-2026-0012', reason: '', confirmable: false, candidates: [near(false)] } }),
    ]), [], [], []);
    expect(rows.map(row => [row.movement.id, row.action])).toEqual([['fee', 'link_with_fee'], ['wrong-way', 'choose']]);
    expect(rows[0]).toMatchObject({ invoiceId: 'i1', paymentId: 'p1', recordedCents: 17800, feeCents: 50 });
  });
  it('reminds of the weekly statement only for a linked account', () => {
    expect(statementDue(bank([], ['2026-10-01']), '2026-10-20')).toBe(true);
    expect(statementDue(bank([], ['2026-10-18']), '2026-10-20')).toBe(false);
    expect(hasLinkedBank(null)).toBe(false);
  });
});
