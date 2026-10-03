import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: transport.invoke }));
import { desktopApi } from './bridge';
import { flushDiagnostics, recentDiagnosticEvents } from './diagnostics';
import { createPaymentReceipt, extendPaymentRequest, readPaymentRequest, retainPaymentRequest, type PaymentRequestInput, type PaymentRequestProof, type PaymentRequestStorage } from './paymentRequest';

// Exercise the real bridge serializers, guards and diagnosticInvoke. Only the
// native transport is synthetic; these tests do not execute the Rust database.
const scope = 'synthetic-payment-origin';
const requestId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const otherRequestId = 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff';
const canonicalPaymentId = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const input = (patch: Partial<PaymentRequestInput> = {}): PaymentRequestInput => ({
  requestId, invoiceId: 'synthetic-client-invoice', amountCents: 2703, date: '2026-04-01', method: 'Virement',
  reference: 'synthetic-bank-reference', notes: 'synthetic-private-note',
  expectedReview: { balanceCents: 5405, bankAccountId: 'synthetic-bank' }, ...patch,
});
const recorded = (patch: Partial<Extract<PaymentRequestProof, { status: 'recorded' }>> = {}): Extract<PaymentRequestProof, { status: 'recorded' }> => ({
  status: 'recorded', originalRequestId: requestId, canonicalPaymentId: requestId, wasAliased: false,
  workspaceScope: scope, variantIndex: 0, journalEntryId: 'synthetic-payment-journal', ...patch,
});
const absent: PaymentRequestProof = { status: 'absent', originalRequestId: requestId, workspaceScope: scope };
const conflict: PaymentRequestProof = { status: 'conflict', originalRequestId: requestId, workspaceScope: scope };
const expectedNativeInput = {
  request_id: requestId, invoice_id: 'synthetic-client-invoice', amount_cents: 2703, date: '2026-04-01', method: 'Virement',
  reference: 'synthetic-bank-reference', notes: 'synthetic-private-note',
};
beforeEach(() => { transport.invoke.mockReset(); vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('durable payment requests through the real bridge', () => {
  it('writes exactly one scoped payment with normalized snake-case input and its separate review', async () => {
    transport.invoke.mockResolvedValue({ id: requestId });
    const draft = input({ method: ' Virement ', reference: ' synthetic-bank-reference ', notes: ' synthetic-private-note ' });
    await expect(desktopApi.writePaymentRequest(draft.invoiceId, draft, scope)).resolves.toBeUndefined();
    expect(transport.invoke).toHaveBeenCalledExactlyOnceWith('record_payment', {
      input: expectedNativeInput, expectedReview: draft.expectedReview, expectedWorkspaceScope: scope,
    });
    expect(draft.method).toBe(' Virement ');
    expect(draft.expectedReview.balanceCents).toBe(5405);
  });

  it.each([Error('Synthetic native interruption'), 'Synthetic native interruption'])('propagates the original write rejection without inspecting, loading or retrying', async cause => {
    transport.invoke.mockRejectedValue(cause);
    await expect(desktopApi.writePaymentRequest(input().invoiceId, input(), scope)).rejects.toBe(cause);
    expect(transport.invoke).toHaveBeenCalledExactlyOnceWith('record_payment', {
      input: expectedNativeInput, expectedReview: input().expectedReview, expectedWorkspaceScope: scope,
    });
  });

  it('probes all retained variants once, strips each review, and preserves the reported alias/index', async () => {
    const variants = Object.freeze([
      input(),
      input({ notes: 'corrected-note', expectedReview: { balanceCents: 5000, bankAccountId: 'synthetic-other-bank' } }),
    ]);
    const result = recorded({ canonicalPaymentId, wasAliased: true, variantIndex: 1 });
    transport.invoke.mockResolvedValue(result);
    expect(await desktopApi.readPaymentRequest(variants, scope)).toEqual(result);
    expect(transport.invoke).toHaveBeenCalledExactlyOnceWith('read_payment_request', {
      inputs: [expectedNativeInput, { ...expectedNativeInput, notes: 'corrected-note' }], expectedWorkspaceScope: scope,
    });
    expect(variants[0].expectedReview.balanceCents).toBe(5405);
    expect(variants[1].expectedReview.bankAccountId).toBe('synthetic-other-bank');
  });

  it('preserves separate reviewed variants with equal payment payloads for the native first-match index', async () => {
    transport.invoke.mockResolvedValue(recorded());
    const variants = [input(), input({ expectedReview: { balanceCents: 5000, bankAccountId: 'synthetic-bank' } })];
    expect(await desktopApi.readPaymentRequest(variants, scope)).toEqual(recorded());
    expect(transport.invoke).toHaveBeenCalledExactlyOnceWith('read_payment_request', {
      inputs: [expectedNativeInput, expectedNativeInput], expectedWorkspaceScope: scope,
    });
  });

  it('recovers an uppercase historical UUID without changing the raw CAS token and appends the same lowercase UUID', async () => {
    const identity = { companyId: scope, memberId: 'synthetic-verified-member' };
    const created = createPaymentReceipt(identity, input(), 1);
    const historicalRaw = JSON.stringify({ ...created.record, variants: [input({ requestId: requestId.toUpperCase() })] });
    const rows = new Map([[created.key, historicalRaw]]);
    const local: PaymentRequestStorage = {
      getItem: vi.fn(key => rows.get(key) ?? null),
      setItem: vi.fn((key, raw) => { rows.set(key, raw); }),
      removeItem: vi.fn(key => { rows.delete(key); }),
    };
    const recovered = readPaymentRequest(identity, input().invoiceId, local);
    if (recovered.kind !== 'pending') throw Error('historical receipt missing');
    expect(recovered.receipt.raw).toBe(historicalRaw);
    expect(recovered.receipt.record.variants[0].requestId).toBe(requestId);
    retainPaymentRequest(recovered.receipt, identity, local);
    expect(local.setItem).not.toHaveBeenCalled();
    expect(rows.get(created.key)).toBe(historicalRaw);
    transport.invoke.mockResolvedValue(recorded());
    expect(await desktopApi.readPaymentRequest(recovered.receipt.record.variants, scope)).toEqual(recorded());
    expect(transport.invoke).toHaveBeenCalledExactlyOnceWith('read_payment_request', { inputs: [expectedNativeInput], expectedWorkspaceScope: scope });
    const corrected = extendPaymentRequest(recovered.receipt, identity, input({ notes: 'corrected-after-restart' }), local);
    expect(corrected.record.variants).toHaveLength(2);
    expect(corrected.record.variants.map(variant => variant.requestId)).toEqual([requestId, requestId]);
    expect(corrected.record.variants[0]).toEqual(recovered.receipt.record.variants[0]);
    expect(recovered.receipt.raw).toBe(historicalRaw);
    expect(rows.get(created.key)).toBe(corrected.raw);
    expect(local.removeItem).not.toHaveBeenCalled();
  });

  it.each([absent, conflict])('returns a scoped $status observation without replaying the write or loading a workspace', async result => {
    transport.invoke.mockResolvedValue(result);
    expect(await desktopApi.readPaymentRequest([input()], scope)).toEqual(result);
    expect(transport.invoke).toHaveBeenCalledExactlyOnceWith('read_payment_request', { inputs: [expectedNativeInput], expectedWorkspaceScope: scope });
  });

  it.each([Error('Synthetic probe failure'), 'Synthetic probe failure'])('propagates the original probe error instead of manufacturing absence or issuing another call', async cause => {
    transport.invoke.mockRejectedValue(cause);
    await expect(desktopApi.readPaymentRequest([input()], scope)).rejects.toBe(cause);
    expect(transport.invoke).toHaveBeenCalledExactlyOnceWith('read_payment_request', { inputs: [expectedNativeInput], expectedWorkspaceScope: scope });
  });

  it.each([undefined, null, 0, {}, '', '  ', 'invalid\0scope'])('rejects an invalid scope before admitting either native call: %s', async invalid => {
    transport.invoke.mockResolvedValue(absent);
    await expect(desktopApi.writePaymentRequest(input().invoiceId, input(), invalid as string)).rejects.toThrow();
    await expect(desktopApi.readPaymentRequest([input()], invalid as string)).rejects.toThrow();
    expect(transport.invoke).not.toHaveBeenCalled();
  });

  it('refuses a write whose separately selected invoice differs from the retained invoice', async () => {
    await expect(desktopApi.writePaymentRequest('other-invoice', input(), scope)).rejects.toThrow();
    expect(transport.invoke).not.toHaveBeenCalled();
  });

  it.each([
    ['empty UUID', { requestId: '' }], ['invalid UUID', { requestId: 'not-an-uuid' }], ['empty invoice', { invoiceId: '' }],
  ] as const)('rejects a structurally invalid %s before native write or probe', async (_label, patch) => {
    const invalid = input(patch); transport.invoke.mockResolvedValue(absent);
    await expect(desktopApi.writePaymentRequest(invalid.invoiceId, invalid, scope)).rejects.toThrow();
    await expect(desktopApi.readPaymentRequest([invalid], scope)).rejects.toThrow();
    expect(transport.invoke).not.toHaveBeenCalled();
  });

  it('enforces the 1..12 probe bound without dropping any retained variants', async () => {
    transport.invoke.mockResolvedValue(absent);
    const variants = Array.from({ length: 12 }, (_, index) => input({ notes: `version-${index}` }));
    expect(await desktopApi.readPaymentRequest(variants, scope)).toEqual(absent);
    expect(transport.invoke).toHaveBeenCalledTimes(1);
    expect(transport.invoke.mock.calls[0][1].inputs).toHaveLength(12);
    transport.invoke.mockClear();
    await expect(desktopApi.readPaymentRequest([], scope)).rejects.toThrow();
    await expect(desktopApi.readPaymentRequest([...variants, input({ notes: 'thirteenth' })], scope)).rejects.toThrow();
    expect(transport.invoke).not.toHaveBeenCalled();
  });

  it.each([
    ['UUID', input({ requestId: otherRequestId })], ['invoice', input({ invoiceId: 'other-invoice' })],
  ] as const)('rejects mixed %s histories before IPC', async (_label, other) => {
    await expect(desktopApi.readPaymentRequest([input(), other], scope)).rejects.toThrow();
    expect(transport.invoke).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null], ['undefined', undefined], ['empty', {}], ['unknown status', { ...absent, status: 'missing' }],
    ['wrong scope', { ...absent, workspaceScope: 'other-company' }], ['wrong UUID', { ...absent, originalRequestId: otherRequestId }],
    ['missing scope', { status: 'absent', originalRequestId: requestId }], ['missing UUID', { status: 'absent', workspaceScope: scope }],
    ['non-string status', { ...absent, status: 0 }],
  ])('rejects a %s proof as unusable without converting it to absence', async (_label, invalid) => {
    transport.invoke.mockResolvedValue(invalid);
    await expect(desktopApi.readPaymentRequest([input()], scope)).rejects.toThrow(/conservée/);
    expect(transport.invoke).toHaveBeenCalledExactlyOnceWith('read_payment_request', { inputs: [expectedNativeInput], expectedWorkspaceScope: scope });
  });

  it.each([
    ['missing recorded metadata', { status: 'recorded', originalRequestId: requestId, workspaceScope: scope }],
    ['empty canonical identity', recorded({ canonicalPaymentId: '' })], ['empty journal identity', recorded({ journalEntryId: '' })],
    ['negative variant', recorded({ variantIndex: -1 })], ['out-of-range variant', recorded({ variantIndex: 1 })],
    ['fractional variant', recorded({ variantIndex: 0.5 })], ['false alias metadata', recorded({ canonicalPaymentId, wasAliased: false })],
    ['true alias metadata', recorded({ wasAliased: true })], ['non-boolean alias', { ...recorded(), wasAliased: 'false' }],
  ])('rejects %s without publishing a malformed recorded proof', async (_label, invalid) => {
    transport.invoke.mockResolvedValue(invalid);
    await expect(desktopApi.readPaymentRequest([input()], scope)).rejects.toThrow(/conservée/);
    expect(transport.invoke).toHaveBeenCalledExactlyOnceWith('read_payment_request', { inputs: [expectedNativeInput], expectedWorkspaceScope: scope });
  });

  it('keeps amounts, payment text, client IDs, scope and raw errors out of the real diagnostic journal', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const sensitiveScope = 'PRIVATE_COMPANY_891', sensitive = input({
      invoiceId: 'PRIVATE_CLIENT_INVOICE_892', amountCents: 3456789, reference: 'PRIVATE_REFERENCE_893', notes: 'PRIVATE_NOTE_894',
      expectedReview: { balanceCents: 7654321, bankAccountId: 'PRIVATE_BANK_895' },
    });
    const refusal = Error('permission denied for PRIVATE_CLIENT_896 PRIVATE_RAW_ERROR_897');
    const eventStart = recentDiagnosticEvents().length;
    transport.invoke.mockImplementation(async (command: string) => {
      if (command === 'record_payment') return { privateClient: 'PRIVATE_RESULT_898' };
      if (command === 'read_payment_request') throw refusal;
      if (command === 'append_diagnostic_events') return undefined;
      throw Error('unexpected native call');
    });
    await desktopApi.writePaymentRequest(sensitive.invoiceId, sensitive, sensitiveScope);
    await expect(desktopApi.readPaymentRequest([sensitive], sensitiveScope)).rejects.toBe(refusal);
    const events = recentDiagnosticEvents().slice(eventStart);
    expect(events.map(event => [event.operation, event.phase])).toEqual([
      ['record_payment', 'start'], ['record_payment', 'success'], ['read_payment_request', 'start'], ['read_payment_request', 'failure'],
    ]);
    expect(events[3].errorCode).toBe('PERMISSION');
    await flushDiagnostics(true);
    const journals = transport.invoke.mock.calls.filter(([name]) => name === 'append_diagnostic_events');
    expect(journals).toHaveLength(1);
    expect(journals[0][1].events).toEqual(events);
    const serialized = JSON.stringify(journals);
    for (const secret of [sensitiveScope, sensitive.invoiceId, sensitive.reference, sensitive.notes, sensitive.expectedReview.bankAccountId, '3456789', '7654321', 'PRIVATE_CLIENT_896', 'PRIVATE_RAW_ERROR_897', 'PRIVATE_RESULT_898', requestId]) expect(serialized).not.toContain(secret);
    expect(transport.invoke.mock.calls.map(([name]) => name)).toEqual(['record_payment', 'read_payment_request', 'append_diagnostic_events']);
  });
});
