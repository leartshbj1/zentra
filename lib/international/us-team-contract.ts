import type { AccountRole } from '../account-security';

export const US_TEAM_SCHEMA_VERSION = 1 as const;
export const US_TEAM_TOKEN_PREFIX = 'zui_' as const;
export const US_TEAM_TOKEN_HASH_PREFIX = 'zentra:us-team-invitation:v1:' as const;
export const US_TEAM_INVITATION_TTL_SECONDS = 604_800;
export const US_TEAM_CONTEXT_MAX_AGE_SECONDS = 30;
export type UsTeamInviteRole = Exclude<AccountRole, 'owner'>;
export interface UsTeamUser { readonly userId: string; readonly email: string | null; readonly emailConfirmed: boolean }
export type UsTeamCredential = Readonly<{ kind: 'browser' }> | Readonly<{ kind: 'device'; sessionId: string; supportedSchemaVersion: 1 | 2 | 3 | 4 }>;

/** Internal Auth + currently approved US SaaS provenance, not a browser DTO.
 * Structural validation never establishes the authenticity of these facts. */
export interface UsTeamContext {
  readonly schemaVersion: 1;
  readonly organizationId: string;
  readonly mode: 'member' | 'recipient';
  readonly role: AccountRole;
  readonly user: UsTeamUser;
  readonly subscriptionId: string;
  readonly environment: 'TEST' | 'PRODUCTION';
  readonly catalogVersion: string;
  readonly priceId: string;
  readonly seatLimit: number;
  readonly checkedAt: number;
  readonly validStartsAt: number;
  readonly validEndsAt: number;
  /** Real bindings always provide this. Optional for isolated fixtures only. */
  readonly credential?: UsTeamCredential;
}
export interface UsTeamMember {
  readonly membershipId: string; readonly userId: string; readonly role: AccountRole;
  readonly displayName: string | null; readonly joinedAt: number;
}
/** Current non-expired reservations only; closed history stays private. */
export interface UsTeamPublicInvitation {
  readonly invitationId: string; readonly email: string; readonly role: UsTeamInviteRole;
  readonly createdAt: number; readonly expiresAt: number;
}
export interface UsTeamProjection {
  readonly schemaVersion: 1; readonly organizationId: string; readonly revision: number;
  readonly role: AccountRole; readonly seatLimit: number; readonly activeMembers: number;
  readonly reservedInvitations: number; readonly remainingSeats: number; readonly checkedAt: number;
  readonly members: readonly UsTeamMember[];
  /** Empty for accountant/member/read_only, including no recipient e-mails. */
  readonly invitations: readonly UsTeamPublicInvitation[];
}
interface UsTeamRequestBase { readonly schemaVersion: 1; readonly requestId: string; readonly expectedTeamRevision: number }
export type UsTeamRequest = UsTeamRequestBase & (
  | Readonly<{ action: 'create_invitation'; email: string; role: UsTeamInviteRole }>
  | Readonly<{ action: 'regenerate_invitation' | 'revoke_invitation'; invitationId: string }>
  | Readonly<{ action: 'revoke_member'; membershipId: string }>
);
export interface UsTeamResolveRequest { readonly schemaVersion: 1; readonly token: string }
export interface UsTeamAcceptRequest extends UsTeamRequestBase {
  readonly token: string; readonly firstName: string; readonly lastName: string;
}
export interface UsTeamResolution {
  readonly schemaVersion: 1; readonly organizationId: string; readonly organizationName: string;
  readonly invitationId: string; readonly role: UsTeamInviteRole; readonly expiresAt: number; readonly teamRevision: number;
}
export type UsTeamAction = UsTeamRequest['action'] | 'accept_invitation';
export interface UsTeamReceipt {
  readonly schemaVersion: 1; readonly organizationId: string; readonly requestId: string;
  readonly action: UsTeamAction; readonly entityId: string; readonly revision: number;
}
export interface UsTeamMutationResponse {
  readonly team: UsTeamProjection; readonly receipt: UsTeamReceipt; readonly replayed: boolean;
  /** Only a confirmed first create/regenerate application, never a replay. */
  readonly invitationLink?: string;
}
export interface UsTeamAcceptResponse { readonly receipt: UsTeamReceipt; readonly replayed: boolean }

export interface UsTeamInvitation {
  readonly schemaVersion: 1; readonly organizationId: string; readonly invitationId: string;
  readonly email: string; readonly role: UsTeamInviteRole; readonly tokenHash: string;
  readonly createdBy: string; readonly createdAt: number; readonly expiresAt: number;
  readonly status: 'pending' | 'revoked' | 'accepted'; readonly revokedAt: number | null;
  readonly acceptedBy: string | null; readonly acceptedAt: number | null; readonly membershipId: string | null;
}
/** No clear token. Generated IDs/hash/expiry are first-application artifacts,
 * excluded from the semantic requestHash for create/regenerate retries. */
export type UsTeamPrivateCommand = UsTeamRequestBase & (
  | Readonly<{ action: 'create_invitation'; email: string; role: UsTeamInviteRole; invitationId: string; tokenHash: string; expiresAt: number }>
  | Readonly<{ action: 'regenerate_invitation'; invitationId: string; newInvitationId: string; tokenHash: string; expiresAt: number }>
  | Readonly<{ action: 'revoke_invitation'; invitationId: string }>
  | Readonly<{ action: 'accept_invitation'; invitationId: string; tokenHash: string; membershipId: string; firstName: string; lastName: string; displayName: string }>
  | Readonly<{ action: 'revoke_member'; membershipId: string }>
);
export interface UsTeamStoredReceipt {
  readonly receipt: UsTeamReceipt; readonly requestHash: string; readonly actorUserId: string; readonly createdAt: number;
}
export interface UsTeamCommit {
  readonly context: UsTeamContext; readonly command: UsTeamPrivateCommand; readonly requestHash: string;
}
export interface UsTeamCommitResult {
  readonly receipt: UsTeamReceipt; readonly replayed: boolean; readonly firstApplied: boolean;
}
/** D1 implementation owns CAS, seats, recipient matching, fixed roles, audit,
 * owner protection and both session families. Fresh Auth/SaaS is the caller's
 * duty; an invitation is not an independent subscription or financial grant. */
export interface UsTeamStore {
  read(this: void, context: UsTeamContext): Promise<UsTeamProjection>;
  /** Recipient-safe head only, after confirmed e-mail matching. */
  revision(this: void, context: UsTeamContext): Promise<number>;
  find(this: void, tokenHash: string): Promise<UsTeamInvitation | null>;
  invitation(this: void, context: UsTeamContext, invitationId: string): Promise<UsTeamInvitation | null>;
  receipt(this: void, context: UsTeamContext, requestId: string): Promise<UsTeamStoredReceipt | null>;
  commit(this: void, input: UsTeamCommit): Promise<UsTeamCommitResult>;
}
export class UsTeamError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); this.name = 'UsTeamError'; }
}
