import { describe, expect, it, vi } from 'vitest';
import { AccountPublicError, sha256Hex } from '../account-security';
import type { FinancialAuthority } from './accounting/ledger';
import { canonicalErpJson } from './erp-contract';
import type { ErpSchemaVersion } from './erp-schema-capability';
import { createErpHandlers, type ErpServerDependencies } from './runtime-server';
import type { ErpRequest, ErpStore } from './runtime-types';
import type { CompanyConfiguration } from './types';
import { createUsTaxInvoiceTestRuntime } from './us-tax-invoice-test-runtime';

const organizationId = 'fictitious-revalidation-space';
const timestamp = '2026-10-10T12:00:00.000Z';
const configuration: CompanyConfiguration = {
  schemaVersion: 1, organizationId, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York',
  address: { country: 'US', line1: '1 Fictitious Street', city: 'New York', subdivision: 'NY', postalCode: '10001' },
  accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' },
};
const actor: FinancialAuthority = { organizationId, userId: 'fictitious-owner', role: 'owner', managementEntitled: true, timestamp };
const initialize: ErpRequest = { idempotencyKey: 'revalidate-initialize', expectedRevision: 0, command: { type: 'initialize', periods: [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'open' }] } };
const invoice: ErpRequest = { idempotencyKey: 'revalidate-invoice', expectedRevision: 4, command: { type: 'issue_invoice', id: 'invoice', estimateId: 'estimate', expectedEstimateRevision: 2, date: '2026-10-10', accountingDate: '2026-10-10', dueDate: '2026-11-10', periodId: '2026' } };
const faults = ['configuration_changed', 'configuration_error', 'capability_closed', 'capability_error', 'flag_closed', 'flag_error'] as const;
type Fault = typeof faults[number];
type Loss = 401 | 402 | 403 | 'user' | 'entitlement' | 'role';
type Flow = 'ordinary' | 'test-hook' | 'hook-response' | 'invalid-hook-response';
const faultResponse: Record<Fault, readonly [number, string]> = {
  configuration_changed: [409, 'configuration_changed'], configuration_error: [503, 'service_unavailable'],
  capability_closed: [409, 'client_upgrade_required'], capability_error: [503, 'service_unavailable'],
  flag_closed: [404, 'feature_unavailable'], flag_error: [503, 'service_unavailable'],
};
function lossResponse(loss: Loss): readonly [number, string] {
  if (loss === 'user') return [401, 'session_changed'];
  if (loss === 'entitlement' || loss === 402) return [402, 'management_entitlement_required'];
  return loss === 401 ? [401, 'unauthorized'] : [403, 'forbidden'];
}

/** Real HTTP/core and real lazy TEST hook; all authority, storage and private
 * ports are local fixtures. No hosted Auth, SQL, credentials or provider calls. */
function fixture(flow: Flow, fault: Fault, loss?: Loss) {
  let configReads = 0, flagReads = 0, lost = false, durableWrites = 0;
  const store: ErpStore = {
    supportedSchemaVersion: 4, read: vi.fn(async () => null), receipt: vi.fn(async () => null),
    commit: vi.fn(async input => input.receipt),
  };
  const authority = vi.fn(async () => {
    if (lost && typeof loss === 'number') throw new AccountPublicError('PRIVATE_FICTITIOUS_AUTH_DETAIL', loss);
    return { mode: 'browser' as const, actor: { ...actor,
      ...(lost && loss === 'user' ? { userId: 'different-user' } : {}),
      ...(lost && loss === 'entitlement' ? { managementEntitled: false } : {}),
      ...(lost && loss === 'role' ? { role: 'read_only' as const } : {}),
    } };
  });
  function revoke() { if (loss !== undefined) lost = true; }
  const unexpectedPrivate = vi.fn(async (): Promise<never> => { throw new Error('PRIVATE_FICTITIOUS_PORT_MUST_NOT_RUN'); });
  const dependencies: ErpServerDependencies = {
    enabled: vi.fn(async () => {
      if (++flagReads > 1 && fault.startsWith('flag_')) {
        // The first fresh authority has already returned. Loss occurs during
        // the fallible flag await and needs the bounded final authority read.
        await Promise.resolve(); revoke();
        if (fault === 'flag_error') throw new Error('PRIVATE_FICTITIOUS_FLAG_DETAIL');
        return false;
      }
      return true;
    }),
    authority,
    configuration: vi.fn(async (): Promise<CompanyConfiguration> => {
      if (++configReads > 1 && fault.startsWith('configuration_')) {
        await Promise.resolve(); revoke();
        if (fault === 'configuration_error') throw new Error('PRIVATE_FICTITIOUS_CONFIGURATION_DETAIL');
        return { ...configuration, language: 'fr' };
      }
      return structuredClone(configuration);
    }),
    freshSupportedSchemaVersion: vi.fn(async (): Promise<ErpSchemaVersion> => {
      if (fault.startsWith('capability_')) {
        await Promise.resolve(); revoke();
        if (fault === 'capability_error') throw new Error('PRIVATE_FICTITIOUS_CAPABILITY_DETAIL');
        return 1;
      }
      return 4;
    }),
    store: vi.fn(() => store), taxProvider: unexpectedPrivate, rateLimit: vi.fn(async () => undefined), diagnostic: vi.fn(),
  };
  if (flow === 'test-hook') dependencies.issueInvoiceTest = createUsTaxInvoiceTestRuntime({
    enabled: unexpectedPrivate, merchant: unexpectedPrivate, merchantStore: unexpectedPrivate, contexts: unexpectedPrivate,
    preparations: unexpectedPrivate, operations: unexpectedPrivate, operationId: () => 'a6000000-0000-4000-8000-000000000001', now: () => timestamp,
  });
  if (flow === 'hook-response' || flow === 'invalid-hook-response') dependencies.issueInvoiceTest = async (_execution, input) => {
    durableWrites++;
    return { receipt: flow === 'invalid-hook-response' ? { private: 'PRIVATE_FICTITIOUS_PROOF' } : {
      idempotencyKey: input.idempotencyKey, commandHash: await sha256Hex(canonicalErpJson([organizationId, actor.userId, input])),
      revision: input.expectedRevision + 1, action: input.command.type, entityId: 'invoice',
    }, replayed: false };
  };
  const handlers = createErpHandlers(dependencies);
  const request = new Request(`https://zentra.test/api/international/workspaces/${organizationId}/erp`, {
    method: 'POST', headers: { Origin: 'https://zentra.test', 'Content-Type': 'application/json', 'X-Zentra-Erp-Schema-Version': '4', 'X-Zentra-Expected-User': actor.userId },
    body: JSON.stringify(flow === 'ordinary' ? initialize : invoice),
  });
  return { dependencies, store, authority, unexpectedPrivate, response: () => handlers.POST(request, organizationId), writes: () => durableWrites };
}
async function rejected(t: ReturnType<typeof fixture>, expected: readonly [number, string]) {
  const response = await t.response();
  expect(response.status).toBe(expected[0]); expect(await response.json()).toEqual({ error: expected[1] });
  expect(response.headers.get('Cache-Control')).toContain('no-store');
  expect(t.dependencies.diagnostic).toHaveBeenCalledWith({ operation: 'write', status: expected[0], code: expected[1] });
  expect(JSON.stringify(vi.mocked(t.dependencies.diagnostic).mock.calls)).not.toContain('PRIVATE_FICTITIOUS');
  expect(t.store.commit).not.toHaveBeenCalled(); expect(t.unexpectedPrivate).not.toHaveBeenCalled();
}

describe('shared ERP revalidation failure priority', () => {
  const cases = faults.flatMap(fault => ([401, 402, 403] as const).map(loss => ({ fault, loss })));
  describe.each(['ordinary', 'test-hook', 'hook-response', 'invalid-hook-response'] as const)('%s', flow => {
    it.each(cases)('prioritizes current access loss $loss after $fault', async ({ fault, loss }) => {
      const t = fixture(flow, fault, loss); await rejected(t, lossResponse(loss));
      expect(t.authority.mock.calls.length).toBeGreaterThanOrEqual(fault.startsWith('flag_') ? 3 : 2);
      expect(t.writes()).toBe(flow === 'hook-response' || flow === 'invalid-hook-response' ? 1 : 0);
    });
  });
  it.each(faults.flatMap(fault => (['user', 'entitlement', 'role'] as const).map(loss => ({ fault, loss }))))('checks returned admission $loss after $fault', async ({ fault, loss }) => {
    const t = fixture('ordinary', fault, loss); await rejected(t, lossResponse(loss));
  });
  it.each(faults)('retains the existing %s response when fresh access remains admitted', async fault => {
    const t = fixture('ordinary', fault); await rejected(t, faultResponse[fault]);
    expect(t.authority).toHaveBeenCalledTimes(fault.startsWith('flag_') ? 3 : 2);
  });
});
