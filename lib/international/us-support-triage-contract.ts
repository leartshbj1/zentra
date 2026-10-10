import { CATEGORIES, PRIORITIES, type Category, type Priority } from '../support/types';
import { TRIAGE_POLICY_VERSION } from '../support/jev';
import { canonicalErpJson } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import { sha256Hex } from './canonical-hash';
import { isUsSupportWorkerContext, type UsSupportExecutionContext } from './us-support-execution-contract';

export const US_SUPPORT_TRIAGE_MODEL = 'jev-1.13.0' as const;
export const US_SUPPORT_TRIAGE_RECIPE_VERSION = `us-support-text:${TRIAGE_POLICY_VERSION}`;
export const US_SUPPORT_TRIAGE_MAX_SOURCES = 500;
export const US_SUPPORT_TRIAGE_MAX_REQUESTS = 2000;
export class UsSupportTriageError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); this.name = 'UsSupportTriageError'; }
}
export interface UsSupportTriageRequest {
  readonly schemaVersion: 1; readonly requestId: string; readonly connectionId: string;
  readonly expectedMailboxRevision: number; readonly uid: string; readonly expectedMessageVersion: string;
  readonly processingPolicyVersion: string; readonly consent: true;
}
/** Private observed facts. No message text, credential or model instruction is persisted. */
export interface UsSupportTriageSource {
  readonly provider: 'infomaniak'; readonly mailboxId: string; readonly folderId: string; readonly uid: string;
  readonly messageVersion: string; readonly receivedAt: number; readonly messageSha256: string;
  readonly attachmentCount: number; readonly bodyComplete: boolean;
}
export type UsSupportTriageReviewReason = 'low_confidence' | 'human_requested' | 'other_category' | 'unread_attachments' | 'incomplete_body';
export interface UsSupportTriageDecision {
  readonly schemaVersion: 1; readonly category: Category; readonly priority: Priority;
  readonly categoryConfidence: number; readonly priorityConfidence: number; readonly confidence: number;
  readonly language: 'fr' | 'de' | 'it' | 'en' | 'other'; readonly languageConfidence: number;
  readonly humanRequested: number; readonly reviewReasons: readonly UsSupportTriageReviewReason[]; readonly needsReview: boolean;
  readonly model: typeof US_SUPPORT_TRIAGE_MODEL; readonly recipeVersion: string;
}
export interface UsSupportTriageGrant {
  readonly schemaVersion: 1; readonly organizationId: string; readonly workspaceId: string;
  readonly environment: 'TEST' | 'PRODUCTION'; readonly bucket: 'support_message_classify';
  readonly periodId: string; readonly periodStart: number; readonly periodEnd: number; readonly limit: number;
  readonly budgetPolicyVersion: string; readonly processingPolicyVersion: string;
  readonly catalogVersion: string; readonly priceId: string; readonly recipeVersion: string; readonly threshold: number;
}
export interface UsSupportTriageJob {
  readonly schemaVersion: 1; readonly id: string; readonly organizationId: string; readonly workspaceId: string;
  readonly actorUserId: string; readonly requestId: string; readonly source: UsSupportTriageSource; readonly sourceHash: string;
  readonly grant: UsSupportTriageGrant; readonly createdAt: number;
  readonly state: 'reserved' | 'dispatched' | 'uncertain' | 'completed'; readonly dispatchId: string | null;
  readonly result: UsSupportTriageDecision | null; readonly completedAt: number | null;
}
export interface UsSupportTriageResult { readonly job: UsSupportTriageJob; readonly requestId: string; readonly requestHash: string; readonly replayed: boolean }
export interface UsSupportTriageUsage { readonly limit: number; readonly used: number; readonly remaining: number }
type Revalidate = () => Promise<UsSupportExecutionContext>;
type Reference = { readonly requestId: string; readonly requestHash: string; readonly dispatchId: string };
export interface UsSupportTriageStore {
  find(this: void, context: UsSupportExecutionContext, requestId: string, requestHash: string): Promise<UsSupportTriageResult | null>;
  claim(this: void, context: UsSupportExecutionContext, input: { readonly request: UsSupportTriageRequest; readonly source: UsSupportTriageSource; readonly grant: UsSupportTriageGrant }, revalidate: Revalidate): Promise<UsSupportTriageResult>;
  dispatch(this: void, context: UsSupportExecutionContext, input: Reference, revalidate: Revalidate): Promise<{ readonly result: UsSupportTriageResult; readonly mayDispatch: boolean }>;
  complete(this: void, context: UsSupportExecutionContext, input: Reference & { readonly decision: UsSupportTriageDecision }, revalidate: Revalidate): Promise<UsSupportTriageResult>;
  uncertain(this: void, context: UsSupportExecutionContext, input: Reference, revalidate: Revalidate): Promise<UsSupportTriageResult>;
  usage(this: void, context: UsSupportExecutionContext, grant: UsSupportTriageGrant): Promise<UsSupportTriageUsage>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = (code = 'invalid_triage_request', status = 422): never => { throw new UsSupportTriageError(code,status); };
const id = (v: unknown): v is string => typeof v === 'string' && uuid.test(v);
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const key = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && v.trim() === v && !/[\p{Cc}\p{Cf}]/u.test(v);
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER - 1): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const second = (v: unknown): v is number => integer(v,1,253_402_300_799);
const unit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
function exact(input: unknown, keys: readonly string[]): Record<string,unknown> {
  const v = snapshotPrivateJson(input);
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v,k))) return fail();
  return v as Record<string,unknown>;
}
function privateValue<T>(read: () => T): T { try { return read(); } catch { return fail('invalid_triage_record',503); } }
export function validateUsSupportTriageRequest(input: unknown): UsSupportTriageRequest {
  try {
    const v = exact(input,['schemaVersion','requestId','connectionId','expectedMailboxRevision','uid','expectedMessageVersion','processingPolicyVersion','consent']);
    if (v.schemaVersion !== 1 || !id(v.requestId) || !id(v.connectionId) || !integer(v.expectedMailboxRevision,1) || typeof v.uid !== 'string' || !/^\d{1,20}$/.test(v.uid)
      || !text(v.expectedMessageVersion,200) || !key(v.processingPolicyVersion) || v.consent !== true) return fail();
    return v as unknown as UsSupportTriageRequest;
  } catch { return fail(); }
}
export function validateUsSupportTriageSource(input: unknown): UsSupportTriageSource {
  return privateValue(() => {
    const v = exact(input,['provider','mailboxId','folderId','uid','messageVersion','receivedAt','messageSha256','attachmentCount','bodyComplete']);
    if (v.provider !== 'infomaniak' || !text(v.mailboxId,200) || !text(v.folderId,200) || typeof v.uid !== 'string' || !/^\d{1,20}$/.test(v.uid)
      || !text(v.messageVersion,200) || !second(v.receivedAt) || !digest(v.messageSha256) || !integer(v.attachmentCount,0,1000) || typeof v.bodyComplete !== 'boolean') return fail();
    return v as unknown as UsSupportTriageSource;
  });
}
export function validateUsSupportTriageGrant(input: unknown, organizationId?: string, workspaceId?: string, now?: number): UsSupportTriageGrant {
  return privateValue(() => {
    const v = exact(input,['schemaVersion','organizationId','workspaceId','environment','bucket','periodId','periodStart','periodEnd','limit','budgetPolicyVersion','processingPolicyVersion','catalogVersion','priceId','recipeVersion','threshold']);
    if (v.schemaVersion !== 1 || !id(v.organizationId) || !id(v.workspaceId) || organizationId !== undefined && v.organizationId !== organizationId || workspaceId !== undefined && v.workspaceId !== workspaceId
      || !['TEST','PRODUCTION'].includes(String(v.environment)) || v.bucket !== 'support_message_classify' || typeof v.periodId !== 'string' || !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(v.periodId)
      || !second(v.periodStart) || !second(v.periodEnd) || !integer(v.limit,1,1_000_000) || !key(v.budgetPolicyVersion) || !key(v.processingPolicyVersion) || !key(v.catalogVersion)
      || typeof v.priceId !== 'string' || !/^price_[A-Za-z0-9_]{1,120}$/.test(v.priceId) || !key(v.recipeVersion) || !unit(v.threshold)) return fail();
    const start = new Date(`${v.periodId}-01T00:00:00Z`), end = new Date(start); end.setUTCMonth(end.getUTCMonth()+1);
    if (start.getTime()/1000 !== v.periodStart || end.getTime()/1000 !== v.periodEnd || now !== undefined && (!second(now) || now < v.periodStart || now >= v.periodEnd)) return fail();
    return v as unknown as UsSupportTriageGrant;
  });
}
export function validateUsSupportTriageDecision(input: unknown, context?: { readonly source: UsSupportTriageSource; readonly grant: UsSupportTriageGrant }): UsSupportTriageDecision {
  return privateValue(() => {
    const v = exact(input,['schemaVersion','category','priority','categoryConfidence','priorityConfidence','confidence','language','languageConfidence','humanRequested','reviewReasons','needsReview','model','recipeVersion']);
    const reasons: readonly UsSupportTriageReviewReason[] = ['low_confidence','human_requested','other_category','unread_attachments','incomplete_body'];
    if (v.schemaVersion !== 1 || !Object.hasOwn(CATEGORIES,String(v.category)) || !Object.hasOwn(PRIORITIES,String(v.priority)) || !unit(v.categoryConfidence) || !unit(v.priorityConfidence)
      || !unit(v.confidence) || v.confidence !== Math.min(v.categoryConfidence,v.priorityConfidence) || !['fr','de','it','en','other'].includes(String(v.language)) || !unit(v.languageConfidence)
      || !unit(v.humanRequested) || !Array.isArray(v.reviewReasons) || v.reviewReasons.some(r => !reasons.includes(r)) || canonicalErpJson(v.reviewReasons) !== canonicalErpJson(reasons.filter(r => (v.reviewReasons as unknown[]).includes(r)))
      || typeof v.needsReview !== 'boolean' || v.needsReview !== (v.reviewReasons.length > 0) || v.model !== US_SUPPORT_TRIAGE_MODEL || !key(v.recipeVersion)) return fail();
    if (context) {
      const source = validateUsSupportTriageSource(context.source), grant = validateUsSupportTriageGrant(context.grant);
      const required = reasons.filter(r => r === 'low_confidence' ? Math.min(v.confidence as number,v.languageConfidence as number) < grant.threshold : r === 'human_requested' ? (v.humanRequested as number) >= 0.2 : r === 'other_category' ? v.category === 'other' : r === 'unread_attachments' ? source.attachmentCount > 0 : !source.bodyComplete);
      if (v.recipeVersion !== grant.recipeVersion || canonicalErpJson(v.reviewReasons) !== canonicalErpJson(required)) return fail();
    }
    return v as unknown as UsSupportTriageDecision;
  });
}
export function validateUsSupportTriageJob(input: unknown, organizationId?: string, workspaceId?: string): UsSupportTriageJob {
  return privateValue(() => {
    const v = exact(input,['schemaVersion','id','organizationId','workspaceId','actorUserId','requestId','source','sourceHash','grant','createdAt','state','dispatchId','result','completedAt']);
    if (v.schemaVersion !== 1 || ![v.id,v.organizationId,v.workspaceId,v.actorUserId,v.requestId].every(id) || organizationId !== undefined && v.organizationId !== organizationId || workspaceId !== undefined && v.workspaceId !== workspaceId
      || !digest(v.sourceHash) || !second(v.createdAt) || !['reserved','dispatched','uncertain','completed'].includes(String(v.state))) return fail();
    const source = validateUsSupportTriageSource(v.source), grant = validateUsSupportTriageGrant(v.grant,v.organizationId as string,v.workspaceId as string,v.createdAt as number);
    if (v.state === 'reserved' ? v.dispatchId !== null : !id(v.dispatchId)) return fail();
    if (v.state === 'completed') { if (!second(v.completedAt) || v.completedAt < (v.createdAt as number)) return fail(); validateUsSupportTriageDecision(v.result,{source,grant}); }
    else if (v.result !== null || v.completedAt !== null) return fail();
    return v as unknown as UsSupportTriageJob;
  });
}
export function validateUsSupportTriageResult(input: unknown, organizationId?: string, workspaceId?: string): UsSupportTriageResult {
  return privateValue(() => {
    const v = exact(input,['job','requestId','requestHash','replayed']);
    if (!id(v.requestId) || !digest(v.requestHash) || typeof v.replayed !== 'boolean') return fail();
    return {job:validateUsSupportTriageJob(v.job,organizationId,workspaceId),requestId:v.requestId,requestHash:v.requestHash,replayed:v.replayed};
  });
}
export async function hashUsSupportTriageRequest(organizationId: string, workspaceId: string, actorUserId: string, input: UsSupportTriageRequest): Promise<string> {
  if (![organizationId,workspaceId,actorUserId].every(id)) return fail();
  return sha256Hex(canonicalErpJson({domain:'zentra:us-support-triage:request:v1',organizationId,workspaceId,actorUserId,request:validateUsSupportTriageRequest(input)}));
}
export async function hashUsSupportTriageExecutionRequest(context:UsSupportExecutionContext,input:UsSupportTriageRequest):Promise<string>{const a=context.authority;if(!isUsSupportWorkerContext(context))return hashUsSupportTriageRequest(a.organizationId,context.workspaceId,a.userId,input);const k=context.authority.credential;return sha256Hex(canonicalErpJson({domain:'zentra:us-support-triage:worker-request:v1',organizationId:a.organizationId,workspaceId:context.workspaceId,delegatorUserId:a.userId,workerId:k.workerId,request:validateUsSupportTriageRequest(input)}));}
/** Stable locator. Changed content/version for the same UID must conflict. */
export async function hashUsSupportTriageSource(organizationId: string, workspaceId: string, input: UsSupportTriageSource): Promise<string> {
  if (![organizationId,workspaceId].every(id)) return fail(); const s = validateUsSupportTriageSource(input);
  return sha256Hex(canonicalErpJson({domain:'zentra:us-support-triage:source:v1',organizationId,workspaceId,provider:s.provider,mailboxId:s.mailboxId,folderId:s.folderId,uid:s.uid}));
}
