import { planQuoteDraft } from './planner';
import {
  ActionEngineError,
  type ActionActor,
  type QuoteExecutionPorts,
  type QuotePreparationPorts,
  type QuotePlan,
  type StoredQuoteProposal,
} from './types';
import {
  actionIdentifier,
  captureActor,
  captureAdmission,
  captureProposal,
  captureQuotePlan,
  captureReceipt,
  validatePlanningContext,
  validatePlanAgainstContext,
} from './validation';

/** Canonical capture orders every field and detaches caller-owned values before digest's await. */
export async function quotePlanFingerprint(raw: QuotePlan): Promise<string> {
  const plan = captureQuotePlan(raw);
  const bytes = new TextEncoder().encode(JSON.stringify(plan));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

async function verifiedProposal(
  raw: unknown,
  actor: ActionActor,
): Promise<StoredQuoteProposal> {
  const stored = captureProposal(raw, actor);
  if ((await quotePlanFingerprint(stored.plan)) !== stored.fingerprint)
    throw new ActionEngineError('invalid_proposal');
  return stored;
}

/**
 * Orchestration only. Authenticated composition supplies durable repositories.
 * This module is NOT an API endpoint or a native writer. No model output grants
 * a permission, picks a tenant, supplies a price or names an executable command.
 */
export async function prepareQuoteProposal(
  rawActor: ActionActor,
  rawSourceId: string,
  ports: QuotePreparationPorts,
): Promise<StoredQuoteProposal> {
  const actor = captureActor(rawActor),
    sourceId = actionIdentifier(rawSourceId);
  const authorize = ports.authorize.bind(ports),
    loadContext = ports.loadContext.bind(ports),
    findProposal = ports.findProposal.bind(ports),
    saveProposal = ports.saveProposal.bind(ports),
    provider = { decide: ports.provider.decide.bind(ports.provider) };
  captureAdmission(await authorize(actor), actor);
  const context = validatePlanningContext(await loadContext(actor, sourceId));
  if (
    context.organizationId !== actor.organizationId ||
    context.source.id !== sourceId
  )
    throw new ActionEngineError('forbidden');
  const prior = await findProposal(actor, sourceId);
  if (prior !== null) {
    const stored = await verifiedProposal(prior, actor);
    validatePlanAgainstContext(stored.plan, context);
    captureAdmission(await authorize(actor), actor);
    return stored;
  }
  captureAdmission(await authorize(actor), actor);
  const plan = captureQuotePlan(await planQuoteDraft(context, provider));
  validatePlanAgainstContext(plan, context);
  const fingerprint = await quotePlanFingerprint(plan);
  const admission = captureAdmission(await authorize(actor), actor);
  const stored = await verifiedProposal(
    await saveProposal(actor, plan, fingerprint, admission),
    actor,
  );
  if (stored.fingerprint !== fingerprint || stored.plan.sourceId !== sourceId)
    throw new ActionEngineError('invalid_proposal');
  captureAdmission(await authorize(actor), actor);
  return stored;
}

/**
 * Accept only a persisted proposal ID. Receipt-first recovery prevents another
 * write when the first commit succeeded but its acknowledgement was lost.
 * Financial finalization is deliberately not representable by these ports.
 */
export async function executeQuoteProposal(
  rawActor: ActionActor,
  rawProposalId: string,
  ports: QuoteExecutionPorts,
) {
  const actor = captureActor(rawActor),
    proposalId = actionIdentifier(rawProposalId);
  const authorize = ports.authorize.bind(ports),
    loadProposal = ports.loadProposal.bind(ports),
    findReceipt = ports.findReceipt.bind(ports),
    loadContext = ports.loadContext.bind(ports),
    commitDraft = ports.commitDraft.bind(ports);
  captureAdmission(await authorize(actor), actor);
  const loaded = await loadProposal(actor, proposalId);
  if (loaded === null) throw new ActionEngineError('invalid_proposal');
  const stored = await verifiedProposal(loaded, actor);
  if (stored.id !== proposalId) throw new ActionEngineError('invalid_proposal');
  if (stored.plan.status !== 'ready')
    throw new ActionEngineError('review_required');
  const historical = await findReceipt(actor, proposalId, stored.fingerprint);
  if (historical !== null) {
    const receipt = captureReceipt(historical, stored);
    captureAdmission(await authorize(actor), actor);
    return receipt;
  }
  const context = validatePlanningContext(
    await loadContext(actor, stored.plan.sourceId),
  );
  if (context.organizationId !== actor.organizationId)
    throw new ActionEngineError('forbidden');
  validatePlanAgainstContext(stored.plan, context);
  const admission = captureAdmission(await authorize(actor), actor);
  // The adapter still MUST authorize and compare revisions inside its transaction.
  const receipt = captureReceipt(
    await commitDraft(actor, stored, admission),
    stored,
  );
  captureAdmission(await authorize(actor), actor);
  return receipt;
}
