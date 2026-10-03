import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BankCustomerRequest } from './bankCustomerRefundRequests';

// Source-relative candidate test. Closed IPC and synthetic IndexedDB only.
const transport = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: transport.invoke }));
vi.mock('./bridge', () => {
  // Resolve at call time: resetModules must not leave the mock factory holding
  // a different diagnostic session from the module imported by each test.
  return { desktopApi: {
    createBankCustomerCreditRefund: async (...args: unknown[]) => (await import('./diagnostics')).diagnosticInvoke('create_bank_customer_credit_refund', { args }),
    matchBankCustomerCreditRefund: async (...args: unknown[]) => (await import('./diagnostics')).diagnosticInvoke('match_bank_customer_credit_refund', { args }),
    unmatchBankCustomerCreditRefund: async (...args: unknown[]) => (await import('./diagnostics')).diagnosticInvoke('unmatch_bank_customer_credit_refund', { args }),
  } };
});
const origin = { companyId: 'private-company', organizationId: 'private-org', memberId: 'private-member' };
const warning = 'L’opération est enregistrée, mais sa demande locale reste à vérifier. Une nouvelle vérification ne créera aucun doublon.';
function request(kind: BankCustomerRequest['kind']): BankCustomerRequest {
  const common = { requestId: 'private-request', movementId: 'private-movement', description: 'private-document', amountCents: 2500, currency: 'CHF', date: '2026-10-03' };
  if (kind === 'create') return { ...common, kind, customerCreditNoteId: 'private-credit', reference: 'private-reference', reason: 'private-reason', receipt: null };
  if (kind === 'match') return { ...common, kind, refundId: 'private-refund', dateDifferenceReason: 'private-reason' };
  return { ...common, kind, matchId: 'private-match', reason: 'private-reason' };
}
function storageFixture(cleanupFails = false) {
  let stored: any;
  const deletes = vi.fn();
  const db = {
    close: vi.fn(), onversionchange: null,
    transaction: vi.fn(() => {
      const tx: any = { oncomplete: null, onabort: null, onerror: null };
      const complete = () => queueMicrotask(() => tx.oncomplete?.());
      const fail = () => queueMicrotask(() => tx.onabort?.());
      const store = {
        get: vi.fn(() => { const read: any = { result: stored, onsuccess: null }; queueMicrotask(() => read.onsuccess?.()); return read; }),
        put: vi.fn((row: unknown) => { stored = row; complete(); }),
        delete: deletes.mockImplementation(() => { if (cleanupFails) fail(); else { stored = undefined; complete(); } }),
      };
      tx.objectStore = () => store; tx.abort = fail;
      return tx;
    }),
  };
  vi.stubGlobal('indexedDB', { open: vi.fn(() => { const opened: any = { result: db, onsuccess: null }; queueMicrotask(() => opened.onsuccess?.()); return opened; }) });
  vi.stubGlobal('window', new EventTarget());
  return { db, deletes, retained: () => stored };
}
beforeEach(() => { vi.resetModules(); transport.invoke.mockReset(); transport.invoke.mockResolvedValue(undefined); });
afterEach(() => vi.unstubAllGlobals());

describe('customer bank request cleanup diagnostics', () => {
  it.each([
    ['create', 'create_bank_customer_credit_refund'],
    ['match', 'match_bank_customer_credit_refund'],
    ['unlink', 'unmatch_bank_customer_credit_refund'],
  ] as const)('keeps one %s financial call and the same warning after cleanup storage failure', async (kind, command) => {
    const storage = storageFixture(true), input = request(kind);
    const { runBankCustomerRequest } = await import('./bankCustomerRefundRequests');
    const d = await import('./diagnostics');
    await expect(runBankCustomerRequest(input, origin.companyId, undefined, origin)).resolves.toBe(warning);
    expect(transport.invoke.mock.calls.map(call => call[0])).toEqual([command]);
    expect(storage.deletes).toHaveBeenCalledOnce();
    expect(storage.retained().request).toBe(input);
    const events = d.recentDiagnosticEvents();
    expect(events.map(event => [event.operation, event.phase])).toEqual([
      [command, 'start'], [command, 'success'],
      ['bank.customer_request_cleanup', 'start'], ['bank.customer_request_cleanup', 'failure'],
    ]);
    expect(events[3]).toMatchObject({ area: 'draft', errorCode: 'STORAGE', id: events[2].id });
    expect(events[3].durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(events)).not.toMatch(/private-|amountCents|currency|reason|requestId|memberId|receipt/);
    expect(Object.keys(events[3]).sort()).toEqual(['area', 'durationMs', 'errorCode', 'id', 'operation', 'phase', 'sessionId', 'timestamp'].sort());
  });

  it('keeps null after successful cleanup and removes the retained input', async () => {
    const storage = storageFixture(), input = request('create');
    const { runBankCustomerRequest } = await import('./bankCustomerRefundRequests');
    const d = await import('./diagnostics');
    await expect(runBankCustomerRequest(input, origin.companyId, undefined, origin)).resolves.toBeNull();
    expect(transport.invoke).toHaveBeenCalledOnce();
    expect(storage.retained()).toBeUndefined();
    expect(d.recentDiagnosticEvents().filter(event => event.operation === 'bank.customer_request_cleanup').map(event => event.phase)).toEqual(['start', 'success']);
  });

  it('does not cleanup or repeat the financial write after its original rejection', async () => {
    const storage = storageFixture(true), original = new Error('network token=private-secret customer@example.invalid');
    transport.invoke.mockRejectedValue(original);
    const { runBankCustomerRequest } = await import('./bankCustomerRefundRequests');
    const d = await import('./diagnostics');
    await expect(runBankCustomerRequest(request('create'), origin.companyId, undefined, origin)).rejects.toBe(original);
    expect(transport.invoke).toHaveBeenCalledOnce();
    expect(storage.deletes).not.toHaveBeenCalled();
    expect(storage.retained()).toBeDefined();
    expect(d.recentDiagnosticEvents().some(event => event.operation === 'bank.customer_request_cleanup')).toBe(false);
    expect(JSON.stringify(d.recentDiagnosticEvents())).not.toMatch(/private-|token|customer@example/);
  });
});
