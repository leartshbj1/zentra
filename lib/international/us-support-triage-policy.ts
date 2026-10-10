import { validateUsSupportExecutionContext, type UsSupportExecutionContext } from './us-support-execution-contract';
import { snapshotPrivateJson } from './private-json';
import { US_SUPPORT_TRIAGE_RECIPE_VERSION, UsSupportTriageError, validateUsSupportTriageGrant, type UsSupportTriageGrant } from './us-support-triage-contract';

export interface UsSupportTriagePolicy {
  readonly schemaVersion: 1; readonly cadence: 'utc_calendar_month'; readonly budgetPolicyVersion: string;
  readonly processingPolicyVersion: string; readonly recipeVersion: string; readonly threshold: number;
  readonly entries: readonly Readonly<{catalogVersion:string;priceId:string;limit:number}>[];
}
const fail = (): never => { throw new UsSupportTriageError('invalid_triage_policy',503); };
const key = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
function exact(input: unknown, keys: readonly string[]): Record<string,unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== keys.length || keys.some(k => !Object.hasOwn(input,k))) return fail();
  return input as Record<string,unknown>;
}
/** Explicit configuration, never a default quota or inferred commercial offer. */
export function parseUsSupportTriagePolicy(input: unknown): UsSupportTriagePolicy {
  try {
    if (typeof input === 'string' && new TextEncoder().encode(input).length > 65_536) return fail();
    const v = exact(snapshotPrivateJson(typeof input === 'string' ? JSON.parse(input) : input),['schemaVersion','cadence','budgetPolicyVersion','processingPolicyVersion','recipeVersion','threshold','entries']);
    if (v.schemaVersion !== 1 || v.cadence !== 'utc_calendar_month' || !key(v.budgetPolicyVersion) || !key(v.processingPolicyVersion) || v.recipeVersion !== US_SUPPORT_TRIAGE_RECIPE_VERSION
      || typeof v.threshold !== 'number' || !Number.isFinite(v.threshold) || v.threshold < 0 || v.threshold > 1 || !Array.isArray(v.entries) || v.entries.length > 100) return fail();
    const seen = new Set<string>(), entries = v.entries.map(raw => {
      const e = exact(raw,['catalogVersion','priceId','limit']);
      if (!key(e.catalogVersion) || typeof e.priceId !== 'string' || !/^price_[A-Za-z0-9_]{1,120}$/.test(e.priceId) || typeof e.limit !== 'number' || !Number.isSafeInteger(e.limit) || e.limit < 1 || e.limit > 1_000_000) return fail();
      const identity = JSON.stringify([e.catalogVersion,e.priceId]); if (seen.has(identity)) return fail(); seen.add(identity);
      return Object.freeze({catalogVersion:e.catalogVersion,priceId:e.priceId,limit:e.limit});
    });
    return Object.freeze({...v,entries:Object.freeze(entries)}) as unknown as UsSupportTriagePolicy;
  } catch { return fail(); }
}
export function createUsSupportTriageGrant(context: UsSupportExecutionContext, input: UsSupportTriagePolicy): UsSupportTriageGrant {
  const c = validateUsSupportExecutionContext(context), policy = parseUsSupportTriagePolicy(input), a = c.authority;
  if (!['owner','admin'].includes(a.role)) throw new UsSupportTriageError('support_management_required',403);
  const entry = policy.entries.find(e => e.catalogVersion === a.catalogVersion && e.priceId === a.priceId);
  if (!entry) throw new UsSupportTriageError('triage_budget_unavailable',503);
  const at = new Date(a.checkedAt*1000), start = new Date(at); start.setUTCDate(1); start.setUTCHours(0,0,0,0);
  const end = new Date(start); end.setUTCMonth(end.getUTCMonth()+1);
  return validateUsSupportTriageGrant({schemaVersion:1,organizationId:a.organizationId,workspaceId:c.workspaceId,environment:a.environment,bucket:'support_message_classify',
    periodId:`${String(start.getUTCFullYear()).padStart(4,'0')}-${String(start.getUTCMonth()+1).padStart(2,'0')}`,periodStart:start.getTime()/1000,periodEnd:end.getTime()/1000,
    limit:entry.limit,budgetPolicyVersion:policy.budgetPolicyVersion,processingPolicyVersion:policy.processingPolicyVersion,catalogVersion:a.catalogVersion,priceId:a.priceId,recipeVersion:policy.recipeVersion,threshold:policy.threshold},a.organizationId,c.workspaceId,a.checkedAt);
}
