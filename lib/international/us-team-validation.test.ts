import { describe, expect, it, vi } from 'vitest';
import { UsTeamError, US_TEAM_INVITATION_TTL_SECONDS } from './us-team-contract';
import {
  validateUsTeamRequest, validateUsTeamAcceptRequest, validateUsTeamResolveRequest,
  validateUsTeamUser, validateUsTeamContext, validateUsTeamInvitation, validateUsTeamProjection,
  validateUsTeamResolution, validateUsTeamReceipt, validateUsTeamStoredReceipt,
  validateUsTeamPrivateCommand, validateUsTeamCommit, validateUsTeamCommitResult,
  validateUsTeamMutationResponse, validateUsTeamAcceptResponse, usTeamCanManageRole,
  isUsTeamToken, normalizeUsTeamEmail,
} from './us-team-validation';
import type { AccountRole } from '../account-security';

const org = '11111111-1111-4111-8111-111111111111';
const owner = '22222222-2222-4222-8222-222222222222';
const member = '33333333-3333-4333-8333-333333333333';
const requestId = '44444444-4444-4444-8444-444444444444';
const invitationId = '55555555-5555-4555-8555-555555555555';
const membershipId = '66666666-6666-4666-8666-666666666666';
const now = 1_791_500_000;
const token = 'zui_' + 'A'.repeat(43);
const request = () => ({ schemaVersion: 1, requestId, expectedTeamRevision: 0, action: 'create_invitation', email: 'member@example.com', role: 'member' });
const context = () => ({ schemaVersion: 1, organizationId: org, mode: 'member', role: 'owner', user: { userId: owner, email: null, emailConfirmed: false }, subscriptionId: 'sub_us_test', environment: 'TEST', catalogVersion: 'us-test-v1', priceId: 'price_us_test', seatLimit: 3, checkedAt: now, validStartsAt: now - 60, validEndsAt: now + 3600 });
const invitation = () => ({ schemaVersion: 1, organizationId: org, invitationId, email: 'member@example.com', role: 'member', tokenHash: 'a'.repeat(64), createdBy: owner, createdAt: now - 60, expiresAt: now + 600, status: 'pending', revokedAt: null, acceptedBy: null, acceptedAt: null, membershipId: null });
const projection = () => ({ schemaVersion: 1, organizationId: org, revision: 1, role: 'owner', seatLimit: 3, activeMembers: 1, reservedInvitations: 1, remainingSeats: 1, checkedAt: now, members: [{ membershipId, userId: owner, role: 'owner', displayName: null, joinedAt: now - 120 }], invitations: [{ invitationId, email: 'member@example.com', role: 'member', createdAt: now - 60, expiresAt: now + 600 }] });
const receipt = () => ({ schemaVersion: 1, organizationId: org, requestId, action: 'create_invitation', entityId: invitationId, revision: 1 });
const command = () => ({ ...request(), invitationId, tokenHash: 'a'.repeat(64), expiresAt: now + 600 });
function rejection(fn: () => unknown, code = 'invalid_team_request', status = 422) {
  try { fn(); throw new Error('accepted invalid fixture'); } catch (error) {
    expect(error).toBeInstanceOf(UsTeamError);
    expect(error).toMatchObject({ code, status, message: code });
  }
}
describe('US Team public request allowlists', () => {
  it('normalizes e-mail and NFC names into detached frozen data without inventing identity', () => {
    const source = { ...request(), email: '  MEMBER@Example.com  ' };
    const parsed = validateUsTeamRequest(source); source.email = 'other@example.com';
    expect(parsed).toMatchObject({ email: 'member@example.com' }); expect(Object.isFrozen(parsed)).toBe(true);
    const accepted = validateUsTeamAcceptRequest({ schemaVersion: 1, requestId, expectedTeamRevision: 2, token, firstName: '  Jose\u0301  ', lastName: 'de   Souza' });
    expect(accepted).toMatchObject({ firstName: 'José', lastName: 'de Souza' });
    expect(Object.keys(accepted)).not.toContain('displayName');
  });
  it.each(['tokenHash', 'organizationId', 'seatLimit', 'environment', 'subscriptionId', 'firstApplied', 'authority'])('rejects browser field %s', key => {
    rejection(() => validateUsTeamRequest({ ...request(), [key]: 'not-a-grant' }));
  });
  it.each(['owner', 'OWNER', '', null])('rejects invitation role %s', role => rejection(() => validateUsTeamRequest({ ...request(), role })));
  it.each([-1, 0.1, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER, '0'])('rejects invalid CAS %s', expectedTeamRevision => rejection(() => validateUsTeamRequest({ ...request(), expectedTeamRevision })));
  it.each(['revoke_invitation', 'regenerate_invitation', 'revoke_member'])('accepts exact targeted command %s', action => {
    const key = action === 'revoke_member' ? 'membershipId' : 'invitationId';
    expect(validateUsTeamRequest({ schemaVersion: 1, requestId, expectedTeamRevision: 1, action, [key]: invitationId })).toHaveProperty(key, invitationId);
  });
  it.each(['../evil', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase(), '00000000-0000-0000-0000-000000000000'])('rejects noncanonical IDs %s', requestId => rejection(() => validateUsTeamRequest({ ...request(), requestId })));
  it.each(['a@b', 'a @example.com', 'a\n@example.com', 'a\u200b@example.com', 'a\u0000@example.com', 'a\ud800@example.com'])('rejects malformed email %s', email => rejection(() => validateUsTeamRequest({ ...request(), email })));
  it.each(['', '123', 'A@B', 'A<B', 'A\u0000', 'A\ud800', 'A\u200e', 'A'.repeat(71)])('rejects malformed member name', firstName => rejection(() => validateUsTeamAcceptRequest({ schemaVersion: 1, requestId, expectedTeamRevision: 1, token, firstName, lastName: 'Member' })));
  it('does not accept action/organization/tokenHash in recipient requests', () => {
    expect(validateUsTeamResolveRequest({ schemaVersion: 1, token })).toMatchObject({ token });
    rejection(() => validateUsTeamResolveRequest({ schemaVersion: 1, token, organizationId: org }));
    rejection(() => validateUsTeamAcceptRequest({ schemaVersion: 1, requestId, expectedTeamRevision: 1, token, firstName: 'Team', lastName: 'Member', action: 'accept_invitation' }));
  });
  it('rejects unknown JSON surfaces before evaluating accessors', () => {
    const getter = vi.fn(() => 'secret'); const hostile = { ...request() };
    Object.defineProperty(hostile, 'email', { get: getter, enumerable: true });
    rejection(() => validateUsTeamRequest(hostile)); expect(getter).not.toHaveBeenCalled();
    const toJSON = vi.fn(() => request()); rejection(() => validateUsTeamRequest({ ...request(), toJSON })); expect(toJSON).not.toHaveBeenCalled();
    rejection(() => validateUsTeamRequest(Object.assign(Object.create({ authority: true }), request())));
    rejection(() => validateUsTeamRequest({ ...request(), [Symbol('hidden')]: true }));
    const hidden = { ...request() }; Object.defineProperty(hidden, 'secret', { value: 'private' }); rejection(() => validateUsTeamRequest(hidden));
    const cyclic = { ...request(), extra: {} }; cyclic.extra = cyclic; rejection(() => validateUsTeamRequest(cyclic));
  });
});
describe('Private Auth/SaaS context validation does not grant browser rights', () => {
  it('allows nullable device e-mail but requires confirmed canonical recipient e-mail and nonowner role', () => {
    expect(validateUsTeamContext(context(), org, now)).toMatchObject({ user: { email: null, emailConfirmed: false } });
    const recipient = { ...context(), mode: 'recipient', role: 'member', user: { userId: member, email: 'member@example.com', emailConfirmed: true } };
    expect(validateUsTeamContext(recipient, org, now)).toMatchObject({ mode: 'recipient', role: 'member' });
    for (const patch of [{ role: 'owner' }, { user: { userId: member, email: null, emailConfirmed: false } }, { user: { userId: member, email: 'member@example.com', emailConfirmed: false } }]) rejection(() => validateUsTeamContext({ ...recipient, ...patch }), 'invalid_team_context', 503);
  });
  it.each([{ priceId: 'price' }, { seatLimit: 0 }, { seatLimit: 1001 }, { environment: 'CHF' }, { currency: 'USD' }, { subscriptionId: 'sub\nsecret' }, { validStartsAt: now + 1 }, { validEndsAt: now }, { checkedAt: now - 1.1 }])('rejects malformed private provenance %j', patch => rejection(() => validateUsTeamContext({ ...context(), ...patch }), 'invalid_team_context', 503));
  it.each([now - 1, now + 31, now + 3600])('rejects stale/future/expired context at %s', stamp => rejection(() => validateUsTeamContext(context(), org, stamp), 'invalid_team_context', 503));
  it('accepts exact30second freshness boundary, checks tenant and confirmed/null inconsistency', () => {
    expect(validateUsTeamContext(context(), org, now + 30)).toHaveProperty('checkedAt', now);
    rejection(() => validateUsTeamContext(context(), member), 'invalid_team_context', 503);
    rejection(() => validateUsTeamUser({ userId: member, email: null, emailConfirmed: true }), 'invalid_team_context', 503);
  });
  it('accepts a browser or scoped device credential but no bearer or private hash', () => {
    expect(validateUsTeamContext({ ...context(), credential: { kind: 'browser' } })).toHaveProperty('credential.kind', 'browser');
    for (const supportedSchemaVersion of [1, 2, 3, 4]) expect(validateUsTeamContext({ ...context(), credential: { kind: 'device', sessionId: 'usd_' + owner, supportedSchemaVersion } })).toHaveProperty('credential.supportedSchemaVersion', supportedSchemaVersion);
    for (const credential of [{ kind: 'browser', bearer: 'secret' }, { kind: 'device', sessionId: owner, supportedSchemaVersion: 4 }, { kind: 'device', sessionId: 'usd_' + owner, supportedSchemaVersion: 5 }, { kind: 'device', sessionId: 'usd_' + owner, supportedSchemaVersion: 4, tokenHash: 'a'.repeat(64) }]) rejection(() => validateUsTeamContext({ ...context(), credential }), 'invalid_team_context', 503);
    rejection(() => validateUsTeamContext({ ...context(), mode: 'recipient', role: 'member', user: { userId: member, email: 'member@example.com', emailConfirmed: true }, credential: { kind: 'device', sessionId: 'usd_' + owner, supportedSchemaVersion: 4 } }), 'invalid_team_context', 503);
  });
  it.each(['owner', 'admin', 'accountant', 'member', 'read_only'] as AccountRole[])('applies the management hierarchy without owner/self transfer for %s', actorRole => {
    for (const targetRole of ['owner', 'admin', 'accountant', 'member', 'read_only'] as AccountRole[]) expect(usTeamCanManageRole(actorRole, targetRole)).toBe(actorRole === 'owner' && targetRole !== 'owner' || actorRole === 'admin' && ['member', 'read_only'].includes(targetRole));
  });
});
describe('Private invitation and command history', () => {
  it('accepts pending, revoked and consumed history while preserving expiry as factual data', () => {
    expect(validateUsTeamInvitation(invitation(), org)).toHaveProperty('status', 'pending');
    expect(validateUsTeamInvitation({ ...invitation(), status: 'revoked', revokedAt: now }, org)).toHaveProperty('status', 'revoked');
    expect(validateUsTeamInvitation({ ...invitation(), status: 'accepted', acceptedBy: member, acceptedAt: now, membershipId }, org)).toHaveProperty('membershipId', membershipId);
    expect(validateUsTeamInvitation({ ...invitation(), expiresAt: now - 1 })).toHaveProperty('status', 'pending');
  });
  it.each([{ tokenHash: token }, { acceptedBy: member }, { status: 'expired' }, { expiresAt: now - 61 }, { expiresAt: now + US_TEAM_INVITATION_TTL_SECONDS }, { status: 'accepted', acceptedBy: member, acceptedAt: now + 600, membershipId }, { status: 'revoked', revokedAt: now - 61 }])('rejects inconsistent invitation history %j', patch => rejection(() => validateUsTeamInvitation({ ...invitation(), ...patch }), 'invalid_team_record', 503));
  it('requires canonical private names and denies tokens or caller grants in private commands', () => {
    const accepted = { schemaVersion: 1, requestId, expectedTeamRevision: 1, action: 'accept_invitation', invitationId, tokenHash: 'a'.repeat(64), membershipId, firstName: 'José', lastName: 'Member', displayName: 'José Member' };
    expect(validateUsTeamPrivateCommand(accepted)).toMatchObject({ displayName: 'José Member' });
    for (const patch of [{ token }, { firstName: 'Jose\u0301' }, { displayName: 'member@example.com' }]) rejection(() => validateUsTeamPrivateCommand({ ...accepted, ...patch }), 'invalid_team_record', 503);
  });
  it('captures every private field before any trusted caller await', () => {
    const input = { context: context(), command: command(), requestHash: 'b'.repeat(64) };
    const parsed = validateUsTeamCommit(input, now); input.context.user.userId = member; input.command.email = 'other@example.com';
    expect(parsed.context.user.userId).toBe(owner); expect(parsed.command).toHaveProperty('email', 'member@example.com');
    expect(Object.isFrozen(parsed.context.user)).toBe(true);
  });
  it.each([{ mode: 'recipient', role: 'member', user: { userId: member, email: 'member@example.com', emailConfirmed: true } }, { role: 'accountant' }, { role: 'admin' }])('denies unauthorized create role/context', patch => {
    const c = patch.role === 'admin' ? { ...command(), role: 'accountant' } : command();
    rejection(() => validateUsTeamCommit({ context: { ...context(), ...patch }, command: c, requestHash: 'b'.repeat(64) }, now), 'invalid_team_record', 503);
  });
  it('rejects indefinite links and regenerated identical IDs', () => {
    rejection(() => validateUsTeamCommit({ context: context(), command: { ...command(), expiresAt: now + US_TEAM_INVITATION_TTL_SECONDS + 1 }, requestHash: 'b'.repeat(64) }), 'invalid_team_record', 503);
    rejection(() => validateUsTeamPrivateCommand({ schemaVersion: 1, requestId, expectedTeamRevision: 1, action: 'regenerate_invitation', invitationId, newInvitationId: invitationId, tokenHash: 'b'.repeat(64), expiresAt: now + 1 }), 'invalid_team_record', 503);
  });
});
describe('Public projections and stable receipts do not expose invitation secrets', () => {
  it('keeps historical receipt separate from latest head, and redacts invitations for coworkers', () => {
    const team = validateUsTeamProjection({ ...projection(), role: 'read_only', invitations: [] }, org);
    expect(team.invitations).toEqual([]); expect(team.reservedInvitations).toBe(1);
    expect(validateUsTeamMutationResponse({ team: { ...projection(), revision: 3 }, receipt: receipt(), replayed: true }, org)).toMatchObject({ receipt: { revision: 1 }, team: { revision: 3 } });
  });
  it.each(['accountant', 'member', 'read_only'])('rejects manager invitation e-mails for %s', role => rejection(() => validateUsTeamProjection({ ...projection(), role }), 'invalid_team_record', 503));
  it.each([{ activeMembers: 2 }, { remainingSeats: 0 }, { seatLimit: 0 }, { checkedAt: now - 121 }, { tokenHash: 'a'.repeat(64) }, { revision: Number.MAX_SAFE_INTEGER }])('rejects inconsistent public head %j', patch => rejection(() => validateUsTeamProjection({ ...projection(), ...patch }), 'invalid_team_record', 503));
  it('rejects duplicate memberships/users, missing owner, expired reservations and noncanonical names', () => {
    const p = projection();
    rejection(() => validateUsTeamProjection({ ...p, seatLimit: 4, activeMembers: 2, members: [...p.members, p.members[0]] }), 'invalid_team_record', 503);
    rejection(() => validateUsTeamProjection({ ...p, members: [{ ...p.members[0], role: 'admin' }] }), 'invalid_team_record', 503);
    rejection(() => validateUsTeamProjection({ ...p, invitations: [{ ...p.invitations[0], expiresAt: now }] }), 'invalid_team_record', 503);
    rejection(() => validateUsTeamProjection({ ...p, members: [{ ...p.members[0], displayName: ' Jose\u0301 Member ' }] }), 'invalid_team_record', 503);
  });
  it('rejects raw proof/token/actor/date fields from receipt and validates private correlation shape', () => {
    for (const key of ['token', 'tokenHash', 'requestHash', 'createdAt', 'actorUserId']) rejection(() => validateUsTeamReceipt({ ...receipt(), [key]: 'secret' }), 'invalid_team_record', 503);
    expect(validateUsTeamStoredReceipt({ receipt: receipt(), requestHash: 'a'.repeat(64), actorUserId: owner, createdAt: now }, org)).toHaveProperty('actorUserId', owner);
    rejection(() => validateUsTeamStoredReceipt({ receipt: receipt(), requestHash: 'a'.repeat(64), actorUserId: 'secret', createdAt: now }), 'invalid_team_record', 503);
    rejection(() => validateUsTeamReceipt(receipt(), member), 'invalid_team_record', 503);
  });
  it('allows fragment link only confirmed first management application, never replay or arbitraryURL', () => {
    const response = { team: projection(), receipt: receipt(), replayed: false, invitationLink: '/invitation/us#token=' + token };
    expect(validateUsTeamMutationResponse(response)).toHaveProperty('invitationLink', response.invitationLink);
    for (const patch of [{ replayed: true }, { invitationLink: 'https://evil.example/#token=' + token }, { invitationLink: '/invitation/us#token=' + token + '&next=evil' }, { receipt: { ...receipt(), action: 'revoke_invitation' } }, { team: { ...projection(), revision: 0 } }]) rejection(() => validateUsTeamMutationResponse({ ...response, ...patch }), 'invalid_team_record', 503);
  });
  it('accept response is receipt only and commit flags cannot invent first delivery', () => {
    const r = { ...receipt(), action: 'accept_invitation', entityId: membershipId };
    expect(validateUsTeamAcceptResponse({ receipt: r, replayed: true }, org)).toMatchObject({ replayed: true });
    rejection(() => validateUsTeamAcceptResponse({ receipt: r, replayed: false, team: projection() }), 'invalid_team_record', 503);
    for (const replayed of [false, true]) expect(validateUsTeamCommitResult({ receipt: r, replayed, firstApplied: !replayed }, org)).toHaveProperty('firstApplied', !replayed);
    rejection(() => validateUsTeamCommitResult({ receipt: r, replayed: true, firstApplied: true }), 'invalid_team_record', 503);
  });
  it('resolution is a minimal scoped projection, not provider/financial authority', () => {
    const result = { schemaVersion: 1, organizationId: org, organizationName: 'US Workspace', invitationId, role: 'member', expiresAt: now + 600, teamRevision: 1 };
    expect(validateUsTeamResolution(result)).toMatchObject(result);
    for (const patch of [{ tokenHash: 'a'.repeat(64) }, { role: 'owner' }, { email: 'member@example.com' }, { authority: context() }, { organizationName: 'A'.repeat(161) }]) rejection(() => validateUsTeamResolution({ ...result, ...patch }), 'invalid_team_record', 503);
  });
  it('token encoding requires exactly32 canonical bytes and e-mail normalization is explicit', () => {
    expect(isUsTeamToken(token)).toBe(true);
    for (const invalid of ['zud_' + 'A'.repeat(43), token + '=', token.slice(0, -1) + 'B', token + 'A', 'a'.repeat(64)]) expect(isUsTeamToken(invalid)).toBe(false);
    expect(normalizeUsTeamEmail(' Person@Example.COM ')).toBe('person@example.com');
    rejection(() => normalizeUsTeamEmail('a\ud800@example.com'));
    rejection(() => normalizeUsTeamEmail(' '.repeat(513) + 'a@example.com'));
    expect(usTeamCanManageRole('owner', 'intruder' as AccountRole)).toBe(false);
  });
});
