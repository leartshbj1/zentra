import { ACCOUNT_ROLES, type AccountRole } from '../account-security';
import { memberFullName } from '../member-name';
import { snapshotPrivateJson } from './private-json';
import { canonicalErpJson } from './erp-contract';
import { sha256Hex } from './canonical-hash';
import {
  US_TEAM_CONTEXT_MAX_AGE_SECONDS, US_TEAM_INVITATION_TTL_SECONDS, US_TEAM_TOKEN_HASH_PREFIX, US_TEAM_TOKEN_PREFIX, UsTeamError,
  type UsTeamAcceptRequest, type UsTeamAcceptResponse, type UsTeamCommit, type UsTeamCommitResult,
  type UsTeamContext, type UsTeamInvitation, type UsTeamMutationResponse, type UsTeamPrivateCommand,
  type UsTeamProjection, type UsTeamReceipt, type UsTeamRequest, type UsTeamResolution,
  type UsTeamResolveRequest, type UsTeamStoredReceipt, type UsTeamUser,
} from './us-team-contract';

const MAX_REVISION = Number.MAX_SAFE_INTEGER - 1;
const MAX_SECONDS = 253_402_300_799;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const tokenPattern = /^zui_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const actions = ['create_invitation', 'regenerate_invitation', 'revoke_invitation', 'accept_invitation', 'revoke_member'];
const base = ['schemaVersion', 'requestId', 'expectedTeamRevision'];
const controls = /[\p{Cc}\p{Cf}]/u;
const fail = (code = 'invalid_team_request', status = 422): never => { throw new UsTeamError(code, status); };
type Data = Record<string, unknown>;
function snapshot(input: unknown): unknown { try { return snapshotPrivateJson(input); } catch { return fail(); } }
function object(value: unknown): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Data;
}
function exact(input: unknown, keys: readonly string[]): Data {
  const v = object(input);
  if (Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) return fail();
  return v;
}
function integer(v: unknown, min = 0, max = MAX_REVISION): v is number { return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max; }
function seconds(v: unknown): v is number { return integer(v, 0, MAX_SECONDS); }
function uuid(v: unknown): v is string { return typeof v === 'string' && uuidPattern.test(v); }
function text(v: unknown, max = 160): v is string { return typeof v === 'string' && !!v && v.length <= max && v.trim() === v && !controls.test(v); }
function role(v: unknown): v is AccountRole { return typeof v === 'string' && (ACCOUNT_ROLES as readonly string[]).includes(v); }
function inviteRole(v: unknown): boolean { return role(v) && v !== 'owner'; }
function scope(v: unknown, org?: string): void { if (!uuid(v) || org !== undefined && (!uuid(org) || v !== org)) fail(); }
function requestBase(v: Data): void { if (v.schemaVersion !== 1 || !uuid(v.requestId) || !integer(v.expectedTeamRevision, 0, MAX_REVISION - 1)) fail(); }
function privateData<T>(fn: () => T, code = 'invalid_team_record'): T { try { return fn(); } catch { return fail(code, 503); } }
function names(first: unknown, last: unknown): { firstName: string; lastName: string; displayName: string } {
  let displayName: string;
  try { displayName = memberFullName(first, last); } catch { return fail(); }
  return { firstName: (first as string).trim().replace(/\s+/gu, ' ').normalize('NFC'), lastName: (last as string).trim().replace(/\s+/gu, ' ').normalize('NFC'), displayName };
}
function displayName(v: unknown): boolean {
  return v === null || text(v, 141) && v.normalize('NFC') === v && v.replace(/\s+/gu, ' ') === v && !/[<>@]/u.test(v) && /\p{L}/u.test(v);
}
function hash(v: unknown): boolean { return typeof v === 'string' && hashPattern.test(v); }
function expiry(createdAt: unknown, expiresAt: unknown): void {
  if (!seconds(createdAt) || !seconds(expiresAt) || expiresAt <= createdAt || expiresAt - createdAt > US_TEAM_INVITATION_TTL_SECONDS) fail();
}

export function normalizeUsTeamEmail(input: unknown): string {
  const value = snapshot(input);
  if (typeof value !== 'string' || value.length > 512 || controls.test(value)) return fail();
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) return fail();
  return email;
}
export function isUsTeamToken(input: unknown): input is string { return typeof input === 'string' && tokenPattern.test(input); }
export function newUsTeamToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return US_TEAM_TOKEN_PREFIX + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export async function hashUsTeamToken(input: unknown): Promise<string> {
  if (!isUsTeamToken(input)) return fail();
  const captured = US_TEAM_TOKEN_HASH_PREFIX + input;
  return sha256Hex(captured);
}
export function usTeamCanManageRole(actorRole: AccountRole, targetRole: AccountRole): boolean {
  return role(actorRole) && role(targetRole) && (actorRole === 'owner' && targetRole !== 'owner' || actorRole === 'admin' && (targetRole === 'member' || targetRole === 'read_only'));
}

export function validateUsTeamRequest(input: unknown): UsTeamRequest {
  const value = object(snapshot(input));
  const keys = value.action === 'create_invitation' ? ['email', 'role'] : value.action === 'regenerate_invitation' || value.action === 'revoke_invitation' ? ['invitationId'] : value.action === 'revoke_member' ? ['membershipId'] : null;
  if (!keys) return fail();
  const v = exact(value, [...base, 'action', ...keys]); requestBase(v);
  if (v.action === 'create_invitation') {
    if (!inviteRole(v.role)) return fail();
    return Object.freeze({ ...v, email: normalizeUsTeamEmail(v.email) }) as unknown as UsTeamRequest;
  }
  if (!uuid(v.action === 'revoke_member' ? v.membershipId : v.invitationId)) return fail();
  return v as unknown as UsTeamRequest;
}
export function validateUsTeamResolveRequest(input: unknown): UsTeamResolveRequest {
  const v = exact(snapshot(input), ['schemaVersion', 'token']);
  if (v.schemaVersion !== 1 || !isUsTeamToken(v.token)) return fail();
  return v as unknown as UsTeamResolveRequest;
}
export function validateUsTeamAcceptRequest(input: unknown): UsTeamAcceptRequest {
  const v = exact(snapshot(input), [...base, 'token', 'firstName', 'lastName']); requestBase(v);
  if (!isUsTeamToken(v.token)) return fail();
  const n = names(v.firstName, v.lastName);
  return Object.freeze({ ...v, firstName: n.firstName, lastName: n.lastName }) as unknown as UsTeamAcceptRequest;
}
export function validateUsTeamUser(input: unknown): UsTeamUser {
  return privateData(() => {
    const v = exact(snapshot(input), ['userId', 'email', 'emailConfirmed']);
    if (!uuid(v.userId) || typeof v.emailConfirmed !== 'boolean' || v.email === null && v.emailConfirmed || v.email !== null && normalizeUsTeamEmail(v.email) !== v.email) return fail();
    return v as unknown as UsTeamUser;
  }, 'invalid_team_context');
}
/** This only validates a trusted internal snapshot. It does not authenticate a
 * caller, approve a catalog/price or prove a membership. Supply now for freshness. */
export function validateUsTeamContext(input: unknown, organizationId?: string, now?: number): UsTeamContext {
  return privateData(() => {
    const value = object(snapshot(input));
    const v = exact(value, ['schemaVersion', 'organizationId', 'mode', 'role', 'user', 'subscriptionId', 'environment', 'catalogVersion', 'priceId', 'seatLimit', 'checkedAt', 'validStartsAt', 'validEndsAt', ...(Object.hasOwn(value, 'credential') ? ['credential'] : [])]);
    scope(v.organizationId, organizationId);
    const user = validateUsTeamUser(v.user);
    if (v.schemaVersion !== 1 || !['member', 'recipient'].includes(String(v.mode)) || !role(v.role) || !['TEST', 'PRODUCTION'].includes(String(v.environment)) || !text(v.subscriptionId) || !text(v.catalogVersion) || typeof v.priceId !== 'string' || !/^price_[A-Za-z0-9_]{1,120}$/.test(v.priceId) || !integer(v.seatLimit, 1, 1000) || !seconds(v.checkedAt) || !seconds(v.validStartsAt) || !seconds(v.validEndsAt) || v.validStartsAt > v.checkedAt || v.checkedAt >= v.validEndsAt) return fail();
    if (v.mode === 'recipient' && (v.role === 'owner' || !user.emailConfirmed || user.email === null)) return fail();
    if (Object.hasOwn(v, 'credential')) {
      const credential = object(v.credential);
      if (credential.kind === 'browser') exact(credential, ['kind']);
      else {
        exact(credential, ['kind', 'sessionId', 'supportedSchemaVersion']);
        if (credential.kind !== 'device' || typeof credential.sessionId !== 'string' || !/^usd_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(credential.sessionId) || !integer(credential.supportedSchemaVersion, 1, 4) || v.mode === 'recipient') return fail();
      }
    }
    if (now !== undefined && (!seconds(now) || now < v.checkedAt || now - v.checkedAt > US_TEAM_CONTEXT_MAX_AGE_SECONDS || now >= v.validEndsAt)) return fail();
    return Object.freeze({ ...v, user }) as unknown as UsTeamContext;
  }, 'invalid_team_context');
}
export function validateUsTeamInvitation(input: unknown, organizationId?: string): UsTeamInvitation {
  return privateData(() => {
    const v = exact(snapshot(input), ['schemaVersion', 'organizationId', 'invitationId', 'email', 'role', 'tokenHash', 'createdBy', 'createdAt', 'expiresAt', 'status', 'revokedAt', 'acceptedBy', 'acceptedAt', 'membershipId']);
    scope(v.organizationId, organizationId); expiry(v.createdAt, v.expiresAt);
    if (v.schemaVersion !== 1 || !uuid(v.invitationId) || normalizeUsTeamEmail(v.email) !== v.email || !inviteRole(v.role) || !hash(v.tokenHash) || !uuid(v.createdBy)) return fail();
    if (v.status === 'pending') {
      if (v.revokedAt !== null || v.acceptedBy !== null || v.acceptedAt !== null || v.membershipId !== null) return fail();
    } else if (v.status === 'revoked') {
      if (!seconds(v.revokedAt) || v.revokedAt < (v.createdAt as number) || v.acceptedBy !== null || v.acceptedAt !== null || v.membershipId !== null) return fail();
    } else if (v.status === 'accepted') {
      if (v.revokedAt !== null || !uuid(v.acceptedBy) || !uuid(v.membershipId) || !seconds(v.acceptedAt) || v.acceptedAt < (v.createdAt as number) || v.acceptedAt >= (v.expiresAt as number)) return fail();
    } else return fail();
    return v as unknown as UsTeamInvitation;
  });
}
export function validateUsTeamProjection(input: unknown, organizationId?: string): UsTeamProjection {
  return privateData(() => {
    const v = exact(snapshot(input), ['schemaVersion', 'organizationId', 'revision', 'role', 'seatLimit', 'activeMembers', 'reservedInvitations', 'remainingSeats', 'checkedAt', 'members', 'invitations']);
    scope(v.organizationId, organizationId);
    if (v.schemaVersion !== 1 || !integer(v.revision) || !role(v.role) || !integer(v.seatLimit, 1, 1000) || !integer(v.activeMembers, 1, 1000) || !integer(v.reservedInvitations, 0, 1000) || !integer(v.remainingSeats, 0, 1000) || !seconds(v.checkedAt) || !Array.isArray(v.members) || !Array.isArray(v.invitations) || v.members.length !== v.activeMembers || v.activeMembers + v.reservedInvitations + v.remainingSeats !== v.seatLimit) return fail();
    const memberIds = new Set(), userIds = new Set(); let owners = 0;
    for (const member of v.members) {
      const m = exact(member, ['membershipId', 'userId', 'role', 'displayName', 'joinedAt']);
      if (!uuid(m.membershipId) || !uuid(m.userId) || !role(m.role) || !displayName(m.displayName) || !seconds(m.joinedAt) || m.joinedAt > v.checkedAt || memberIds.has(m.membershipId) || userIds.has(m.userId)) return fail();
      memberIds.add(m.membershipId); userIds.add(m.userId); if (m.role === 'owner') owners++;
    }
    if (owners !== 1) return fail();
    const managers = v.role === 'owner' || v.role === 'admin';
    if (managers ? v.invitations.length !== v.reservedInvitations : v.invitations.length !== 0) return fail();
    const invitationIds = new Set(), emails = new Set();
    for (const invitation of v.invitations) {
      const i = exact(invitation, ['invitationId', 'email', 'role', 'createdAt', 'expiresAt']); expiry(i.createdAt, i.expiresAt);
      if (!uuid(i.invitationId) || normalizeUsTeamEmail(i.email) !== i.email || !inviteRole(i.role) || (i.createdAt as number) > v.checkedAt || (i.expiresAt as number) <= v.checkedAt || invitationIds.has(i.invitationId) || emails.has(i.email)) return fail();
      invitationIds.add(i.invitationId); emails.add(i.email);
    }
    return v as unknown as UsTeamProjection;
  });
}
export function validateUsTeamResolution(input: unknown): UsTeamResolution {
  return privateData(() => {
    const v = exact(snapshot(input), ['schemaVersion', 'organizationId', 'organizationName', 'invitationId', 'role', 'expiresAt', 'teamRevision']);
    scope(v.organizationId);
    if (v.schemaVersion !== 1 || !text(v.organizationName, 160) || !uuid(v.invitationId) || !inviteRole(v.role) || !seconds(v.expiresAt) || !integer(v.teamRevision)) return fail();
    return v as unknown as UsTeamResolution;
  });
}
export function validateUsTeamReceipt(input: unknown, organizationId?: string): UsTeamReceipt {
  return privateData(() => {
    const v = exact(snapshot(input), ['schemaVersion', 'organizationId', 'requestId', 'action', 'entityId', 'revision']); scope(v.organizationId, organizationId);
    if (v.schemaVersion !== 1 || !uuid(v.requestId) || !actions.includes(String(v.action)) || !uuid(v.entityId) || !integer(v.revision, 1)) return fail();
    return v as unknown as UsTeamReceipt;
  });
}
export function validateUsTeamStoredReceipt(input: unknown, organizationId?: string): UsTeamStoredReceipt {
  return privateData(() => {
    const v = exact(snapshot(input), ['receipt', 'requestHash', 'actorUserId', 'createdAt']);
    const receipt = validateUsTeamReceipt(v.receipt, organizationId);
    if (!hash(v.requestHash) || !uuid(v.actorUserId) || !seconds(v.createdAt)) return fail();
    return Object.freeze({ ...v, receipt }) as unknown as UsTeamStoredReceipt;
  });
}
export function validateUsTeamPrivateCommand(input: unknown): UsTeamPrivateCommand {
  return privateData(() => {
    const value = object(snapshot(input));
    const keys = value.action === 'create_invitation' ? ['email', 'role', 'invitationId', 'tokenHash', 'expiresAt'] : value.action === 'regenerate_invitation' ? ['invitationId', 'newInvitationId', 'tokenHash', 'expiresAt'] : value.action === 'revoke_invitation' ? ['invitationId'] : value.action === 'revoke_member' ? ['membershipId'] : value.action === 'accept_invitation' ? ['invitationId', 'tokenHash', 'membershipId', 'firstName', 'lastName', 'displayName'] : null;
    if (!keys) return fail();
    const v = exact(value, [...base, 'action', ...keys]); requestBase(v);
    if (v.action === 'create_invitation' && (!inviteRole(v.role) || normalizeUsTeamEmail(v.email) !== v.email)) return fail();
    if (v.action !== 'revoke_member' && !uuid(v.invitationId) || v.action === 'revoke_member' && !uuid(v.membershipId)) return fail();
    if (v.action === 'create_invitation' || v.action === 'regenerate_invitation') {
      if (!hash(v.tokenHash) || !seconds(v.expiresAt) || v.action === 'regenerate_invitation' && (!uuid(v.newInvitationId) || v.newInvitationId === v.invitationId)) return fail();
    }
    if (v.action === 'accept_invitation') {
      const n = names(v.firstName, v.lastName);
      if (!hash(v.tokenHash) || !uuid(v.membershipId) || v.firstName !== n.firstName || v.lastName !== n.lastName || v.displayName !== n.displayName) return fail();
    }
    return v as unknown as UsTeamPrivateCommand;
  });
}
/** Semantic identity deliberately excludes CSPRNG first-application artifacts.
 * The actor userId and organizationId are added by the caller, never timestamps. */
export function usTeamCommandIdentity(input: unknown): Readonly<Record<string, unknown>> {
  const v = validateUsTeamPrivateCommand(input);
  const identity = { schemaVersion: v.schemaVersion, requestId: v.requestId, expectedTeamRevision: v.expectedTeamRevision, action: v.action };
  if (v.action === 'create_invitation') return Object.freeze({ ...identity, email: v.email, role: v.role });
  if (v.action === 'regenerate_invitation' || v.action === 'revoke_invitation') return Object.freeze({ ...identity, invitationId: v.invitationId });
  if (v.action === 'revoke_member') return Object.freeze({ ...identity, membershipId: v.membershipId });
  return Object.freeze({ ...identity, invitationId: v.invitationId, tokenHash: v.tokenHash, firstName: v.firstName, lastName: v.lastName });
}
export async function hashUsTeamCommand(organizationId: string, userId: string, command: unknown): Promise<string> {
  if (!uuid(organizationId) || !uuid(userId)) return fail('invalid_team_context', 503);
  const body = canonicalErpJson([organizationId, userId, usTeamCommandIdentity(command)]);
  return sha256Hex(body);
}
export function validateUsTeamCommit(input: unknown, now?: number): UsTeamCommit {
  return privateData(() => {
    const v = exact(snapshot(input), ['context', 'command', 'requestHash']);
    const context = validateUsTeamContext(v.context, undefined, now), command = validateUsTeamPrivateCommand(v.command);
    if (!hash(v.requestHash)) return fail();
    if (command.action === 'accept_invitation') {
      if (context.mode !== 'recipient') return fail();
    } else if (context.mode !== 'member' || !['owner', 'admin'].includes(context.role)) return fail();
    if (command.action === 'create_invitation' && !usTeamCanManageRole(context.role, command.role)) return fail();
    if (command.action === 'create_invitation' || command.action === 'regenerate_invitation') expiry(context.checkedAt, command.expiresAt);
    return Object.freeze({ context, command, requestHash: v.requestHash }) as UsTeamCommit;
  });
}
export function validateUsTeamCommitResult(input: unknown, organizationId?: string): UsTeamCommitResult {
  return privateData(() => {
    const v = exact(snapshot(input), ['receipt', 'replayed', 'firstApplied']);
    const receipt = validateUsTeamReceipt(v.receipt, organizationId);
    if (typeof v.replayed !== 'boolean' || typeof v.firstApplied !== 'boolean' || v.firstApplied === v.replayed) return fail();
    return Object.freeze({ ...v, receipt }) as unknown as UsTeamCommitResult;
  });
}
export function validateUsTeamMutationResponse(input: unknown, organizationId?: string): UsTeamMutationResponse {
  return privateData(() => {
    const value = object(snapshot(input));
    const v = exact(value, ['team', 'receipt', 'replayed', ...(Object.hasOwn(value, 'invitationLink') ? ['invitationLink'] : [])]);
    const team = validateUsTeamProjection(v.team, organizationId), receipt = validateUsTeamReceipt(v.receipt, team.organizationId);
    if (typeof v.replayed !== 'boolean' || receipt.action === 'accept_invitation' || receipt.revision > team.revision) return fail();
    if (v.invitationLink !== undefined && (v.replayed || !['owner', 'admin'].includes(team.role) || !['create_invitation', 'regenerate_invitation'].includes(receipt.action) || typeof v.invitationLink !== 'string' || !v.invitationLink.startsWith('/invitation/us#token=') || !isUsTeamToken(v.invitationLink.slice('/invitation/us#token='.length)))) return fail();
    return Object.freeze({ ...v, team, receipt }) as unknown as UsTeamMutationResponse;
  });
}
export function validateUsTeamAcceptResponse(input: unknown, organizationId?: string): UsTeamAcceptResponse {
  return privateData(() => {
    const v = exact(snapshot(input), ['receipt', 'replayed']); const receipt = validateUsTeamReceipt(v.receipt, organizationId);
    if (typeof v.replayed !== 'boolean' || receipt.action !== 'accept_invitation') return fail();
    return Object.freeze({ ...v, receipt }) as unknown as UsTeamAcceptResponse;
  });
}
