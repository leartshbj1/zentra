import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import { ErpError, canonicalErpJson } from './erp-contract';
import { sha256Hex } from './canonical-hash';
import { snapshotPrivateJson } from './private-json';
import { validateUsSupplierProposal } from './us-supplier-proposal';
import { automationExact, automationFail, automationUuid, validateUsAutomationActor, validateUsAutomationGrant, validateUsAutomationJob, validateUsAutomationResult, validateUsAutomationSettings, validateUsAutomationSettingsRequest, validateUsAutomationSource, validateUsAutomationUsage } from './us-automation-validation';
import type { FinancialAuthority } from './accounting/ledger';
import type { ErpSchemaVersion } from './erp-schema-capability';
import type { UsAutomationJob, UsAutomationStore } from './us-automation-contract';

const codes: Readonly<Record<string, readonly [string, number]>> = {
  PA001: ['automation_revision_conflict', 409], PA002: ['automation_idempotency_conflict', 409],
  PA003: ['automation_consent_required', 409], PA004: ['invalid_automation_request', 422],
  PA005: ['automation_permission_required', 403], PA006: ['automation_upgrade_required', 409],
  PA007: ['automation_quota_exceeded', 402], PA008: ['invalid_automation_record', 503],
  PA009: ['automation_busy', 409], PA010: ['automation_dispatch_uncertain', 409],
  PA011: ['automation_grant_expired', 402], PA012: ['automation_limit_reached', 409],
  PS002: ['automation_idempotency_conflict', 409], PS007: ['automation_limit_reached', 409], PS008: ['invalid_automation_record', 503],
};
function controlled(error: unknown): ErpError {
  if (error instanceof ErpError) return error;
  if (error instanceof SupabaseServerError && Object.hasOwn(codes, error.code)) return new ErpError(...codes[error.code]);
  return new ErpError('service_unavailable', 503);
}
function parsed<T>(parse: () => T): T { try { return parse(); } catch { return automationFail('invalid_automation_record', 503); } }
const sameSource = (j: UsAutomationJob, source: UsAutomationJob['source']) => j.source.sha256 === source.sha256 && j.source.documentText === source.documentText && j.source.mediaType === source.mediaType;
async function parsedJob(input: unknown, org: string): Promise<UsAutomationJob> {
  const job = parsed(() => validateUsAutomationJob(input, org));
  if (job.source.sha256 !== await sha256Hex(job.source.documentText) || job.resultBody !== null && job.resultSha256 !== await sha256Hex(job.resultBody)) return automationFail('invalid_automation_record', 503);
  return job;
}

/** Fixed private RPC adapter. No key/provider, billing fallback, financial
 * mutation or public worker tokens. Fresh D1 admission is the caller's duty. */
export function createSupabaseUsAutomationStore(client: Pick<SupabaseServerClient, 'rpc'>, options: Readonly<{ supportedSchemaVersion?: ErpSchemaVersion }> = {}): UsAutomationStore {
  const supportedSchemaVersion = options.supportedSchemaVersion ?? 1;
  if (![1, 2, 3, 4].includes(supportedSchemaVersion)) return automationFail();
  const params = (actor: FinancialAuthority) => {
    const safe = validateUsAutomationActor(actor);
    if (supportedSchemaVersion !== 4) return automationFail('automation_upgrade_required', 409);
    return { p_organization: safe.organizationId, p_actor: safe, p_supported_schema_version: supportedSchemaVersion };
  };
  return {
    supportedSchemaVersion,
    async readSettings(actor) {
      try { const p = params(actor), result = await client.rpc<unknown>('zentra_read_us_automation_settings', p); return parsed(() => validateUsAutomationSettings(result, p.p_organization)); }
      catch (error) { throw controlled(error); }
    },
    async saveSettings(actor, input) {
      try {
        const p = params(actor), request = validateUsAutomationSettingsRequest(input);
        if (request.action === 'activate' ? p.p_actor.role !== 'owner' : !['owner', 'admin'].includes(p.p_actor.role)) return automationFail('automation_permission_required', 403);
        const result = await client.rpc<unknown>('zentra_save_us_automation_settings', { ...p, p_request: request });
        const r = parsed(() => automationExact(result, ['settings', 'replayed'])), settings = parsed(() => validateUsAutomationSettings(r.settings, p.p_organization));
        if (typeof r.replayed !== 'boolean') return automationFail('invalid_automation_record', 503);
        if (settings.revision !== request.expectedRevision + 1 || settings.enabled !== (request.action === 'activate') || request.action === 'activate' && (settings.consent?.processingPolicyVersion !== request.processingPolicyVersion || settings.consent.acceptedBy !== p.p_actor.userId)) return automationFail('invalid_automation_record', 503);
        return Object.freeze({ settings, replayed: r.replayed });
      } catch (error) { throw controlled(error); }
    },
    async claim(input) {
      try {
        const v = automationExact(input, ['actor', 'grant', 'source', 'recipeVersion', 'requestId', 'leaseToken']), p = params(v.actor as FinancialAuthority);
        const grant = validateUsAutomationGrant(v.grant, p.p_organization), source = validateUsAutomationSource(v.source, p.p_organization), requestId = automationUuid(v.requestId), leaseToken = automationUuid(v.leaseToken);
        if (typeof v.recipeVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v.recipeVersion) || source.sha256 !== await sha256Hex(source.documentText)) return automationFail();
        const result = await client.rpc<unknown>('zentra_claim_us_automation_analysis', { ...p, p_grant: grant, p_source: source, p_recipe_version: v.recipeVersion, p_request_id: requestId, p_lease_token: leaseToken });
        const r = parsed(() => automationExact(result, ['job', 'claimed'])), job = await parsedJob(r.job, p.p_organization);
        if (typeof r.claimed !== 'boolean' || job.environment !== grant.environment || !sameSource(job, source) || r.claimed && (job.state !== 'held' || job.leaseToken !== leaseToken)) return automationFail('invalid_automation_record', 503);
        return Object.freeze({ job, claimed: r.claimed });
      } catch (error) { throw controlled(error); }
    },
    async dispatch(input) {
      try {
        const v = automationExact(input, ['actor', 'grant', 'jobId', 'leaseToken']), p = params(v.actor as FinancialAuthority), grant = validateUsAutomationGrant(v.grant, p.p_organization), jobId = automationUuid(v.jobId), leaseToken = automationUuid(v.leaseToken);
        const result = await client.rpc<unknown>('zentra_dispatch_us_automation_analysis', { ...p, p_grant: grant, p_job_id: jobId, p_lease_token: leaseToken });
        const r = parsed(() => automationExact(result, ['job', 'mayDispatch'])), job = await parsedJob(r.job, p.p_organization);
        if (typeof r.mayDispatch !== 'boolean' || job.id !== jobId || job.environment !== grant.environment || !['dispatched', 'uncertain', 'completed'].includes(job.state) || r.mayDispatch && (job.state !== 'dispatched' || job.leaseToken !== leaseToken)) return automationFail('invalid_automation_record', 503);
        return Object.freeze({ job, mayDispatch: r.mayDispatch });
      } catch (error) { throw controlled(error); }
    },
    async complete(input) {
      try {
        const v = automationExact(input, ['actor', 'grant', 'jobId', 'dispatchId', 'resultBody', 'resultSha256']), p = params(v.actor as FinancialAuthority), grant = validateUsAutomationGrant(v.grant, p.p_organization), jobId = automationUuid(v.jobId), dispatchId = automationUuid(v.dispatchId), resultBody = validateUsAutomationResult(v.resultBody);
        if (v.resultSha256 !== await sha256Hex(resultBody)) return automationFail();
        const result = await client.rpc<unknown>('zentra_complete_us_automation_analysis', { ...p, p_grant: grant, p_job_id: jobId, p_dispatch_id: dispatchId, p_result_body: resultBody, p_result_sha256: v.resultSha256 });
        const r = parsed(() => automationExact(result, ['job', 'proposal'])), job = await parsedJob(r.job, p.p_organization), proposal = parsed(() => validateUsSupplierProposal(r.proposal, p.p_organization));
        if (job.id !== jobId || job.environment !== grant.environment || job.state !== 'completed' || job.dispatchId !== dispatchId || job.resultBody !== resultBody || job.resultSha256 !== v.resultSha256 || job.proposalId !== proposal.id || !sameSource(job, proposal.source) || canonicalErpJson(proposal.extraction) !== resultBody) return automationFail('invalid_automation_record', 503);
        return Object.freeze({ job, proposal });
      } catch (error) { throw controlled(error); }
    },
    async markUncertain(actor, jobId, dispatchId) {
      try {
        const p = params(actor), id = automationUuid(jobId), dispatch = automationUuid(dispatchId);
        const result = await client.rpc<unknown>('zentra_uncertain_us_automation_analysis', { ...p, p_job_id: id, p_dispatch_id: dispatch });
        const job = await parsedJob(result, p.p_organization);
        if (job.id !== id || job.dispatchId !== dispatch || !['uncertain', 'completed'].includes(job.state)) return automationFail('invalid_automation_record', 503); return job;
      } catch (error) { throw controlled(error); }
    },
    async read(actor, jobId) {
      try {
        const p = params(actor), id = automationUuid(jobId), result = await client.rpc<unknown>('zentra_read_us_automation_analysis', { ...p, p_job_id: id });
        if (result === null) return null; const job = await parsedJob(result, p.p_organization); if (job.id !== id) return automationFail('invalid_automation_record', 503); return job;
      } catch (error) { throw controlled(error); }
    },
    async findSource(actor, input, sourceSha256) {
      try {
        const p = params(actor), grant = validateUsAutomationGrant(input, p.p_organization);
        if (typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sourceSha256)) return automationFail();
        const result = await client.rpc<unknown>('zentra_find_us_automation_source', { ...p, p_grant: grant, p_source_sha256: sourceSha256 });
        if (result === null) return null; const job = await parsedJob(result, p.p_organization);
        if (job.environment !== grant.environment || job.source.sha256 !== sourceSha256) return automationFail('invalid_automation_record', 503); return job;
      } catch (error) { throw controlled(error); }
    },
    async usage(actor, input) {
      try { const p = params(actor), grant = validateUsAutomationGrant(input, p.p_organization), result = await client.rpc<unknown>('zentra_usage_us_automation_analysis', { ...p, p_grant: grant }); return parsed(() => validateUsAutomationUsage(result, grant)); }
      catch (error) { throw controlled(error); }
    },
    async expireHeld(actor, input) {
      try {
        const p = params(actor), grant = validateUsAutomationGrant(input, p.p_organization), result = snapshotPrivateJson(await client.rpc<unknown>('zentra_expire_us_automation_held', { ...p, p_grant: grant }));
        if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 0 || result > 50) return automationFail('invalid_automation_record', 503); return result;
      } catch (error) { throw controlled(error); }
    },
  };
}
