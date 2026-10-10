import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from './canonical-hash';
import { encryptSecret, decryptSecret } from '../support/crypto';
import {
  hashUsMailboxRequest, hashUsMailboxPrivateCommand, normalizeUsMailboxToken, usMailboxCommandMaterial, usMailboxEncryptionContext,
  usMailboxProjection, validateUsMailboxContext, validateUsMailboxPrivateCommand, validateUsMailboxProjection,
  validateUsMailboxReceipt, validateUsMailboxRequest, validateUsMailboxResult, validateUsMailboxState,
  type UsMailboxContext, type UsMailboxPrivateCommand,
} from './us-support-mailbox-contract';

const now = 1_800_000_000, organizationId = randomUUID(), actor = randomUUID(), workspaceId = randomUUID();
const context: UsMailboxContext = { schemaVersion: 1, workspaceId, authority: { schemaVersion: 1, organizationId, userId: actor, role: 'owner', ownerUserId: actor,
  subscriptionId: 'sub_MailboxFixture', environment: 'TEST', catalogVersion: 'fixture', priceId: 'price_MailboxFixture', authorityReference: 'in_Fixture',
  validStartsAt: now - 60, validEndsAt: now + 3600, seatLimit: 8, checkedAt: now, credential: { kind: 'browser' } } };
const request = { schemaVersion: 1, requestId: randomUUID(), expectedRevision: 0, action: 'connect', email: 'mailbox@example.test', token: 'fake_fixture_token' } as const;
const cipher = 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA==';
async function command(): Promise<UsMailboxPrivateCommand> { return { schemaVersion: 1, requestId: request.requestId, expectedRevision: 0, action: 'connect', email: request.email,
  tokenSha256: await sha256Hex(request.token), connectionId: randomUUID(), provider: 'infomaniak', mailboxId: 'fixture-mailbox', folderId: 'fixture-inbox', credentialsCiphertext: cipher, verifiedAt: now }; }

describe('US mailbox exact DTOs and server-only credential material', () => {
  it('normalizes address and token before stable hashing without mutating input', () => {
    const input = { ...request, email: ' MailBox@Example.Test ', token: ' Bearer fake_fixture_token ' }, parsed = validateUsMailboxRequest(input);
    expect(parsed).toMatchObject({ email: request.email, token: request.token }); expect(input.email).toBe(' MailBox@Example.Test '); expect(Object.isFrozen(parsed)).toBe(true);
    expect(normalizeUsMailboxToken('Bearer fake_fixture_token')).toBe(request.token);
  });
  it.each([
    { ...request, action: 'read' }, { ...request, schemaVersion: 2 }, { ...request, requestId: 'foreign' }, { ...request, expectedRevision: -1 },
    { ...request, expectedRevision: 0.5 }, { ...request, expectedRevision: Number.MAX_SAFE_INTEGER }, { ...request, extra: 'unexpected' },
    { ...request, email: 'mailbox@example.test\u202e' }, { ...request, email: 'not-an-address' }, { ...request, token: 'a b' },
    { ...request, token: 'x'.repeat(8193) }, { ...request, token: '' }, { ...request, token: 'x\u0000' },
    { schemaVersion: 1, requestId: request.requestId, expectedRevision: 0, action: 'disconnect', token: request.token },
  ])('rejects malformed, oversized or open public command %#', input => { expect(() => validateUsMailboxRequest(input)).toThrow(); });
  it('rejects accessor input without invoking it', () => {
    let calls = 0; const input = { ...request }; Object.defineProperty(input, 'token', { enumerable: true, get() { calls++; return request.token; } });
    expect(() => validateUsMailboxRequest(input)).toThrow(); expect(calls).toBe(0);
  });
  it('keeps public/private hash equal while generated ID, IV and time change', async () => {
    const q = await command(); if (q.action !== 'connect') throw Error('fixture');
    expect(await hashUsMailboxRequest(organizationId, actor, request)).toBe(await hashUsMailboxPrivateCommand(organizationId, actor, q));
    expect(await hashUsMailboxPrivateCommand(organizationId, actor, { ...q, connectionId: randomUUID(), verifiedAt: now + 1,
      credentialsCiphertext: 'v1.BBBBBBBBBBBBBBBB.BBBBBBBBBBBBBBBBBBBBBB==' })).toBe(await hashUsMailboxPrivateCommand(organizationId, actor, q));
    expect(await hashUsMailboxPrivateCommand(organizationId, actor, { ...q, email: 'different@example.test' })).not.toBe(await hashUsMailboxPrivateCommand(organizationId, actor, q));
    expect(await hashUsMailboxPrivateCommand(randomUUID(), actor, q)).not.toBe(await hashUsMailboxPrivateCommand(organizationId, actor, q));
    expect(await hashUsMailboxPrivateCommand(organizationId, randomUUID(), q)).not.toBe(await hashUsMailboxPrivateCommand(organizationId, actor, q));
    expect(JSON.stringify(usMailboxCommandMaterial(q))).not.toContain('credentialsCiphertext');
    expect(JSON.stringify(usMailboxCommandMaterial(q))).not.toContain('mailboxId');
    expect(JSON.stringify(usMailboxCommandMaterial(q))).not.toContain(request.token);
  });
  it('bounds private ciphertext, provider IDs and provider enum', async () => {
    const q = await command();
    for (const patch of [{ credentialsCiphertext: request.token }, { credentialsCiphertext: cipher + '.extra' }, { provider: 'other' }, { mailboxId: '' }, { folderId: 'x'.repeat(201) }, { tokenSha256: 'A'.repeat(64) }, { token: request.token }]) {
      expect(() => validateUsMailboxPrivateCommand({ ...q, ...patch })).toThrow();
    }
  });
  it('binds real AES-GCM to org, registry, connection and revision with a fictitious key', async () => {
    const q = await command(); if (q.action !== 'connect') throw Error('fixture');
    const key = btoa('k'.repeat(32)), aad = usMailboxEncryptionContext(context, q.connectionId, 1), sealed = await encryptSecret(key, request.token, aad);
    expect(await decryptSecret(key, sealed, aad)).toBe(request.token);
    expect(() => validateUsMailboxPrivateCommand({ ...q, credentialsCiphertext: sealed })).not.toThrow();
    for (const wrong of [aad + ':wrong', usMailboxEncryptionContext(context, q.connectionId, 2), usMailboxEncryptionContext({ ...context, workspaceId: randomUUID() }, q.connectionId, 1)]) {
      await expect(decryptSecret(key, sealed, wrong)).rejects.toMatchObject({ status: 503 });
    }
  });
  it('validates fresh context exactly and refuses a legacy/non-scope identifier', () => {
    expect(validateUsMailboxContext(context, organizationId, now)).toEqual(context);
    for (const input of [{ ...context, extra: true }, { ...context, workspaceId: 'legacy-support' }, { ...context, schemaVersion: 2 }, { ...context, authority: { ...context.authority, checkedAt: now - 31 } }]) expect(() => validateUsMailboxContext(input, organizationId, now)).toThrow();
    expect(() => validateUsMailboxContext(context, randomUUID(), now)).toThrow();
  });
  it('projects only sanitized metadata and derives management from the actual role', async () => {
    const q = await command(); if (q.action !== 'connect') throw Error('fixture');
    const state = validateUsMailboxState({ schemaVersion: 1, organizationId, workspaceId, revision: 1, currentConnection: { id: q.connectionId, provider: q.provider, email: q.email,
      mailboxId: q.mailboxId, folderId: q.folderId, tokenSha256: q.tokenSha256, credentialsCiphertext: q.credentialsCiphertext, verifiedAt: q.verifiedAt, connectedBy: actor, revision: 1 } });
    const projection = usMailboxProjection(context, state);
    expect(Object.keys(projection.connection!).sort()).toEqual(['email','id','provider','verifiedAt']);
    for (const secret of [q.credentialsCiphertext, q.tokenSha256, q.mailboxId, q.folderId]) expect(JSON.stringify(projection)).not.toContain(secret);
    expect(() => validateUsMailboxProjection({ ...projection, canManage: false })).toThrow();
    expect(usMailboxProjection({ ...context, authority: { ...context.authority, userId: randomUUID(), role: 'member' } }, state).canManage).toBe(false);
  });
  it('allows historical receipt alongside a later current state without claiming resurrection', async () => {
    const q = await command(); if (q.action !== 'connect') throw Error('fixture');
    const receipt = validateUsMailboxReceipt({ schemaVersion: 1, organizationId, workspaceId, actorUserId: actor, requestId: q.requestId,
      requestHash: await hashUsMailboxPrivateCommand(organizationId, actor, q), action: 'connect', expectedRevision: 0, revision: 1, connectionId: q.connectionId, createdAt: now });
    expect(validateUsMailboxResult({ state: { schemaVersion: 1, organizationId, workspaceId, revision: 2, currentConnection: null }, receipt, replayed: true }).receipt).toEqual(receipt);
    expect(() => validateUsMailboxReceipt({ ...receipt, tokenSha256: 'a'.repeat(64) })).toThrow();
    expect(() => validateUsMailboxResult({ state: { schemaVersion: 1, organizationId, workspaceId, revision: 0, currentConnection: null }, receipt, replayed: true })).toThrow();
  });
});
