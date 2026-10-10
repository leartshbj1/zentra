import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashUsSupportWorkspaceRequest, validateUsSupportWorkspaceRequest, validateUsSupportWorkspaceContext, validateUsSupportWorkspaceProjection, type UsSupportWorkspaceContext } from './us-support-workspace-contract';

function context(): UsSupportWorkspaceContext { const userId = randomUUID(); return { schemaVersion: 1, organizationId: randomUUID(), userId, ownerUserId: userId, role: 'owner', subscriptionId: 'sub_TEST', environment: 'TEST', catalogVersion: 'test-v1', priceId: 'price_Test', authorityReference: 'in_Test', validStartsAt: 1791600000, validEndsAt: 1791601000, seatLimit: 3, checkedAt: 1791600100, credential: { kind: 'browser' } }; }
describe('US Support registry exact contracts', () => {
  it('canonicalizes name and detaches a frozen command before hashing', async () => {
    const input = { schemaVersion: 1, requestId: randomUUID(), name: '  De\u0301mo  ' }, org = randomUUID(), user = randomUUID();
    const valid = validateUsSupportWorkspaceRequest(input); expect(valid.name).toBe('Démo'); expect(Object.isFrozen(valid)).toBe(true);
    const promise = hashUsSupportWorkspaceRequest(org, user, valid); input.name = 'changed'; expect(await promise).toBe(await hashUsSupportWorkspaceRequest(org, user, { ...valid, name: 'Démo' }));
    expect(await promise).not.toBe(await hashUsSupportWorkspaceRequest(org, randomUUID(), valid)); expect(await promise).not.toBe(await hashUsSupportWorkspaceRequest(randomUUID(), user, valid));
  });
  it('never invokes getters while checking public/private data', () => {
    let calls = 0; const c = context(); const hostile = { ...c, get role() { calls++; return 'owner'; } };
    expect(() => validateUsSupportWorkspaceContext(hostile)).toThrow(); expect(calls).toBe(0);
    expect(() => validateUsSupportWorkspaceRequest({ schemaVersion: 1, requestId: randomUUID(), get name() { calls++; return 'demo'; } })).toThrow(); expect(calls).toBe(0);
  });
  it.each(['checkedAt','validStartsAt','validEndsAt'] as const)('refuses invalid/future/stale seconds for %s', key => {
    const c = context(); expect(() => validateUsSupportWorkspaceContext({ ...c, [key]: NaN }, c.organizationId, c.checkedAt)).toThrow();
    expect(() => validateUsSupportWorkspaceContext(c, c.organizationId, c.checkedAt + 31)).toThrow(); expect(() => validateUsSupportWorkspaceContext(c, c.organizationId, c.checkedAt - 1)).toThrow();
  });
  it('requires real owner and exact credential fields', () => {
    const c = context(); expect(() => validateUsSupportWorkspaceContext({ ...c, ownerUserId: randomUUID() })).toThrow();
    expect(() => validateUsSupportWorkspaceContext({ ...c, credential: { kind: 'browser', sessionId: randomUUID() } })).toThrow();
    expect(() => validateUsSupportWorkspaceContext({ ...c, credential: { kind: 'device', sessionId: randomUUID(), supportedSchemaVersion: '4' } })).toThrow();
    expect(() => validateUsSupportWorkspaceContext({ ...c, credential: { kind: 'device', sessionId: randomUUID(), supportedSchemaVersion: 4 } })).toThrow();
    expect(validateUsSupportWorkspaceContext({ ...c, credential: { kind: 'device', sessionId: 'usd_' + randomUUID(), supportedSchemaVersion: 4 } }).credential.kind).toBe('device');
  });
  it('public projection rejects private provenance and invented ready capabilities', () => {
    const c = context(), p = { schemaVersion: 1, organizationId: c.organizationId, userId: c.userId, role: c.role, canCreate: true, stage: 'registry_only', mailboxAvailable: false, classificationAvailable: false, workspace: null };
    expect(validateUsSupportWorkspaceProjection(p)).toEqual(p); expect(() => validateUsSupportWorkspaceProjection({ ...p, mailboxAvailable: true })).toThrow(); expect(() => validateUsSupportWorkspaceProjection({ ...p, subscriptionId: 'secret' })).toThrow();
    expect(() => validateUsSupportWorkspaceProjection({ ...p, role: 'member' })).toThrow();
  });
});
