import type { FinancialAuthority } from './accounting/ledger';
import { canonicalErpJson, ErpError } from './erp-contract';
import { sha256Hex } from './canonical-hash';
import { createUsSingleDispatchProvider } from './us-analysis-provider';
import type { UsAutomationGrant, UsAutomationJob, UsAutomationStore } from './us-automation-contract';
import { validateUsAutomationGrant, validateUsAutomationJob, validateUsAutomationSettings, validateUsAutomationSource } from './us-automation-validation';
import { extractUsSupplierInvoice, validateUsSupplierExtraction, US_SUPPLIER_MIN_SOURCE_CHARACTERS } from './us-supplier-extraction';
import { validateUsSupplierProposal } from './us-supplier-proposal';
import type { UsSupplierPrepareResponse, UsSupplierSource, UsSupplierStore } from './us-supplier-contract';

export const US_SUPPLIER_RECIPE = 'us-supplier-text-jev113-1';
export interface UsSupplierAnalysisDependencies {
  grant(actor: FinancialAuthority): Promise<UsAutomationGrant>;
  store: UsAutomationStore;
  suppliers: UsSupplierStore;
  providerKey(): Promise<string | null>;
  providerEnabled(): Promise<boolean>;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  newId(): string;
}
/** No automatic accounting. A durable first-dispatch fence is required even
 * for HTTP retries/collaborators. Unknown dispatches cannot invoke the model. */
export function createUsSupplierAnalysis(dependencies: UsSupplierAnalysisDependencies) {
  const privateValue=<T>(parse:()=>T):T=>{try{return parse();}catch{throw new ErpError('invalid_automation_record',503);}};
  return async (input: Readonly<{ actor: FinancialAuthority; source: UsSupplierSource; revalidate: () => Promise<FinancialAuthority> }>): Promise<UsSupplierPrepareResponse> => {
    const source = validateUsAutomationSource(input.source, input.actor.organizationId);
    if (source.sha256 !== await sha256Hex(source.documentText) || dependencies.store.supportedSchemaVersion !== 4 || dependencies.suppliers.supportedSchemaVersion !== 4) throw new ErpError('invalid_automation_request');
    if (source.documentText.trim().length < US_SUPPLIER_MIN_SOURCE_CHARACTERS) throw new ErpError('supplier_source_unreadable',422);
    async function fresh() {
      const actor = await input.revalidate();
      const grant = validateUsAutomationGrant(await dependencies.grant(actor), actor.organizationId);
      const current = await input.revalidate();
      if (current.userId !== actor.userId || current.role !== actor.role || current.organizationId !== actor.organizationId) throw new ErpError('session_changed', 401);
      return { actor: current, grant };
    }
    async function dispatchConsent(actor: FinancialAuthority, grant: UsAutomationGrant, revision?: number) {
      const raw=await dependencies.store.readSettings(actor),settings = privateValue(()=>validateUsAutomationSettings(raw, actor.organizationId));
      if (!settings.enabled || settings.consent?.processingPolicyVersion !== grant.processingPolicyVersion || revision !== undefined && settings.revision !== revision) throw new ErpError('automation_consent_required', 409);
      if (!await dependencies.providerEnabled()) throw new ErpError('supplier_analysis_unavailable', 503);
      return settings;
    }
    async function existing(job: UsAutomationJob, actor: FinancialAuthority): Promise<UsSupplierPrepareResponse> {
      job=privateValue(()=>validateUsAutomationJob(job,actor.organizationId));
      if (job.state !== 'completed' || !job.proposalId) throw new ErpError(['dispatched','uncertain'].includes(job.state) ? 'automation_dispatch_uncertain' : 'automation_busy', 409);
      const proposal = await dependencies.suppliers.read(actor, job.proposalId);
      if (!proposal) throw new ErpError('invalid_automation_record', 503);
      const safe = privateValue(()=>validateUsSupplierProposal(proposal, actor.organizationId));
      if (safe.id!==job.proposalId || safe.source.documentText !== source.documentText || safe.source.sha256 !== source.sha256 || canonicalErpJson(safe.extraction) !== job.resultBody || job.resultSha256!==await sha256Hex(job.resultBody!)) throw new ErpError('invalid_automation_record', 503);
      await input.revalidate(); return { proposal: safe, replayed: true };
    }
    let current = await fresh();
    const prior = await dependencies.store.findSource(current.actor, current.grant, source.sha256);
    if (prior && !['held','released'].includes(prior.state)) return existing(prior, current.actor);
    const settings = await dispatchConsent(current.actor, current.grant);
    const key = await dependencies.providerKey();
    if (!key) throw new ErpError('supplier_analysis_unavailable', 503);
    current = await fresh(); await dispatchConsent(current.actor, current.grant, settings.revision);
    const leaseToken = dependencies.newId();
    const reservation = await dependencies.store.claim({ ...current, source, recipeVersion: US_SUPPLIER_RECIPE, requestId: dependencies.newId(), leaseToken });
    if (!reservation.claimed) return existing(reservation.job, (await fresh()).actor);
    let dispatched: UsAutomationJob | undefined, admissionFailure:unknown;
    const provider = createUsSingleDispatchProvider({ apiKey: key, fetcher: dependencies.fetcher, timeoutMs: dependencies.timeoutMs,
      async authorize() {
        try {
        const before = await fresh(); await dispatchConsent(before.actor, before.grant, reservation.job.consentRevision);
        const transition = await dependencies.store.dispatch({ ...before, jobId: reservation.job.id, leaseToken });
        dispatched = transition.job;
        if (!transition.mayDispatch || !dispatched.dispatchId) throw new ErpError('automation_dispatch_uncertain', 409);
        const after = await fresh();
        if (after.grant.environment !== reservation.job.environment || after.grant.processingPolicyVersion !== reservation.job.grant.processingPolicyVersion) throw new ErpError('automation_consent_required', 409);
        await dispatchConsent(after.actor, after.grant, reservation.job.consentRevision);
        await input.revalidate();
        } catch(error) {admissionFailure=error;throw error;}
      },
    });
    try {
      // Recipient is a trusted company address, not the document's alleged buyer.
      // Current extractor only uses bounded context; avoid loading contact PII.
      const result = validateUsSupplierExtraction(await extractUsSupplierInvoice(source.documentText, 'US workspace business', provider));
      const after = await fresh();
      if (!dispatched?.dispatchId || after.grant.environment !== reservation.job.environment) throw new ErpError('invalid_automation_record', 503);
      const resultBody = canonicalErpJson(result), resultSha256 = await sha256Hex(resultBody);
      const completed = await dependencies.store.complete({ ...after, jobId: dispatched.id, dispatchId: dispatched.dispatchId, resultBody, resultSha256 });
      const proposal = privateValue(()=>validateUsSupplierProposal(completed.proposal, after.actor.organizationId));
      const job=privateValue(()=>validateUsAutomationJob(completed.job,after.actor.organizationId));
      // The job preserves the original reservation's author/time. A proposal
      // is created by the freshly admitted completion actor/time; these are
      // distinct events and must not be conflated during a slow provider call.
      const expectedJob={...dispatched,state:'completed',resultBody,resultSha256,proposalId:proposal.id};
      if(canonicalErpJson(job)!==canonicalErpJson(expectedJob) || canonicalErpJson(job.source)!==canonicalErpJson(reservation.job.source) || canonicalErpJson(proposal.source)!==canonicalErpJson(job.source) || canonicalErpJson(proposal.extraction)!==resultBody || proposal.createdBy!==after.actor.userId || proposal.createdAt!==after.actor.timestamp) throw new ErpError('invalid_automation_record',503);
      await input.revalidate(); return { proposal, replayed: false };
    } catch (error) {
      if (dispatched?.dispatchId) {
        try { await dependencies.store.markUncertain((await fresh()).actor, dispatched.id, dispatched.dispatchId); } catch { /* A revoked actor cannot update the private job; dispatch remains consumed. */ }
      }
      throw admissionFailure??error;
    }
  };
}
