import { describe, expect, it, vi } from 'vitest';
import { org, salesOrderErpFixture, user } from '../../tests/us-sales-orders-fixture';
import type { SupabaseServerClient } from '../supabase-server';
import { ERP_SCHEMA_HEADER, erpClientSchemaVersion, requireErpClientSchema, type ErpSchemaVersion } from './erp-schema-capability';
import { createSupabaseErpStore } from './runtime-store';
import { applyErpDelta, validateErpDelta, validateErpRevision, type ErpDelta } from './runtime-sync';
import { createSupabaseErpSyncStore } from './runtime-sync-store';
import type { ErpCommit, ErpHeader, ErpState } from './runtime-types';
import { validateStoredErp } from './runtime-validation';

// Deliberately bypass TypeScript in these tests: a JS caller, RPC projection or
// native header must not admit the internal financial kernel as public ERP5.
const unsupported = 5 as unknown as ErpSchemaVersion;
const versions = [1, 2, 3, 4] as const;
function state() { return validateStoredErp(salesOrderErpFixture(), org); }
function header(seed: ErpState): ErpHeader {
  const { customers: _customers, estimates: _estimates, invoices: _invoices, vendors: _vendors, vendorBills: _bills, vendorPayments: _payments, projects: _projects, ledger, ...rest } = seed;
  const { entries: _entries, audit: _audit, ...ledgerHeader } = ledger;
  return { ...rest, ledger: ledgerHeader };
}
function delta(seed = state()): ErpDelta {
  return { schemaVersion: seed.schemaVersion, organizationId: org, fromRevision: seed.revision, toRevision: seed.revision, headRevision: seed.revision, hasMore: false, resetRequired: false, events: [] };
}
function changedDelta(seed = state()): ErpDelta {
  const revision = seed.revision + 1;
  return {
    ...delta(seed), toRevision: revision, headRevision: revision,
    events: [{ schemaVersion: seed.schemaVersion, organizationId: org, revision, header: { ...header(seed), revision }, changes: [], ledgerAudit: [], receipt: { idempotencyKey: 'capability-check', commandHash: 'a'.repeat(64), revision, entityId: org, action: 'refresh_configuration' }, actorId: user, occurredAt: '2026-10-10T12:00:00Z' }],
  };
}
function client(result: unknown) {
  const rpc = vi.fn(async () => result) as ReturnType<typeof vi.fn> & SupabaseServerClient['rpc'];
  return { rpc };
}

describe('internal US financial kernel stays outside published ERP capabilities', () => {
  it.each(versions)('retains the public schema %s header and negotiation as a positive control', version => {
    expect(erpClientSchemaVersion(new Request('https://zentra.test/erp', { headers: { [ERP_SCHEMA_HEADER]: String(version) } }))).toBe(version);
    expect(() => requireErpClientSchema(version, 4)).not.toThrow();
  });
  it('rejects an explicit schema5 browser or native header at runtime', () => {
    const request = new Request('https://zentra.test/erp', { headers: { [ERP_SCHEMA_HEADER]: '5', Authorization: 'Bearer fictitious-not-an-authority' } });
    expect(() => erpClientSchemaVersion(request)).toThrow(expect.objectContaining({ code: 'invalid_request', status: 422 }));
  });
  it.each([[unsupported, 4], [4, unsupported], [unsupported, unsupported]] as const)('rejects JS capability negotiation %s/%s despite a forced compile-time cast', (requested, supported) => {
    expect(() => requireErpClientSchema(requested, supported)).toThrow(expect.objectContaining({ code: 'service_unavailable', status: 503 }));
  });
  it('refuses a stored schema5 projection while preserving a valid schema4 fixture', () => {
    const seed = state(), before = JSON.stringify(seed);
    expect(validateStoredErp(seed, org)).toEqual(seed);
    expect(() => validateStoredErp({ ...seed, schemaVersion: 5 }, org)).toThrow(expect.objectContaining({ code: 'invalid_stored_state', status: 503 }));
    expect(JSON.stringify(seed)).toBe(before);
  });
  it('rejects schema5 as a trusted Supabase ERP capability without invoking any RPC', () => {
    const adapter = client(null);
    expect(() => createSupabaseErpStore(adapter, { supportedSchemaVersion: unsupported })).toThrow(expect.objectContaining({ code: 'invalid_request', status: 422 }));
    expect(adapter.rpc).not.toHaveBeenCalled();
  });
  it.each(versions)('never returns schema5 through the real Supabase ERP read adapter at capability%s', async supportedSchemaVersion => {
    const adapter = client({ ...state(), schemaVersion: 5 }), store = createSupabaseErpStore(adapter, { supportedSchemaVersion });
    await expect(store.read(org)).rejects.toMatchObject({ code: 'invalid_stored_state', status: 503 });
    const rpcName = supportedSchemaVersion === 1 ? 'zentra_read_us_erp' : `zentra_read_us_erp_v${supportedSchemaVersion}`;
    expect(adapter.rpc).toHaveBeenCalledExactlyOnceWith(rpcName, { p_organization: org });
  });
  it.each(versions)('rejects a schema5 commit before any persistence RPC at capability%s', async supportedSchemaVersion => {
    const seed = state(), adapter = client(null), store = createSupabaseErpStore(adapter, { supportedSchemaVersion });
    const commit: ErpCommit = {
      organizationId: org, expectedRevision: seed.revision, header: { ...header(seed), schemaVersion: unsupported, revision: seed.revision + 1 }, changes: [], ledgerAudit: [],
      receipt: { idempotencyKey: 'unsupported-financial-kernel', commandHash: 'a'.repeat(64), revision: seed.revision + 1, entityId: org, action: 'refresh_configuration' },
      actor: { organizationId: org, userId: user, role: 'owner', managementEntitled: true, timestamp: '2026-10-10T12:00:00Z' },
    };
    await expect(store.commit(commit)).rejects.toMatchObject({ code: 'client_upgrade_required', status: 409 });
    expect(adapter.rpc).not.toHaveBeenCalled();
  });
});

describe('published delta and synchronization barriers reject the private kernel', () => {
  it('accepts a valid schema4 no-op and configuration event before checking their unknown-schema counterparts', () => {
    const seed = state();
    expect(validateErpDelta(delta(seed), org, seed.revision, 100, 4)).toEqual(delta(seed));
    expect(applyErpDelta(seed, delta(seed), org, 4)).toBe(seed);
    const changed = changedDelta(seed);
    expect(validateErpDelta(changed, org, seed.revision, 100, 4)).toEqual(changed);
    expect(applyErpDelta(seed, changed, org, 4)?.revision).toBe(seed.revision + 1);
  });
  it('rejects schema5 revision and delta envelopes regardless of a forced supported5 argument', () => {
    const seed = state();
    for (const supported of [4, unsupported] as const) {
      expect(() => validateErpRevision({ schemaVersion: 5, organizationId: org, revision: seed.revision }, org, supported)).toThrow(expect.objectContaining({ code: 'invalid_sync_state', status: 503 }));
      expect(() => validateErpDelta({ ...delta(seed), schemaVersion: 5 }, org, seed.revision, 100, supported)).toThrow(expect.objectContaining({ code: 'invalid_sync_state', status: 503 }));
    }
  });
  it.each(['event', 'header'] as const)('rejects a schema5 %s smuggled inside a schema4 delta', field => {
    const seed = state(), input = changedDelta(seed), event = input.events[0];
    const changed = { ...input, events: [{ ...event, ...(field === 'event' ? { schemaVersion: 5 } : { header: { ...event.header, schemaVersion: 5 } }) }] };
    expect(() => validateErpDelta(changed, org, seed.revision, 100, 4)).toThrow(expect.objectContaining({ code: 'invalid_sync_state', status: 503 }));
    expect(() => applyErpDelta(seed, changed, org, 4)).toThrow(expect.objectContaining({ code: 'invalid_sync_state', status: 503 }));
  });
  it('cannot merge a schema5 envelope or current book into an existing public state', () => {
    const seed = state(), before = JSON.stringify(seed);
    expect(() => applyErpDelta(seed, { ...delta(seed), schemaVersion: 5 }, org, 4)).toThrow(expect.objectContaining({ code: 'invalid_sync_state', status: 503 }));
    expect(() => applyErpDelta({ ...seed, schemaVersion: unsupported }, delta(seed), org, unsupported)).toThrow(expect.objectContaining({ code: 'invalid_stored_state', status: 503 }));
    expect(JSON.stringify(seed)).toBe(before);
  });
  it('refuses a schema5 Supabase sync capability before calling its privileged port', () => {
    const adapter = client(null);
    expect(() => createSupabaseErpSyncStore(adapter, { supportedSchemaVersion: unsupported })).toThrow(expect.objectContaining({ code: 'invalid_request', status: 422 }));
    expect(adapter.rpc).not.toHaveBeenCalled();
  });
  it('rejects schema5 heads and deltas returned by the real current Supabase sync adapter', async () => {
    const seed = state(), headAdapter = client({ schemaVersion: 5, organizationId: org, revision: seed.revision });
    await expect(createSupabaseErpSyncStore(headAdapter, { supportedSchemaVersion: 4 }).revision(org)).rejects.toMatchObject({ code: 'invalid_sync_state', status: 503 });
    expect(headAdapter.rpc).toHaveBeenCalledExactlyOnceWith('zentra_us_erp_revision_v4', { p_organization: org });
    const deltaAdapter = client({ ...delta(seed), schemaVersion: 5 });
    await expect(createSupabaseErpSyncStore(deltaAdapter, { supportedSchemaVersion: 4 }).changes(org, seed.revision, 100)).rejects.toMatchObject({ code: 'invalid_sync_state', status: 503 });
    expect(deltaAdapter.rpc).toHaveBeenCalledExactlyOnceWith('zentra_us_erp_delta_v4', { p_organization: org, p_after_revision: seed.revision, p_limit: 100 });
  });
});
