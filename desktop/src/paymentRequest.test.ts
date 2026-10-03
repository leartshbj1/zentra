import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertPaymentRequestCurrent, clearConfirmedPaymentRequest, confirmPaymentRequest, createPaymentReceipt,
  extendPaymentRequest, paymentRequestScopeKey, readPaymentRequest, retainPaymentRequest, validPaymentDraft,
  type PaymentReceipt, type PaymentRequestInput, type PaymentRequestProof, type PaymentRequestScope, type PaymentRequestStorage,
} from './paymentRequest';
import { initialOnboardingSettings } from './onboardingDraft';
import type { Workspace } from './types';

const diagnostics = vi.hoisted(() => vi.fn());
vi.mock('./diagnostics', () => ({ recordDiagnostic: diagnostics }));
const scope: PaymentRequestScope = { companyId: 'synthetic-company', organizationId: 'synthetic-organization', memberId: 'synthetic-member' };
const requestId = '10000000-0000-4000-8000-000000000001';
const anotherRequestId = '10000000-0000-4000-8000-000000000002';
const canonicalPaymentId = '10000000-0000-4000-8000-000000000003';
const input = (patch: Partial<PaymentRequestInput> = {}): PaymentRequestInput => ({
  requestId, invoiceId: 'synthetic-invoice', amountCents: 1025, date: '2026-05-02', method: 'Virement',
  reference: 'synthetic-reference', notes: 'synthetic-note', expectedReview: { balanceCents: 10000, bankAccountId: 'synthetic-bank' }, ...patch,
});
class MemoryStorage implements PaymentRequestStorage {
  readonly rows = new Map<string, string>();
  getItem = vi.fn((key: string): string | null => this.rows.get(key) ?? null);
  setItem = vi.fn((key: string, value: string): void => { this.rows.set(key, value); });
  removeItem = vi.fn((key: string): void => { this.rows.delete(key); });
}
function stored(value = input()) {
  const local = new MemoryStorage(), receipt = createPaymentReceipt(scope, value, 1);
  retainPaymentRequest(receipt, scope, local);
  return { local, receipt };
}
function workspace(receipt: PaymentReceipt, variantIndex = 0, paymentId = requestId): Workspace {
  const variant = receipt.record.variants[variantIndex];
  return {
    workNotesScope: scope.companyId, onboardingCompleted: true, settings: initialOnboardingSettings,
    invoices: [{ id: variant.invoiceId }], accounts: [],
    payments: [{ id: paymentId, invoiceId: variant.invoiceId, amountCents: variant.amountCents, date: variant.date,
      method: variant.method, reference: variant.reference, notes: variant.notes,
      journalEntryId: 'synthetic-journal', journalEntrySemanticallyValid: true, journalEntryIsActive: true }],
  } as unknown as Workspace;
}
const proof = (patch: Partial<Extract<PaymentRequestProof, { status: 'recorded' }>> = {}): Extract<PaymentRequestProof, { status: 'recorded' }> => ({
  status: 'recorded', originalRequestId: requestId, canonicalPaymentId: requestId, wasAliased: false,
  workspaceScope: scope.companyId, variantIndex: 0, journalEntryId: 'synthetic-journal', ...patch,
});
const absent: PaymentRequestProof = { status: 'absent', originalRequestId: requestId, workspaceScope: scope.companyId };
beforeEach(() => diagnostics.mockClear());

describe('immutable durable client payment receipt', () => {
  it('normalizes text, detaches the input and deeply freezes every retained version', () => {
    const supplied = input({ date: ' 2026-05-02 ', method: ' Virement ', reference: ' reference ', notes: ' note ' });
    const receipt = createPaymentReceipt(scope, supplied, 0);
    supplied.notes = 'edited'; supplied.expectedReview.bankAccountId = 'edited-bank';
    expect(receipt.record.variants[0]).toEqual(input({ reference: 'reference', notes: 'note' }));
    for (const value of [receipt, receipt.record, receipt.record.variants, receipt.record.variants[0], receipt.record.variants[0].expectedReview]) expect(Object.isFrozen(value)).toBe(true);
    expect(() => { (receipt.record.variants as PaymentRequestInput[]).push(input()); }).toThrow();
    const local = new MemoryStorage(); retainPaymentRequest(receipt, scope, local);
    const recovered = readPaymentRequest(scope, supplied.invoiceId, local);
    expect(recovered.kind).toBe('pending');
    if (recovered.kind !== 'pending') throw Error('missing receipt');
    expect(recovered.receipt).toEqual(receipt);
    expect(recovered.receipt.record.savedAt).toBe(0); // No expiry, even for the oldest receipt.
    expect(local.removeItem).not.toHaveBeenCalled();
  });

  it('requires a verified member and isolates company, organization and member identities', () => {
    const { receipt, local } = stored();
    expect(paymentRequestScopeKey(scope)).toBe(JSON.stringify([scope.companyId, scope.organizationId, scope.memberId]));
    for (const next of [null, { ...scope, memberId: '' }, { ...scope, companyId: ' ' }, { ...scope, organizationId: 'bad\0id' }, { ...scope, memberId: undefined }]) {
      expect(paymentRequestScopeKey(next as PaymentRequestScope | null)).toBeNull();
      expect(readPaymentRequest(next as PaymentRequestScope | null, input().invoiceId, local).kind).toBe('blocked');
    }
    for (const next of [{ ...scope, companyId: 'other-company' }, { ...scope, organizationId: 'other-organization' }, { ...scope, memberId: 'other-member' }]) {
      expect(readPaymentRequest(next, input().invoiceId, local).kind).toBe('none');
      expect(() => assertPaymentRequestCurrent(receipt, next, local)).toThrow();
      expect(() => clearConfirmedPaymentRequest(receipt, next, workspace(receipt), proof(), local)).toThrow();
    }
    expect(local.rows.get(receipt.key)).toBe(receipt.raw);
    expect(local.removeItem).not.toHaveBeenCalled();
  });

  it('accepts incomplete drafts, counts Unicode characters and rejects NUL/oversized fields', () => {
    const draft = { amount: '', date: '', method: '', reference: '', notes: '' };
    expect(validPaymentDraft(draft)).toBe(true);
    expect(validPaymentDraft({ ...draft, method: '🙂'.repeat(80), reference: '🙂'.repeat(160), notes: '🙂'.repeat(5000) })).toBe(true);
    for (const [field, size] of [['amount', 128], ['date', 10], ['method', 80], ['reference', 160], ['notes', 5000]] as const) {
      expect(validPaymentDraft({ ...draft, [field]: '🙂'.repeat(size + 1) })).toBe(false);
      expect(validPaymentDraft({ ...draft, [field]: 'a\0b' })).toBe(false);
    }
    expect(validPaymentDraft({ ...draft, amount: 5 })).toBe(false);
    expect(validPaymentDraft({ ...draft, unexpected: '' })).toBe(false);
    expect(validPaymentDraft(null)).toBe(false);
  });

  it('requires real dates, safe positive amounts, bounded Unicode text and a reviewed balance/account', () => {
    const good = input({ date: '2024-02-29', method: '🙂'.repeat(80), reference: '🙂'.repeat(160), notes: '🙂'.repeat(5000) });
    expect(createPaymentReceipt(scope, good).record.variants[0]).toEqual(good);
    for (const patch of [
      { date: '2026-02-29' }, { date: '2026-04-31' }, { date: 'invalid' }, { amountCents: 0 }, { amountCents: -1 },
      { amountCents: 1.5 }, { amountCents: Number.MAX_SAFE_INTEGER + 1 }, { requestId: 'invalid' },
      { method: ' ' }, { method: '🙂'.repeat(81) }, { reference: '🙂'.repeat(161) }, { notes: '🙂'.repeat(5001) },
      { notes: 'a\0b' }, { expectedReview: { balanceCents: 1024, bankAccountId: 'bank' } },
      { expectedReview: { balanceCents: 1025.5, bankAccountId: 'bank' } },
      { expectedReview: { balanceCents: Number.MAX_SAFE_INTEGER + 1, bankAccountId: 'bank' } },
      { expectedReview: { balanceCents: 10000, bankAccountId: '' } },
    ]) expect(() => createPaymentReceipt(scope, input(patch))).toThrow();
    for (const now of [-1, NaN, Infinity, 0.5]) expect(() => createPaymentReceipt(scope, input(), now)).toThrow();
  });

  it('quarantines malformed, foreign and oversized stored values without deleting or overwriting them', () => {
    const { receipt, local } = stored(), record = JSON.parse(receipt.raw);
    const malformed = ['broken-json', 'null', '[]', ...[
      { ...record, version: 2 }, { ...record, scope: 'foreign' }, { ...record, invoiceId: 'foreign-invoice' },
      { ...record, savedAt: -1 }, { ...record, variants: [] }, { ...record, variants: [input({ date: '2026-02-30' })] },
      { ...record, variants: [input(), input({ requestId: anotherRequestId })] },
      { ...record, variants: Array.from({ length: 13 }, () => input()) }, { ...record, unexpected: true },
      { ...record, variants: [input({ expectedReview: { balanceCents: 10000, bankAccountId: 'bank', extra: true } as never })] },
    ].map(value => JSON.stringify(value))];
    const limit = 256 * 1024;
    const justUnder = receipt.raw + ' '.repeat(limit - new TextEncoder().encode(receipt.raw).length - 1);
    local.rows.set(receipt.key, justUnder);
    expect(readPaymentRequest(scope, record.invoiceId, local).kind).toBe('pending');
    malformed.push(justUnder + ' ');
    for (const raw of malformed) {
      local.rows.set(receipt.key, raw);
      expect(readPaymentRequest(scope, record.invoiceId, local).kind).toBe('blocked');
      expect(() => retainPaymentRequest(receipt, scope, local)).toThrow();
      expect(local.rows.get(receipt.key)).toBe(raw);
    }
    expect(local.removeItem).not.toHaveBeenCalled();
  });

  it('blocks submission after quota failures or an unconfirmed storage readback', () => {
    const receipt = createPaymentReceipt(scope, input()), local = new MemoryStorage();
    local.setItem.mockImplementation(() => { throw Error('private quota failure'); });
    expect(() => retainPaymentRequest(receipt, scope, local)).toThrow(/stockage local/);
    expect(local.rows.size).toBe(0);
    local.setItem.mockImplementation(() => {});
    expect(() => retainPaymentRequest(receipt, scope, local)).toThrow();
    expect(() => assertPaymentRequestCurrent(receipt, scope, local)).toThrow();
    local.getItem.mockImplementation(() => { throw Error('private read failure'); });
    expect(readPaymentRequest(scope, input().invoiceId, local).kind).toBe('blocked');
    expect(() => assertPaymentRequestCurrent(receipt, scope, local)).toThrow(/stockage/);
    expect(local.removeItem).not.toHaveBeenCalled();
  });

  it('does not overwrite a request that appears during first retention', () => {
    const receipt = createPaymentReceipt(scope, input()), other = createPaymentReceipt(scope, input({ requestId: anotherRequestId })), local = new MemoryStorage();
    local.getItem.mockImplementationOnce(() => null).mockImplementationOnce(() => {
      local.rows.set(receipt.key, other.raw); return other.raw;
    });
    expect(() => retainPaymentRequest(receipt, scope, local)).toThrow();
    expect(local.setItem).not.toHaveBeenCalled();
    expect(local.rows.get(receipt.key)).toBe(other.raw);
  });
});

describe('append-only correction of an interrupted invocation', () => {
  it('adds a new payload using the same UUID and retains the original for a delayed invocation', () => {
    const { receipt, local } = stored();
    const corrected = extendPaymentRequest(receipt, scope, input({ date: '2026-05-03', notes: 'corrected' }), local);
    expect(corrected.record.variants).toHaveLength(2);
    expect(corrected.record.variants[0]).toEqual(receipt.record.variants[0]);
    expect(corrected.record.variants[1].requestId).toBe(requestId);
    expect(() => assertPaymentRequestCurrent(receipt, scope, local)).toThrow();
    // The original invocation may still commit after the correction was retained.
    const delayed = workspace(corrected, 0);
    expect(confirmPaymentRequest(corrected, scope, delayed, proof({ variantIndex: 0 }), local)).toBe(true);
    clearConfirmedPaymentRequest(corrected, scope, delayed, proof({ variantIndex: 0 }), local);
    expect(readPaymentRequest(scope, input().invoiceId, local)).toEqual({ kind: 'none' });
  });

  it('deduplicates complete variants while preserving separate reviews of an identical payload', () => {
    const { receipt, local } = stored(), previousWrites = local.setItem.mock.calls.length;
    expect(extendPaymentRequest(receipt, scope, input({ method: ' Virement ', notes: ' synthetic-note ' }), local)).toBe(receipt);
    expect(local.setItem).toHaveBeenCalledTimes(previousWrites);
    const next = extendPaymentRequest(receipt, scope, input({ expectedReview: { balanceCents: 9000, bankAccountId: 'synthetic-bank' } }), local);
    expect(next.record.variants).toHaveLength(2);
    expect(next.record.variants[0].expectedReview.balanceCents).toBe(10000);
    expect(next.record.variants[1].expectedReview.balanceCents).toBe(9000);
    expect(confirmPaymentRequest(next, scope, workspace(next), proof({ variantIndex: 0 }), local)).toBe(true);
  });

  it('forbids a new UUID or invoice during correction and preserves the current receipt', () => {
    const { receipt, local } = stored();
    for (const patch of [{ requestId: anotherRequestId }, { invoiceId: 'other-invoice' }]) {
      expect(() => extendPaymentRequest(receipt, scope, input(patch), local)).toThrow(/même identifiant/);
      expect(local.rows.get(receipt.key)).toBe(receipt.raw);
    }
  });

  it('limits correction history to 12 without eviction and still allows an existing version', () => {
    const fixture = stored(); let receipt = fixture.receipt;
    for (let index = 1; index < 12; index++) receipt = extendPaymentRequest(receipt, scope, input({ notes: `version-${index}` }), fixture.local);
    expect(receipt.record.variants).toHaveLength(12);
    const before = receipt.raw, writes = fixture.local.setItem.mock.calls.length;
    expect(() => extendPaymentRequest(receipt, scope, input({ notes: 'thirteenth' }), fixture.local)).toThrow(/12 versions/);
    expect(fixture.local.rows.get(receipt.key)).toBe(before);
    expect(fixture.local.setItem).toHaveBeenCalledTimes(writes);
    expect(extendPaymentRequest(receipt, scope, input(), fixture.local)).toBe(receipt);
  });

  it('blocks a correction exceeding the byte bound before storage is changed', () => {
    const fixture = stored(input({ notes: '\u0001'.repeat(5000) })); let receipt = fixture.receipt;
    for (let index = 1; index < 8; index++) receipt = extendPaymentRequest(receipt, scope, input({ notes: '\u0001'.repeat(4999) + String(index) }), fixture.local);
    const before = receipt.raw;
    expect(() => extendPaymentRequest(receipt, scope, input({ notes: '\u0001'.repeat(4999) + '8' }), fixture.local)).toThrow();
    expect(fixture.local.rows.get(receipt.key)).toBe(before);
    expect(receipt.record.variants).toHaveLength(8);
  });

  it('detects a replaced snapshot before append and refuses to overwrite it', () => {
    const { receipt, local } = stored(), other = createPaymentReceipt(scope, input({ requestId: anotherRequestId }));
    local.getItem.mockImplementationOnce(() => receipt.raw).mockImplementationOnce(() => {
      local.rows.set(receipt.key, other.raw); return other.raw;
    });
    const writes = local.setItem.mock.calls.length;
    expect(() => extendPaymentRequest(receipt, scope, input({ notes: 'corrected' }), local)).toThrow();
    expect(local.setItem).toHaveBeenCalledTimes(writes);
    expect(local.rows.get(receipt.key)).toBe(other.raw);
  });

  it('detects competing writes in append readback and preserves history on quota failure', () => {
    const { receipt, local } = stored(), other = createPaymentReceipt(scope, input({ requestId: anotherRequestId }));
    local.setItem.mockImplementationOnce(() => { throw Error('private quota'); });
    expect(() => extendPaymentRequest(receipt, scope, input({ notes: 'corrected' }), local)).toThrow();
    expect(local.rows.get(receipt.key)).toBe(receipt.raw);
    local.setItem.mockImplementationOnce(key => { local.rows.set(key, other.raw); });
    expect(() => extendPaymentRequest(receipt, scope, input({ notes: 'corrected' }), local)).toThrow();
    expect(local.rows.get(receipt.key)).toBe(other.raw);
  });
});

describe('exact proof and confirmed cleanup', () => {
  it('confirms a canonical alias against its full workspace row without modifying the receipt', () => {
    const { receipt, local } = stored(), next = workspace(receipt, 0, canonicalPaymentId);
    const aliased = proof({ canonicalPaymentId, wasAliased: true });
    expect(confirmPaymentRequest(receipt, scope, next, aliased, local)).toBe(true);
    expect(local.rows.get(receipt.key)).toBe(receipt.raw);
    expect(local.removeItem).not.toHaveBeenCalled();
    clearConfirmedPaymentRequest(receipt, scope, next, aliased, local);
    expect(local.rows.has(receipt.key)).toBe(false);
  });

  it('retains an absent or conflicting invocation and rejects contradictory absence', () => {
    const { receipt, local } = stored(), next = workspace(receipt); next.payments = [];
    expect(confirmPaymentRequest(receipt, scope, next, absent, local)).toBe(false);
    expect(() => clearConfirmedPaymentRequest(receipt, scope, next, absent, local)).toThrow();
    expect(() => confirmPaymentRequest(receipt, scope, next, { ...absent, status: 'conflict' }, local)).toThrow();
    expect(() => confirmPaymentRequest(receipt, scope, workspace(receipt), absent, local)).toThrow();
    expect(local.rows.get(receipt.key)).toBe(receipt.raw);
    expect(local.removeItem).not.toHaveBeenCalled();
  });

  it('requires matching original request, scope, canonical alias, journal and variant index', () => {
    const { receipt, local } = stored(), next = workspace(receipt);
    for (const patch of [
      { originalRequestId: anotherRequestId }, { workspaceScope: 'other-company' }, { canonicalPaymentId }, { wasAliased: true },
      { journalEntryId: 'other-journal' }, { variantIndex: -1 }, { variantIndex: 1 }, { variantIndex: 0.5 },
    ]) expect(() => clearConfirmedPaymentRequest(receipt, scope, next, proof(patch), local)).toThrow();
    const aliasWorkspace = workspace(receipt, 0, canonicalPaymentId);
    expect(() => clearConfirmedPaymentRequest(receipt, scope, aliasWorkspace, proof({ canonicalPaymentId, wasAliased: false }), local)).toThrow();
    expect(local.rows.get(receipt.key)).toBe(receipt.raw);
    expect(local.removeItem).not.toHaveBeenCalled();
  });

  it('rejects partial/foreign workspaces and mismatched or reversed payment projections', () => {
    const { receipt, local } = stored();
    for (const patch of [
      { workNotesScope: 'foreign' }, { workNotesScope: undefined }, { onboardingCompleted: false }, { settings: undefined },
      { invoices: undefined }, { payments: undefined }, { accounts: undefined }, { invoices: [] },
    ]) expect(() => clearConfirmedPaymentRequest(receipt, scope, { ...workspace(receipt), ...patch } as Workspace, proof(), local)).toThrow();
    for (const patch of [
      { invoiceId: 'foreign-invoice' }, { amountCents: 1026 }, { date: '2026-05-03' }, { method: 'other' },
      { reference: 'other' }, { notes: 'other' }, { journalEntryId: null }, { journalEntrySemanticallyValid: false },
      { journalEntrySemanticallyValid: undefined }, { journalEntryIsActive: false },
    ]) {
      const next = workspace(receipt); next.payments[0] = { ...next.payments[0], ...patch };
      expect(() => clearConfirmedPaymentRequest(receipt, scope, next, proof(), local)).toThrow();
    }
    expect(local.rows.get(receipt.key)).toBe(receipt.raw);
    expect(local.removeItem).not.toHaveBeenCalled();
  });

  it('checks the exact raw snapshot again after proof validation and before deletion', () => {
    const { receipt, local } = stored(), other = createPaymentReceipt(scope, input({ notes: 'newer-request' }));
    const next = workspace(receipt);
    Object.defineProperty(next.payments[0], 'journalEntryIsActive', { get: () => { local.rows.set(receipt.key, other.raw); return true; } });
    expect(() => clearConfirmedPaymentRequest(receipt, scope, next, proof(), local)).toThrow();
    expect(local.rows.get(receipt.key)).toBe(other.raw);
    expect(local.removeItem).not.toHaveBeenCalled();
  });

  it('preserves a receipt on cleanup failure and detects a newer receipt after removal', () => {
    const { receipt, local } = stored();
    local.removeItem.mockImplementationOnce(() => { throw Error('private removal failure'); });
    expect(() => clearConfirmedPaymentRequest(receipt, scope, workspace(receipt), proof(), local)).toThrow(/confirmé.*effacée/);
    expect(local.rows.get(receipt.key)).toBe(receipt.raw);
    local.removeItem.mockImplementationOnce(() => {});
    expect(() => clearConfirmedPaymentRequest(receipt, scope, workspace(receipt), proof(), local)).toThrow(/confirmé.*effacée/);
    expect(local.rows.get(receipt.key)).toBe(receipt.raw);
    const newer = createPaymentReceipt(scope, input({ requestId: anotherRequestId }));
    local.removeItem.mockImplementationOnce(key => { local.rows.set(key, newer.raw); });
    expect(() => clearConfirmedPaymentRequest(receipt, scope, workspace(receipt), proof(), local)).toThrow();
    expect(local.rows.get(receipt.key)).toBe(newer.raw);
  });

  it('does not trust a forged record whose proof differs from its stored raw snapshot', () => {
    const { receipt, local } = stored();
    const forged = { ...receipt, record: { ...receipt.record, variants: [input({ notes: 'forged' })] } };
    expect(() => clearConfirmedPaymentRequest(forged, scope, workspace(forged), proof(), local)).toThrow();
    expect(local.rows.get(receipt.key)).toBe(receipt.raw);
    expect(local.removeItem).not.toHaveBeenCalled();
  });

  it('never logs private fields, scope identifiers, raw receipts or storage error messages', () => {
    const { receipt, local } = stored(input({ reference: 'PRIVATE_REFERENCE_91', notes: 'PRIVATE_NOTE_92' }));
    local.getItem.mockImplementation(() => { throw Error('PRIVATE_RAW_ERROR_93'); });
    expect(readPaymentRequest(scope, input().invoiceId, local).kind).toBe('blocked');
    expect(() => assertPaymentRequestCurrent(receipt, scope, local)).toThrow();
    expect(() => extendPaymentRequest(receipt, scope, input({ notes: 'other' }), local)).toThrow();
    expect(() => clearConfirmedPaymentRequest(receipt, scope, workspace(receipt), proof(), local)).toThrow();
    const serialized = JSON.stringify(diagnostics.mock.calls);
    for (const secret of ['PRIVATE_REFERENCE_91', 'PRIVATE_NOTE_92', 'PRIVATE_RAW_ERROR_93', scope.companyId, scope.memberId, requestId, input().invoiceId, receipt.raw]) expect(serialized).not.toContain(secret);
    for (const [event] of diagnostics.mock.calls) {
      expect(Object.keys(event).sort()).toEqual(event.errorCode ? ['area', 'errorCode', 'operation', 'phase'] : ['area', 'operation', 'phase']);
      expect(event.operation).toMatch(/^payment\.request\.(read|create|retain|assert|extend|confirm|clear)$/);
    }
  });
});
