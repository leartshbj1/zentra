import { ACCOUNT_ROLES, type AccountRole } from '../account-security';
import { canonicalErpJson } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import { sha256Hex } from './canonical-hash';
import type { UsTeamCredential } from './us-team-contract';

export class UsSupportWorkspaceError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); this.name = 'UsSupportWorkspaceError'; }
}
/** Internal, freshly verified Auth + current US SaaS provenance. Shape alone
 * never proves a membership, catalogue, invoice or session. Never a public DTO. */
export interface UsSupportWorkspaceContext {
  readonly schemaVersion: 1; readonly organizationId: string; readonly userId: string;
  readonly role: AccountRole; readonly ownerUserId: string; readonly subscriptionId: string;
  readonly environment: 'TEST' | 'PRODUCTION'; readonly catalogVersion: string;
  readonly priceId: string; readonly authorityReference: string;
  readonly validStartsAt: number; readonly validEndsAt: number; readonly seatLimit: number;
  readonly checkedAt: number; readonly credential: UsTeamCredential;
}
export interface UsSupportWorkspace {
  readonly schemaVersion: 1; readonly organizationId: string; readonly workspaceId: string;
  readonly ownerUserId: string; readonly connectedBy: string; readonly name: string;
  readonly revision: 1; readonly createdAt: number;
}
export interface UsSupportWorkspaceRequest { readonly schemaVersion: 1; readonly requestId: string; readonly name: string }
export interface UsSupportWorkspaceReceipt {
  readonly schemaVersion: 1; readonly organizationId: string; readonly requestId: string;
  readonly workspaceId: string; readonly actorUserId: string; readonly createdAt: number;
}
export interface UsSupportWorkspaceResult { readonly workspace: UsSupportWorkspace; readonly receipt: UsSupportWorkspaceReceipt; readonly replayed: boolean }
export interface UsSupportWorkspaceProjection {
  readonly schemaVersion: 1; readonly organizationId: string; readonly userId: string;
  readonly role: AccountRole; readonly canCreate: boolean; readonly stage: 'registry_only';
  readonly mailboxAvailable: false; readonly classificationAvailable: false;
  readonly workspace: UsSupportWorkspace | null;
}
export interface UsSupportWorkspaceStore {
  read(context: UsSupportWorkspaceContext): Promise<UsSupportWorkspace | null>;
  create(context: UsSupportWorkspaceContext, request: UsSupportWorkspaceRequest, revalidate: () => Promise<UsSupportWorkspaceContext>): Promise<UsSupportWorkspaceResult>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const controls = /[\p{Cc}\p{Cf}]/u;
const fail = (code = 'invalid_support_request', status = 422): never => { throw new UsSupportWorkspaceError(code, status); };
function exact(input: unknown, keys: readonly string[]): Record<string, unknown> {
  const v = snapshotPrivateJson(input);
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) return fail();
  return v as Record<string, unknown>;
}
function id(v: unknown): v is string { return typeof v === 'string' && uuid.test(v); }
function text(v: unknown, max = 160): v is string { return typeof v === 'string' && v.length > 0 && v.length <= max && v.trim() === v && !controls.test(v); }
function second(v: unknown): v is number { return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 253_402_300_799; }
function privateValue<T>(read: () => T, code: string): T { try { return read(); } catch { return fail(code, 503); } }
export function validateUsSupportWorkspaceRequest(input: unknown): UsSupportWorkspaceRequest {
  try {
    const v = exact(input, ['schemaVersion', 'requestId', 'name']);
    if (v.schemaVersion !== 1 || !id(v.requestId) || typeof v.name !== 'string' || controls.test(v.name)) return fail();
    const name = v.name.trim().normalize('NFC');
    if (!text(name, 100) || name.length < 2) return fail();
    return Object.freeze({ schemaVersion: 1, requestId: v.requestId, name });
  } catch { return fail(); }
}
export function validateUsSupportWorkspaceContext(input: unknown, organizationId?: string, now?: number): UsSupportWorkspaceContext {
  return privateValue(() => {
    const v = exact(input, ['schemaVersion','organizationId','userId','role','ownerUserId','subscriptionId','environment','catalogVersion','priceId','authorityReference','validStartsAt','validEndsAt','seatLimit','checkedAt','credential']);
    if (v.schemaVersion !== 1 || !id(v.organizationId) || organizationId !== undefined && v.organizationId !== organizationId || !id(v.userId) || !id(v.ownerUserId) || !(ACCOUNT_ROLES as readonly unknown[]).includes(v.role) || v.role === 'owner' && v.userId !== v.ownerUserId || v.userId === v.ownerUserId && v.role !== 'owner' || !text(v.subscriptionId) || !text(v.catalogVersion) || !text(v.authorityReference) || typeof v.priceId !== 'string' || !/^price_[A-Za-z0-9_]{1,120}$/.test(v.priceId) || !['TEST','PRODUCTION'].includes(String(v.environment)) || !second(v.validStartsAt) || !second(v.validEndsAt) || !second(v.checkedAt) || v.validStartsAt > v.checkedAt || v.checkedAt >= v.validEndsAt || typeof v.seatLimit !== 'number' || !Number.isSafeInteger(v.seatLimit) || v.seatLimit < 1 || v.seatLimit > 1000) return fail();
    if (now !== undefined && (!second(now) || v.checkedAt > now || now - v.checkedAt > 30 || now >= v.validEndsAt)) return fail();
    const c = v.credential as Record<string, unknown>;
    if (!c || typeof c !== 'object') return fail();
    if (c.kind === 'browser') exact(c, ['kind']);
    else if (c.kind === 'device') { exact(c, ['kind','sessionId','supportedSchemaVersion']); if (typeof c.sessionId !== 'string' || !/^usd_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(c.sessionId) || ![1,2,3,4].includes(Number(c.supportedSchemaVersion)) || typeof c.supportedSchemaVersion !== 'number') return fail(); }
    else return fail();
    return v as unknown as UsSupportWorkspaceContext;
  }, 'invalid_support_context');
}
export function validateUsSupportWorkspace(input: unknown, organizationId?: string): UsSupportWorkspace {
  return privateValue(() => {
    const v = exact(input, ['schemaVersion','organizationId','workspaceId','ownerUserId','connectedBy','name','revision','createdAt']);
    if (v.schemaVersion !== 1 || !id(v.organizationId) || organizationId !== undefined && v.organizationId !== organizationId || !id(v.workspaceId) || !id(v.ownerUserId) || !id(v.connectedBy) || !text(v.name, 100) || (v.name as string).length < 2 || (v.name as string).normalize('NFC') !== v.name || v.revision !== 1 || !second(v.createdAt)) return fail();
    return v as unknown as UsSupportWorkspace;
  }, 'invalid_support_record');
}
export function validateUsSupportWorkspaceReceipt(input: unknown, organizationId?: string): UsSupportWorkspaceReceipt {
  return privateValue(() => {
    const v = exact(input, ['schemaVersion','organizationId','requestId','workspaceId','actorUserId','createdAt']);
    if (v.schemaVersion !== 1 || !id(v.organizationId) || organizationId !== undefined && v.organizationId !== organizationId || !id(v.requestId) || !id(v.workspaceId) || !id(v.actorUserId) || !second(v.createdAt)) return fail();
    return v as unknown as UsSupportWorkspaceReceipt;
  }, 'invalid_support_record');
}
export function validateUsSupportWorkspaceResult(input: unknown, organizationId?: string): UsSupportWorkspaceResult {
  return privateValue(() => {
    const v = exact(input, ['workspace','receipt','replayed']);
    const workspace = validateUsSupportWorkspace(v.workspace, organizationId), receipt = validateUsSupportWorkspaceReceipt(v.receipt, workspace.organizationId);
    if (typeof v.replayed !== 'boolean' || receipt.workspaceId !== workspace.workspaceId || receipt.createdAt < workspace.createdAt) return fail();
    return Object.freeze({ workspace, receipt, replayed: v.replayed });
  }, 'invalid_support_record');
}
export function validateUsSupportWorkspaceProjection(input: unknown, organizationId?: string): UsSupportWorkspaceProjection {
  return privateValue(() => {
    const v = exact(input, ['schemaVersion','organizationId','userId','role','canCreate','stage','mailboxAvailable','classificationAvailable','workspace']);
    if (v.schemaVersion !== 1 || !id(v.organizationId) || organizationId !== undefined && v.organizationId !== organizationId || !id(v.userId) || !(ACCOUNT_ROLES as readonly unknown[]).includes(v.role) || v.stage !== 'registry_only' || v.mailboxAvailable !== false || v.classificationAvailable !== false || typeof v.canCreate !== 'boolean' || v.canCreate !== (['owner','admin'].includes(String(v.role)) && v.workspace === null)) return fail();
    return Object.freeze({ ...v, workspace: v.workspace === null ? null : validateUsSupportWorkspace(v.workspace, v.organizationId) }) as unknown as UsSupportWorkspaceProjection;
  }, 'invalid_support_record');
}
export async function hashUsSupportWorkspaceRequest(organizationId: string, userId: string, input: UsSupportWorkspaceRequest): Promise<string> {
  const request = validateUsSupportWorkspaceRequest(input);
  if (!id(organizationId) || !id(userId)) return fail();
  return sha256Hex(canonicalErpJson({ domain: 'zentra:us-support-workspace:v1', organizationId, userId, request }));
}
export function sameUsSupportWorkspaceContext(before: UsSupportWorkspaceContext, after: UsSupportWorkspaceContext): void {
  if (before.userId !== after.userId || canonicalErpJson(before.credential) !== canonicalErpJson(after.credential)) return fail('session_changed', 401);
  if (before.organizationId !== after.organizationId || before.role !== after.role || before.ownerUserId !== after.ownerUserId) return fail('forbidden', 403);
  if (canonicalErpJson({ ...before, checkedAt: 0 }) !== canonicalErpJson({ ...after, checkedAt: 0 })) return fail('configuration_changed', 409);
}
