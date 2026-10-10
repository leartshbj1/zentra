import { canonicalErpJson } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import { sha256Hex } from './canonical-hash';
import { d1UsSupportWorkspaceStore } from './us-support-workspace-d1';
import { UsSupportWorkspaceError } from './us-support-workspace-contract';
import { UsMailboxError } from './us-support-mailbox-contract';
import { validateUsSupportExecutionContext, sameUsSupportExecutionContext, isUsSupportWorkerContext, type UsSupportExecutionContext } from './us-support-execution-contract';
import { assertUsSupportWorkerExecution } from './us-support-execution-d1';
import { UsSupportTriageError, hashUsSupportTriageExecutionRequest, hashUsSupportTriageSource, validateUsSupportTriageRequest, validateUsSupportTriageSource,
  validateUsSupportTriageGrant, validateUsSupportTriageDecision, validateUsSupportTriageJob, validateUsSupportTriageResult,
  type UsSupportTriageStore, type UsSupportTriageResult } from './us-support-triage-contract';

type Database = Pick<D1Database,'prepare'|'batch'>;
type Row = Record<string,unknown>;
const fail = (code = 'invalid_triage_record',status = 503): never => { throw new UsSupportTriageError(code,status); };
function row(input: unknown): Row { const v = snapshotPrivateJson(input); if (!v || typeof v !== 'object' || Array.isArray(v)) return fail(); return v as Row; }
function json(input: unknown): unknown {
  if (typeof input !== 'string' || new TextEncoder().encode(input).length > 16_384) return fail();
  const v: unknown = JSON.parse(input); if (canonicalErpJson(v) !== input) return fail(); return v;
}
function reference(input: unknown) {
  const v = row(input);
  if (typeof v.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v.requestId)
    || typeof v.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(v.requestHash)) return fail('invalid_triage_request',422);
  return {requestId:v.requestId,requestHash:v.requestHash};
}
function mapped(error: unknown): UsSupportTriageError {
  if (error instanceof UsSupportTriageError) return error;
  if (error instanceof UsMailboxError || error instanceof UsSupportWorkspaceError) return new UsSupportTriageError(error.code,error.status);
  const message = error instanceof Error ? error.message : '';
  const codes: readonly [string,number][] = [['idempotency_conflict',409],['source_conflict',409],['connection_changed',409],['quota_exceeded',409],['capacity_exceeded',409],['grant_expired',409],['subscription_required',402],['forbidden',403],['unauthorized',401],['invalid_record',503],['immutable',503]];
  const match = codes.find(([code]) => message.includes('us_triage_'+code));
  return match ? new UsSupportTriageError(['subscription_required','forbidden','unauthorized'].includes(match[0]) ? match[0] : match[0] === 'invalid_record' || match[0] === 'immutable' ? 'invalid_triage_record' : 'triage_'+match[0],match[1]) : new UsSupportTriageError('service_unavailable',503);
}
/** Service-only D1 admission. Auth/catalogue/provider source proof remain server ports;
 * SQL corroborates fresh H1 records and fences every dispatch. No message body or effect. */
export function d1UsSupportTriageStore(database: Database, options: {now?: () => number} = {}): UsSupportTriageStore {
  const now = options.now ?? (() => Math.floor(Date.now()/1000));
  const registry = d1UsSupportWorkspaceStore(database,{now});
  async function context(input: unknown) {
    const c = validateUsSupportExecutionContext(input,undefined,now());if(isUsSupportWorkerContext(c))return assertUsSupportWorkerExecution(database,c,now());const workspace = await registry.read(c.authority);
    if (!workspace || workspace.workspaceId !== c.workspaceId || !['owner','admin'].includes(c.authority.role)) return fail('forbidden',403);
    if (c.authority.credential.kind === 'device' && c.authority.credential.supportedSchemaVersion !== 4) return fail('client_upgrade_required',409);
    return c;
  }
  async function lookup(c: UsSupportExecutionContext, requestId: string, requestHash: string): Promise<UsSupportTriageResult | null> {
    const raw = await database.prepare(`SELECT r.*,j.source_json,j.source_hash,j.grant_json,j.actor_user_id AS first_actor,j.request_id AS first_request,j.created_at AS first_created,
      j.request_json AS first_request_json,j.context_json AS first_context_json,d.dispatch_id,d.created_at AS dispatched_at,
      x.decision_json,x.result_sha256,x.created_at AS completed_at
      FROM international_us_support_triage_requests r JOIN international_us_support_triage_jobs j ON j.organization_id=r.organization_id AND j.workspace_id=r.workspace_id AND j.id=r.job_id
      LEFT JOIN international_us_support_triage_dispatches d ON d.organization_id=j.organization_id AND d.workspace_id=j.workspace_id AND d.job_id=j.id
      LEFT JOIN international_us_support_triage_completions x ON x.organization_id=j.organization_id AND x.workspace_id=j.workspace_id AND x.job_id=j.id
      WHERE r.organization_id=? AND r.workspace_id=? AND r.actor_user_id=? AND r.request_id=?`).bind(c.authority.organizationId,c.workspaceId,c.authority.userId,requestId).first();
    if (!raw) return null; const r = row(raw);
    if (r.request_hash !== requestHash) return fail('triage_idempotency_conflict',409);
    const request = validateUsSupportTriageRequest(json(r.request_json)), captured = validateUsSupportExecutionContext(json(r.context_json),c.authority.organizationId);
    const first = validateUsSupportExecutionContext(json(r.first_context_json),c.authority.organizationId), firstRequest = validateUsSupportTriageRequest(json(r.first_request_json));
    if (captured.workspaceId !== c.workspaceId || captured.authority.userId !== c.authority.userId || captured.authority.checkedAt !== r.created_at || request.requestId !== requestId
      || await hashUsSupportTriageExecutionRequest(captured,request) !== requestHash || await hashUsSupportTriageExecutionRequest(c,request)!==requestHash || first.workspaceId !== c.workspaceId
      || first.authority.userId !== r.first_actor || first.authority.checkedAt !== r.first_created || firstRequest.requestId !== r.first_request) return fail();
    const source = validateUsSupportTriageSource(json(r.source_json)), grant = validateUsSupportTriageGrant(json(r.grant_json),c.authority.organizationId,c.workspaceId);
    if (await hashUsSupportTriageSource(c.authority.organizationId,c.workspaceId,source) !== r.source_hash || request.uid !== source.uid || request.expectedMessageVersion !== source.messageVersion) return fail();
    const decision = r.decision_json === null ? null : validateUsSupportTriageDecision(json(r.decision_json),{source,grant});
    if (decision !== null && await sha256Hex(r.decision_json as string) !== r.result_sha256) return fail();
    const job = validateUsSupportTriageJob({schemaVersion:1,id:r.job_id,organizationId:c.authority.organizationId,workspaceId:c.workspaceId,
      actorUserId:r.first_actor,requestId:r.first_request,source,sourceHash:r.source_hash,grant,createdAt:r.first_created,
      state:decision ? 'completed' : r.dispatch_id ? 'uncertain' : 'reserved',dispatchId:r.dispatch_id,result:decision,completedAt:r.completed_at},c.authority.organizationId,c.workspaceId);
    return validateUsSupportTriageResult({job,requestId,requestHash,replayed:true},c.authority.organizationId,c.workspaceId);
  }
  async function admitted(input: UsSupportExecutionContext, revalidate: () => Promise<UsSupportExecutionContext>) {
    const initial = await context(input);
    const fresh = async () => { const next = validateUsSupportExecutionContext(await revalidate(),initial.authority.organizationId,now()); sameUsSupportExecutionContext(initial,next); return context(next); };
    return {initial,fresh};
  }
  async function workerSource(c:UsSupportExecutionContext,receivedAt:number){if(!isUsSupportWorkerContext(c))return;const d=await database.prepare('SELECT json_extract(snapshot_json,\'$.startsAt\') AS starts_at FROM international_us_support_worker_delegations WHERE organization_id=? AND workspace_id=? AND delegation_id=? AND revision=?').bind(c.authority.organizationId,c.workspaceId,c.authority.credential.delegationId,c.authority.credential.delegationRevision).first<Row>();if(!d||typeof d.starts_at!=='number'||receivedAt<d.starts_at)return fail('triage_source_conflict',409);}
  return {
    async find(input,requestId,requestHash) {
      try { reference({requestId,requestHash}); const c = await context(input), result = await lookup(c,requestId,requestHash); await context(c); return result; } catch (error) { throw mapped(error); }
    },
    async claim(input,commandInput,revalidate) {
      try {
        const command = row(commandInput); if (Object.keys(command).length !== 3 || !['request','source','grant'].every(k => Object.hasOwn(command,k))) return fail();
        const q = validateUsSupportTriageRequest(command.request), source = validateUsSupportTriageSource(command.source);
        const {initial,fresh} = await admitted(input,revalidate), org = initial.authority.organizationId, ws = initial.workspaceId;
        const requestHash = await hashUsSupportTriageExecutionRequest(initial,q);
        const historical = await lookup(await fresh(),q.requestId,requestHash);
        if (historical) { if (canonicalErpJson(historical.job.source) !== canonicalErpJson(source)) return fail('triage_source_conflict',409); await fresh(); return historical; }
        await workerSource(await fresh(),source.receivedAt);
        const grant = validateUsSupportTriageGrant(command.grant,org,ws,now());
        if (grant.environment !== initial.authority.environment || grant.catalogVersion !== initial.authority.catalogVersion || grant.priceId !== initial.authority.priceId || q.processingPolicyVersion !== grant.processingPolicyVersion
          || q.uid !== source.uid || q.expectedMessageVersion !== source.messageVersion) return fail('triage_source_conflict',409);
        const sourceHash = await hashUsSupportTriageSource(org,ws,source), c = await fresh(), commandId = crypto.randomUUID(), jobId = crypto.randomUUID();
        if(isUsSupportWorkerContext(c)){const prior=await database.prepare('SELECT source_json,recipe_version FROM international_us_support_triage_jobs WHERE organization_id=? AND workspace_id=? AND source_hash=? ORDER BY created_at,id LIMIT 1').bind(org,ws,sourceHash).first<Row>();if(prior&&(prior.recipe_version!==grant.recipeVersion||prior.source_json!==canonicalErpJson(source)))return fail('triage_source_conflict',409);}
        const statements = [database.prepare(`INSERT INTO international_us_support_triage_jobs(id,organization_id,workspace_id,first_command_id,actor_user_id,request_id,connection_id,mailbox_revision,
          source_hash,recipe_version,environment,period_id,source_json,grant_json,request_json,context_json,created_at)
          SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM international_us_support_triage_jobs WHERE organization_id=? AND workspace_id=? AND source_hash=? AND recipe_version=?)`)
          .bind(jobId,org,ws,commandId,c.authority.userId,q.requestId,q.connectionId,q.expectedMailboxRevision,sourceHash,grant.recipeVersion,grant.environment,grant.periodId,
            canonicalErpJson(source),canonicalErpJson(grant),canonicalErpJson(q),canonicalErpJson(c),c.authority.checkedAt,org,ws,sourceHash,grant.recipeVersion),
        database.prepare(`INSERT INTO international_us_support_triage_requests(command_id,organization_id,workspace_id,actor_user_id,request_id,request_hash,job_id,connection_id,mailbox_revision,request_json,source_json,grant_json,context_json,created_at)
          SELECT ?,?,?,?,?,?,id,?,?,?,?,?,?,? FROM international_us_support_triage_jobs WHERE organization_id=? AND workspace_id=? AND source_hash=? AND recipe_version=?`)
          .bind(commandId,org,ws,c.authority.userId,q.requestId,requestHash,q.connectionId,q.expectedMailboxRevision,canonicalErpJson(q),canonicalErpJson(source),canonicalErpJson(grant),canonicalErpJson(c),c.authority.checkedAt,org,ws,sourceHash,grant.recipeVersion)];
        let replayed = false;
        try { const results = await database.batch(statements); if (!results.every(r => r.success) || results[1]?.meta.changes !== 1) return fail(); replayed = results[0]?.meta.changes !== 1; }
        catch (error) { const saved = await lookup(await fresh(),q.requestId,requestHash); if (!saved) throw error; await fresh(); return saved; }
        const result = await lookup(await fresh(),q.requestId,requestHash); if (!result) return fail(); await fresh(); return {...result,replayed};
      } catch (error) { throw mapped(error); }
    },
    async dispatch(input,commandInput,revalidate) {
      try {
        const q = reference(commandInput), command = row(commandInput); if (Object.keys(command).length !== 3 || typeof command.dispatchId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(command.dispatchId)) return fail('invalid_triage_request',422);
        const {fresh} = await admitted(input,revalidate), c = await fresh(), prior = await lookup(c,q.requestId,q.requestHash); if (!prior) return fail('triage_not_reserved',409);
        if (prior.job.dispatchId) { await fresh(); return {result:prior,mayDispatch:false}; }
        await workerSource(c,prior.job.source.receivedAt);
        const statement = database.prepare(`INSERT INTO international_us_support_triage_dispatches(organization_id,workspace_id,job_id,dispatch_id,command_id,actor_user_id,context_json,created_at)
          SELECT organization_id,workspace_id,job_id,?,command_id,actor_user_id,?,? FROM international_us_support_triage_requests r WHERE organization_id=? AND workspace_id=? AND actor_user_id=? AND request_id=? AND request_hash=?
          AND NOT EXISTS(SELECT 1 FROM international_us_support_triage_dispatches d WHERE d.organization_id=r.organization_id AND d.workspace_id=r.workspace_id AND d.job_id=r.job_id)`)
          .bind(command.dispatchId,canonicalErpJson(c),c.authority.checkedAt,c.authority.organizationId,c.workspaceId,c.authority.userId,q.requestId,q.requestHash);
        let mayDispatch = false;
        try { const results = await database.batch([statement]); if (!results[0]?.success) return fail(); mayDispatch = results[0].meta.changes === 1; }
        catch (error) { const saved = await lookup(await fresh(),q.requestId,q.requestHash); if (!saved?.job.dispatchId) throw error; await fresh(); return {result:saved,mayDispatch:false}; }
        const saved = await lookup(await fresh(),q.requestId,q.requestHash); if (!saved?.job.dispatchId) return fail(); await fresh();
        return {result:mayDispatch ? {...saved,replayed:false,job:{...saved.job,state:'dispatched'}} : saved,mayDispatch};
      } catch (error) { throw mapped(error); }
    },
    async complete(input,commandInput,revalidate) {
      try {
        const command = row(commandInput), q = reference(command); if (Object.keys(command).length !== 4 || !Object.hasOwn(command,'decision')) return fail('invalid_triage_request',422);
        const {fresh} = await admitted(input,revalidate), c = await fresh(), previous = await lookup(c,q.requestId,q.requestHash); if (!previous || !previous.job.dispatchId) return fail('triage_not_dispatched',409);
        if (previous.job.dispatchId !== command.dispatchId) return fail('triage_idempotency_conflict',409);
        const decision = validateUsSupportTriageDecision(command.decision,{source:previous.job.source,grant:previous.job.grant}), body = canonicalErpJson(decision);
        if (previous.job.result) { if (canonicalErpJson(previous.job.result) !== body) return fail('triage_idempotency_conflict',409); await fresh(); return previous; }
        const statement = database.prepare(`INSERT INTO international_us_support_triage_completions(organization_id,workspace_id,job_id,dispatch_id,command_id,decision_json,result_sha256,actor_user_id,context_json,created_at)
          SELECT organization_id,workspace_id,job_id,?,command_id,?,?,actor_user_id,?,? FROM international_us_support_triage_requests WHERE organization_id=? AND workspace_id=? AND actor_user_id=? AND request_id=? AND request_hash=?`)
          .bind(command.dispatchId,body,await sha256Hex(body),canonicalErpJson(c),c.authority.checkedAt,c.authority.organizationId,c.workspaceId,c.authority.userId,q.requestId,q.requestHash);
        try { const results = await database.batch([statement]); if (!results[0]?.success || results[0].meta.changes !== 1) return fail(); }
        catch (error) { const saved = await lookup(await fresh(),q.requestId,q.requestHash); if (!saved?.job.result) throw error; if (canonicalErpJson(saved.job.result) !== body) return fail('triage_idempotency_conflict',409); await fresh(); return saved; }
        const saved = await lookup(await fresh(),q.requestId,q.requestHash); if (!saved?.job.result) return fail(); await fresh(); return {...saved,replayed:false};
      } catch (error) { throw mapped(error); }
    },
    async uncertain(input,commandInput,revalidate) {
      try {
        const command = row(commandInput), q = reference(command); if (Object.keys(command).length !== 3) return fail('invalid_triage_request',422);
        const {fresh} = await admitted(input,revalidate), c = await fresh(), previous = await lookup(c,q.requestId,q.requestHash);
        if (!previous?.job.dispatchId || previous.job.dispatchId !== command.dispatchId) return fail('triage_not_dispatched',409);
        if (previous.job.result) { await fresh(); return previous; }
        const statement = database.prepare(`INSERT INTO international_us_support_triage_uncertain(organization_id,workspace_id,job_id,dispatch_id,command_id,actor_user_id,context_json,created_at)
          SELECT organization_id,workspace_id,job_id,?,command_id,actor_user_id,?,? FROM international_us_support_triage_requests r WHERE organization_id=? AND workspace_id=? AND actor_user_id=? AND request_id=? AND request_hash=?
          AND NOT EXISTS(SELECT 1 FROM international_us_support_triage_uncertain u WHERE u.organization_id=r.organization_id AND u.workspace_id=r.workspace_id AND u.job_id=r.job_id)`)
          .bind(command.dispatchId,canonicalErpJson(c),c.authority.checkedAt,c.authority.organizationId,c.workspaceId,c.authority.userId,q.requestId,q.requestHash);
        try { const results = await database.batch([statement]); if (!results[0]?.success) return fail(); }
        catch (error) { await fresh(); throw error; }
        const saved = await lookup(await fresh(),q.requestId,q.requestHash); if (!saved) return fail(); await fresh(); return saved;
      } catch (error) { throw mapped(error); }
    },
    async usage(input,grantInput) {
      try {
        const c = await context(input), grant = validateUsSupportTriageGrant(grantInput,c.authority.organizationId,c.workspaceId,now());
        if (grant.environment !== c.authority.environment || grant.catalogVersion !== c.authority.catalogVersion || grant.priceId !== c.authority.priceId) return fail();
        const raw = await database.prepare('SELECT count(*) AS used FROM international_us_support_triage_jobs WHERE organization_id=? AND environment=? AND period_id=?').bind(c.authority.organizationId,grant.environment,grant.periodId).first(); await context(c);
        const used = row(raw).used; if (typeof used !== 'number' || !Number.isSafeInteger(used) || used < 0) return fail();
        return {limit:grant.limit,used,remaining:Math.max(0,grant.limit-used)};
      } catch (error) { throw mapped(error); }
    },
  };
}
