import { planQuoteDraft } from './planner';
import { quotePlanFingerprint } from './fingerprint';
import {
  captureQuotePreparationClaim,
  captureQuotePreparationResult,
  quotePreparationInput,
  quotePreparationInputFingerprint,
} from './intake';
import {
  QuotePreparationError,
  type QuotePreparationClaimResult,
  type QuotePreparationInput,
  type QuotePreparationResult,
} from './intake-types';
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

export { quotePlanFingerprint } from './fingerprint';

async function verifiedProposal(
  raw: unknown,
  actor: ActionActor,
): Promise<StoredQuoteProposal> {
  const stored = captureProposal(raw, actor);
  if ((await quotePlanFingerprint(stored.plan)) !== stored.fingerprint)
    throw new ActionEngineError('invalid_proposal');
  return stored;
}

function capturedClaimResult(
  raw: unknown,
  actor: ActionActor,
  input: QuotePreparationInput,
): QuotePreparationClaimResult {
  const invalid = (): never => {
    throw new QuotePreparationError('invalid_record');
  };
  if (
    !raw ||
    typeof raw !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
  )
    return invalid();
  const fields = Object.getOwnPropertyDescriptors(raw);
  if (
    Reflect.ownKeys(raw).length !== 2 ||
    !fields.state?.enumerable ||
    !('value' in fields.state)
  )
    return invalid();
  const state: unknown = fields.state.value;
  const key =
    state === 'owned'
      ? 'claim'
      : state === 'finished'
        ? 'result'
        : state === 'held' || state === 'uncertain'
          ? 'sourceId'
          : null;
  if (key === null || !fields[key]?.enumerable || !('value' in fields[key]))
    return invalid();
  const value: unknown = fields[key].value;
  if (state === 'owned')
    return Object.freeze({
      state,
      claim: captureQuotePreparationClaim(value, actor, input),
    });
  if (state === 'finished')
    return Object.freeze({
      state,
      result: captureQuotePreparationResult(value, input),
    });
  if (value !== input.sourceId) return invalid();
  return Object.freeze({
    state: state as 'held' | 'uncertain',
    sourceId: input.sourceId,
  });
}

async function verifiedPreparationResult(
  raw: unknown,
  input: QuotePreparationInput,
  inputHash: string,
): Promise<QuotePreparationResult> {
  const result = captureQuotePreparationResult(raw, input);
  if (
    result.inputHash !== inputHash ||
    (await quotePlanFingerprint(result.plan)) !== result.fingerprint
  )
    throw new QuotePreparationError('invalid_record');
  return result;
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
  const providerPort = ports.provider,
    intakePort = ports.intake;
  const authorize = ports.authorize.bind(ports),
    loadContext = ports.loadContext.bind(ports),
    findProposal = ports.findProposal.bind(ports),
    saveProposal = ports.saveProposal.bind(ports),
    decide = providerPort.decide.bind(providerPort),
    intake = {
      claim: intakePort.claim.bind(intakePort),
      start: intakePort.start.bind(intakePort),
      finish: intakePort.finish.bind(intakePort),
      uncertain: intakePort.uncertain.bind(intakePort),
    };
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
  const input = await quotePreparationInput(context);
  const inputHash = await quotePreparationInputFingerprint(input);
  const claimed = capturedClaimResult(
    await intake.claim(actor, input),
    actor,
    input,
  );
  let plan: QuotePlan, fingerprint: string;
  if (claimed.state === 'held') throw new QuotePreparationError('held');
  if (claimed.state === 'uncertain')
    throw new QuotePreparationError('uncertain');
  if (claimed.state === 'finished') {
    const result = await verifiedPreparationResult(
      claimed.result,
      input,
      inputHash,
    );
    plan = result.plan;
    fingerprint = result.fingerprint;
  } else if (claimed.state === 'owned') {
    const claim = claimed.claim;
    if (claim.inputHash !== inputHash)
      throw new QuotePreparationError('invalid_record');
    let attempted = false;
    const provider = {
      async decide(decisionInput: Parameters<typeof decide>[0]) {
        if (attempted) throw new QuotePreparationError('uncertain');
        attempted = true;
        // A lost acknowledgement here does NOT authorize HTTP: the durable
        // state may already be started. No lease/TTL may free that uncertainty.
        try {
          await intake.start(actor, claim);
        } catch (error) {
          if (error instanceof QuotePreparationError) throw error;
          throw new QuotePreparationError('service_unavailable');
        }
        try {
          return await decide(decisionInput);
        } catch {
          // Keep the durable started state even if this notification fails.
          // Revocation must not cause a second call, or freeze a failed draft.
          await intake.uncertain(actor, claim).catch(() => undefined);
          throw new QuotePreparationError('uncertain');
        }
      },
    };
    plan = captureQuotePlan(await planQuoteDraft(context, provider));
    validatePlanAgainstContext(plan, context);
    fingerprint = await quotePlanFingerprint(plan);
    captureAdmission(await authorize(actor), actor);
    const result = await verifiedPreparationResult(
      await intake.finish(actor, claim, plan, fingerprint),
      input,
      inputHash,
    );
    if (result.fingerprint !== fingerprint)
      throw new ActionEngineError('invalid_proposal');
    plan = result.plan;
  } else throw new QuotePreparationError('invalid_record');
  validatePlanAgainstContext(plan, context);
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
