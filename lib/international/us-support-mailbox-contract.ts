import { ACCOUNT_ROLES, type AccountRole } from '../account-security';
import { canonicalErpJson } from './erp-contract';
import { sha256Hex } from './canonical-hash';
import { snapshotPrivateJson } from './private-json';
import { sameUsSupportWorkspaceContext, validateUsSupportWorkspaceContext, type UsSupportWorkspaceContext } from './us-support-workspace-contract';

export class UsMailboxError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); this.name = 'UsMailboxError'; }
}
/** Private server context: shape is never proof of Auth or SQL admission. */
export interface UsMailboxContext { readonly schemaVersion: 1; readonly authority: UsSupportWorkspaceContext; readonly workspaceId: string }
interface CommandBase { readonly schemaVersion: 1; readonly requestId: string; readonly expectedRevision: number }
export type UsMailboxRequest = CommandBase & ({ readonly action: 'disconnect' } | { readonly action: 'connect'; readonly email: string; readonly token: string });
export type UsMailboxPrivateCommand = CommandBase & ({ readonly action: 'disconnect' } | {
  readonly action: 'connect'; readonly email: string; readonly tokenSha256: string; readonly connectionId: string;
  readonly provider: 'infomaniak'; readonly mailboxId: string; readonly folderId: string; readonly credentialsCiphertext: string; readonly verifiedAt: number;
});
export type UsMailboxCommandMaterial = CommandBase & ({ readonly action: 'disconnect' } | { readonly action: 'connect'; readonly email: string; readonly tokenSha256: string });
/** IDs and ciphertext remain server-only. Member reads erase ciphertext in memory. */
export interface UsMailboxConnection {
  readonly id: string; readonly provider: 'infomaniak'; readonly email: string; readonly mailboxId: string; readonly folderId: string;
  readonly tokenSha256: string; readonly credentialsCiphertext: string | null; readonly verifiedAt: number; readonly connectedBy: string; readonly revision: number;
}
export interface UsMailboxState {
  readonly schemaVersion: 1; readonly organizationId: string; readonly workspaceId: string; readonly revision: number;
  readonly currentConnection: UsMailboxConnection | null;
}
export interface UsMailboxReceipt {
  readonly schemaVersion: 1; readonly organizationId: string; readonly workspaceId: string; readonly actorUserId: string;
  readonly requestId: string; readonly requestHash: string; readonly action: 'connect' | 'disconnect'; readonly expectedRevision: number;
  readonly revision: number; readonly connectionId: string | null; readonly createdAt: number;
}
export interface UsMailboxResult { readonly state: UsMailboxState; readonly receipt: UsMailboxReceipt; readonly replayed: boolean }
export interface UsMailboxProjection {
  readonly schemaVersion: 1; readonly organizationId: string; readonly userId: string; readonly role: AccountRole;
  readonly workspaceId: string; readonly revision: number; readonly canManage: boolean;
  readonly connection: Pick<UsMailboxConnection, 'id' | 'provider' | 'email' | 'verifiedAt'> | null;
}
export interface UsMailboxStore {
  read(this: void, context: UsMailboxContext): Promise<UsMailboxState>;
  receipt(this: void, context: UsMailboxContext, requestId: string, requestHash: string): Promise<UsMailboxReceipt | null>;
  commit(this: void, context: UsMailboxContext, command: UsMailboxPrivateCommand, revalidate: () => Promise<UsMailboxContext>): Promise<UsMailboxResult>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hex = /^[0-9a-f]{64}$/;
const controls = /[\p{Cc}\p{Cf}]/u;
const baseKeys = ['schemaVersion', 'requestId', 'expectedRevision', 'action'] as const;
const fail = (code = 'invalid_mailbox_request', status = 422): never => { throw new UsMailboxError(code, status); };
function exact(input: unknown, keys: readonly string[], maxBytes = 32_768): Record<string, unknown> {
  const v = snapshotPrivateJson(input);
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))
    || new TextEncoder().encode(canonicalErpJson(v)).length > maxBytes) return fail();
  return v as Record<string, unknown>;
}
function id(v: unknown): v is string { return typeof v === 'string' && uuid.test(v); }
function revision(v: unknown): v is number { return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v < Number.MAX_SAFE_INTEGER; }
function second(v: unknown): v is number { return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 253_402_300_799; }
function text(v: unknown, max: number): v is string { return typeof v === 'string' && v.length > 0 && v.length <= max && v === v.trim() && !controls.test(v); }
function email(v: unknown): v is string { return text(v, 254) && v === v.toLowerCase() && /^[^\s:@]+@[^\s:]+\.[^\s:]+$/.test(v); }
function base(v: Record<string, unknown>): void { if (v.schemaVersion !== 1 || !id(v.requestId) || !revision(v.expectedRevision)) fail(); }
function privateValue<T>(read: () => T, code = 'invalid_mailbox_record'): T { try { return read(); } catch { return fail(code, 503); } }
function ciphertext(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 16_384 || !/^v1\.[A-Za-z0-9+/]{16}\.[A-Za-z0-9+/]+={0,2}$/.test(v)) return false;
  try { const [, iv, data] = v.split('.'); return atob(iv).length === 12 && atob(data).length >= 16; } catch { return false; }
}
export function normalizeUsMailboxToken(input: string): string {
  const token = input.trim().replace(/^Bearer(?:\s+|$)/i, '');
  if (!token || token.length > 8192 || /\s/u.test(token) || Array.from(token).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return fail();
  return token;
}
export function validateUsMailboxRequest(input: unknown): UsMailboxRequest {
  try {
    const copied = snapshotPrivateJson(input) as Record<string, unknown>;
    const v = exact(copied, copied?.action === 'connect' ? [...baseKeys, 'email', 'token'] : baseKeys, 16_384); base(v);
    if (v.action === 'disconnect') return v as unknown as UsMailboxRequest;
    if (v.action !== 'connect' || typeof v.email !== 'string' || typeof v.token !== 'string') return fail();
    const normalizedEmail = v.email.trim().toLowerCase();
    if (!email(normalizedEmail)) return fail();
    return Object.freeze({ ...v, email: normalizedEmail, token: normalizeUsMailboxToken(v.token) }) as unknown as UsMailboxRequest;
  } catch { return fail(); }
}
export function validateUsMailboxPrivateCommand(input: unknown): UsMailboxPrivateCommand {
  return privateValue(() => {
    const copied = snapshotPrivateJson(input) as Record<string, unknown>;
    const v = exact(copied, copied?.action === 'connect' ? [...baseKeys, 'email', 'tokenSha256', 'connectionId', 'provider', 'mailboxId', 'folderId', 'credentialsCiphertext', 'verifiedAt'] : baseKeys); base(v);
    if (v.action === 'disconnect') return v as unknown as UsMailboxPrivateCommand;
    if (v.action !== 'connect' || !email(v.email) || typeof v.tokenSha256 !== 'string' || !hex.test(v.tokenSha256) || !id(v.connectionId)
      || v.provider !== 'infomaniak' || !text(v.mailboxId, 200) || !text(v.folderId, 200) || !ciphertext(v.credentialsCiphertext) || !second(v.verifiedAt)) return fail();
    return v as unknown as UsMailboxPrivateCommand;
  });
}
export function validateUsMailboxContext(input: unknown, organizationId?: string, now?: number): UsMailboxContext {
  return privateValue(() => {
    const v = exact(input, ['schemaVersion', 'authority', 'workspaceId']);
    if (v.schemaVersion !== 1 || !id(v.workspaceId)) return fail();
    return Object.freeze({ schemaVersion: 1, authority: validateUsSupportWorkspaceContext(v.authority, organizationId, now), workspaceId: v.workspaceId });
  }, 'invalid_mailbox_context');
}
export function sameUsMailboxContext(before: UsMailboxContext, after: UsMailboxContext): void {
  try { sameUsSupportWorkspaceContext(before.authority, after.authority); }
  catch (e) { if (e instanceof Error && 'code' in e && 'status' in e) throw new UsMailboxError(String(e.code), Number(e.status)); throw e; }
  if (before.workspaceId !== after.workspaceId) fail('configuration_changed', 409);
}
export function validateUsMailboxConnection(input: unknown): UsMailboxConnection {
  return privateValue(() => {
    const v = exact(input, ['id','provider','email','mailboxId','folderId','tokenSha256','credentialsCiphertext','verifiedAt','connectedBy','revision']);
    if (!id(v.id) || v.provider !== 'infomaniak' || !email(v.email) || !text(v.mailboxId, 200) || !text(v.folderId, 200)
      || typeof v.tokenSha256 !== 'string' || !hex.test(v.tokenSha256) || v.credentialsCiphertext !== null && !ciphertext(v.credentialsCiphertext)
      || !second(v.verifiedAt) || !id(v.connectedBy) || !revision(v.revision) || v.revision < 1) return fail();
    return v as unknown as UsMailboxConnection;
  });
}
export function validateUsMailboxState(input: unknown, organizationId?: string): UsMailboxState {
  return privateValue(() => {
    const v = exact(input, ['schemaVersion','organizationId','workspaceId','revision','currentConnection']);
    if (v.schemaVersion !== 1 || !id(v.organizationId) || organizationId !== undefined && v.organizationId !== organizationId || !id(v.workspaceId) || !revision(v.revision)) return fail();
    const connection = v.currentConnection === null ? null : validateUsMailboxConnection(v.currentConnection);
    if (connection && connection.revision !== v.revision || v.revision === 0 && connection !== null) return fail();
    return Object.freeze({ ...v, currentConnection: connection }) as unknown as UsMailboxState;
  });
}
export function validateUsMailboxReceipt(input: unknown, organizationId?: string): UsMailboxReceipt {
  return privateValue(() => {
    const v = exact(input, ['schemaVersion','organizationId','workspaceId','actorUserId','requestId','requestHash','action','expectedRevision','revision','connectionId','createdAt']);
    if (v.schemaVersion !== 1 || !id(v.organizationId) || organizationId !== undefined && v.organizationId !== organizationId || !id(v.workspaceId) || !id(v.actorUserId) || !id(v.requestId)
      || typeof v.requestHash !== 'string' || !hex.test(v.requestHash) || !revision(v.expectedRevision) || !revision(v.revision) || v.revision !== v.expectedRevision + 1
      || !['connect','disconnect'].includes(String(v.action)) || (v.action === 'connect' ? !id(v.connectionId) : v.connectionId !== null) || !second(v.createdAt)) return fail();
    return v as unknown as UsMailboxReceipt;
  });
}
export function validateUsMailboxResult(input: unknown, organizationId?: string): UsMailboxResult {
  return privateValue(() => {
    const v = exact(input, ['state','receipt','replayed']);
    const state = validateUsMailboxState(v.state, organizationId), receipt = validateUsMailboxReceipt(v.receipt, state.organizationId);
    if (typeof v.replayed !== 'boolean' || receipt.workspaceId !== state.workspaceId || receipt.revision > state.revision) return fail();
    return Object.freeze({ state, receipt, replayed: v.replayed });
  });
}
export function validateUsMailboxProjection(input: unknown, organizationId?: string): UsMailboxProjection {
  return privateValue(() => {
    const v = exact(input, ['schemaVersion','organizationId','userId','role','workspaceId','revision','canManage','connection']);
    if (v.schemaVersion !== 1 || !id(v.organizationId) || organizationId !== undefined && v.organizationId !== organizationId || !id(v.userId) || !id(v.workspaceId)
      || !(ACCOUNT_ROLES as readonly unknown[]).includes(v.role) || !revision(v.revision) || v.canManage !== ['owner','admin'].includes(String(v.role))) return fail();
    if (v.connection !== null) {
      const c = exact(v.connection, ['id','provider','email','verifiedAt']);
      if (!id(c.id) || c.provider !== 'infomaniak' || !email(c.email) || !second(c.verifiedAt) || v.revision === 0) return fail();
    }
    return v as unknown as UsMailboxProjection;
  });
}
export function usMailboxProjection(context: UsMailboxContext, state: UsMailboxState): UsMailboxProjection {
  const c = validateUsMailboxContext(context), s = validateUsMailboxState(state, c.authority.organizationId);
  if (c.workspaceId !== s.workspaceId) return fail('invalid_mailbox_record', 503);
  const conn = s.currentConnection;
  return validateUsMailboxProjection({ schemaVersion: 1, organizationId: s.organizationId, userId: c.authority.userId, role: c.authority.role,
    workspaceId: s.workspaceId, revision: s.revision, canManage: ['owner','admin'].includes(c.authority.role),
    connection: conn ? { id: conn.id, provider: conn.provider, email: conn.email, verifiedAt: conn.verifiedAt } : null }, s.organizationId);
}
/** Only this non-secret material is retained in immutable command history. */
export function usMailboxCommandMaterial(command: UsMailboxPrivateCommand): UsMailboxCommandMaterial {
  const q = validateUsMailboxPrivateCommand(command);
  return q.action === 'connect' ? Object.freeze({ schemaVersion: 1, requestId: q.requestId, expectedRevision: q.expectedRevision, action: q.action, email: q.email, tokenSha256: q.tokenSha256 })
    : Object.freeze({ schemaVersion: 1, requestId: q.requestId, expectedRevision: q.expectedRevision, action: q.action });
}
export function validateUsMailboxCommandMaterial(input: unknown): UsMailboxCommandMaterial {
  return privateValue(() => {
    const copied = snapshotPrivateJson(input) as Record<string, unknown>;
    const v = exact(copied, copied?.action === 'connect' ? [...baseKeys, 'email', 'tokenSha256'] : baseKeys, 4096); base(v);
    if (v.action !== 'disconnect' && (v.action !== 'connect' || !email(v.email) || typeof v.tokenSha256 !== 'string' || !hex.test(v.tokenSha256))) return fail();
    return v as unknown as UsMailboxCommandMaterial;
  });
}
async function materialHash(organizationId: string, userId: string, q: { action: 'connect' | 'disconnect'; expectedRevision: number; email?: string; tokenSha256?: string }): Promise<string> {
  if (!id(organizationId) || !id(userId)) return fail();
  return sha256Hex(canonicalErpJson({ domain: 'zentra:us-support-mailbox:v1', organizationId, userId, action: q.action, expectedRevision: q.expectedRevision,
    ...(q.action === 'connect' ? { email: q.email, tokenSha256: q.tokenSha256 } : {}) }));
}
export async function hashUsMailboxRequest(organizationId: string, userId: string, input: UsMailboxRequest): Promise<string> {
  const q = validateUsMailboxRequest(input);
  return materialHash(organizationId, userId, q.action === 'connect' ? { ...q, tokenSha256: await sha256Hex(q.token) } : q);
}
export async function hashUsMailboxPrivateCommand(organizationId: string, userId: string, command: UsMailboxPrivateCommand): Promise<string> {
  return materialHash(organizationId, userId, validateUsMailboxPrivateCommand(command));
}
export async function hashUsMailboxMaterial(organizationId: string, userId: string, material: UsMailboxCommandMaterial): Promise<string> {
  return materialHash(organizationId, userId, validateUsMailboxCommandMaterial(material));
}
export function usMailboxEncryptionContext(context: UsMailboxContext, connectionId: string, connectionRevision: number): string {
  const c = validateUsMailboxContext(context);
  if (!id(connectionId) || !revision(connectionRevision) || connectionRevision < 1) return fail();
  return `us-support-mailbox:${c.authority.organizationId}:${c.workspaceId}:${connectionId}:${connectionRevision}`;
}
