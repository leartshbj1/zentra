import { describe, expect, it, vi } from 'vitest';
import { canonicalErpJson } from './erp-contract';
import { sha256Hex } from './canonical-hash';
import { US_TEAM_TOKEN_HASH_PREFIX, UsTeamError } from './us-team-contract';
import { hashUsTeamCommand, hashUsTeamToken, isUsTeamToken, newUsTeamToken, usTeamCommandIdentity } from './us-team-validation';

const org = '11111111-1111-4111-8111-111111111111', actor = '22222222-2222-4222-8222-222222222222';
const requestId = '33333333-3333-4333-8333-333333333333', invitationId = '44444444-4444-4444-8444-444444444444', secondId = '55555555-5555-4555-8555-555555555555';
const base = { schemaVersion: 1, requestId, expectedTeamRevision: 1 };
describe('US Team token secrecy and durable semantic identities', () => {
  it('uses WebCrypto CSPRNG32bytes with a separate US invitation namespace', async () => {
    const getRandomValues = vi.spyOn(crypto, 'getRandomValues').mockImplementation(array => {
      if (array instanceof Uint8Array) { expect(array.byteLength).toBe(32); array.fill(255); }
      return array;
    });
    try {
      const token = newUsTeamToken(); expect(isUsTeamToken(token)).toBe(true); expect(token).toMatch(/^zui_/); expect(token.length).toBe(47);
      const hash = await hashUsTeamToken(token); expect(hash).toMatch(/^[a-f0-9]{64}$/);
      expect(hash).toBe(await sha256Hex(US_TEAM_TOKEN_HASH_PREFIX + token)); expect(hash).not.toBe(await sha256Hex(token));
      expect(getRandomValues).toHaveBeenCalledTimes(1);
    } finally { getRandomValues.mockRestore(); }
  });
  it('rejects malformed token before digest without echoing it', async () => {
    const digest = vi.spyOn(crypto.subtle, 'digest');
    try { await expect(hashUsTeamToken('private-secret')).rejects.toMatchObject({ code: 'invalid_team_request', status: 422, message: 'invalid_team_request' }); expect(digest).not.toHaveBeenCalled(); }
    finally { digest.mockRestore(); }
  });
  it('creation retry ignores new server CSPRNG artifacts but preserves semantic role/email/CAS', async () => {
    const a = { ...base, action: 'create_invitation', email: 'recipient@example.com', role: 'member', invitationId, tokenHash: 'a'.repeat(64), expiresAt: 100 };
    const b = { ...a, invitationId: secondId, tokenHash: 'b'.repeat(64), expiresAt: 200 };
    expect(await hashUsTeamCommand(org, actor, a)).toBe(await hashUsTeamCommand(org, actor, b));
    expect(usTeamCommandIdentity(a)).toEqual({ ...base, action: 'create_invitation', email: a.email, role: a.role });
    for (const patch of [{ role: 'read_only' }, { email: 'another@example.com' }, { expectedTeamRevision: 2 }]) expect(await hashUsTeamCommand(org, actor, { ...a, ...patch })).not.toBe(await hashUsTeamCommand(org, actor, a));
  });
  it('regenerate identity retains original invitation target and never new token artifact', async () => {
    const a = { ...base, action: 'regenerate_invitation', invitationId, newInvitationId: secondId, tokenHash: 'a'.repeat(64), expiresAt: 100 };
    const b = { ...a, newInvitationId: actor, tokenHash: 'b'.repeat(64), expiresAt: 200 };
    expect(await hashUsTeamCommand(org, actor, a)).toBe(await hashUsTeamCommand(org, actor, b));
    expect(await hashUsTeamCommand(org, actor, { ...a, invitationId: requestId })).not.toBe(await hashUsTeamCommand(org, actor, a));
  });
  it('accept identity binds hash/recipient chosen name and target without retry membership artifact', async () => {
    const a = { ...base, action: 'accept_invitation', invitationId, tokenHash: 'a'.repeat(64), membershipId: secondId, firstName: 'Team', lastName: 'Member', displayName: 'Team Member' };
    expect(await hashUsTeamCommand(org, actor, a)).toBe(await hashUsTeamCommand(org, actor, { ...a, membershipId: requestId }));
    for (const patch of [{ tokenHash: 'b'.repeat(64) }, { firstName: 'Other', displayName: 'Other Member' }]) expect(await hashUsTeamCommand(org, actor, { ...a, ...patch })).not.toBe(await hashUsTeamCommand(org, actor, a));
    expect(Object.keys(usTeamCommandIdentity(a))).not.toContain('membershipId'); expect(Object.keys(usTeamCommandIdentity(a))).not.toContain('displayName');
  });
  it('binds tenant and actor, excludes Auth e-mail and mutable context time', async () => {
    const command = { ...base, action: 'revoke_member', membershipId: secondId };
    const hash = await hashUsTeamCommand(org, actor, command);
    expect(hash).toBe(await sha256Hex(canonicalErpJson([org, actor, usTeamCommandIdentity(command)])));
    expect(hash).not.toBe(await hashUsTeamCommand(secondId, actor, command)); expect(hash).not.toBe(await hashUsTeamCommand(org, secondId, command));
  });
  it('snapshots command synchronously before digest await', async () => {
    const command = { ...base, action: 'revoke_member', membershipId: secondId };
    const expected = await hashUsTeamCommand(org, actor, command); const pending = hashUsTeamCommand(org, actor, command); command.membershipId = requestId;
    expect(await pending).toBe(expected);
  });
  it('does not evaluate a browser accessor while building semantic identity', async () => {
    const getter = vi.fn(() => secondId); const command = { ...base, action: 'revoke_member' };
    Object.defineProperty(command, 'membershipId', { enumerable: true, get: getter });
    await expect(hashUsTeamCommand(org, actor, command)).rejects.toBeInstanceOf(UsTeamError); expect(getter).not.toHaveBeenCalled();
  });
});
