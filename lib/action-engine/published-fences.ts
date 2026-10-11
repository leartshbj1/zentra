import { quotePreparationInput } from './intake';
import type {
  QuotePreparationFence,
  QuotePreparationInput,
} from './intake-types';
import { QuotePreparationError } from './intake-types';
import type { QuoteLedgerFence, QuoteLedgerPredicate } from './ledger-types';
import { QuoteLedgerError } from './ledger-types';
import type {
  DeviceQuoteAdmissionCas,
  DeviceQuoteAuthority,
} from './production-admission';
import type { PublishedQuotePublication } from './published-context';
import { publicationPredicate } from './publication-ledger';
import {
  combineQuotePredicates,
  type SupportQuoteSourceCapability,
} from './support-source';
import type {
  ActionActor,
  ActionAdmission,
  QuotePlanningContext,
} from './types';
import { ActionEngineError } from './types';
import {
  captureActor,
  captureAdmission,
  validatePlanningContext,
  validatePlanAgainstContext,
} from './validation';

/** Private capabilities, created by authenticated server readers, never JSON DTOs. */
export async function createPublishedQuoteFences(
  authority: DeviceQuoteAuthority,
  admissionCas: DeviceQuoteAdmissionCas,
  loaded: Readonly<{
    context: QuotePlanningContext;
    publication: PublishedQuotePublication;
    admission: ActionAdmission;
    sourceCapability: SupportQuoteSourceCapability;
  }>,
) {
  const actor = captureActor(authority.actor),
    context = validatePlanningContext(loaded.context);
  const admission = captureAdmission(admissionCas.admission, actor);
  const source = loaded.sourceCapability;
  if (
    context.organizationId !== actor.organizationId ||
    loaded.publication.organizationId !== actor.organizationId ||
    source.source.id !== context.source.id ||
    source.revision !== context.source.revision ||
    source.source.organizationId !== actor.organizationId ||
    captureAdmission(loaded.admission, actor).revision !== admission.revision
  )
    throw new ActionEngineError('stale_plan');
  const input = await quotePreparationInput(context);
  // Copy the expectation, excluding resource/projection fields not in its closed DTO.
  const publication = publicationPredicate({
    organizationId: loaded.publication.organizationId,
    snapshotId: loaded.publication.snapshotId,
    revision: loaded.publication.revision,
    baseRevision: loaded.publication.baseRevision,
    archiveSha256: loaded.publication.archiveSha256,
    manifestSha256: loaded.publication.manifestSha256,
  });
  const matchesActor = (candidate: ActionActor) => {
    const captured = captureActor(candidate);
    if (
      captured.organizationId !== actor.organizationId ||
      captured.userId !== actor.userId
    )
      throw new ActionEngineError('forbidden');
  };
  const matchesInput = (candidate: QuotePreparationInput) => {
    if (JSON.stringify(candidate) !== JSON.stringify(input))
      throw new QuotePreparationError('conflict');
  };
  const historical = (): QuoteLedgerPredicate =>
    combineQuotePredicates(
      authority.predicate('read'),
      source.predicate('read'),
    );
  const progression = (): QuoteLedgerPredicate =>
    combineQuotePredicates(
      admissionCas.predicate(),
      source.predicate('progression'),
      publication,
    );
  const ledgerFence: QuoteLedgerFence = async (request) => {
    matchesActor(request.actor);
    if (request.operation === 'read') {
      if (request.sourceId !== null) {
        if (
          request.sourceId !== context.source.id ||
          request.proposalId !== null
        )
          throw new QuoteLedgerError('forbidden');
        return historical();
      }
      if (request.proposalId === null) throw new QuoteLedgerError('forbidden');
      // A source-bound read cannot disclose a proposal from another Support space.
      return combineQuotePredicates(historical(), {
        sql: 'EXISTS(SELECT 1 FROM action_engine_quote_proposals WHERE organization_id=? AND id=? AND source_id=?)',
        bindings: [actor.organizationId, request.proposalId, context.source.id],
      });
    }
    if (request.operation === 'confirm') {
      // Publication of a resource catalogue is NOT proof that a quote exists.
      // A3/A4 never authorize confirmation without the canonical business receipt.
      return Object.freeze({ sql: '0', bindings: Object.freeze([]) });
    }
    validatePlanAgainstContext(request.proposal.plan, context);
    if (
      request.operation === 'reserve' &&
      request.installationId !== authority.installationId
    )
      throw new QuoteLedgerError('forbidden');
    if (
      request.operation === 'save' &&
      captureAdmission(request.admission, actor).revision !== admission.revision
    )
      throw new ActionEngineError('stale_plan');
    return progression();
  };
  const intakeFence: QuotePreparationFence = async (request) => {
    matchesActor(request.actor);
    matchesInput('input' in request ? request.input : request.claim.input);
    if ('claim' in request && request.claim.userId !== actor.userId)
      throw new QuotePreparationError('forbidden');
    if (request.operation === 'finish')
      validatePlanAgainstContext(request.result.plan, context);
    return request.operation === 'read' ? historical() : progression();
  };
  return Object.freeze({
    ledgerFence,
    intakeFence,
    progression,
    input,
    context,
    admission,
  });
}
